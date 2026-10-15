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
      const idx = queue.findIndex((r) => r.provider === provider && r.model === model);
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

  // 导出内部状态供后续 RPC/调试（暂不挂 Remote，先跑通本地）
  return {
    router,
    saveSettings,
    loadSettings,
  };
}

export const Config = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: false, description: '启用故障转移' },
    queue: {
      type: 'array',
      default: [],
      description: '故障转移队列，索引 0 为 P1',
      items: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          model: { type: 'string' },
          manual: { type: 'boolean', default: false, description: 'P1 手动锁定' },
        },
        required: ['provider', 'model'],
      },
    },
    p1Follow: { type: 'boolean', default: true, description: 'P1 跟随当前模型' },
    immediateCodes: { type: 'array', default: DEFAULT_IMMEDIATE_CODES, items: { type: 'string' } },
    failureThreshold: { type: 'number', default: 2 },
    cooldownMs: { type: 'number', default: 60_000 },
    failbackMode: { type: 'string', enum: ['sticky', 'probe', 'manual'], default: 'sticky' },
    failbackDelayMs: { type: 'number', default: 300_000 },
  },
};
