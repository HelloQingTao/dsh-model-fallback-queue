/**
 * dsh-model-fallback-queue — Host half.
 *
 * 模型故障转移队列：
 * - agent/request (waterfall): 当 P1 熔断/粘滞切换生效时，用队列中下一个可用路由覆盖
 *   本次请求的 provider/model（返回 {...next值, provider, model}）。
 * - agent/request-error (waterfall): 请求失败时判定熔断码；命中即时码或软阈值则熔断
 *   当前路由，并返回 { kind: 'retry' } 让 agent-loop 用新配置重试同一步。
 * - agent/assistant-stream (emit): end/committed 判定成功，重置熔断计数。
 *
 * 设计要点（docs/design-plan.md）：
 * - 熔断器三态 Closed/Open/HalfOpen，纯内存，进程重启归零。
 * - failbackMode: sticky(粘滞,默认) / probe(探测回切) / manual(手动回切)。
 * - 非致命码走 next() 让路给 dsh-llm-retry 同路由重试。
 * - 插件任何异常不得拦截请求：全部 try/catch 兜底 next()。
 */

/**
 * 运行态变更通知事件名。
 * 宿主（dsh-api-remotes）只转发白名单里的事件，这个不在白名单上，到不了浏览器 ——
 * 客户端靠轮询 snapshot 的 revision 感知变化。emit 保留：将来宿主支持转发时会自动生效。
 */
const CHANGE_EVENT = 'dsh-model-fallback-queue/changed';

/** 配置级健康：路由的 provider/model 是否真实存在。INVALID = 重试无意义，直接跳过 */
const HEALTH = { OK: 'ok', INVALID: 'invalid' };

const DEFAULT_IMMEDIATE_CODES = [
  'QUOTA',
  'ACCOUNT_QUOTA',
  'RATE_LIMIT',
  'AUTH',
  'INVALID_CREDENTIAL',
  'NO_ADAPTER',
  // 适配层认不出的文本一律落这两个码（dsh-llm-pi-ai 的 classifyPiAiError 兜底是
  // PI_AI_ERROR，dsh-agent-loop 的失败兜底是 UNKNOWN）。provider 把内部异常原样
  // 当错误信息回传时（如把 `hook.callback.bind is not a function` 当 429 文案），
  // 只会落到这里 —— 不算即时熔断的话，配额耗尽的 P1 会一直被当成健康路由反复选中。
  // 代价是任何不认识的下游文本都会让本路由切一次；回切策略保证它冷却后能被探回。
  'PI_AI_ERROR',
  'UNKNOWN',
];

const DEFAULT_CONFIG = {
  enabled: false,
  queue: [], // [{ provider, model }]，索引 0 = P1。来源是 state 文件，不是 settings
  p1Follow: true, // P1 跟随当前模型（用户在 UI 手动换模型时 P1 自动跟随）
  immediateCodes: DEFAULT_IMMEDIATE_CODES,
  failureThreshold: 2,
  cooldownMs: 60_000,
  failbackMode: 'sticky', // 'sticky' | 'probe' | 'manual'
  failbackDelayMs: 5 * 60_000, // probe 模式防抖
};

/** settings 里不允许出现的键：queue 已迁到 state 文件 */
const SETTINGS_EXCLUDED_KEYS = ['queue'];

const CIRCUIT = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

/**
 * 客户端错误码：请求本身有问题（参数不合法、内容被策略拒绝），换模型也救不了。
 * 这类失败不能算路由不健康，也不能触发跨路由切换。
 *
 * UNKNOWN / PI_AI_ERROR 不在这里：它们可能是 "connection error." 也可能是 provider
 * 把内部异常当文案回传，无法区分，按即时熔断处理（宁可切一次，别让坏路由一直被选中）。
 */
const CLIENT_FAULT_CODES = new Set([
  'INVALID_ARGS',
  'INVALID_REQUEST',
  'BAD_REQUEST',
  'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED',
  'ABORTED',
]);

function isClientFaultCode(code) {
  return typeof code === 'string' && CLIENT_FAULT_CODES.has(code);
}

/** provider 侧的配额类措辞：适配层没认出错误码时靠它补判 */
const QUOTA_TEXT = /quota|额度|限额|余额|insufficient|exceeded (?:your )?(?:current )?quota|usage limit|billing/i;

/**
 * 文本层配额判定。适配层认不出的文本会落成 PI_AI_ERROR / UNKNOWN，错误码分类就失效了；
 * 这时只要报文里有配额/超限措辞，仍按即时熔断处理。
 */
function looksLikeQuota(message) {
  return typeof message === 'string' && QUOTA_TEXT.test(message);
}

