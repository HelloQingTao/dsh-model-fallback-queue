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

const DEFAULT_IMMEDIATE_CODES = [
  'QUOTA',
  'ACCOUNT_QUOTA',
  'RATE_LIMIT',
  'AUTH',
  'INVALID_CREDENTIAL',
  'NO_ADAPTER',
];

const DEFAULT_CONFIG = {
  enabled: false,
  queue: [], // [{ provider, model, manual? }]，索引 0 = P1
  p1Follow: true, // P1 跟随当前模型（用户在 UI 手动换模型时 P1 自动跟随）
  immediateCodes: DEFAULT_IMMEDIATE_CODES,
  failureThreshold: 2,
  cooldownMs: 60_000,
  failbackMode: 'sticky', // 'sticky' | 'probe' | 'manual'
  failbackDelayMs: 5 * 60_000, // probe 模式防抖
};

const CIRCUIT = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

function createRouter(config, log) {
  // 每个路由 key 的熔断状态，纯内存
  const circuits = new Map(); // key -> { state, failures, openedAt, lastAttemptAt }
  // 运行态
  const runtime = {
    activeIndex: 0, // 当前生效的队列索引
    lastSwitch: null, // { from, to, code, at }
    probeInFlight: false,
  };

  const keyOf = (route) => `${route.provider}\u0000${route.model}`;

  function circuitOf(key) {
    let c = circuits.get(key);
    if (!c) {
      c = { state: CIRCUIT.CLOSED, failures: 0, openedAt: 0, lastAttemptAt: 0 };
      circuits.set(key, c);
    }
    return c;
  }

  function isAvailable(route, now = Date.now()) {
    const c = circuitOf(keyOf(route));
    if (c.state === CIRCUIT.CLOSED || c.state === CIRCUIT.HALF_OPEN) return true;
    // OPEN 且冷却到期 → 进入半开，允许一次探测
    if (now - c.openedAt >= config.cooldownMs) {
      c.state = CIRCUIT.HALF_OPEN;
      return true;
    }
    return false;
  }

  function recordFailure(route, code) {
    const c = circuitOf(keyOf(route));
    c.failures += 1;
    const immediate = config.immediateCodes.includes(code);
    if (immediate || c.failures >= config.failureThreshold) {
      c.state = CIRCUIT.OPEN;
      c.openedAt = Date.now();
      c.failures = 0;
    }
  }

  function recordSuccess(route) {
    const c = circuitOf(keyOf(route));
    c.state = CIRCUIT.CLOSED;
    c.failures = 0;
  }

  /** 邻近可用：从 fromIndex 起找第一个可用路由；粘滞模式绕回 P1 仅当其余全不可用 */
  function pickFrom(startIndex, { allowP1 }) {
    const queue = config.queue || [];
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
    pickFrom,
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
      }
      return chosen;
    },
    /** 失败后决定是否要求重试（切换路由） */
    onFailedAttempt(provider, model, code) {
      const queue = config.queue || [];
      if (!config.enabled || queue.length === 0) return false;
      let idx = queue.findIndex((r) => r.provider === provider && r.model === model);
      // P1 动态跟随：失败路由=当前会话模型且不等于队列静态 P1 时，把失败记到 P1（idx 0）
      if (idx === -1 && config.p1Follow) idx = 0;
      if (idx === -1) return false; // 不是队列里的路由，不接管
      recordFailure(queue[idx], code);
      const nextIdx = this.resolveIndex();
      if (nextIdx === -1 || nextIdx === idx) return false; // 全熔断或仍在原路由：不重试
      runtime.lastSwitch.code = code;
      return true;
    },
    snapshot() {
      const queue = config.queue || [];
      return {
        enabled: config.enabled,
        p1Follow: config.p1Follow,
        activeIndex: runtime.activeIndex,
        lastSwitch: runtime.lastSwitch,
        entries: queue.map((r, i) => {
          const c = circuitOf(keyOf(r));
          return {
            index: i,
            provider: r.provider,
            model: r.model,
            state: c.state,
            failures: c.failures,
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
let serviceBridge = null; // { router, config, saveSettings } 由 apply 设置

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
    this.router.runtime.lastSwitch = { from, to: i, code: 'MANUAL', at: Date.now() };
    return { ok: true };
  }
}
markRemoteMethods(FallbackQueueService.prototype, ['snapshot', 'probe', 'manualFailback']);

export const inject = ['settings'];

export function apply(ctx) {
  const config = { ...DEFAULT_CONFIG };

  // ---- 设置持久化：namespace = 插件行 id ----
  const NS = 'dsh-model-fallback-queue';
  let settingsView = null;

  async function loadSettings() {
    try {
      const desc = ctx.settings.describe().find((d) => d.ns === NS);
      if (desc) {
        settingsView = desc;
        Object.assign(config, desc.value || {});
      }
    } catch (e) {
      ctx.logger?.warn?.('[fallback-queue] settings read failed, using defaults: %s', e?.message);
    }
  }

  async function saveSettings(patch) {
    try {
      Object.assign(config, patch);
      await ctx.settings.update(NS, patch, settingsView?.revision);
      const desc = ctx.settings.describe().find((d) => d.ns === NS);
      if (desc) settingsView = desc;
    } catch (e) {
      ctx.logger?.warn?.('[fallback-queue] settings write failed: %s', e?.message);
    }
  }

  const router = createRouter(config, ctx.logger);

  // 供 Client（经 remote RPC 或事件）读取运行态快照
  ctx.effect(() => {
    // settings/document-updated 时刷新本地 config
    return ctx.on('settings/document-updated', (ns) => {
      if (ns !== NS) return;
      loadSettings();
    });
  });

  // ---- agent/request：覆盖冻结调用配置 ----
  ctx.effect(() =>
    ctx.on('agent/request', async (payload, next) => {
      try {
        const cfg = await next();
        const idx = router.resolveIndex();
        if (idx === -1) return cfg;
        // P1（idx 0）动态跟随当前会话模型：不覆盖，放行原配置
        if (idx === 0 && config.p1Follow) return cfg;
        const route = config.queue[idx];
        if (!route) return cfg;
        return { ...cfg, provider: route.provider, model: route.model };
      } catch (e) {
        ctx.logger?.warn?.('[fallback-queue] agent/request error, passing through: %s', e?.message);
        return next();
      }
    }),
  );

  // ---- agent/request-error：熔断判定 + 请求重试 ----
  ctx.effect(() =>
    ctx.on('agent/request-error', { prepend: true }, async (payload, next) => {
      const { provider, failure } = payload;
      const model = payload.agent?.callConfig?.model;
      try {
        const switched = router.onFailedAttempt(provider, model, failure?.code);
        if (switched) return { kind: 'retry' };
      } catch (e) {
        ctx.logger?.warn?.('[fallback-queue] request-error handling failed: %s', e?.message);
      }
      // 非致命 / 未接管：让路给 dsh-llm-retry 等
      return next();
    }),
  );

  // ---- agent/assistant-stream：成功即复位熔断 ----
  ctx.effect(() =>
    ctx.on('agent/assistant-stream', (payload) => {
      try {
        const { frame } = payload;
        if (frame?.type !== 'end') return;
        // end frame 意味着本次尝试至少走通了流；复位当前路由
        const queue = config.queue || [];
        const cur = queue[router.runtime.activeIndex];
        if (cur) router.recordSuccess(cur);
      } catch {
        /* 忽略 */
      }
    }),
  );

  // ---- 启动加载设置 ----
  ctx.effect(() => {
    loadSettings();
  });

  // ---- 运行态 RPC 服务 ----
  serviceBridge = { router, config, saveSettings };
  ctx.effect(() => ctx.plugin(FallbackQueueService), 'fallback-queue rpc service');
  ctx.effect(() => () => {
    serviceBridge = null;
  }, 'fallback-queue bridge cleanup');

  return {
    router,
    saveSettings,
    loadSettings,
  };
}

/**
 * 极简 Standard Schema (~/standard) 实现：零依赖，避免插件解析 zod 的路径问题。
 * 只做「透传 + 填默认值 + 类型宽校验」，验错抛 issues。
 */
export const Config = s.object({
  enabled: s.boolean().default(DEFAULT_CONFIG.enabled).description('启用故障转移').volatile(),
  queue: s.array(
    s.object({
      provider: s.string().required().description('provider id'),
      model: s.string().required().description('model id'),
    }).required(),
  ).default([]).description('故障转移队列 P1→Pn').volatile(),
  p1Follow: s.boolean().default(DEFAULT_CONFIG.p1Follow).description('P1 跟随当前会话模型').volatile(),
  immediateCodes: s.array(s.string()).default(DEFAULT_IMMEDIATE_CODES).description('命中即熔断的错误码').volatile(),
  failureThreshold: s.number().default(DEFAULT_CONFIG.failureThreshold).description('连续失败次数阈值（软熔断）').volatile(),
  cooldownMs: s.number().default(DEFAULT_CONFIG.cooldownMs).description('熔断冷却毫秒').volatile(),
  failbackMode: s.union(['sticky', 'probe', 'manual']).default(DEFAULT_CONFIG.failbackMode).description('P1 恢复策略').volatile(),
  failbackDelayMs: s.number().default(DEFAULT_CONFIG.failbackDelayMs).description('探测回切防抖毫秒').volatile(),
});