/** 熔断原因正文的上限：上游偶尔把整页 HTML / 长堆栈当 message 回传，不能整段塞进快照 */
const MAX_REASON_LENGTH = 300;

/**
 * 收敛上游报错原文成一行可展示的短文案（保留原文措辞，只压空白 + 截断）。
 * @param {unknown} message 上游错误信息
 * @returns {string} 空字符串表示没有可展示的原因
 */
function normalizeReason(message) {
  if (typeof message !== 'string') return '';
  const oneLine = message.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_REASON_LENGTH) return oneLine;
  return `${oneLine.slice(0, MAX_REASON_LENGTH)}…`;
}

function createRouter(config, log) {
  // log = 宿主 ctx：touch() 需要它来 emit 变更通知（无 emit 能力时静默降级）
  // 每个路由 key 的熔断状态，纯内存
  const circuits = new Map(); // key -> { state, failures, openedAt, lastAttemptAt }
  // 配置级健康表：provider/model 是否真实存在（适配器注册表 + 模型目录）。
  // 区别于熔断：熔断是"暂时不可用会恢复"，这里是"配置死了永远不可用"。
  const health = new Map(); // key -> HEALTH.OK | HEALTH.INVALID
  // 会话模型快照：P1 应指的用户手选模型。apply 层仅在 P1 真实放行时写它，
  // 熔断覆盖（cfg 被改成后备模型）不碰——否则 P1 的 key 被后备模型永久污染。
  let sessionModel = null; // { provider, model } | null
  // 运行态
  const runtime = {
    activeIndex: 0, // 当前生效的队列索引（= 已挂起、等待下一级请求替换的那条）
    inFlightIndex: -1, // 最近一次实际发出去的请求所走的路由；-1 = 未覆盖（放行原配置）
    lastProposal: null, // { key, idx, overridden } 最近一次 agent/request 的提案
    lastSwitch: null, // { from, to, code, at }
    revision: 0, // 状态版本号，客户端据此判断是否需要重新拉 snapshot
    probeInFlight: false,
  };

  /** 任何会改变运行态/电路的操作都应调用它：bump 版本号 → 通知客户端拉新快照 */
  function touch() {
    runtime.revision += 1;
    try {
      // cordis 的 emit(name, ...args)：name 是第一个参数，不是 this
      log?.emit?.(CHANGE_EVENT);
    } catch {
      /* 通知失败不影响主流程 */
    }
  }

  const keyOf = (route) => `${route.provider}\u0000${route.model}`;

  function circuitOf(key) {
    let c = circuits.get(key);
    if (!c) {
      c = {
        state: CIRCUIT.CLOSED, failures: 0, openedAt: 0, lastAttemptAt: 0,
        // 最近一次失败的原因：熔断后 UI 的 ⓘ 悬浮提示要直接展示上游原文
        lastCode: null, lastMessage: '', retryAfterMs: 0,
      };
      circuits.set(key, c);
    }
    return c;
  }

  function isAvailable(route, now = Date.now()) {
    // 配置级失效（provider 没注册适配器 / 模型已不存在）优先于熔断状态：
    // 这类路由重试多少次都不会好，等冷却毫无意义，必须直接判死。
    if (health.get(keyOf(route)) === HEALTH.INVALID) return false;
    const c = circuitOf(keyOf(route));
    if (c.state === CIRCUIT.CLOSED || c.state === CIRCUIT.HALF_OPEN) return true;
    // OPEN 且冷却到期 → 进入半开，允许一次探测
    if (now - c.openedAt >= config.cooldownMs) {
      c.state = CIRCUIT.HALF_OPEN;
      return true;
    }
    return false;
  }

  function recordFailure(route, code, message, retryAfterMs) {
    const c = circuitOf(keyOf(route));
    c.failures += 1;
    // 记下最近一次失败的原文与上游建议等待时长：熔断后 UI 悬浮提示直接展示它们。
    // 每次都覆盖（而不是只在熔断那一刻记），因为熔断前的最后一次失败才是当前病根。
    c.lastCode = typeof code === 'string' && code ? code : 'UNKNOWN';
    c.lastMessage = normalizeReason(message);
    c.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
    const immediate = config.immediateCodes.includes(code) || looksLikeQuota(message);
    if (immediate || c.failures >= config.failureThreshold) {
      c.state = CIRCUIT.OPEN;
      c.openedAt = Date.now();
      c.failures = 0;
    }
    touch();
  }

  function recordSuccess(route) {
    const c = circuitOf(keyOf(route));
    c.state = CIRCUIT.CLOSED;
    c.failures = 0;
    // 恢复正常后清掉旧账：否则下次熔断前若没拿到新原因，悬浮提示会展示早已过期的报错
    c.lastCode = null;
    c.lastMessage = '';
    c.retryAfterMs = 0;
    touch();
  }

  /**
   * UI 指示器要显示的"实际生效路由"索引。
   * 优先级：最近一次真的发出去的请求 > 已挂起等待替换的路由。
   * -1 表示本次请求没被本插件覆盖（放行原配置）——此时 P1 才真的是"当前"。
   */
  function effectiveIndex() {
    if (runtime.inFlightIndex >= 0) return runtime.inFlightIndex;
    return runtime.activeIndex;
  }

  /** 邻近可用：从 fromIndex 起找第一个可用路由；粘滞模式绕回 P1 仅当其余全不可用 */
  function pickFrom(startIndex, { allowP1 }) {    const queue = config.queue || [];
    const n = queue.length;
    for (let step = 1; step <= n; step += 1) {
      const i = (startIndex + step) % n;
      if (i === 0 && !allowP1) continue; // 粘滞模式跳过 P1，除非绕满一圈
      if (isAvailable(queue[i])) return i;
    }
    return -1;
  }

  return {
    runtime,
    circuits,
    keyOf,
    isAvailable,
    recordFailure,
    recordSuccess,
    touch,
    pickFrom,
    health,
    HEALTH,
    /**
     * 预检队列：逐条核对 provider 是否有已注册适配器（llm.listProviders）。
     * 适配器缺失 = 配置级死亡（NO_ADAPTER 必然发生），当场判 INVALID 并触发一次
     * 重选——不等请求撞上去才发现。返回变更摘要供日志/诊断用。
     */
    async preflight(llm) {
      const queue = config.queue || [];
      if (!llm?.listProviders) return { checked: 0, invalid: [] };
      let registered;
      try {
        registered = new Set(llm.listProviders().map((p) => p.id));
      } catch {
        return { checked: 0, invalid: [] }; // 适配器表不可读：不误杀，保持原状
      }
      const invalid = [];
      let changed = false;
      for (const r of queue) {
        const key = keyOf(r);
        const dead = !registered.has(r.provider);
        if (dead && health.get(key) !== HEALTH.INVALID) {
          health.set(key, HEALTH.INVALID);
          invalid.push({ provider: r.provider, model: r.model });
          changed = true;
        } else if (!dead && health.get(key) === HEALTH.INVALID) {
          health.delete(key); // 适配器回来了（插件装回/配置修复）→ 自动复活
          changed = true;
        }
      }
      // 游标检查每次都做：即使本轮无新判死，游标也可能因队列改动/手动切换
      // 停在早已判死的路由上，同样要立即切走。
      const cur = Math.min(runtime.activeIndex, Math.max(queue.length - 1, 0));
      if (queue[cur] && health.get(keyOf(queue[cur])) === HEALTH.INVALID) {
        const next = pickFrom(cur, { allowP1: true });
        if (next >= 0 && next !== cur) {
          runtime.lastSwitch = { from: cur, to: next, code: 'NO_ADAPTER', at: Date.now() };
          runtime.activeIndex = next;
          changed = true;
        }
      }
      if (changed) touch();
      return { checked: queue.length, invalid, changed };
    },
    /** 选出本次请求应使用的队列索引；返回 -1 表示队列不可用（放行原配置） */
    resolveIndex(now = Date.now()) {
      const queue = config.queue || [];
      if (!config.enabled || queue.length === 0) return -1;
      const cur = Math.min(runtime.activeIndex, queue.length - 1);
      if (isAvailable(queue[cur], now)) return cur;
      // 当前路由不可用 → 找下一个可用
      const sticky = config.failbackMode === 'sticky';
      const next = pickFrom(cur, { allowP1: !sticky || cur === 0 ? true : false });
      // 粘滞模式：只有绕一圈找不到任何非 P1 可用路由时才允许回 P1
      let chosen = next;
      if (chosen === -1 && sticky) chosen = pickFrom(cur, { allowP1: true });
      if (chosen === -1) return -1; // 全熔断：放行原配置（降级）
      if (chosen !== cur) {
        runtime.lastSwitch = {
          from: cur,
          to: chosen,
          at: Date.now(),
        };
        runtime.activeIndex = chosen;
        touch();
      }
      return chosen;
    },
    /**
     * 失败后决定是否要求重试（切换路由）。
     * p1OwnsFailure：失败确实发生在 P1 上（或本次请求未覆盖路由，P1 就是实际使用的
     * 路由）时才允许把"找不到匹配"的失败归到 idx 0；否则 P2 的 AUTH/NO_ADAPTER 之类
     * 失败会被误记到 P1 电路上，把健康的 P1 熔断掉。
     * failure：宿主给的失败事实（LlmFailure），带上它才能把上游原文与建议等待时长
     * 一起记进电路，供 UI 的熔断原因悬浮提示展示。
     */
    onFailedAttempt(provider, model, code, p1OwnsFailure = true, failure = null) {
      const queue = config.queue || [];
      if (!config.enabled || queue.length === 0) return false;
      let idx = queue.findIndex((r) => r.provider === provider && r.model === model);
      // P1 动态跟随：失败路由=当前会话模型且不等于队列静态 P1 时，把失败记到 P1（idx 0）
      if (idx === -1 && config.p1Follow && p1OwnsFailure) idx = 0;
      if (idx === -1) return false; // 不是队列里的路由，不接管
      // 客户端错误（请求体不合法、内容被拒之类）不是路由健康问题：既不能熔断，
      // 也不能把游标钉过去，否则一条坏请求会让健康路由整段冷却 60s。
      if (isClientFaultCode(code)) return false;
      // 游标钉到实际失败的这条路由上，再算下一个。否则："P1 跟随当前模型"模式下
      // 用户手动选了 P3、P3 挂了，游标还停在 P2，resolveIndex() 会认为 P2 正常并
      // 直接返回，切换根本不发生；或者 resolveIndex() 从旧游标推出来的下一站是刚
      // 挂掉的这条，同样切不出去。
      runtime.activeIndex = idx;
      recordFailure(queue[idx], code, failure?.message, failure?.providerRetryAfterMs);
      const nextIdx = this.resolveIndex();
      if (nextIdx === -1 || nextIdx === idx) {
        touch(); // 熔断已记下，指标变了，通知一次
        return false; // 全熔断或仍在原路由：不重试
      }
      // 切换决定已作出：retry 后下一个请求会发往 nextIdx。若此处不同步 inFlightIndex，
      // effectiveIndex() 会一直返回旧的 inFlightIndex（上一条路由），UI 的指示器与
      // "当前"标记在下一轮 agent/request 瀑布跑过之前都指错对象（P3 在跑却显示 P2）。
      runtime.inFlightIndex = nextIdx;
      runtime.lastSwitch.code = code;
      touch();
      return true;
    },
    snapshot() {
      const queue = config.queue || [];
      return {
        enabled: config.enabled,
        p1Follow: config.p1Follow,
        activeIndex: runtime.activeIndex,
        inFlightIndex: runtime.inFlightIndex,
        effectiveIndex: effectiveIndex(),
        lastProposal: runtime.lastProposal ? { ...runtime.lastProposal } : null,
        // 会话模型快照：P1 应该指的用户手选模型（不受熔断回写污染）。
        // UI 用它显示 P1 行名称，并在"会话模型 ≠ effective 路由"时判断是否已切走。
        sessionModel: sessionModel ? { ...sessionModel } : null, // 闭包内 let，见上方声明
        lastSwitch: runtime.lastSwitch,
        revision: runtime.revision,
        // 冷却时长给 UI：悬浮提示要用它把 openedAt 换算成"预计恢复"的时刻
        cooldownMs: config.cooldownMs,
        entries: queue.map((r, i) => {
          const c = circuitOf(keyOf(r));
          return {
            index: i,
            provider: r.provider,
            model: r.model,
            state: c.state,
            failures: c.failures,
            // 配置级死亡（无适配器）：UI 据此直接标"配置失效"而不是"熔断中"
            invalid: health.get(keyOf(r)) === HEALTH.INVALID,
            // 熔断原因（ⓘ 悬浮提示）：只在电路非正常态时给出，健康路由不背历史失败的账
            lastError: c.state !== CIRCUIT.CLOSED && c.lastCode
              ? { code: c.lastCode, message: c.lastMessage }
              : null,
            openedAt: c.openedAt || null,
            // 预计恢复 = 熔断时刻 + 冷却时长；half_open 之后就不再是"等冷却"了
            recoverAt: c.state === CIRCUIT.OPEN ? c.openedAt + config.cooldownMs : null,
            retryAfterMs: c.retryAfterMs || null,
          };
        }),
      };
    },
  };
}

// 依赖写法：必须用裸包名 + package.json 声明 peerDependencies。
// dsh 启动时会给「profile 内的包」和「link 到工作区的包」装一层运行时解析拦截
// （dsh-app-boot 的 ResolutionRouter）：祖先 node_modules 里声明了该 peer 名字时，
// 请求会被路由到安装域（dsh 主包 node_modules）里的同一份副本。
// 因此这里既不需要绝对路径，也能保证与宿主拿到同一个模块实例（类标记/符号一致）。
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
// schemastery：Config 必须是它（toJSON 信封供 dsh-settings 派生 settings namespace，
// ~standard 供 cordis 校验），同样走 peerDependencies 解析。
import s from '@deepseek-ai/schemastery';
// 队列顺序的独立持久化（不放 settings，避免每次写盘触发整页主题重算）。
import { readQueueState, writeQueueState, normalizeQueue, statePath } from './state.js';

// 与 @deepseek-ai/dsh-typert-protocol 内部常量同值（该包 0.2.1-rc.2 起不再导出
// ./remote-methods 子路径，但协议本身仍是这个字符串键 + {version:1, methods:[...]} 结构，
// 宿主自己的 dsh-repeat-tool-reminder / dsh-tmux-context 也直接硬编码同一常量）。
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/** 给原型打 Remote 方法标记（等价于 TS 装饰器编译产物） */
function markRemoteMethods(prototype, methods) {
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(
        methods.map((m) => Object.freeze({ method: m, invocation: Object.freeze({ kind: 'direct' }) })),
      ),
    }),
  });
}

/**
 * 运行态 RPC 服务：浏览器半区经 ctx.remote['dsh-model-fallback-queue'].snapshot() 调用。
 * cordis 类插件实例化只传 (ctx, config)，故 router 经模块级桥接获取。
 */
let serviceBridge = null; // { router, config, saveSettings, saveQueue } 由 apply 设置

class FallbackQueueService extends TypertRemoteService {
  static inject = [];

  constructor(ctx) {
    super(ctx, 'FallbackQueueService', { namespace: 'dsh-model-fallback-queue' });
    if (!serviceBridge) throw new Error('fallback-queue: service bridge missing');
    this.router = serviceBridge.router;
    this.config = serviceBridge.config;
  }

  /** 运行态快照 */
  snapshot() {
    return this.router.snapshot();
  }

  /** 手动探测：强制指定索引的熔断器进半开 */
  probe(index) {
    const route = this.config.queue?.[index];
    if (!route) return { ok: false };
    const c = this.router.circuits.get(this.router.keyOf(route));
    if (c) {
      c.state = CIRCUIT.HALF_OPEN;
      c.openedAt = 0;
    }
    return { ok: true };
  }

  /** 手动回切：把 activeIndex 拉回指定索引（默认 P1=0） */
  manualFailback(index) {
    const i = Number.isFinite(index) ? index : 0;
    const route = this.config.queue?.[i];
    if (!route) return { ok: false };
    const from = this.router.runtime.activeIndex;
    this.router.runtime.activeIndex = i;
    // 手动回切后 UI 立刻应显示 P1，而不是继续显示上次失败的路由
    this.router.runtime.inFlightIndex = i;
    this.router.runtime.lastSwitch = { from, to: i, code: 'MANUAL', at: Date.now() };
    this.router.touch();
    return { ok: true };
  }

  /** 读当前队列顺序（来自 state 文件，非 settings） */
  getQueue() {
    return { queue: this.config.queue || [] };
  }

  /** 写队列顺序：只落 state 文件，不碰 settings → 不触发主题重算 */
  async setQueue(queue) {
    const ok = await serviceBridge.saveQueue(queue);
    return { ok, queue: this.config.queue || [] };
  }
}
markRemoteMethods(FallbackQueueService.prototype, ['snapshot', 'probe', 'manualFailback', 'getQueue', 'setQueue']);

export const inject = ['settings', 'llm'];

export function apply(ctx, llm) {
  const config = { ...DEFAULT_CONFIG };

  // ---- 设置持久化：namespace = 插件行 id ----
  const NS = 'dsh-model-fallback-queue';
  let settingsView = null;

  async function loadSettings() {
    try {
      const desc = ctx.settings.describe().find((d) => d.ns === NS);
      if (desc) {
        settingsView = desc;
        const value = { ...(desc.value || {}) };
        // queue 不再由 settings 承载；老版本残留的 queue 值在迁移步骤里单独取用
        const legacyQueue = value.queue;
        for (const k of SETTINGS_EXCLUDED_KEYS) delete value[k];
        Object.assign(config, value);
        return legacyQueue;
      }
    } catch (e) {
      ctx.logger?.warn?.('[fallback-queue] settings read failed, using defaults: %s', e?.message);
    }
    return undefined;
  }

  async function saveSettings(patch) {
    try {
      const clean = { ...patch };
      for (const k of SETTINGS_EXCLUDED_KEYS) delete clean[k];
      Object.assign(config, clean);
      if (Object.keys(clean).length === 0) return; // 只有 queue 的 patch 不该写 settings
      await ctx.settings.update(NS, clean, settingsView?.revision);
      const desc = ctx.settings.describe().find((d) => d.ns === NS);
      if (desc) settingsView = desc;
    } catch (e) {
      ctx.logger?.warn?.('[fallback-queue] settings write failed: %s', e?.message);
    }
  }

  /**
   * 写队列顺序到 state 文件。只碰文件，不碰 settings，因此不会触发
   * ui-theme 的 adopt()/theme 重推，也就不会让整页主题重刷（白闪）。
   */
  async function saveQueue(queue) {
    const next = normalizeQueue(queue);
    config.queue = next;
    const ok = await writeQueueState(next);
    if (!ok) ctx.logger?.warn?.('[fallback-queue] queue write failed, keeping in-memory value');
    return ok;
  }

  /**
   * 启动时载入队列：state 文件优先；文件缺失（首次升级）时把 settings 里
   * 残留的旧 queue 一次性迁移过来。迁移后 settings 侧不再保留 queue
   * （也不主动去改文档 —— 改文档就是推 revision，正是要避开的动作）。
   */
  async function loadQueue(legacyQueue) {
    const fromState = await readQueueState();
    if (fromState) {
      config.queue = fromState;
      return;
    }
    const legacy = normalizeQueue(legacyQueue);
    if (legacy.length > 0) {
      config.queue = legacy;
      const ok = await writeQueueState(legacy);
      ctx.logger?.info?.(
        '[fallback-queue] migrated %d queue entr%s from settings to %s',
        legacy.length,
        legacy.length === 1 ? 'y' : 'ies',
        statePath(),
      );
      if (!ok) ctx.logger?.warn?.('[fallback-queue] migration write failed; will retry next boot');
      // 此处刻意不回写 settings：Config 已无 queue 字段，写它只会白白推一次
      // settings revision → 触发宿主主题全量重算（也就是白闪本身）。
      // 残留的 queue 值留在文档里也无害：loadSettings 每次都会丢弃它。
      return;
    }
    config.queue = [];
  }

  const router = createRouter(config, ctx);

  // ---- 路由预检：启动时 + 适配器拓扑变化时，核对队列里的 provider 是否真的存在 ----
  // 没有这一步时，"provider 被卸载/改名/模型下架"只能等请求撞上 NO_ADAPTER、熔断
  // 计数走完才被发现；预检在装配期就判死并切走。llm 服务缺失（旧宿主/单测环境）
  // 时 preflight 内部直接返回，不报错。
  async function runPreflight(trigger) {
    const result = await router.preflight(llm);
    if (result.invalid?.length) {
      ctx.logger?.warn?.(
        '[fallback-queue] preflight(%s): %d entr%s dead (no adapter): %s',
        trigger,
        result.invalid.length,
        result.invalid.length === 1 ? 'y' : 'ies',
        result.invalid.map((r) => `${r.provider}/${r.model}`).join(', '),
      );
    }
  }
  ctx.effect(() => ctx.on('llm/adapters-updated', () => runPreflight('adapters-updated')));
  // 启动预检要等适配器注册完成，adapters-updated 事件天然覆盖（xdpool 等注册完会触发）。
  // 兜底：启动后 3s 再跑一次，防宿主不派发该事件。
  const preflightTimer = setTimeout(() => runPreflight('boot'), 3000);

  // 供 Client（经 remote RPC 或事件）读取运行态快照
  ctx.effect(() => {
    // settings/document-updated 时刷新本地 config
    return ctx.on('settings/document-updated', (ns) => {
      if (ns !== NS) return;
      loadSettings();
    });
  });

  // ---- agent/request：覆盖冻结调用配置 ----
  // 记下"本次请求实际提案的路由"，供 request-error（P1 归属判定）与 assistant-stream
  // （精确复位）使用。键是 `${provider}\u0000${model}`：失败尝试与随后的重试是同一步的
  // 两次事件，用路由键而不是全局游标才能对上号。
  let lastProposal = null; // { key, idx, overridden }

  // ---- 会话模型快照（P1 的"本尊"）----
  // P1 跟随模式下 P1 = 当前会话模型。但"会话模型"必须指**用户手选的那个**，而不是
  // 熔断切走后宿主回写的后备模型——否则熔断到 P3 后 P1 的 key 也变成 P3，会话模型
  // 被永久污染，显示与归属判定全跟着错。
  // 更新规则：仅当本轮请求未被本插件覆盖（overridden=false，即 P1 真实放行）时才
  // 记录 cfg 的 provider/model；被覆盖的请求（overridden=true，发往后备）不碰它。
  // 手动切模型必然经过 P1 放行路径，所以这里能自然跟上用户的手选。
  // 存放在 router（router.sessionModel）上：snapshot 归 createRouter 所有，
  // 放 apply 闭包会在 snapshot 里 ReferenceError。

  /** 本次提案落在队列里的真实索引；-1 = 队列外 */
  const actualRouteOf = (provider, model) => {
    const queue = config.queue || [];
    if (provider && model) {
      const hit = queue.findIndex((r) => r.provider === provider && r.model === model);
      if (hit >= 0) return hit;
    }
    return lastProposal ? lastProposal.idx : -1;
  };

  /** 游离标钉到实际在跑的路由（P1 跟随模式下 UI 手选的其他模型也算） */
  const runtimePin = (idx) => {
    if (Number.isInteger(idx) && idx >= 0) router.runtime.activeIndex = idx;
  };

  ctx.effect(() =>
    ctx.on('agent/request', async (payload, next) => {
      // 下游的 await next() 不能进 try：瀑布的 next() 只能消费一次，抛错之后再调一次
      // 拿到的是 undefined，会把整轮请求的 provider/model 变成空的。真出异常就让
      // prepareRequest 抛 —— agent-loop 会把它当成一个正常失败（UNKNOWN）吞掉。
      const cfg = await next();
      try {
        const idx = router.resolveIndex();
        if (idx === -1) {
          lastProposal = null; // 队列不生效：原配置即提案，交由下游
          router.runtime.inFlightIndex = -1;
          router.runtime.lastProposal = null;
          return cfg;
        }
        // P1（idx 0）动态跟随当前会话模型：不覆盖，放行原配置
        if (idx === 0 && config.p1Follow) {
          lastProposal = { key: router.keyOf({ provider: cfg.provider, model: cfg.model }), idx: 0, overridden: false };
          // P1 真实放行 = 用户所选会话模型的可靠采样点：更新快照。
          // 前提是这条路由没被判死/熔断（判死时 resolveIndex 不会返回 0）。
          router.sessionModel = { provider: cfg.provider, model: cfg.model };
          const actual = actualRouteOf(cfg.provider, cfg.model);
          runtimePin(actual);
          // UI 显示的是"实际在跑的这条"：用户手选了队列外的模型就是 -1（P1 跟随）
          router.runtime.inFlightIndex = actual;
          router.runtime.lastProposal = { ...lastProposal };
          router.touch();
          return cfg;
        }
        const route = config.queue[idx];
        if (!route) {
          lastProposal = null;
          router.runtime.inFlightIndex = -1;
          router.runtime.lastProposal = null;
          return cfg;
        }
        lastProposal = { key: router.keyOf(route), idx, overridden: true };
        router.runtime.inFlightIndex = idx;
        router.runtime.lastProposal = { ...lastProposal };
        router.touch();
        return { ...cfg, provider: route.provider, model: route.model };
      } catch (e) {
        ctx.logger?.warn?.('[fallback-queue] agent/request override skipped: %s', e?.message);
        lastProposal = null;
        router.runtime.inFlightIndex = -1;
        router.runtime.lastProposal = null;
        return cfg;
      }
    }),
  );

  // ---- agent/request-error：熔断判定 + 请求重试 ----
  // ⚠️ cordis 的签名是 on(name, listener, options)：options 在**第三个**参数。
  // 曾经写成 on(name, { prepend: true }, fn)，于是 listener={prepend:true}、
  // options=真函数，钩子记录变成 { callback: {prepend:true} } —— dispatch 时
  // `hook.callback.bind` 必然抛 "is not a function"，而且熔断判定一次都没执行过。
  ctx.logger?.info?.(
    '[fallback-queue] attached: queue=%d p1Follow=%s enabled=%s',
    (config.queue || []).length,
    config.p1Follow,
    config.enabled,
  );

  ctx.effect(() =>
    ctx.on('agent/request-error', async (payload, next) => {
      const { provider, failure } = payload;
      // payload.agent 由 dsh-agent 的 agentEvents() fused 注入，运行时确实存在；
      // callConfig 不一定有（宿主没给），actualModel 是 agent/request 里记下的真实路由模型。
      const model = payload.agent?.callConfig?.model ?? lastProposal?.key?.split('\u0000')[1];
      // 诊断日志：确认监听器真的被调用了、拿到了什么。用户报"完全没切换"时，
      // 靠它区分"没执行到"和"执行了但判定不切"——这两种情况表现一样但修法完全不同。
      ctx.logger?.info?.(
        '[fallback-queue] request-error fired: provider=%s model=%s code=%s queue=%d lastProposal=%s',
        provider,
        model,
        failure?.code,
        (config.queue || []).length,
        JSON.stringify(lastProposal),
      );
      // 先把路由复原到"实际失败的那条"再判定归属：用户手动切到 P2/P3 后，队列里
      // 找不到匹配是常态，此时若按"未覆盖 = P1 的锅"处理，会把 P2/P3 的 429 记到
      // P1 头上，P1 无端熔断，P2/P3 反而永远健康、反复被选中。
      const actual = lastProposal ? actualRouteOf(provider, model) : -1;
      let p1OwnsFailure = true;
      if (actual >= 0) {
        runtimePin(actual);
        p1OwnsFailure = actual === 0;
      } else {
        // P1 动态跟随：只有"本次提案就是 P1"时才允许把找不到匹配的失败归到 idx 0
        p1OwnsFailure = config.p1Follow && (lastProposal === null || !lastProposal.overridden || lastProposal.idx === 0);
        // 额外防线：失败路由若等于熔断切走后的后备模型（会话模型快照之外的），
        // 说明这是后备路由自己的失败，不能算到 P1 头上。
        const sm = router.sessionModel;
        if (p1OwnsFailure && sm && (sm.provider !== provider || sm.model !== model)) {
          p1OwnsFailure = false;
        }
      }
      try {
        const switched = router.onFailedAttempt(provider, model, failure?.code, p1OwnsFailure, failure);
        // 诊断日志：判定结果。switched=false 时同时打出熔断态，便于看清是"全熔断"
        // 还是"码不在立即列表"还是"路由不在队列里"。
        ctx.logger?.info?.(
          '[fallback-queue] decision: actual=%d p1Owns=%s switched=%s activeIndex=%d circuits=%s',
          actual,
          p1OwnsFailure,
          switched,
          router.runtime.activeIndex,
          JSON.stringify(router.snapshot().entries.map((e) => `${e.index}:${e.state}`)),
        );
        if (switched) return { kind: 'retry' };
      } catch (e) {
        ctx.logger?.warn?.('[fallback-queue] request-error handling failed: %s', e?.message);
      }
      // 非致命 / 未接管：必须 next()，否则 dsh-llm-retry 等下游永远接不到
      return next();
    }, { prepend: true }),
  );

  // ---- agent/assistant-stream：成功即复位熔断 ----
  ctx.effect(() =>
    ctx.on('agent/assistant-stream', (payload) => {
      try {
        const { frame } = payload;
        if (frame?.type !== 'end') return;
        // end 帧既可能是 committed 也可能是 abandoned（失败/中断），只有 committed 才算走通
        if (frame.outcome?.kind !== 'committed') return;
        // 复位"本次实际使用的那条路由"，而不是全局游标 activeIndex
        // （用户在 UI 手动换模型后 P1 会跟随，用游标会复位错对象）
        const proposal = lastProposal;
        const queue = config.queue || [];
        let route = proposal && proposal.overridden ? queue[proposal.idx] : undefined;
        if (!route && proposal) {
          route = queue.find((r) => router.keyOf(r) === proposal.key);
        }
        if (route) router.recordSuccess(route);
      } catch {
        /* 忽略 */
      }
    }),
  );

  // ---- 启动加载设置 ----
  ctx.effect(() => {
    void (async () => {
      const legacyQueue = await loadSettings();
      await loadQueue(legacyQueue);
    })().catch((e) => ctx.logger?.warn?.('[fallback-queue] boot load failed: %s', e?.message));
  });

  // ---- 运行态 RPC 服务 ----
  serviceBridge = { router, config, saveSettings, saveQueue };
  ctx.effect(() => ctx.plugin(FallbackQueueService), 'fallback-queue rpc service');
  ctx.effect(() => () => {
    serviceBridge = null;
  }, 'fallback-queue bridge cleanup');

  return {
    router,
    saveSettings,
    saveQueue,
    loadSettings,
    loadQueue,
  };
}

/**
 * 极简 Standard Schema (~/standard) 实现：零依赖，避免插件解析 zod 的路径问题。
 * 只做「透传 + 填默认值 + 类型宽校验」，验错抛 issues。
 */
export const Config = s.object({
  enabled: s.boolean().default(DEFAULT_CONFIG.enabled).description('启用故障转移').volatile(),
  // queue 不在这里：它存在 $DSH_HOME/fallback-queue-state.json，
  // 因为写 settings 会触发宿主主题全量重算（见 state.js 顶部注释）。
  p1Follow: s.boolean().default(DEFAULT_CONFIG.p1Follow).description('P1 跟随当前会话模型').volatile(),
  immediateCodes: s.array(s.string()).default(DEFAULT_IMMEDIATE_CODES).description('命中即熔断的错误码').volatile(),
  failureThreshold: s.number().default(DEFAULT_CONFIG.failureThreshold).description('连续失败次数阈值（软熔断）').volatile(),
  cooldownMs: s.number().default(DEFAULT_CONFIG.cooldownMs).description('熔断冷却毫秒').volatile(),
  failbackMode: s.union(['sticky', 'probe', 'manual']).default(DEFAULT_CONFIG.failbackMode).description('P1 恢复策略').volatile(),
  failbackDelayMs: s.number().default(DEFAULT_CONFIG.failbackDelayMs).description('探测回切防抖毫秒').volatile(),
});
