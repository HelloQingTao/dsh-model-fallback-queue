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
  // PI_AI_ERROR / UNKNOWN 刻意不在这里：它们是适配层的"分类失败"兜底（dsh-llm-pi-ai
  // 的 classifyPiAiError 兜底是 PI_AI_ERROR，dsh-agent-loop 的失败兜底是 UNKNOWN），
  // 本身不携带"是谁的问题"的信息。把它们当即时码 = 任何不认识的失败都换一次路由，
  // 会把 Runtime 自伤（TypeError、`is not a function`）和请求侧问题误判成 provider 故障。
  // 现在改由 classifyFailureSource() 按来源分层判定。
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
  // 周期全员 ping 间隔（ms）；0 = 关闭。
  // 默认 0（关闭）：周期探测会向模型发**真实请求**，哪怕是 maxTokens 很小的微型请求，
  // 也可能消耗配额/费用。默认打开等于替用户做花钱的决定，所以只在用户显式开启后
  // 才轮询；需要前瞻性健康视图的用户到设置页把间隔调成 60000 即可。
  pingIntervalMs: 0,
  // 周期扫描是否跳过付费条目。默认 true（跳过）：付费模型的探测请求照样计费，
  // 周期轮询每一轮都要付钱；用户想要"付费也一起探"可以在这里关掉跳过。
  pingSkipPaid: true,
  // 探测请求的 maxTokens。历史默认 1（"省到极致"），但这不是更省，而是更容易测不成：
  // 一部分网关/推理模型会对 1-token 请求直接 400（"max_tokens must be >= N"、
  // "reasoning budget exceeds max_tokens"），于是一条**完全能正常对话**的模型在面板上
  // 长期挂着"探测不支持/探测失败"——探测体的形状问题冒充满模型的问题。
  // 默认 8：多花 7 个 token（约 ¥0.00001/次），换探测真正能成立。
  pingMaxTokens: 8,
  // 「探测全部」的并发数。旧实现一条条串行 ping，每条约 1–15s，队列一长（6 条）
  // 就要等十几秒甚至更久——用户实测「太慢了」。这些探测彼此独立、都是极短请求，
  // 完全可以限并发并跑：墙钟时间约等于「最慢的一条」而不是「全部之和」。
  // 默认 4：既明显变快，又不会一次性把网关打爆（付费/限流网关对突发敏感）。
  probeConcurrency: 4,
  // 「探测完成」逐条状态在快照里保留多久（毫秒），到点自动清空/淡出。
  probeStatusTtlMs: 4000,
  // 跨路由（换 provider/model）时，历史 assistant 消息里的 thinking 无法带到新模型：
  // 宿主的适配层按 source.provider 决定是否保留 replayState，跨适配器时 reasoning
  // 会被丢掉。而有的 API 要求「text + tool_use」的 assistant 消息必须带 thinking 块，
  // 否则 400（DeepSeek Anthropic 兼容端点原文：「The `content[].thinking` in the
  // thinking mode must be passed back to the API.」）。
  //
  // 对这里列出的 provider，下发给它之前把这类消息的 text 块摘掉：assistant 只带
  // tool_use（不带 text、不带 thinking）是该 API 接受的形状，工具调用/参数/结果不动，
  // 只损失模型写在工具调用旁边的解说文字——跨适配器降级时最小的损失。
  // deepseek-account 与 deepseek-official 共用 @deepseek-ai/dsh-llm-deepseek 适配器：
  // 同一套 serialize / replayState（kind 都是 deepseek-messages），严格 thinking 的
  // 约束对它一样成立，默认名单里不能只写一个。
  strictThinkingProviders: ['deepseek-official', 'deepseek-account'],
  // provider → 该 provider 原生 replayState.response.kind。历史消息的 thinking 只有
  // 在 kind 与目标 provider 原生 kind 一致时才能真正被重放；对不上（比如 z.ai 的
  // pi-ai 历史送到 DeepSeek）就按“跨适配器历史”处理。未列出的 provider 视为不可确认。
  // 形如 'provider=replayKind'；数组而不是 dict，是为了兼容宿主/测试里的极简 schema。
  nativeReplayKinds: [
    'deepseek-official=deepseek-messages',
    'deepseek-account=deepseek-messages',
  ],
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

/**
 * 能力不匹配码：请求的形状（典型是推理档位）目标模型不认。
 *
 * 与「调用侧自伤」的区别必须分开处理：这类失败**不代表路由坏了**——模型本身
 * 好好的，只是它不吃上一台模型设置的档位，所以不能熔断；但换一条路由确实能
 * 救回来，这正是本插件存在的意义，因此它必须允许切换（见 onFailedAttempt）。
 *
 * 宿主的 LlmService 在发请求前做能力校验、0 毫秒本地拒绝：
 *   throw new LlmError(`provider "..." model "..." does not support reasoning effort "balanced"`,
 *                      "UNSUPPORTED_REASONING_EFFORT")
 * 请求根本没出去——所以它既不是网络问题，也不是额度问题。
 */
const CAPABILITY_CODES = new Set(['UNSUPPORTED_REASONING_EFFORT', 'INVALID_MODEL_REASONING']);

/** 适配层把能力不匹配降级成兜底码（PI_AI_ERROR/UNKNOWN）时，靠报文认出来 */
const UNSUPPORTED_EFFORT_TEXT = /does not support reasoning effort|reasoning effort .*not supported/i;

/** 失败来源分类（见 classifyFailureSource） */
const FAILURE_SOURCE = {
  PROVIDER: 'provider',
  TRANSPORT: 'transport',
  UNKNOWN: 'unknown',
  CALLER: 'caller',
  CAPABILITY: 'capability',
};

/** 适配层的"分类失败"兜底码：本身不携带"是谁的问题"的信息 */
const FALLBACK_CODES = new Set(['PI_AI_ERROR', 'UNKNOWN']);

/** 传输层码：链路瞬时故障，重试常能自愈 */
const TRANSPORT_CODES = new Set(['TIMEOUT', 'TRANSPORT', 'SERVER', 'EMPTY_RESPONSE']);

/** 调用侧自伤特征：这些文本只能出自 Runtime 内部（插件/宿主 bug），不会是 provider 文案 */
const SELF_FAULT_TEXT = /is not a function|cannot read propert|is not a constructor|undefined is not an object|TypeError|ReferenceError/i;

/** HTTP 状态码里明确指向"密钥/额度/模型不可用"的：上游自己承认问题源 */
const PROVIDER_STATUS = new Set([401, 402, 403, 404, 429]);

/** 请求体类状态码：换模型救不了，属调用侧 */
const CALLER_STATUS = new Set([400, 413, 415, 422]);

/** provider 侧的配额类措辞：适配层没认出错误码时靠它补判 */
const QUOTA_TEXT = /quota|额度|限额|余额|insufficient|exceeded (?:your )?(?:current )?quota|usage limit|billing/i;

/**
 * 文本层配额判定。适配层认不出的文本会落成 PI_AI_ERROR / UNKNOWN，错误码分类就失效了；
 * 这时只要报文里有配额/超限措辞，仍按即时熔断处理。
 */
function looksLikeQuota(message) {
  return typeof message === 'string' && QUOTA_TEXT.test(message);
}

/**
 * 失败来源分层：把"这条失败该不该算在路由头上、要多快熔断"从单一错误码里解耦。
 *
 * - provider  上游明确承认自己是问题源（配额/限流/鉴权码、配额措辞、指向性 HTTP 状态）
 *             → 立即熔断，不必等阈值。
 * - transport 网络/超时/流中断/5xx：可能是瞬时抖动 → 按 failureThreshold 累积。
 * - unknown   兜底码（PI_AI_ERROR/UNKNOWN）且拿不到任何来源证据 → 同样按阈值：
 *             既不秒切（避免把健康路由误杀），持续失败也终究会切走。
 * - caller    请求本身有问题，或 Runtime 自伤（插件/宿主 bug）→ 换模型救不了：
 *             不熔断、不切游标，只记原因让 UI 说清"为什么没切"。
 * - capability 请求形状与目标模型能力不匹配（推理档位不支持）→ 不是路由坏了，
 *             不熔断；但换一条路由能救，所以允许切换。
 *
 * @param {string} code 适配层给出的错误码
 * @param {unknown} message 上游错误原文
 * @param {number|undefined} status HTTP 状态码（LlmFailure.status / LlmError.status）
 * @param {string[]} immediateCodes 配置里的即时熔断码
 * @returns {string} FAILURE_SOURCE 之一
 */
function classifyFailureSource(code, message, status, immediateCodes) {
  // 1) 请求本身不合法（宿主已明确分类），或请求体类状态码
  if (isClientFaultCode(code)) return FAILURE_SOURCE.CALLER;
  // 1.5) 能力不匹配：必须在 CALLER_STATUS 之前判——这个错误也可能带 400，
  //      但"换模型救不了"的结论对它不成立（换一台支持该档位的模型就好了）。
  if (CAPABILITY_CODES.has(code)) return FAILURE_SOURCE.CAPABILITY;
  if (typeof status === 'number' && CALLER_STATUS.has(status)) return FAILURE_SOURCE.CALLER;
  // 2) 兜底码 + Runtime 自伤特征：这是插件/宿主的问题，不是 provider 的
  if (FALLBACK_CODES.has(code) && SELF_FAULT_TEXT.test(typeof message === 'string' ? message : '')) {
    return FAILURE_SOURCE.CALLER;
  }
  // 2.5) 适配层丢掉了错误码、只把报文透传上来时，靠措辞认出同一件事
  if (FALLBACK_CODES.has(code) && UNSUPPORTED_EFFORT_TEXT.test(typeof message === 'string' ? message : '')) {
    return FAILURE_SOURCE.CAPABILITY;
  }
  // 3) 上游明确的问题源。刻意用 !FALLBACK_CODES.has(code) 挡一道：历史配置里若还留着
  //    PI_AI_ERROR/UNKNOWN，分层判定优先于旧配置，不会被拉回无条件熔断。
  if (!FALLBACK_CODES.has(code) && Array.isArray(immediateCodes) && immediateCodes.includes(code)) {
    return FAILURE_SOURCE.PROVIDER;
  }
  if (looksLikeQuota(message)) return FAILURE_SOURCE.PROVIDER;
  if (typeof status === 'number' && PROVIDER_STATUS.has(status)) return FAILURE_SOURCE.PROVIDER;
  // 4) 链路瞬时故障
  if (TRANSPORT_CODES.has(code)) return FAILURE_SOURCE.TRANSPORT;
  // 5) 不认识、也没证据
  return FAILURE_SOURCE.UNKNOWN;
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

/**
 * 从上游报错原文里解析「什么时候恢复出网」。
 *
 * 现实里上游写恢复时刻有三种方式，都必须认：
 *  - ISO 8601（本机 magpie 的 bili 闸门）：
 *      `bili is holding outbound sends until 2026-11-08T06:15:51.683Z`
 *  - 本地时间（channel-pack）：
 *      `最近一个将于 2026/10/30 00:00:00 解锁`
 *  - 只有相对时长（bili 的报文里也带一份）：
 *      `(~180s, exponential backoff)`
 *
 * 为什么值得解析：宿主 dsh-llm-retry 的规则是「providerRetryAfterMs > maxDelayMs
 * 就放弃这次重试」。把闸门的到期时刻换算成 providerRetryAfterMs，一次用户消息
 * 就能从「链长 × 6 次 429」降到「链长 × 1 次」，不需要改宿主。
 *
 * @param {unknown} message 上游错误原文
 * @returns {number} epoch ms；解析不出返回 0（绝不猜一个时长）
 */
function parseResetAt(message) {
  const text = typeof message === 'string' ? message : '';
  if (!text) return 0;
  // 1) ISO 8601：带时区，交给 Date.parse，不受本机时区影响
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/.exec(text);
  if (iso) {
    const ms = Date.parse(iso[1]);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  // 2) 本地时间：按月/日/时:分（秒可省）构造，与用户看到的钟点一致
  const local = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (local) {
    const ms = new Date(+local[1], +local[2] - 1, +local[3], +local[4], +local[5], +(local[6] || 0)).getTime();
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  // 3) 只有相对时长：必须同时带上「在等什么」的措辞才认。
  //    否则 "upstream timeout after 15s" 这种普通超时文案会被误读成
  //    「15 秒后恢复」，UI 上凭空多出一个倒计时。
  if (/hold|backoff|retry|resume|wait|恢复|重试|等待/i.test(text)) {
    const rel = /(?:~|about\s+|in\s+)?(\d{1,5})\s*(?:s|secs?|seconds?)\b/i.exec(text);
    if (rel) {
      const secs = Number(rel[1]);
      if (Number.isFinite(secs) && secs > 0) return Date.now() + secs * 1000;
    }
  }
  return 0;
}

/** 归一化配置里的 provider 列表（容错：非数组/空串直接忽略）。 */
function providerList(value) {
  return Array.isArray(value) ? value.filter((x) => typeof x === 'string' && x.length > 0) : [];
}

/** 读取 provider → 原生 replayState.response.kind 映射。 */
function nativeReplayKindMap(config) {
  const map = new Map();
  const declared = config ? config.nativeReplayKinds : undefined;
  const entries = Array.isArray(declared)
    ? declared
        .filter((entry) => typeof entry === 'string')
        .map((entry) => {
          const at = entry.indexOf('=');
          return at < 0 ? [entry, ''] : [entry.slice(0, at).trim(), entry.slice(at + 1).trim()];
        })
    : declared && typeof declared === 'object'
      ? Object.entries(declared)
      : [];
  for (const [provider, kind] of entries) {
    if (typeof provider === 'string' && provider.length > 0 && typeof kind === 'string' && kind.length > 0) {
      map.set(provider, kind);
    }
  }
  return map;
}

/** 这条 assistant 消息的 thinking 能否被目标路由原生重放。 */
function messageReplayIsNative(message, route, kinds) {
  const source = message && message.source;
  if (!source || typeof source !== 'object') return false;
  if (source.provider !== route.provider || source.model !== route.model) return false;
  const expected = kinds.get(route.provider);
  if (expected === undefined) return false; // 原生 kind 未声明 = 无法确认可重放
  const kind = source.replayState && source.replayState.response && source.replayState.response.kind;
  return kind === expected;
}

/**
 * 历史适配：目标路由无法重放旧 thinking 时，摘掉「text + tool_use」assistant 消息的 text。
 *
 * 只对 config.strictThinkingProviders 里列出的 provider 生效；路由不变或历史本来就是
 * 该路由原生生成的（replay kind 对得上）时原样返回，不动用户的历史。
 *
 * @param {Array<object>} messages 宿主请求里的 harness 消息数组（可能被冻结）
 * @param {{provider: string, model: string}} route 目标路由
 * @param {object} config 插件配置（strictThinkingProviders / nativeReplayKinds）
 * @param {{onAdapted?: (count: number) => void}} hooks 适配计数回调（日志用）
 * @returns {Array<object>|Array} 原数组（无需改动）或改写后的新数组
 */
function adaptMessagesForRoute(messages, route, config = {}, hooks = {}) {
  if (!Array.isArray(messages)) return messages;
  const strict = new Set(providerList(config.strictThinkingProviders));
  if (!strict.has(route.provider)) return messages;
  const kinds = nativeReplayKindMap(config);
  let adapted = 0;
  const out = messages.map((message) => {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return message;
    const blocks = message.content;
    const hasToolCall = blocks.some((block) => block && block.type === 'tool-call');
    if (!hasToolCall) return message;
    const hasText = blocks.some((block) => block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0);
    if (!hasText) return message;
    if (messageReplayIsNative(message, route, kinds)) return message;
    adapted += 1;
    const content = Object.freeze(blocks.filter((block) => !(block && block.type === 'text')));
    return Object.freeze({ ...message, content });
  });
  if (adapted === 0) return messages;
  hooks.onAdapted?.(adapted);
  return Object.freeze(out);
}

/**
 * 队列里一条路由对应的子请求参数：换路由 + 剥掉上一台适配器物化的控制字段 + 历史适配。
 *
 * 不换路由时原样返回（只换 provider/model 是恒等变换），保持单路由请求的既有行为。
 *
 * @param {object} options 宿主 llm.stream 的原始请求（provider/model 为 P1）
 * @param {{provider: string, model: string}} route 实际要试的路由
 * @param {object} config 插件配置
 * @param {{onAdapted?: (count: number) => void}} hooks 历史适配计数回调
 * @returns {object} 可直接下发给宿主 llm.stream 的请求
 */
function routeCallOptions(options, route, config = {}, hooks = {}) {
  const routeChanged = options.provider !== route.provider || options.model !== route.model;
  const next = { ...options, provider: route.provider, model: route.model };
  if (!routeChanged) return next;
  delete next.reasoningEffort;
  delete next.maxTokens;
  const adapted = adaptMessagesForRoute(options.messages, route, config, hooks);
  if (adapted !== options.messages) next.messages = adapted;
  return next;
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
  let sessionModel = null; // { provider, model } | null（全局最近一次；按会话的见下）
  // 按会话记「用户手选的会话模型」：P1 行的名字、「会话模型」归属判定都按会话取。
  // 只存纯数据，snapshot 直接 JSON 序列化下发，客户端据此显示 P1 行。
  const sessionModelBySession = new Map(); // sessionId -> { provider, model }
  /** 记录某会话的会话模型（用户手选 / P1 真实放行采样） */
  function noteSessionModel(sessionId, provider, model) {
    if (!provider || !model) return;
    if (typeof sessionId === 'string' && sessionId) {
      const prev = sessionModelBySession.get(sessionId);
      if (!prev || prev.provider !== provider || prev.model !== model) {
        sessionModelBySession.set(sessionId, { provider, model });
      }
    }
    if (!sessionModel || sessionModel.provider !== provider || sessionModel.model !== model) {
      sessionModel = { provider, model };
    }
  }
  /** 取某会话的会话模型（无会话上下文/未记录 → 全局快照） */
  function sessionModelFor(sessionId) {
    if (typeof sessionId === 'string' && sessionId) {
      const v = sessionModelBySession.get(sessionId);
      if (v) return v;
    }
    return sessionModel;
  }
  /**
   * P1 槽的位置：
   * - p1Follow（P1 跟随当前会话模型）：-1 —— P1 不在 config.queue 里，队列索引 i 显示为 P(i+2)
   * - 静态模式：0 —— P1 就是 config.queue[0]
   * 这个区分是「P1 失败却把 P2 熔断掉」「切到后备后原地重试」两个老 bug 的根：
   * 旧实现 p1Follow 也用 0 表示 P1，而 0 同时是队列第一条（UI 的 P2），一个下标两种身份。
   */
  const p1Position = () => (config.p1Follow ? -1 : 0);
  // 运行态
  const runtime = {
    activeIndex: config.p1Follow ? -1 : 0, // 当前生效位置（p1Follow 下 -1 = P1 会话模型）
    // 全局手动切换目标（manualFailback 写入，null = 没有手动意图）。
    // 手动切换是明确的全局意图，必须压过"未记录会话回落到 P1"的默认规则，
    // 否则切换只改显示不改路由：resolveIndex 会照样返回 P1。
    manualIndex: null,
    inFlightIndex: -1, // 最近一次实际发出去的请求所走的路由；-1 = 未覆盖（放行原配置）
    lastProposal: null, // { key, idx, overridden } 最近一次 agent/request 的提案
    lastSwitch: null, // { from, to, code, at }
    revision: 0, // 状态版本号，客户端据此判断是否需要重新拉 snapshot
    probeInFlight: false,
    // 全员探测的「逐条状态」：{ [provider\0model]: { state:'probing'|'done', ok } }。
    // 让前端在每条路由旁显示「探测中 → 探测完成」，而不是只有干巴巴一个总进度。
    // 探测结束后保留 PROBE_STATUS_TTL_MS（4s）再自动清空（前端据此让它淡出）。
    probeStatus: null,
    probeStatusUntil: null, // epoch ms；到点后 snapshot 惰性清空 probeStatus
    // 全员探测进度：{ done, total } | null。
    // 旧实现只有 probingAll 布尔，前端文案「探测中… 0/N」里的 N 永远传 0 ——
    // 宣称的 n/N 进度从未实现。现在由 probeAllRoutes 每探完一条就更新，
    // snapshot 原样透出，前端才能显示真实的「3/7」。
    probeProgress: null,
    // 手动切换后等待「下一条真实请求」确认：{ index, at }。
    // 切换只决定"下一个请求用哪条"，本身不产生任何可用性证据——旧实现切换后立刻
    // 发一条探测，拿不到会话模型就写 NO_SESSION_MODEL 的红色失败，于是「P1 验证失败」
    // 和「P1 正常」同屏出现。现在不探测、不下结论，只记一个等待位。
    pendingConfirm: null,
    // 真实请求证据：{ index, provider, model, at, state:'sent'|'ok'|'fail', code, settledAt }。
    // 「切换到底生效没有」唯一的可信答案：不是游标、不是探测，是宿主真的把请求发过去了。
    lastRequest: null,
    // 旧的探测验证回执：恒为 null，仅保留字段名给老客户端读。
    lastVerify: null,
    // 宿主的"实际使用"回执：{ index, provider, model, at }。
    // 来源是宿主把我们的覆盖投影回 session/event model/selection —— 这是唯一
    // 不依赖我们自己记账的确认信号。有它才能说"这次真的走的是 P3"。
    hostConfirmed: null,
  };
  // ---- 会话隔离的实际路由（inFlight）----
  // inFlightIndex 与游标同理是会话体验：会话1在 P3、会话2在 P2 时，全局单值会让
  // 两者互相覆盖，UI 的"当前"标记和外面的芯片显示都会指错对象。按 sessionId 记。
  const sessionInFlight = new Map(); // sessionId -> index
  function setInFlight(sessionId, idx) {
    if (typeof sessionId !== 'string' || !sessionId) {
      runtime.inFlightIndex = idx; // 无会话上下文 → 全局回退（探测/旧调用）
      return;
    }
    sessionInFlight.set(sessionId, idx);
    runtime.inFlightIndex = idx; // 全局值跟最近一次请求走（UI 主显示，多数场景只有一个活动会话）
  }
  function inFlightFor(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return runtime.inFlightIndex;
    const v = sessionInFlight.get(sessionId);
    return v !== undefined ? v : runtime.inFlightIndex;
  }
  // ---- 会话隔离的切换游标 ----
  // 熔断状态（circuits）和配置判死（health）按 provider/model 记账，天然跨会话共享
  // ——同一个模型在哪都坏，这合理。但"切到第几级"是会话体验：会话1熔断切到 P2，
  // 不该把会话2（还没请求过）也拖到 P2。游标按 sessionId 记，activeIndex 只作
  // 无会话上下文时的回退（旧调用/探测/手动回切）。
  const sessionCursor = new Map(); // sessionId -> index
  function cursorFor(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return runtime; // 无会话上下文 → 全局回退
    const cur = sessionCursor.get(sessionId);
    // 未记录的会话：有全局手动切换意图时跟随它（manualFailback 已清空所有会话游标，
    // 此时"没有记录"是手动切换的结果，不是新会话）；否则从 P1 槽起步——新会话不该
    // 继承别的会话因熔断产生的切换进度。
    // 全局 activeIndex 只反映"曾经有会话切过多深"，供探测/预检选起点，不污染新会话。
    const manual = manualFor(sessionId);
    if (cur === undefined) return {
      activeIndex: Number.isInteger(manual) ? manual : p1Position(),
    };
    return { activeIndex: cur }; // 只读视图，写经 setCursor
  }
  function setCursor(sessionId, idx) {
    if (typeof sessionId !== 'string' || !sessionId) {
      runtime.activeIndex = idx;
      return;
    }
    sessionCursor.set(sessionId, idx);
    // 全局游标记录历史最深切换（探测/预检等无会话路径用它选起点）
    if (idx > runtime.activeIndex) runtime.activeIndex = idx;
  }
  // ---- 会话隔离的手动目标 / 等待位 / 最近切换 / 最近真实请求 ----
  // 旧实现里 manualFailback 写全局 runtime.manualIndex 并 resetSessionCursors() 清空
  // **所有**会话游标——一个会话手动切换会把其它会话一起拖走。现在这些全部按 sessionId
  // 记账；runtime 上的同名字段只保留为"最近一次"的全局镜像，供无会话上下文的旧读取
  // 路径回退（探测/老客户端）。真正的会话隔离靠下面四张 Map。
  const sessionManual = new Map();         // sessionId -> index（手动切换目标，null=无）
  const sessionPendingConfirm = new Map(); // sessionId -> {index, at}
  const sessionLastSwitch = new Map();     // sessionId -> {from,to,code,at}
  const sessionLastRequest = new Map();    // sessionId -> {index,provider,model,at,state,code,settledAt}
  function manualFor(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return runtime.manualIndex;
    const v = sessionManual.get(sessionId);
    return v === undefined ? null : v;
  }
  function setManual(sessionId, idx) {
    if (typeof sessionId !== 'string' || !sessionId) { runtime.manualIndex = idx; return; }
    if (idx === null || idx === undefined) sessionManual.delete(sessionId);
    else sessionManual.set(sessionId, idx);
    runtime.manualIndex = idx; // 全局镜像（旧读取路径）
  }
  function pendingConfirmFor(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return runtime.pendingConfirm;
    return sessionPendingConfirm.get(sessionId) || null;
  }
  function setPendingConfirm(sessionId, val) {
    if (typeof sessionId !== 'string' || !sessionId) { runtime.pendingConfirm = val; return; }
    if (val) sessionPendingConfirm.set(sessionId, val); else sessionPendingConfirm.delete(sessionId);
    runtime.pendingConfirm = val; // 镜像
  }
  function lastSwitchFor(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return runtime.lastSwitch;
    return sessionLastSwitch.get(sessionId) || null;
  }
  function setLastSwitch(sessionId, val) {
    if (typeof sessionId !== 'string' || !sessionId) { runtime.lastSwitch = val; return; }
    if (val) sessionLastSwitch.set(sessionId, val); else sessionLastSwitch.delete(sessionId);
    runtime.lastSwitch = val; // 镜像
  }
  function lastRequestFor(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return runtime.lastRequest;
    return sessionLastRequest.get(sessionId) || null;
  }
  function setLastRequest(sessionId, val) {
    if (typeof sessionId !== 'string' || !sessionId) { runtime.lastRequest = val; return; }
    if (val) sessionLastRequest.set(sessionId, val); else sessionLastRequest.delete(sessionId);
    runtime.lastRequest = val; // 镜像
  }

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
        lastCode: null, lastMessage: '', retryAfterMs: 0, lastSource: null,
        // 健康证据（前瞻性）：最近一次"真的能回话"的时刻与探测耗时。
        // lastOkAt 同时被真实请求成功与探测成功刷新；lastProbeAt/probeLatencyMs/probeOk
        // 只由主动探测写入。UI 靠它们区分「刚测过·820ms」「很久没测过」「上次探测失败」，
        // 而不是只凭熔断状态猜——熔断是事后记账，本身没有预测能力。
        lastOkAt: 0, lastProbeAt: 0, probeLatencyMs: 0, probeOk: null,
        // 探测失败时上游给出的「解锁时刻」（ms）：不限流/无明确时刻时为 0。
        probeResetAt: 0,
        // 探测自己的失败原因：探测不再写熔断器，所以原因要单独留一份给 UI 的悬浮提示
        lastProbeCode: null, lastProbeMessage: '',
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
      c.halfOpenAt = now;
      touch();
      return true;
    }
    return false;
  }

  /** 半开超时（毫秒）：超过仍无请求路过落账，就主动探测一次。0 = 关闭主动探测 */
  const PROBE_TIMEOUT_MS = 90_000;
  /** 找出所有"卡在半开且超时"的熔断器（供主动探测扫描） */
  function staleHalfOpen(now = Date.now()) {
    const queue = config.queue || [];
    if (PROBE_TIMEOUT_MS <= 0) return [];
    const out = [];
    for (const [i, r] of queue.entries()) {
      const c = circuitOf(keyOf(r));
      if (c.state === CIRCUIT.HALF_OPEN && now - (c.halfOpenAt || 0) >= PROBE_TIMEOUT_MS) {
        out.push({ index: i, route: r });
      }
    }
    return out;
  }

  /** 记下最近一次失败的原因：UI 悬浮提示直接展示它们。每次都覆盖，最后一次失败才是当前病根。 */
  function stampFailure(c, code, message, retryAfterMs, source) {
    c.lastCode = typeof code === 'string' && code ? code : 'UNKNOWN';
    c.lastMessage = normalizeReason(message);
    c.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
    c.lastSource = source;
  }

  /**
   * 记一次失败并判定是否熔断。分层规则见 classifyFailureSource：
   * provider 立即熔断；transport/unknown 按 failureThreshold 累积；
   * caller 不计失败；capability 同样不计失败（模型没坏，只是不吃这个请求形状）。
   * @returns {string} 本次失败的来源分类（调用方可据此决定要不要切路由）
   */
  function recordFailure(route, code, message, retryAfterMs, status) {
    const c = circuitOf(keyOf(route));
    c.lastAttemptAt = Date.now();
    const source = classifyFailureSource(code, message, status, config.immediateCodes);
    stampFailure(c, code, message, retryAfterMs, source);
    if (source === FAILURE_SOURCE.CALLER || source === FAILURE_SOURCE.CAPABILITY) {
      // 两类都不算路由的账，但把原因记进电路：UI 才能解释"为什么没切"/"为什么切了"
      touch();
      return source;
    }
    c.failures += 1;
    const immediate = source === FAILURE_SOURCE.PROVIDER;
    if (immediate || c.failures >= config.failureThreshold) {
      c.state = CIRCUIT.OPEN;
      c.openedAt = Date.now();
      c.halfOpenAt = 0;
      c.failures = 0;
    }
    touch();
    return source;
  }

  function recordSuccess(route) {
    const c = circuitOf(keyOf(route));
    c.state = CIRCUIT.CLOSED;
    c.failures = 0;
    c.halfOpenAt = 0;
    // 真实请求成功也是一条健康证据：UI 的"上次可用"要把它算进去，
    // 否则一条一直在正常服务、只是没被探测的路由会显示"未测过"。
    c.lastOkAt = Date.now();
    c.lastAttemptAt = Date.now();
    // 恢复正常后清掉旧账：否则下次熔断前若没拿到新原因，悬浮提示会展示早已过期的报错
    c.lastCode = null;
    c.lastMessage = '';
    c.retryAfterMs = 0;
    c.lastSource = null;
    touch();
  }

  /**
   * 探测成功**不等于**路由恢复——它只是"一条 1-token 的异形请求拿到了回话"。
   *
   * 为什么不能复用 recordSuccess：
   *  - 熔断的判据是**真实请求**的失败。探测请求被厂商特殊对待（不计费、
   *    不校验余额、甚至换个模型名都能过）时，它成功不代表真实请求能成。
   *    曾经这里直接调 recordSuccess，导致已熔断的路由被一次 ping 洗回 closed：
   *    熔断冷却期形同虚设、failures 被清零（阈值再也没法触发）、熔断原因被抹掉。
   *  - 探测**失败**早就不动熔断器了（见 probeOne）；成功侧再改账本是自相矛盾。
   *
   * 现在的规则：
   *  - half_open：允许推进回 closed —— 半开的定义就是"等一条成功证据"，
   *    半开扫描 timer（probeRoute）就是靠它把半开路由救活的，这条能力必须保留。
   *  - open：不动。冷却期（cooldownMs）保留，等它自然到期转半开。
   *  - closed：不清 failures。探测不是真实请求，无权重置熔断计数。
   */
  function recordProbeSuccess(route) {
    const c = circuitOf(keyOf(route));
    if (c.state === CIRCUIT.HALF_OPEN) {
      c.state = CIRCUIT.CLOSED;
      c.failures = 0;
      c.halfOpenAt = 0;
      // 半开被救活 = 恢复正常，清掉旧账（与 recordSuccess 同一口径）
      c.lastCode = null;
      c.lastMessage = '';
      c.retryAfterMs = 0;
      c.lastSource = null;
    }
    touch();
  }

  /**
   * 「探测已通过，但电路还锁着」——这是唯一能把红色变成**可操作**证据的组合：
   * 失败确实发生过（OPEN），但之后的探测又真的拿到了回话。
   *
   * 顺序很重要：探测必须发生在**这次熔断之后**（lastProbeAt > openedAt）。
   * 否则一条几个月前的成功探测会让每一次新熔断都显得"可恢复"——那是骗人的。
   */
  function isRevivable(route) {
    if (!route || !route.provider || !route.model) return false;
    const c = circuitOf(keyOf(route));
    return c.state === CIRCUIT.OPEN
      && c.probeOk === true
      && (c.lastProbeAt || 0) > (c.openedAt || 0);
  }

  /**
   * 「立即恢复」：把探测已通过、却仍锁在熔断里的路由放出来。
   *
   * 只降到 HALF_OPEN，**不是**无条件 CLOSED：探测成功不代表真实请求能成
   * （见 recordProbeSuccess 的长注释）。半开正好表达"下一条真实请求说了算"——
   * 成功就 recordSuccess 转 CLOSED，失败就重新 OPEN，熔断账本没有被提前擦掉。
   * 这也是 recordProbeSuccess 只救 HALF_OPEN 那条规则的延续：
   * 救人这件事需要**用户明确点一下**，而不是探测器自己把锁撬开。
   *
   * @param {{provider:string, model:string}} route
   * @returns {{ok:boolean, reason?:string}}
   */
  function reviveRoute(route) {
    if (!route || !route.provider || !route.model) return { ok: false, reason: 'no-route' };
    if (!isRevivable(route)) return { ok: false, reason: 'no-evidence' };
    const c = circuitOf(keyOf(route));
    c.state = CIRCUIT.HALF_OPEN;
    c.openedAt = 0;
    c.halfOpenAt = Date.now();
    c.failures = 0;
    touch();
    return { ok: true };
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

  /** P1 槽（p1Follow 下 = 会话模型，不在队列里）是否可用：看它自己的电路 */
  function p1Available(now = Date.now()) {
    if (!sessionModel) return true; // 还没采样到会话模型：不能凭空判它坏
    return isAvailable(sessionModel, now);
  }
  /** 某个位置是否可用：-1 = P1 槽，>=0 = config.queue 下标 */
  function positionAvailable(pos, now = Date.now()) {
    if (pos === -1) return p1Available(now);
    const r = (config.queue || [])[pos];
    return r ? isAvailable(r, now) : false;
  }
  /** 从 startIndex 出发的候选位置顺序（不含自身，绕一圈）。纯物理队列序（方案A，无大保底）。 */
  function nextPositions(startIndex) {
    const queue = config.queue || [];
    const n = queue.length;
    let out = [];
    if (!config.p1Follow) {
      for (let step = 1; step <= n; step += 1) out.push((startIndex + step) % n);
    } else {
      // p1Follow：环 = [P1(-1), 队列0=P2, 队列1=P3, ...]
      const ring = [-1];
      for (let i = 0; i < n; i += 1) ring.push(i);
      const at = ring.indexOf(startIndex);
      const base = at >= 0 ? at : 0;
      for (let step = 1; step <= ring.length - 1; step += 1) out.push(ring[(base + step) % ring.length]);
    }
    return out;
  }

  /**
   * 邻近可用：从 startIndex 起找第一个可用位置；粘滞模式绕回 P1 槽仅当其余全不可用。
   * @returns {number|null} 位置（-1 = P1 槽）；null = 一个可用的都没有（null 不等于 -1）
   */
  function pickFrom(startIndex, { allowP1 = true, now = Date.now() } = {}) {
    const p1Pos = p1Position();
    for (const pos of nextPositions(startIndex)) {
      if (pos === p1Pos && !allowP1) continue; // 粘滞模式跳过 P1，除非绕满一圈
      if (positionAvailable(pos, now)) return pos;
    }
    return null;
  }

  return {
    runtime,
    circuits,
    keyOf,
    isAvailable,
    isRevivable,
    reviveRoute,
    recordFailure,
    recordSuccess,
    recordProbeSuccess,
    touch,
    pickFrom,
    positionAvailable,
    p1Position,
    sessionModelFor,
    noteSessionModel,
    staleHalfOpen,
    PROBE_TIMEOUT_MS,
    sessionCursor,
    cursorFor,
    setCursor,
    /**
     * 取某条路由的电路对象（探测记账用）。
     * probeOne 住在 apply 半区，看不到 createRouter 的闭包——旧实现直接裸调
     * circuitOf()，每探测一次就抛 ReferenceError，被 pingAll 的 catch 吞成
     * {ok:false, reason:'error'}，于是「探测全部」永远失败且一条证据都写不进去。
     */
    circuitOf,
    /**
     * 记录「某会话最近一次实际发出去的路由」（-1 = 本次未覆盖，放行原配置）。
     * 必须经 router 暴露：setInFlight 是 createRouter 的闭包，apply 半区看不到它
     * —— 直接裸调用会 ReferenceError（agent/request 钩子整轮抛错，表现为
     * 每次发消息都「本轮运行失败 setInFlight is not defined」）。
     */
    setInFlight,
    /** 读某会话的实际路由（无会话上下文回退全局值） */
    inFlightFor,
    // 会话隔离的读/写助手，供 apply 半区（noteRequest / request-error / assistant-stream /
    // 面板运行时记录）使用 —— 这几处也按 sessionId 记账，不能写全局单值。
    lastRequestFor,
    setLastRequest,
    lastSwitchFor,
    setLastSwitch,
    pendingConfirmFor,
    setPendingConfirm,
    setManual,
    manualFor,
    /** 清空所有会话游标（手动回切/会话清理用）；返回清除的条数 */
    resetSessionCursors() {
      const n = sessionCursor.size;
      sessionCursor.clear();
      if (n) touch();
      return n;
    },
    /**
     * 用户手选模型之后：把该会话拨回 P1 槽（p1Follow 下 = 用户刚选的那条）。
     * 用户的换模型是明确的"我要用这条"意图，必须让它立刻生效；否则上一次熔断把
     * 游标钉在后备路由上时，换模型后下一个请求照样发往旧的后备，用户看到的现象
     * 就是"换了模型但没生效"（P1 行名字也不跟着变）。
     */
    retryFromP1(sessionId) {
      // 用户手选模型 = 明确要回 P1：清掉之前的手动切换意图，否则下次没记录的会话
      // 仍会按旧的手动目标走。会话隔离：只清本会话的手动目标，不动别的会话。
      setManual(sessionId, null);
      setCursor(sessionId, p1Position());
      setInFlight(sessionId, p1Position());
      runtime.lastProposal = null;
      touch();
    },
    /** 会话结束（session/disposed）后清掉它的游标，防 Map 无限增长 */
    dropSession(sessionId) {
      let touched = sessionCursor.delete(sessionId);
      touched = sessionInFlight.delete(sessionId) || touched;
      touched = sessionModelBySession.delete(sessionId) || touched;
      touched = sessionManual.delete(sessionId) || touched;
      touched = sessionPendingConfirm.delete(sessionId) || touched;
      touched = sessionLastSwitch.delete(sessionId) || touched;
      touched = sessionLastRequest.delete(sessionId) || touched;
      if (touched) touch();
    },
    /** 手动回切：清掉所有会话的 inFlight，回到指定索引（全局意图） */
    resetSessionInFlight(idx) {
      sessionInFlight.clear();
      runtime.inFlightIndex = idx;
      touch();
    },
    /**
     * 手动切换（会话隔离版）：只把**本会话**的游标/inFlight/手动目标拨到 i，
     * 并记本会话的等待位与最近切换。不再清空所有会话（旧全局意图的 bug）。
     * 无 sessionId 时退回全局语义（老调用/无会话上下文），保持向后兼容。
     */
    manualSwitch(sessionId, i) {
      const scoped = typeof sessionId === 'string' && sessionId;
      const from = scoped
        ? (Number.isInteger(sessionInFlight.get(sessionId)) ? sessionInFlight.get(sessionId)
          : (Number.isInteger(cursorFor(sessionId).activeIndex) ? cursorFor(sessionId).activeIndex : p1Position()))
        : (runtime.inFlightIndex >= 0 ? runtime.inFlightIndex : runtime.activeIndex);
      if (scoped) {
        setCursor(sessionId, i);
        setInFlight(sessionId, i);
        setManual(sessionId, i);
        if (from !== i) setLastSwitch(sessionId, { from, to: i, code: 'MANUAL', at: Date.now() });
        setPendingConfirm(sessionId, { index: i, at: Date.now() });
      } else {
        resetSessionCursors();
        runtime.activeIndex = i;
        runtime.manualIndex = i;
        resetSessionInFlight(i);
        if (from !== i) runtime.lastSwitch = { from, to: i, code: 'MANUAL', at: Date.now() };
        runtime.pendingConfirm = { index: i, at: Date.now() };
      }
      runtime.lastVerify = null;
      touch();
      return { ok: true, pending: { ...(scoped ? pendingConfirmFor(sessionId) : runtime.pendingConfirm) } };
    },
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
      let cur = runtime.activeIndex;
      if (cur < 0) cur = p1Position();
      if (cur >= queue.length) cur = queue.length - 1;
      // P1 槽（p1Follow 下 = 会话模型）的适配器也可能没注册：同样要当场切走
      const curDead = cur === -1
        ? Boolean(sessionModel && health.get(keyOf(sessionModel)) === HEALTH.INVALID)
        : Boolean(queue[cur] && health.get(keyOf(queue[cur])) === HEALTH.INVALID);
      if (curDead) {
        const next = pickFrom(cur, { allowP1: true });
        if (next !== null && next !== cur) {
          runtime.lastSwitch = { from: cur, to: next, code: 'NO_ADAPTER', at: Date.now() };
          runtime.activeIndex = next;
          changed = true;
        }
      }
      if (changed) touch();
      return { checked: queue.length, invalid, changed };
    },
    /** 选出本次请求应使用的队列索引；返回 -1 表示队列不可用（放行原配置） */
    resolveIndex(now = Date.now(), sessionId = null) {
      const queue = config.queue || [];
      if (!config.enabled || queue.length === 0) return -1;
      const p1Pos = p1Position();
      let cur = cursorFor(sessionId).activeIndex;
      if (!Number.isInteger(cur)) cur = p1Pos;
      if (cur < 0 && !config.p1Follow) cur = 0;
      if (cur >= queue.length) cur = queue.length - 1;
      if (positionAvailable(cur, now)) return cur;
      // 当前位置不可用 → 找下一个可用位置（可能是 P1 槽，也可能是队列里的后备）
      const mode = config.failbackMode;
      // 「能不能自动回 P1」由回切策略决定——旧实现只区分 sticky/非 sticky，
      // probe 与 manual 都被当成"永远可以回 P1"，于是：
      //   · manual 模式会在后备挂掉时自己跳回 P1（"永不自动回切"名存实亡）；
      //   · probe 模式的 failbackDelayMs 防抖从未被读取，冷却一到立刻回切，
      //     形成 P1 抖动→切走→立刻回切→再抖动 的循环。
      // 三种模式的真实语义：
      //   manual → false：只能由用户 manualFailback 拉回
      //   sticky → null ：仅在绕一圈全不可用时兜底回 P1
      //   probe  → bool ：P1 已恢复 且 距上次切走已过防抖期
      const canFallbackToP1 = (() => {
        if (cur === p1Pos) return true;            // 本来就在 P1，无需"回切"
        if (mode === 'manual') return false;
        if (mode === 'sticky') return null;
        const delay = Number(config.failbackDelayMs) || 0;
        const switchedAt = runtime.lastSwitch?.at || 0;
        const elapsed = Date.now() - switchedAt;
        if (delay > 0 && switchedAt > 0 && elapsed < delay) return false;
        return positionAvailable(p1Pos, now);
      })();
      // 第一轮：只有明确"可以回 P1"（true）才把 P1 槽放进候选。
      // 粘滞（null）第一轮必须**排除** P1，否则环序里 P1 永远排在队列第一位，
      // 于是 P3 一挂就跳回 P1、把 P2 整个跳过去——粘滞的意义正是"先顺着后备走完"。
      let chosen = pickFrom(cur, { allowP1: canFallbackToP1 === true, now });
      // 粘滞兜底：绕一圈实在没有别的可用路由，才允许回 P1 降级
      if (chosen === null && canFallbackToP1 === null) chosen = pickFrom(cur, { allowP1: true, now });
      if (chosen === null) return -1; // 全熔断：放行原配置（降级）
      if (chosen !== cur) {
        setLastSwitch(sessionId, {
          from: cur,
          to: chosen,
          // 回切到 P1 时标记 PROBE_FAILBACK，便于 UI/日志区分"故障切换"与"恢复回切"
          code: chosen === p1Pos && mode === 'probe' ? 'PROBE_FAILBACK' : undefined,
          at: Date.now(),
        });
        setCursor(sessionId, chosen);
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
    onFailedAttempt(provider, model, code, p1OwnsFailure = true, failure = null, sessionId = null) {
      const queue = config.queue || [];
      if (!config.enabled || queue.length === 0) return false;
      const p1Pos = p1Position();
      // 失败路由在队列里就记在那一条上；不在队列里、又确属 P1 的失败才记到 P1 槽（-1）。
      // 老实现把 P1 也写成 0，而 0 同时是队列第一条（UI 的 P2）——P1 失败会把 P2
      // 无端熔断，切换直接跳过 P2 跳到 P3。
      // 注意：p1Follow 下 P1 槽本身就用 -1 表示，所以"没找到"不能直接等于 -1 就返回，
      // 否则 P1 的失败永远走不到下面（老代码正因如此把 P1 写成 0，才引出 P2 被误熔断）。
      let pos = queue.findIndex((r) => r.provider === provider && r.model === model);
      if (pos === -1) {
        if (!config.p1Follow || !p1OwnsFailure) return false; // 不是队列里的路由，不接管
        pos = p1Pos; // -1 = P1 槽（会话模型，队列外）
      }
      // P1 槽的路由对象就是会话模型本身（不在队列里，按失败现场构造）
      const failedRoute = pos < 0 ? { provider, model } : queue[pos];
      // 调用侧问题（请求体不合法、内容被拒、Runtime 自伤）不是路由健康问题：既不能
      // 熔断，也不能把游标钉过去，否则一条坏请求会让健康路由整段冷却 60s。
      // 这个判定必须在 setCursor 之前——游标被钉到别的下标后，resolveIndex() 会推出
      // 下一条可用路由，等于对调用侧错误也做了一次切换。
      const source = classifyFailureSource(code, failure?.message, failure?.status, config.immediateCodes);
      if (source === FAILURE_SOURCE.CALLER) {
        recordFailure(failedRoute, code, failure?.message, failure?.providerRetryAfterMs, failure?.status);
        return false;
      }
      // capability（推理档位不被目标模型支持）刻意**不在这里 return**：
      // recordFailure 内部对它不计失败、不熔断，但这条路我们仍然要走下去——
      // 换一台支持该档位的模型就能成就这一轮请求，只是失败的那条不该背锅。
      // 游标钉到实际失败的这条路由上，再算下一个。否则："P1 跟随当前模型"模式下
      // 用户手动选了 P3、P3 挂了，游标还停在 P2，resolveIndex() 会认为 P2 正常并
      // 直接返回，切换根本不发生；或者 resolveIndex() 从旧游标推出来的下一站是刚
      // 挂掉的这条，同样切不出去。
      setCursor(sessionId, pos);
      recordFailure(failedRoute, code, failure?.message, failure?.providerRetryAfterMs, failure?.status);
      // 手动意图随失败失效：用户手选的那条挂了，本会话的 manual 目标必须清掉，否则
      // 新会话（或游标被清空之后）会继续回落到这条已经判死的路由，表现成"切走了又
      // 自己跳回去"。会话隔离：只清本会话，不动别的会话的手动目标。
      if (manualFor(sessionId) === pos) setManual(sessionId, null);
      // capability：请求形状（推理档位）不被这条模型接受。recordFailure 已按
      // 「不计失败、不熔断」分流，所以 resolveIndex 会认为它"仍然可用"并原地返回
      // 同一条——那样这一轮请求就白挂了。这里显式跳过失败位置一次：换一条路由能
      // 救这一轮，而失败那条的健康状态一点没动，下一条请求仍可能再试它。
      if (source === FAILURE_SOURCE.CAPABILITY) {
        const next = pickFrom(pos, { allowP1: true });
        if (next === null || next === pos) {
          touch();
          return false;
        }
        setCursor(sessionId, next);
        setInFlight(sessionId, next);
        setLastSwitch(sessionId, { from: pos, to: next, code, at: Date.now() });
        touch();
        return true;
      }
      // 真实请求失败是比探测更强的证据：最近的请求证据直接改判失败（由调用方在
      // request-error 钩子里写 lastRequest，这里不再维护第二条回执）。
      const nextIdx = this.resolveIndex(Date.now(), sessionId);
      if (nextIdx === -1) {
        // p1Follow 下 -1 有两种可能：绕回 P1 槽（会话模型，这也是一次真切换，UI 要跟着动），
        // 或者"一条可用的都没有"（全熔断降级）。只有前者值得重试——P1 槽自己也刚挂了
        // 还回去重试，只会变成对同一个坏模型的死循环。
        if (!config.p1Follow || !positionAvailable(p1Pos)) {
          touch(); // 熔断已记下，指标变了，通知一次
          return false;
        }
        setInFlight(sessionId, p1Pos);
        setLastSwitch(sessionId, { from: pos, to: p1Pos, code, at: Date.now() });
        touch();
        return true;
      }
      if (nextIdx === pos) {
        touch(); // 熔断已记下，指标变了，通知一次
        return false; // 仍在原路由：不重试
      }
      // 切换决定已作出：retry 后下一个请求会发往 nextIdx。若此处不同步 inFlight，
      // effectiveIndex() 会一直返回旧的值（上一条路由），UI 的指示器与
      // "当前"标记在下一轮 agent/request 瀑布跑过之前都指错对象（P3 在跑却显示 P2）。
      setInFlight(sessionId, nextIdx);
      // lastSwitch 由 resolveIndex 写入（可能为 null：起点本来就不可用时它直接返回，
      // 没有记录）——直接 .code = 会 TypeError 把整个失败处理吞掉。按会话读回再补码。
      const ls = lastSwitchFor(sessionId);
      if (ls) setLastSwitch(sessionId, { ...ls, code });
      touch();
      return true;
    },
    snapshot(sessionId) {
      const queue = config.queue || [];
      // P1 槽属于**调用方会话**：面板/芯片带着自己的 sessionId 来取。
      // 旧实现固定读全局 sessionModel，于是新开的会话看到的是上一个会话的模型
      // （用户实测：新会话点「探测全部」，P1 行红的是别的会话的模型）。
      const sid = typeof sessionId === 'string' && sessionId ? sessionId : null;
      const p1Model = sessionModelFor(sid);
      /** 一条路由的电路视图：entries（队列条目）与 p1（P1 槽）共用，字段完全一致 */
      const view = (route) => {
        const key = keyOf(route);
        const c = circuitOf(key);
        return {
          state: c.state,
          failures: c.failures,
          // 配置级死亡（无适配器）：UI 据此直接标"配置失效"而不是"熔断中"
          invalid: health.get(key) === HEALTH.INVALID,
          // 熔断原因（ⓘ 悬浮提示）：只在电路非正常态时给出，健康路由不背历史失败的账
          // caller / capability 两类失败不进熔断，但同样要能解释"为什么没切"或
          // "为什么这条被跳过了"：所以它们的原因在 closed 状态下也下发
          // （其余状态仍只在非正常态给，健康路由不背旧账）。
          lastError: c.lastCode && (c.state !== CIRCUIT.CLOSED
            || c.lastSource === FAILURE_SOURCE.CALLER
            || c.lastSource === FAILURE_SOURCE.CAPABILITY)
            ? { code: c.lastCode, message: c.lastMessage, source: c.lastSource || null }
            : null,
          // 失败来源分层（provider/transport/unknown/caller）：caller = 请求或 Runtime
          // 自身的问题，换模型救不了所以不熔断。UI 用它解释"为什么没切"。
          source: c.lastSource || null,
          openedAt: c.openedAt || null,
          // 预计恢复 = 熔断时刻 + 冷却时长；half_open 之后就不再是"等冷却"了
          recoverAt: c.state === CIRCUIT.OPEN ? c.openedAt + config.cooldownMs : null,
          retryAfterMs: c.retryAfterMs || null,
          // 健康证据（前端据此画"绿/黄/灰"与"x 秒前可用"）：熔断状态是事后结果，
          // 这三个时间戳才是"多久以前确认过它还能回话"。
          lastOkAt: c.lastOkAt || null,
          lastProbeAt: c.lastProbeAt || null,
          probeLatencyMs: c.probeLatencyMs || null,
          probeOk: c.probeOk === null || c.probeOk === undefined ? null : c.probeOk === true,
          // 上次探测的失败原因（探测不写熔断器，所以单独下发）
          probeError: c.lastProbeCode ? { code: c.lastProbeCode, message: c.lastProbeMessage || null } : null,
          // 已知解锁时刻（限流）→ 前端用它算倒计时；不知道就是 null，不编一个。
          probeResetAt: c.probeResetAt || null,
          // 「探测已通过但仍在熔断」：前端据此把红色换成可操作的"可恢复 + 恢复按钮"。
          // 不给这个布尔，前端只能自己拿 lastProbeAt/openedAt 拼时间戳（三处各拼一遍，
          // 迟早有一处漏判，红色就永远是红色）。
          revivable: c.state === CIRCUIT.OPEN
            && c.probeOk === true
            && (c.lastProbeAt || 0) > (c.openedAt || 0),
        };
      };
      return {
        enabled: config.enabled,
        p1Follow: config.p1Follow,
        activeIndex: runtime.activeIndex,
        // 手动切换目标：客户端在"本会话还没有请求记录"时用它显示生效路由，
        // 修「切到 P4 了但芯片仍写 P1、P4 行不高亮」。
        // 全局镜像（旧客户端回退）+ 按会话映射（真正隔离，见下）。
        manualIndex: runtime.manualIndex,
        sessionManual: Object.fromEntries(sessionManual),
        inFlightIndex: runtime.inFlightIndex,
        // per-session inFlight 映射随快照下发：客户端按当前会话取自己的显示值，
        // 修「会话1在 P3、会话2在 P2 时芯片互相覆盖」的问题。
        sessionInFlight: Object.fromEntries(sessionInFlight),
        effectiveIndex: effectiveIndex(),
        lastProposal: runtime.lastProposal ? { ...runtime.lastProposal } : null,
        // 会话模型快照：P1 应该指的用户手选模型（不受熔断回写污染）。
        // UI 用它显示 P1 行名称，并在"会话模型 ≠ effective 路由"时判断是否已切走。
        sessionModel: sessionModel ? { ...sessionModel } : null, // 闭包内 let，见上方声明
        // 按会话的会话模型：客户端按自己会话取，多会话下 P1 行名不会互相串
        sessionModelBySession: Object.fromEntries(sessionModelBySession),
        // P1 槽自己的电路视图（p1Follow 下 P1 = 会话模型，不在 config.queue 里）。
        // 老客户端读不到它会退回 entries[0]，保持向后兼容。
        // 按调用方 sessionId 取模型：P1 行名与健康态必须来自同一个会话。
        p1: config.p1Follow && p1Model
          ? { provider: p1Model.provider, model: p1Model.model, sessionId: sid, ...view(p1Model) }
          : null,
        lastSwitch: runtime.lastSwitch,
        // 手动切换后的等待位：UI 用它显示「已切到 P3，等下次请求确认」。
        pendingConfirm: runtime.pendingConfirm ? { ...runtime.pendingConfirm } : null,
        // 真实请求证据：最近一条真的发出去的请求走了哪条、结果如何。
        // 这是「切换到底生效没有」唯一可信的答案（游标只是意图，探测只是旁证）。
        lastRequest: runtime.lastRequest ? { ...runtime.lastRequest } : null,
        // ---- 按会话的切换事实（会话隔离：客户端按自己 sessionId 取，互不串味）----
        sessionLastSwitch: Object.fromEntries(sessionLastSwitch),
        sessionPendingConfirm: Object.fromEntries(sessionPendingConfirm),
        sessionLastRequest: Object.fromEntries(sessionLastRequest),
        // 旧字段：恒为 null，保留给老客户端，避免读不到就当成"验证失败"。
        lastVerify: null,
        // 宿主确认的"最近一轮实际使用的路由"（来自宿主回写的 model/selection），
        // 与 lastVerify（探测能否回话）是两条独立证据：一条证明"真的发到了这条"，
        // 一条证明"这条当时能回话"。
        hostConfirmed: runtime.hostConfirmed ? { ...runtime.hostConfirmed } : null,
        revision: runtime.revision,
        // 冷却时长给 UI：悬浮提示要用它把 openedAt 换算成"预计恢复"的时刻
        cooldownMs: config.cooldownMs,
        // 探测节奏给 UI：前端据此判断"这条多久没被确认过"是否已经超过一个周期，
        // 超了就降级成灰色（未验证），不再冒充绿色可用。
        pingIntervalMs: Number(config.pingIntervalMs) || 0,
        pingSkipPaid: config.pingSkipPaid !== false,
        // 设置页要显示/编辑探测体大小：默认 8，最小 1（1 是历史默认，部分网关会拒）
        pingMaxTokens: Math.max(1, Math.floor(Number(config.pingMaxTokens) || DEFAULT_CONFIG.pingMaxTokens)),
        entries: queue.map((r, i) => ({
          index: i,
          provider: r.provider,
          model: r.model,
          // F3/F1 前端需要的新字段：paid（免费/付费）、tier（厂商分组）
          paid: r.paid === 'free' || r.paid === 'paid' ? r.paid : 'unknown',
          tier: typeof r.tier === 'string' && r.tier ? r.tier : null,
          ...view(r),
        })),
        // F4 全员 ping 进度指示：探测中为 true 时前端按钮置灰并显示 n/N 进度
        probingAll: runtime.probeInFlight === true,
        // 真实进度 {done,total}：旧实现只给布尔，前端拿不到已完成条数，
        // 「探测中… n/N」的 n 只能硬编码 0。
        probingDone: runtime.probeProgress ? runtime.probeProgress.done : 0,
        probingTotal: runtime.probeProgress ? runtime.probeProgress.total : 0,
        // 逐条探测状态：{ 'provider\0model': { state:'probing'|'done', ok } }。
        // 到 TTL 后惰性清空（不在这里 touch，避免 snapshot 构造期触发重入；前端轮询下一拍即感知消失）。
        probeStatus: (() => {
          if (runtime.probeStatus && runtime.probeStatusUntil && Date.now() > runtime.probeStatusUntil) {
            runtime.probeStatus = null;
            runtime.probeStatusUntil = null;
            return null;
          }
          return runtime.probeStatus;
        })(),
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

  /** 运行态快照（sessionId 可选：P1 槽按该会话取，缺省退回全局镜像） */
  snapshot(sessionId) {
    return this.router.snapshot(sessionId);
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

  /**
   * 手动切换：把**本会话**的生效路由拨到目标位置（会话隔离）。
   * index 省略或 -1 = P1 槽（p1Follow 下就是"当前会话模型"）。
   * sessionId：当前会话 id（RPC 由客户端透传）；缺省时退回旧的全局语义。
   * 注意 p1Follow 下 queue[0] 是 UI 的 P2，不是 P1——老实现固定 i=0 会让"切回 P1"
   * 实际切到 P2，并把 from===to 的空操作也记进历史（UI 显示成 P2 → P2）。
   */
  manualFailback(index, sessionId) {
    const p1Pos = this.config.p1Follow ? -1 : 0;
    const i = Number.isFinite(index) ? Number(index) : p1Pos;
    if (i === -1) {
      if (!this.config.p1Follow) return { ok: false }; // 静态模式没有"队列外的 P1"
    } else if (!this.config.queue?.[i]) {
      return { ok: false };
    }
    // 会话隔离：只写本会话的游标/inFlight/手动目标/等待位，绝不清空所有会话。
    // 旧实现这里 resetSessionCursors() 把所有会话一起拖到目标位置——用户明确要求
    // "某个会话切了只在该会话生效"。无 sessionId 时 router.manualSwitch 退回全局语义。
    return this.router.manualSwitch(
      typeof sessionId === 'string' ? sessionId : null,
      i,
    );
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

  /**
   * 全员快速 ping（F4）：对队列每条路由（含 P1 槽）发一次微型探测，**限并发并跑**。
   * 手动触发（设置页 / 芯片面板按钮），全探（不跳过 paid，用户明确点了就探）。
   * 结果逐条写进电路（recordSuccess/recordFailure），UI 徽章立即反映真实健康。
   * @returns {Promise<{ok: boolean, results?: Array<{index:number,provider:string,model:string,ok:boolean|null,skipped?:boolean}>, reason?: string}>}
   */
  async pingAll(sessionId) {
    if (!serviceBridge?.probeAllRoutes) return { ok: false, reason: 'unavailable' };
    try {
      // 芯片面板「探测全部」：探队列全部 + P1 槽（面板把 P1 当一行显示，需要一起探）。
      // sessionId：P1 槽按**发起方会话**取模型，不能拿全局最近会话凑数。
      return await serviceBridge.probeAllRoutes({ skipPaid: false, source: 'manual', sessionId });
    } catch (e) {
      return { ok: false, reason: 'error', error: e?.message };
    }
  }

  /**
   * 设置页「探测全部」：只探队列中的模型，**排除 P1 槽**（用户要求：队列区只列
   * P2..Pn，探 P1 会多一条、对不上行数）。与 pingAll 拆成两个零参方法，避免
   * 设置页与芯片面板共用同一 RPC 时口径互相污染。周期探测仍含 P1。
   */
  async pingQueue(sessionId) {
    if (!serviceBridge?.probeAllRoutes) return { ok: false, reason: 'unavailable' };
    try {
      return await serviceBridge.probeAllRoutes({ skipPaid: false, source: 'manual', includeP1: false, sessionId });
    } catch (e) {
      return { ok: false, reason: 'error', error: e?.message };
    }
  }

  /**
   * 「用真实请求验证」一条路由：发一条和真实对话同形的普通请求（不是微型探测体），
   * 回执里带成败、错误码、耗时和 token 用量。
   * index: -1 = P1 槽（p1Follow 下即当前会话模型），>=0 = 队列下标。
   *
   * 返回值里的 `ok` 只表示"验证跑完了"，路由到底行不行看 `receipt.ok`——
   * 两者不能混：一个是 RPC 是否成功，一个是上游是否回话。
   * @returns {Promise<{ok: boolean, route?: {provider:string, model:string}, receipt?: object, reason?: string}>}
   */
  async probeReal(index, sessionId) {
    if (!serviceBridge?.probeRealRoute) return { ok: false, reason: 'unavailable' };
    try {
      return await serviceBridge.probeRealRoute(index, sessionId);
    } catch (e) {
      return { ok: false, reason: 'error', error: e?.message };
    }
  }

  /**
   * 「立即恢复」：把**探测已通过、但仍锁在熔断里**的路由放出来。
   * index: -1 = P1 槽（按 sessionId 取模型），>=0 = 队列下标。
   *
   * 安全性由 router.reviveRoute 兜底：只认"这次熔断之后又探测成功过"的证据，
   * 无条件放开会把熔断变成摆设（用户只是点了下按钮，不代表厂商已经恢复）。
   * @returns {{ok:boolean, reason?:string}}
   */
  reviveRoute(index, sessionId) {
    const i = Number.isFinite(Number(index)) ? Number(index) : -1;
    const sid = typeof sessionId === 'string' && sessionId ? sessionId : null;
    const target = i === -1
      ? (this.config.p1Follow ? this.router.sessionModelFor(sid) : (this.config.queue?.[0] || null))
      : (this.config.queue?.[i] || null);
    if (!target) return { ok: false, reason: 'no-route' };
    return this.router.reviveRoute(target);
  }
}
markRemoteMethods(FallbackQueueService.prototype, ['snapshot', 'probe', 'manualFailback', 'getQueue', 'setQueue', 'pingAll', 'pingQueue', 'probeReal', 'reviveRoute']);

export const inject = ['settings', 'llm'];

/**
 * 插件入口。
 *
 * ⚠️ 签名契约：cordis 的插件入口是 apply(ctx, config) —— **第二个参数是插件自己的
 * Config，不是服务**。服务只能经 `ctx.<name>` 取（hardDependency 走 inject，
 * 可选依赖走 ctx.get('<name>')）。
 *
 * 曾经写成 `apply(ctx, llm)`：形参叫 llm，拿到的却是 Config 对象。那个对象上没有
 * stream()/listProviders()，于是：
 *   - 预检 llm.listProviders 守卫整段短路（永远 checked:0，配置死路由从不判死）；
 *   - 探测 llm.stream 守卫整段短路（周期探测与手动 pingAll 静默空转，reason:'no-stream'）。
 * 两者都不抛错，所以面板「探测」永远是灰的、也没人发现——正是这条错位造成的静默失效。
 */
export function apply(ctx, pluginConfig = {}) {
  // loader 传入的 Config 作为基线，settings 文档随后覆盖它（settings 才是用户可见的真源）
  const config = {
    ...DEFAULT_CONFIG,
    ...(pluginConfig && typeof pluginConfig === 'object' ? pluginConfig : {}),
  };
  // llm 是**服务**，不是第二参。可选获取：宿主没装 llm 时（单测/精简环境）不报错。
  const llm = ctx.get ? ctx.get('llm') : ctx.llm;

  // ---- 方案 B：llm/stream 中间件（LLM 层故障转移，不改 selection）----
  // 0.2.2-rc.1 起 agent/request 不允许再改 provider/model（prepareRequest 会抛
  // "proposed ... after step preparation fixed ..."），所以换路必须下沉到 LLM 层。
  // 方案 B 不注册虚拟 provider、不动 agent.model.select()：会话 selection 始终是
  // 用户真正选的模型（P1），模型选择器/输入框图标正常显示；故障转移在 llm/stream
  // 瀑布里对该请求的 chunk 流做「先 P1、再队列」的顺序重试（只在还没吐可见内容时换路）。
  // 代价：assistant 消息 source 仍标 P1（即使实际由 P2 服务），面板「上一轮实际使用」
  // 显示真实路由以补偿。详见 docs/migration-0.2.2-rc.1.md。

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
  // 这两个调用点过去既不 await 也不 catch：runPreflight 内部只兜住了 listProviders，
  // 之后的 health 表读写 / sessionModelFor 一旦抛错就是一条未捕获的 rejection ——
  // Node 24 默认 --unhandled-rejections=throw，会让宿主进程直接退出。统一收口在这里。
  function preflightSafe(trigger) {
    runPreflight(trigger).catch((e) => {
      ctx.logger?.warn?.('[fallback-queue] preflight(%s) failed: %s', trigger, e?.message);
    });
  }
  // 同步监听器同样不能把异常抛回宿主的事件派发链：一个 throw 会穿过去炸掉整轮请求。
  function safeListener(fn) {
    return (...args) => {
      try {
        return fn(...args);
      } catch (e) {
        ctx.logger?.warn?.('[fallback-queue] listener failed: %s', e?.message);
        return undefined;
      }
    };
  }
  ctx.effect(() => ctx.on('llm/adapters-updated', () => preflightSafe('adapters-updated')));
  // 启动预检要等适配器注册完成，adapters-updated 事件天然覆盖（xdpool 等注册完会触发）。
  // 兜底：启动后 3s 再跑一次，防宿主不派发该事件。
  const preflightTimer = setTimeout(() => preflightSafe('boot'), 3000);

  // ---- 会话模型实时跟随 ----
  // 用户手动切模型时宿主派发 session/event {type:'model/selection', data:{provider,model,...}}
  //（dsh-api-session-controller selectModel → agent.session.append）。
  // 原方案只靠 P1 放行采样（agent/request 瀑布），手动切换后没发消息就是旧值。
  // 这里监听 selection 事件直接更新 router.sessionModel，UI 3s 轮询即可跟上。
  ctx.effect(() =>
    ctx.on('session/event', safeListener((session, event) => {
      if (event?.type !== 'model/selection') return;
      const d = event.data || {};
      if (!d.provider || !d.model) return;
      // 忽略"我们自己的覆盖被投影回来"的 selection：那是后备路由在跑，不是用户手选。
      // 不忽略的话，每次熔断切到 P2/P3，宿主投影回写都会把 P1 的"本尊"改成后备模型。
      // 但这条投影本身是**宿主的确认**：宿主把我们返回的 provider/model 写进了会话，
      // 等于官方承认"本轮用的是它"。所以不拿它改 P1 身份，但要记成回执。
      const forced = router.runtime.lastProposal;
      if (forced?.overridden && forced.idx >= 0) {
        const q = (config.queue || [])[forced.idx];
        if (q && q.provider === d.provider && q.model === d.model) {
          router.runtime.hostConfirmed = {
            index: forced.idx,
            provider: d.provider,
            model: d.model,
            at: Date.now(),
          };
          router.touch();
          return;
        }
      }
      const sessionId = session?.id ?? null;
      router.noteSessionModel(sessionId, d.provider, d.model);
      // 用户手选模型 = "我要用这条"：把该会话拨回 P1 槽，下一个请求先试用户选的这条。
      // 否则熔断把游标钉在后备上时，换模型根本不生效（老 bug：换了模型 P1 行还是旧名）。
      lastProposal = null;
      router.retryFromP1(sessionId);
      ctx.logger?.info?.('[fallback-queue] session model changed: %s/%s', d.provider, d.model);
      router.touch();
    })),
  );

  // ---- 会话数据清理 ----
  // 会话销毁（session/disposed，宿主 dsh-session 派发）时清掉它的切换游标，
  // 防止 sessionCursor Map 随历史会话数无限增长。游标是我们唯一按会话记的运行态；
  // 熔断/判死按 provider/model 记账，与会话无关，不需要清理。
  ctx.effect(() =>
    ctx.on('session/disposed', safeListener((session) => {
      router.dropSession(session?.id);
    })),
  );

  // ---- 主动探测 ----
  // 半开路由超过 PROBE_TIMEOUT_MS 仍没有真实请求路过落账时，由插件直接经 llm.stream 发
  // 一条微型请求（maxTokens=1，'ping'），拿到一个**成功** chunk 才算可用。
  // F4 的「快速 ping」复用同一套探测逻辑，对队列每条路由做全员扫描，更快发现
  // "还没熔断但已经死了"的模型（API key 失效 / 模型下架 / 网络不通）。
  // 并发探测锁：按「provider\0model」精确到具体路由，而不是全局串行。
  // 旧实现是单个 `probing` 布尔 —— 同一时刻只许一个探测在飞，于是「探测全部」
  // 只能一条条排队（6 条就要等十几秒）。现在每个路由各自一把锁：
  //   · probeRoute（半开扫描）只锁自己那条，跟别条互不阻塞；
  //   · probeAllRoutes 批量探测时**按 probeConcurrency 并发**跑——彼此独立、都是极短
  //     请求，墙钟时间≈最慢的一条而不是全部之和；
  //   · 同一条路由不会被两路同时探（in-flight 去重），避免浪费请求/互相覆盖证据。
  const probingKeys = new Set();
  const probeKey = (route) => `${route.provider}\u0000${route.model}`;
  const isProbingKey = (route) => probingKeys.has(probeKey(route));
  let probingAll = false; // 全员 ping 进行中（区别于半开扫描的单条锁）
  /** 探测**请求**超时（毫秒）：到点 abort 掉挂起的流。
   *  注意与 router 的 PROBE_TIMEOUT_MS（90s，半开状态等真实请求的最长期限）不是一回事。 */
  const PROBE_REQUEST_TIMEOUT_MS = 15_000;
  /** 「用真实请求验证」的请求超时：它发的是一条真正常规请求，比 ping 慢是正常的。 */
  const VERIFY_REQUEST_TIMEOUT_MS = 30_000;
  /** 「用真实请求验证」的 maxTokens：够模型正常回一句话，又不至于真的长篇大论。 */
  const VERIFY_MAX_TOKENS = 32;
  /**
   * 单条路由探测/验证的实现，无锁（调用方负责串行化）。**返回回执而非布尔**：
   * 调用方要能拿到 code / 耗时 / token 用量，UI 才说得清"到底怎么了"。
   *  - mode 'ping'：微型请求（maxTokens = config.pingMaxTokens，默认 8），15s 超时
   *  - mode 'real'：真实请求（一条普通的短对话，maxTokens = 32），30s 超时
   * 两者写同一套证据字段，区别只在请求形状与超时——UI 的判定逻辑不用分叉。
   */
  async function runProbe(route, opts = {}) {
    const mode = opts.mode === 'real' ? 'real' : 'ping';
    const maxTokens = mode === 'real'
      ? VERIFY_MAX_TOKENS
      : Math.max(1, Math.min(512, Math.floor(Number(config.pingMaxTokens) || DEFAULT_CONFIG.pingMaxTokens)));
    const timeoutMs = mode === 'real' ? VERIFY_REQUEST_TIMEOUT_MS : PROBE_REQUEST_TIMEOUT_MS;
    const key = router.keyOf(route);
    const startedAt = Date.now();
    // 探测结果无条件记账（无论成败）：UI 要能说"12 秒前测过、890ms、可用"，
    // 只留熔断状态的话，一条刚刚测活的路由仍然显示得跟从未探测过一样。
    // 注意：电路对象必须经 router.circuitOf 取——createRouter 的闭包在 apply 半区不可见。
    const stampProbe = (ok) => {
      const c = router.circuitOf(key);
      c.lastProbeAt = Date.now();
      c.probeLatencyMs = Date.now() - startedAt;
      c.probeOk = ok;
      c.lastAttemptAt = Date.now();
      if (ok) {
        c.lastOkAt = Date.now();
        c.probeResetAt = 0; // 探活了：之前的限流/解锁时刻作废
      }
    };
    // 探测失败记账（只记证据，不动熔断器）。
    const stampFailure = (code, message, probeOk = false) => {
      const c = router.circuitOf(key);
      c.probeOk = probeOk;
      c.lastProbeCode = code;
      c.lastProbeMessage = message || '';
      // 上游若给了明确解锁时刻（channel-pack 原话：「…最近一个将于 2026/10/30 00:00:00
      // 解锁」，bili 则是 ISO 8601），就把它记下来：前端能直接显示「1h37m 后恢复」，
      // 而不是让用户对着「探测失败」守到零点。解析不出时间就清 0，绝不猜一个时长。
      c.probeResetAt = parseResetAt(message);
      // ⚠️ 失败也必须记时间戳。旧实现只记错误码不记 lastProbeAt，而前端判
      // 「有没有证据」看的正是这个字段——于是「探测失败」和「从没探测过」在
      // 界面上长得一模一样（都是灰「未测」）。用户点完「探测全部」看到一片
      // 未测，完全无法区分"测过且挂了"和"压根没测"。
      c.lastProbeAt = Date.now();
      c.probeLatencyMs = Date.now() - startedAt;
    };
    ctx.logger?.info?.('[fallback-queue] %s route %s/%s (maxTokens=%s)',
      mode === 'real' ? 'verifying' : 'probing', route.provider, route.model, maxTokens);
    // 超时用 AbortSignal 传给宿主：旧实现用 Promise.race + setTimeout，超时后
    // 那个 15s 定时器从不清除、底层 stream 也从不 abort——每探测一条就漏一个
    // 挂起连接和一个定时器，全员 ping 一轮能漏掉整整一队。
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    try {
      if (!llm?.stream) {
        ctx.logger?.warn?.('[fallback-queue] probe skipped: llm service unavailable');
        return { ok: false, reason: 'no-stream' };
      }
      if (controller) {
        timer = setTimeout(() => controller.abort(), timeoutMs);
        if (timer.unref) timer.unref();
      }
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        // 探测体只用最小合法字段：带 name 之类的扩展字段时，一些厂商会直接
        // 400 拒绝，于是「能正常对话的模型」在面板上长期显示探测失败。
        // mode='real' 时发的是一句普通问话——它的意义正是"和真实请求同形"。
        //
        // ⚠️ content 必须是 content block 数组，不能是裸字符串。宿主适配层
        // （dsh-llm-pi-ai 的 assertSupportedHistory）会对 content 调 .some()，
        // 字符串没有该方法 → 抛 TypeError → 被 adapterStream 吞成失败 chunk
        // （code UNKNOWN），表现为所有路由探测都"失败"。这是 0.2.2-rc.1 起
        // 的硬约束，裸字符串会让「探测全部」全员报错。
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: mode === 'real' ? '请只回复 OK 两个字母，不要任何解释。' : 'ping',
          }],
        }],
        maxTokens,
        ...(controller ? { signal: controller.signal } : {}),
      });
      // ⚠️ 关键语义：llm.stream **从不抛错**——适配层的失败会变成终态 finish chunk
      // （reason.kind = 'error' | 'aborted'，里面才是 LlmFailure）。所以「拿到第一个
      // chunk 就算成功」是错的：一条 key 失效的路由会立刻回一个 finish{error:AUTH}，
      // 旧实现把它当成"能回话"，于是探测成功、面板刷绿、lastOkAt 被刷新——把死路由
      // 涂成健康，比不探测更危险。必须逐 chunk 判。
      let verdict = null; // null = 还没有结论
      let usage = null; // 上游回传的 token 用量（有就带上，回执里给 UI 看成本）
      let sample = ''; // 前若干字符的真实输出：回执里要能说"它到底回了什么"
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'usage') {
          usage = chunk.usage || usage;
          continue;
        }
        if (chunk.type === 'finish') {
          const kind = chunk.reason?.kind;
          if (chunk.usage) usage = chunk.usage;
          if (kind === 'error' || kind === 'aborted') {
            const failure = chunk.reason?.failure || {};
            verdict = {
              ok: false,
              code: typeof failure.code === 'string' && failure.code ? failure.code : (kind === 'aborted' ? 'ABORTED' : 'UNKNOWN'),
              message: failure.message || (kind === 'aborted' ? '探测被中止' : '上游返回失败'),
              status: failure.status,
            };
          } else {
            verdict = { ok: true }; // stop / tool-calls / max-tokens 都证明这条路由真的能回话
          }
          break; // 终态帧到手即收工
        }
        // 任何真实内容帧（文本/推理/tool-call）都足以证明模型能回话，
        // 不必等 finish——这才是"微型探测"要省的那点 token。
        if (chunk.type === 'text-delta') {
          if (sample.length < 120) sample += String(chunk.text ?? chunk.delta ?? '');
          verdict = { ok: true };
          break;
        }
        if (chunk.type === 'reasoning-delta'
          || chunk.type === 'tool-call-delta' || chunk.type === 'block-start' || chunk.type === 'block-end') {
          verdict = { ok: true };
          break;
        }
        // 其他无内容帧：继续读，不据此下结论
      }
      if (verdict === null) {
        // 流读完了却一个帧都没给：上游空响应，不能算通过
        verdict = { ok: false, code: 'EMPTY_RESPONSE', message: '探测没有收到任何内容' };
      }
      // 立刻中断探测流省 token（成功时尤其重要：我们只读了一个帧就走）
      try { await stream.interrupt?.(); } catch { /* 流可能已结束 */ }
      const latencyMs = Date.now() - startedAt;
      if (verdict.ok) {
        // 记账分两种，两种请求的"证据等级"不同：
        //  - mode='ping'：一条刻意精简的微型请求。厂商可能不计费、不校验余额，
        //    它成功不代表真实请求能成 → 只写证据，最多把「半开」推进回闭合，
        //    **不**复活已熔断（open）的路由，也**不**清 closed 下的失败计数
        //    （否则周期探测会把熔断阈值一次次清零，熔断永远不触发）。
        //  - mode='real'：一条和真实对话**同形**的请求，它的成功就是真实请求级别的
        //    证据 → 允许像真实请求成功一样复位熔断（route 恢复可用是事实）。
        if (mode === 'real') router.recordSuccess(route);
        else router.recordProbeSuccess(route);
        stampProbe(true);
        ctx.logger?.info?.('[fallback-queue] %s ok: %s (%sms)', mode, key, latencyMs);
        return {
          ok: true, mode, code: null, message: '', latencyMs, maxTokens, usage,
          sample: sample.trim().slice(0, 80),
        };
      }
      // 失败路径：只记证据，不动熔断器。
      // 为什么：探测是一条刻意精简的异形请求，某些厂商会以 400/429/超时拒绝它。
      // 如果让它累计失败，60s 一次的周期探测会亲手把每条路由"熔断"掉——
      // 监控把自己监控死，用户看到的就是"一片红、切过去也没用"。
      // 真死了的路由由真实请求记账；探测只负责说明"上次探测没成功"。
      const code = verdict.code;
      const msg = String(verdict.message || '');
      const statusNum = Number(verdict.status);
      // 探测体被拒（4xx 客户端拒绝）说明**这次探测不成立**，不能据此说模型不可用：
      // 标成「探测不支持」，UI 按灰色「未测」显示，不冒充黄色风险。
      // 判定规则：除 鉴权(401/403) / 额度(402) / 模型不存在(404) / 限流(429) 之外的 4xx，
      // 一律算"形状被拒"——因为探测体是刻意精简的，被拒的往往不是模型而是请求形状。
      // 但鉴权/额度/模型不存在这类报错即使包着 400 也是真问题，不能洗白。
      const realFault = /api.?key|authenticat|unauthor|forbidden|quota|额度|余额|rate.?limit|too many requests|not found|does not exist|no such model/i.test(msg);
      const REJECTED_CODES = new Set([
        'INVALID_REQUEST', 'BAD_REQUEST', 'INVALID_ARGS', 'INVALID_PARAMETER',
        'UNSUPPORTED_PARAMETER', 'CONTEXT_WINDOW_EXCEEDED', 'VALIDATION_ERROR',
      ]);
      const REJECTED_STATUS = new Set([400, 405, 406, 409, 413, 415, 422, 424]);
      // 注意 mode='real' 时**不做"形状被拒"豁免**：真实请求被 400 就是真实请求被 400，
      // 它不是探测体的形状问题，把它洗成「未测」等于替一条真坏的路由遮掩。
      const rejected = mode === 'ping' && !realFault && (
        REJECTED_CODES.has(code)
        || REJECTED_STATUS.has(statusNum)
        || /invalid (request|argument|parameter)|unsupported|not supported|max_tokens|max_completion_tokens|schema|stream_options/i.test(msg)
      );
      const finalCode = rejected ? 'PROBE_UNSUPPORTED' : code;
      const finalMsg = rejected ? '该厂商拒绝了探测请求（不代表模型不可用）' : normalizeReason(msg);
      // 探测被拒是"没测成"，probeOk 记 null（UI 按灰色未测显示）；
      // 其余失败都是"测过且没成"，记 false（UI 按黄色风险显示）。
      stampFailure(finalCode, finalMsg, rejected ? null : false);
      ctx.logger?.info?.('[fallback-queue] %s failed: %s code=%s rejected=%s (circuit untouched)',
        mode, key, code, rejected);
      return {
        ok: false, mode, code: finalCode, rejected, message: finalMsg,
        status: verdict.status, latencyMs, maxTokens, usage,
      };
    } catch (e) {
      // 走到这里的是"真异常"：abort、网络层直接抛、适配器注册缺失等
      const aborted = e?.name === 'AbortError' || controller?.signal?.aborted === true;
      const code = aborted ? 'TIMEOUT' : (typeof e?.code === 'string' && e.code ? e.code : 'UNKNOWN');
      stampFailure(code, normalizeReason(e?.message));
      ctx.logger?.info?.('[fallback-queue] %s threw: %s code=%s (circuit untouched)', mode, key, code);
      return {
        ok: false, mode, code, rejected: false, message: normalizeReason(e?.message),
        latencyMs: Date.now() - startedAt, maxTokens,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** 微型探测（全员 ping / 半开扫描用）：只要布尔——调用方只关心"能用吗"。 */
  async function probeOne(route) {
    const receipt = await runProbe(route, { mode: 'ping' });
    return receipt.ok === true;
  }
  /**
   * 「用真实请求验证」：对指定路由发一条**真正常规请求**（不是微型探测体）。
   * index: -1 = P1 槽（p1Follow 下即当前会话模型），>=0 = 队列下标。
   *
   * 为什么需要它：探测体再怎么调，仍然是"一条刻意精简的请求"。当网关按请求形状
   * 挑剔时，探测失败并不能证明模型不可用——只有发一条和真实对话同形的请求才算证据。
   * 代价是它真的会花 token，所以**只由用户手动点**，不参与周期扫描。
   */
  async function probeRealRoute(index, sessionId) {
    if (!llm?.stream) return { ok: false, reason: 'no-stream' };
    const i = Number.isFinite(Number(index)) ? Number(index) : -1;
    // P1 槽同样按发起方会话取（理由见 probeAllRoutes 的 p1Slot）。
    const sid = typeof sessionId === 'string' && sessionId ? sessionId : null;
    const target = i === -1
      ? (config.p1Follow ? router.sessionModelFor(sid) : (config.queue?.[0] || null))
      : (config.queue?.[i] || null);
    if (!target) return { ok: false, reason: 'no-route' };
    if (probingAll || isProbingKey(target)) return { ok: false, reason: 'busy' };
    probingKeys.add(probeKey(target));
    try {
      const receipt = await runProbe(target, { mode: 'real' });
      return {
        ok: true, // 注意：这是"验证跑完了"，路由好不好看 receipt.ok
        route: { provider: target.provider, model: target.model },
        receipt,
      };
    } finally {
      probingKeys.delete(probeKey(target));
    }
  }
  // 半开扫描的入口：只锁「这一条路由」，多条半开路由互不阻塞（各自一把锁）。
  // 全员 ping 进行中（probingAll）时不插队，避免与 pingAll 并发打满网关。
  async function probeRoute(route) {
    if (!llm?.stream || probingAll || isProbingKey(route)) return;
    probingKeys.add(probeKey(route));
    try {
      return await probeOne(route);
    } finally {
      probingKeys.delete(probeKey(route));
    }
  }
  // 全员快速 ping：对队列每条路由（含 P1 槽）做一次性探测。
  //  - skipPaid=true 时跳过 paid==='paid' 的条目（周期扫描省配额；手动按钮传 false 全探）
  //  - 期间置 router.runtime.probeInFlight → snapshot.probingAll
  //  - **按 probeConcurrency 并发**：旧实现串行一条条等，队列一长就慢到用户抱怨。
  //    现在限并发并跑；进度按「已完成条数」实时推进（每条落定就 +1），结果按原序填回。
  async function probeAllRoutes(opts = {}) {
    const skipPaid = opts.skipPaid !== false;
    // 是否连 P1 槽一起探。默认 true（周期探测在后台，探 P1 无 UI 数行数的困扰，
    // 且越早发现 P1 挂了越好）；设置页手动「探测全部」传 false —— 那里只列队列行，
    // 用户明确要求「排除 P1、只探队列中的」（把 P1 探出来会多一条，对不上行数）。
    const includeP1 = opts.includeP1 !== false;
    if (probingAll) return { ok: false, reason: 'busy', results: [] };
    if (!llm?.stream) return { ok: false, reason: 'no-stream', results: [] };
    probingAll = true;
    router.runtime.probeInFlight = true;
    const queue = config.queue || [];
    // ⚠️ P1 槽（p1Follow 下 = 会话模型，不在 config.queue）默认一起探：旧实现只遍历
    // config.queue，P1 永远轮不到探测、面板永远灰「未测」（用户实测：P1 灰色"完全不对"）。
    // 但设置页手动「探测全部」按用户要求只探队列 → 传 includeP1:false 跳过 P1。
    // 进度按「本轮真正要探的条数」算：跳过付费时 total 不含被跳过项，否则 UI 会停在 n/(含跳过)。
    // P1 槽按**发起方会话**取：面板上的 P1 行属于当前会话，探测也必须是同一个模型。
    // 旧实现固定读全局 sessionModel(null)，于是"探测 P1 可用"可能测的是别人会话的模型。
    const probeSessionId = typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : null;
    const p1Slot = (includeP1 && config.p1Follow) ? router.sessionModelFor(probeSessionId) : null;
    // 组装待探列表（保持展示顺序：P1 在前，随后按队列序）。skipped 的付费条目
    // 直接先占位、不计入 total（它们不发请求）。
    const tasks = []; // { index, route, skipped }
    if (p1Slot) tasks.push({ index: -1, route: p1Slot, skipped: false });
    for (const [i, r] of queue.entries()) {
      if (skipPaid && r.paid === 'paid') tasks.push({ index: i, route: r, skipped: true });
      else tasks.push({ index: i, route: r, skipped: false });
    }
    const planned = tasks.filter((t) => !t.skipped).length;
    router.runtime.probeProgress = { done: 0, total: planned };
    // 逐条状态：先把所有待探路由标成 probing（前端立刻显示「探测中」），
    // 每探完一条改 done。结束后保留一会再自动淡出（见 snapshot 的惰性清理）。
    router.runtime.probeStatus = {};
    router.runtime.probeStatusUntil = null;
    for (const t of tasks) {
      if (!t.skipped) router.runtime.probeStatus[probeKey(t.route)] = { state: 'probing', ok: null };
    }
    router.touch();
    const results = [];
    let done = 0;
    // 限并发跑所有非 skipped 任务。每条落定：写结果、+1 进度、刷新快照。
    // 若某条已在别处探测中（isProbingKey），跳过它、不计数也不发请求——
    // 免得两路并发覆盖同一条证据。
    const conc = Math.max(1, Math.min(16, Math.floor(Number(config.probeConcurrency) || DEFAULT_CONFIG.probeConcurrency)));
    const runnable = tasks.filter((t) => !t.skipped);
    let cursor = 0;
    // 同一条路由在「本轮」只探一次：P1 槽和队列里可能出现同一 provider/model，
    // 用一个 in-flight Promise 表按 key 去重——后来者复用先到者的结果。
    const inflight = new Map();
    const probeShared = (route) => {
      const key = probeKey(route);
      if (inflight.has(key)) return inflight.get(key);
      const p = (async () => {
        // 若正被半开扫描探着，轮询等它落定再复用，而不是重复发请求。
        if (isProbingKey(route)) {
          for (let i = 0; i < 100 && isProbingKey(route); i += 1) {
            await new Promise((r) => setTimeout(r, 20));
          }
          return null; // 半开扫描探完会自行写证据；本批这条标 busy
        }
        probingKeys.add(key);
        try {
          return await probeOne(route);
        } finally {
          probingKeys.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    };
    const worker = async () => {
      while (cursor < runnable.length) {
        const t = runnable[cursor++];
        const ok = await probeShared(t.route);
        // revivable：探测通过了，但这条还在熔断冷却里 —— 前端据此把"可用"
        // 和"可用但被锁着"分开说，并给出「恢复」按钮。
        results.push({
          index: t.index,
          provider: t.route.provider,
          model: t.route.model,
          ok,
          skipped: false,
          ...(ok === null ? { busy: true } : {}),
          ...(ok === true && router.isRevivable(t.route) ? { revivable: true } : {}),
        });
        done += 1;
        router.runtime.probeProgress = { done, total: planned };
        // 这条探完了：逐条状态从 probing 改 done（busy 记 null，表示本轮没真探）
        if (router.runtime.probeStatus) {
          router.runtime.probeStatus[probeKey(t.route)] = { state: 'done', ok: ok === null ? null : ok === true };
        }
        router.touch(); // 每条探完就推进一次快照 → 前端能实时看到 3/7
      }
    };
    try {
      // 先补齐 skipped 占位（保持结果顺序与 UI 期望一致），再并发跑 runnable。
      for (const t of tasks) {
        if (t.skipped) results.push({ index: t.index, provider: t.route.provider, model: t.route.model, ok: null, skipped: true });
      }
      await Promise.all(Array.from({ length: Math.min(conc, runnable.length || 1) }, () => worker()));
    } finally {
      probingAll = false;
      router.runtime.probeInFlight = false;
      router.runtime.probeProgress = null; // 结束后清掉，避免下一次快照透出陈旧进度
      // done 状态不立刻清：留 PROBE_STATUS_TTL_MS 让前端显示「探测完成」再淡出。
      router.runtime.probeStatusUntil = Date.now() + (Number(config.probeStatusTtlMs) || DEFAULT_CONFIG.probeStatusTtlMs);
      router.touch();
    }
    // 结果按展示顺序（P1 在前、队列序）排好再返回，前端不依赖完成先后。
    results.sort((a, b) => a.index - b.index);
    ctx.logger?.info?.('[fallback-queue] pingAll(%s): %d probed (conc=%d)', opts.source || 'manual', results.length, conc);
    return { ok: true, results };
  }
  const probeTimer = setInterval(() => {
    try {
      const stale = router.staleHalfOpen();
      if (!stale.length) return;
      // 一次探一条，串行推进。注意 probeRoute 只有 finally、没有 catch，probeOne 的
      // 异常会 rethrow；早先用裸 `void` 丢掉这个 promise → 变成未捕获 rejection →
      // Node 24 默认 throw → 宿主进程退出。这里必须显式接住。
      probeRoute(stale[0].route).catch((e) => {
        ctx.logger?.warn?.('[fallback-queue] half-open probe failed: %s', e?.message);
      });
    } catch (e) {
      ctx.logger?.warn?.('[fallback-queue] probe tick failed: %s', e?.message);
    }
  }, 15_000);
  // 后台探测计时器不该成为阻止进程退出的理由（dispose 里另有 clearInterval）
  if (probeTimer.unref) probeTimer.unref();
  // 周期全员 ping（默认关闭：pingIntervalMs=0）。自排：**等这一轮真的跑完**再排下一轮。
  // 旧实现在触发后立刻 schedulePing()（没有 await）——注释写着"不并发"，实际却
  // 在探测还飞着的时候就排好了下一轮。队列长时一轮全员探测很容易超过间隔，
  // 于是下一轮撞上 probingAll 守卫直接返回 {reason:'busy'}，等于白排一轮；
  // 更糟的是每轮都不知道自己有没有真的探成。现在串行化：跑完 → 再排。
  let pingTimer = null;
  function schedulePing() {
    if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
    const iv = Number(config.pingIntervalMs) || 0;
    if (!(iv > 0)) return;
    pingTimer = setTimeout(async () => {
      pingTimer = null;
      try {
        await probeAllRoutes({ skipPaid: config.pingSkipPaid !== false, source: 'periodic' });
      } catch (e) {
        ctx.logger?.warn?.('[fallback-queue] periodic ping failed: %s', e?.message);
      } finally {
        // 无论成败都排下一轮（失败不能让周期探测永久停摆）；
        // 若期间配置被改成 0，schedulePing 内部会直接返回、不再排。
        schedulePing();
      }
    }, iv);
    // 探测计时器不该成为阻止进程退出的理由
    if (pingTimer.unref) pingTimer.unref();
  }
  schedulePing(); // 启动时按当前配置排（默认 0 = 关闭）
  ctx.effect(() => () => {
    clearTimeout(preflightTimer);
    clearInterval(probeTimer);
    if (pingTimer) clearTimeout(pingTimer);
  });

  // 供 Client（经 remote RPC 或事件）读取运行态快照
  ctx.effect(() => {
    // settings/document-updated 时刷新本地 config + 依新配置重排周期 ping
    return ctx.on('settings/document-updated', (ns) => {
      if (ns !== NS) return;
      loadSettings();
      schedulePing(); // pingIntervalMs 变了就立即按新间隔重排（0=关闭）
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

  /** 游标钉到实际在跑的路由；-1 = P1 槽（p1Follow 下 UI 手选的是队列外模型时就是它） */
  const runtimePin = (idx) => {
    if (Number.isInteger(idx)) router.runtime.activeIndex = idx;
  };

  /**
   * 记录「这一条请求真的发出去了」。
   * 这是「切换到底生效没有」唯一可信的证据：游标只是意图，探测只是旁证，
   * 只有宿主真的把请求交给这条 provider/model，才算切换生效。
   * 同时清掉等待位——已经有真实请求了，不再需要"等下次确认"。
   */
  const noteRequest = (index, provider, model, sessionId) => {
    // 会话隔离：真实请求证据按会话记，别的会话的「上一轮实际使用」不串到本会话。
    router.setLastRequest(sessionId, {
      index,
      provider,
      model,
      session: typeof sessionId === 'string' ? sessionId : null,
      at: Date.now(),
      state: 'sent',
      code: null,
      settledAt: null,
    });
    router.setPendingConfirm(sessionId, null);
  };

  ctx.effect(() =>
    ctx.on('agent/request', async (payload, next) => {
      // 瀑布的 next() 只能消费一次；先 await 再处理，异常直接抛给 prepareRequest。
      const cfg = await next();
      try {
        const sessionId = payload?.agent?.session?.id ?? null;
        // 方案 B：**不在这里改 provider/model**（新宿主会拒绝）。
        // selection 就是用户真正选的模型（P1），把它记成会话锚点与「上一轮实际使用」。
        // 真正的故障转移由 llm/stream 中间件（runFallbackChain）在该请求的流上完成。
        if (cfg && cfg.provider && cfg.model) {
          router.noteSessionModel(sessionId, cfg.provider, cfg.model);
          // 不在这里写 lastRequest：那只是「提案」（selection=P1），真正发出去的路由
          // 由 runFallbackChain 的 markRequest 记账。写 -1 会让面板在请求刚起步时
          // 把「上一轮 P6」闪成「正在请求 P1」，与 sticky 锚点自相矛盾。
          runtimePin(-1);
          // 不再把本会话 inFlight 重置成 -1：那会让面板在请求刚起步时把「当前」
          // 退回 selection（P1），等真正发出去才跳 P6 —— 用户看到的闪变就是它。
          lastProposal = null;
          router.runtime.lastProposal = null;
          router.touch();
        }
      } catch (e) {
        ctx.logger?.warn?.('[fallback-queue] agent/request observe failed: %s', e?.message);
      }
      return cfg;
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
      // 方案 B：真正的换路已在 llm/stream 中间件里把队列逐条试过一遍，每条路由的
      // 成败也已在那一层记进电路。这里只落「上一轮实际使用」的失败证据，然后把是否
      // 整轮重试交给下游（失败帧已带 providerRetryAfterMs，宿主不会放大成 5 次）。
      if (config.enabled && (config.queue || []).length) {
        try {
          const sid = payload?.agent?.session?.id ?? null;
          const lr = router.lastRequestFor(sid);
          if (lr && lr.state === 'sent') {
            router.setLastRequest(sid, {
              ...lr,
              state: 'fail',
              code: typeof failure?.code === 'string' && failure.code ? failure.code : 'UNKNOWN',
              settledAt: Date.now(),
            });
            router.touch();
          }
        } catch { /* ignore */ }
        return next();
      }
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
      const p1Pos = config.p1Follow ? -1 : 0;
      const actual = lastProposal ? actualRouteOf(provider, model) : -1;
      let p1OwnsFailure = true;
      if (actual >= 0) {
        runtimePin(actual);
        p1OwnsFailure = actual === p1Pos;
      } else {
        // P1 动态跟随：只有"本次提案就是 P1 槽"时才允许把找不到匹配的失败归到 P1
        // p1Follow 下只有"本次提案就是 P1 槽"才算 P1 的锅；静态模式下 P1 = queue[0]
        p1OwnsFailure = config.p1Follow
          ? (lastProposal === null || !lastProposal.overridden || lastProposal.idx === p1Pos)
          : (lastProposal === null || lastProposal.idx === 0);
        // 额外防线：失败路由若等于熔断切走后的后备模型（会话模型快照之外的），
        // 说明这是后备路由自己的失败，不能算到 P1 头上。
        const sm = router.sessionModelFor(payload?.agent?.session?.id ?? null);
        if (p1OwnsFailure && sm && (sm.provider !== provider || sm.model !== model)) {
          p1OwnsFailure = false;
        }
      }
      try {
        // 会话隔离：切换游标按会话记（payload.agent 由 agentEvents() fused 注入）
        const sessionId = payload?.agent?.session?.id ?? null;
        // 先给「最近的请求证据」落一下结果：面板上那句「上一轮实际使用」说的就是它。
        // 这一条比任何探测都硬——真实对话请求失败了，就是这条路由当时不可用。
        const lr = router.lastRequestFor(sessionId);
        if (lr && lr.state === 'sent') {
          router.setLastRequest(sessionId, {
            ...lr,
            state: 'fail',
            code: typeof failure?.code === 'string' && failure.code ? failure.code : 'UNKNOWN',
            settledAt: Date.now(),
          });
        }
        const switched = router.onFailedAttempt(provider, model, failure?.code, p1OwnsFailure, failure, sessionId);
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
        // idx === -1 = P1 槽：路由对象是会话模型本身，不在队列里，单独构造。
        let route = proposal && proposal.idx === -1
          ? router.sessionModelFor(payload?.agent?.session?.id ?? null)
          : (proposal && proposal.overridden ? queue[proposal.idx] : undefined);
        if (!route && proposal) {
          route = queue.find((r) => router.keyOf(r) === proposal.key);
        }
        if (route) router.recordSuccess(route);
        // 同一轮请求跑通了：把「最近的请求证据」标成 ok，面板据此显示
        // 「上一轮实际使用：P3 · 成功 · 12s 前」——这是切换生效的实证。
        const lr = router.lastRequestFor((payload?.agent?.session?.id) ?? null);
        if (lr && lr.state === 'sent') {
          router.setLastRequest((payload?.agent?.session?.id) ?? null, { ...lr, state: 'ok', settledAt: Date.now() });
          router.touch();
        }
      } catch {
        /* 忽略 */
      }
    }),
  );

  // ---- 方案 A：虚拟 provider（LLM 层故障转移）----
  // 注册 provider=fallback / model=auto，由 FallbackQueueAdapter 顺序尝试真实路由。
  // 只在「还没吐出可见 chunk」时换路：一旦有内容流出，会话历史已包含它，换路会
  // 产生前后矛盾的半截回答，所以必须停在那条路由上。
  /**
   * 构造「按顺序尝试」的真实路由链：会话模型（P1）优先，其次队列（纯物理序）；
   * 去重、排除自身。队列物理顺序就是尝试顺序，没有隐藏的 pinned 参与。
   */
  function buildFallbackChain(sessionId) {
    const queue = config.queue || [];
    const list = [];
    const seen = new Set();
    const push = (r) => {
      if (!r || !r.provider || !r.model) return;
      const k = `${r.provider}\u0000${r.model}`;
      if (seen.has(k)) return;
      seen.add(k);
      list.push({ provider: r.provider, model: r.model });
    };
    // 环位置：p1Follow 下 P1 槽是 -1，其余是队列下标；静态模式下就是 0..n-1。
    const p1Pos = config.p1Follow ? -1 : 0;
    const ring = config.p1Follow ? [-1, ...queue.map((_, i) => i)] : queue.map((_, i) => i);
    const routeAt = (pos) => (pos === -1 ? router.sessionModelFor(sessionId) : queue[pos]);
    // 起步位置（按会话隔离）：
    //  1) 本会话有手动目标 → 从手动目标起跑（用户明确指定，最高优先级）；
    //  2) 否则从「本会话锚点」起跑——锚点 = 上一轮真正作答成功的那条路由
    //     （sessionCursor，按会话隔离）。粘滞策略下 P6 可用就一直从 P6 起跑，
    //     不再每条消息都重撞 P1、造成面板先闪 P1 再跳回 P6；
    //  3) 都没有 → P1 槽（p1Follow）或队列头（静态）。
    const manual = router.manualFor(sessionId);
    const cursorPos = router.cursorFor(sessionId).activeIndex;
    let startPos = p1Pos;
    if (Number.isInteger(manual) && (manual === -1 || queue[manual])) {
      startPos = manual;
    } else if (Number.isInteger(cursorPos) && (cursorPos === -1 || queue[cursorPos])) {
      startPos = cursorPos;
    }
    // 探测回切（probe）：锚点不在 P1、且 P1 已恢复可用了，并且距上次切走已过
    // failbackDelayMs 防抖 → 本轮先从 P1 试一次（由真实请求顺带验证，不额外烧探测）。
    // 粘滞（sticky）不自动回 P1；手动回切（manual）永不自动回 P1。
    if (startPos !== p1Pos && config.failbackMode === 'probe') {
      const p1Route = routeAt(p1Pos);
      const switchedAt = router.lastSwitchFor(sessionId)?.at || 0;
      const delay = Number(config.failbackDelayMs) || 0;
      const debounced = delay > 0 && switchedAt > 0 && (Date.now() - switchedAt) < delay;
      if (!debounced && p1Route && router.isAvailable(p1Route, Date.now())) startPos = p1Pos;
    }
    const startAt = ring.indexOf(startPos);
    const order = startAt >= 0 ? [...ring.slice(startAt), ...ring.slice(0, startAt)] : ring;
    for (const pos of order) push(routeAt(pos));
    // 兜底：非 p1Follow 且链意外为空时，用会话模型补一条（不该发生）。
    if (list.length === 0) push(router.sessionModelFor(sessionId));
    return list;
  }

  /**
   * 过滤掉熔断中的路由，并显式告诉调用方「是不是全军覆没」。
   *
   * 旧实现在全熔断时直接返回**原链**，本意是"让用户看到真实错误而不是空响应"，
   * 代价是每条消息都把整条链重打一遍：
   *  - 用户实测：发一条「你好」，面板从 2 个可用瞬间变成全红；
   *  - 更糟的是每条路由的 openedAt 都被刷新，60s 冷却永远滑不到头，
   *    等于"越失败越锁死"。
   * 所以这里返回 { chain, melted }，由 runFallbackChain 决定"全熔断只试一条"。
   *
   * @param {Array<{provider:string, model:string}>} chain
   * @returns {{chain: Array, melted: boolean}}
   */
  function availableFallbackChain(chain) {
    const now = Date.now();
    const live = chain.filter((r) => router.isAvailable(r, now));
    if (live.length) return { chain: live, melted: false };
    return { chain: [], melted: chain.length > 0 };
  }

  /**
   * 全熔断时的唯一候选：**冷却最早到期**的那条（最先可能恢复）。
   *
   * 为什么还要发一条而不是直接报错：熔断只是本地记账，路由本身可能早就好了；
   * 发一条既能让用户看到上游的真实错误（而不是我们编的"全部熔断"），
   * 又能给这条路由一次自然恢复的机会。选最早到期的，是因为它对"现在可能已经好了"
   * 的置信度最高，而且只刷新这一条的冷却，其余几条照常倒计时。
   */
  function soonestRecoveringRoute(chain) {
    let best = null;
    let bestAt = Infinity;
    for (const r of chain) {
      const c = router.circuits.get(router.keyOf(r));
      // 没有电路记录 = 从没失败过，理论上不会走到这里；给 0 让它排最前。
      const at = c && c.state === CIRCUIT.OPEN ? (c.openedAt || 0) + config.cooldownMs : 0;
      if (at < bestAt) {
        bestAt = at;
        best = r;
      }
    }
    return best;
  }

  /**
   * 子请求参数：换成真实路由，剥掉上一台模型的推理档位/输出上限，并适配历史 thinking。
   *
   * 换路由时必须重算适配器默认值：maxTokens 是 P1 适配器物化出来的（DeepSeek 256k），
   * 原样带给上限更低的网关会 400；reasoningEffort 是上一台模型的能力选择，目标模型
   * 可能不认。历史里的 thinking 跨适配器带不过去，对严格 thinking 的目标摘掉 text（见
   * adaptMessagesForRoute）。
   */
  function subCallOptions(options, route) {
    return routeCallOptions(options, route, config, {
      onAdapted: (count) => ctx.logger?.info?.(
        '[fallback-queue] route %s/%s: dropped text from %d assistant message(s) whose thinking cannot replay across adapters',
        route.provider,
        route.model,
        count,
      ),
    });
  }

  /**
   * 给失败帧补上「多久之后再试」的提示（providerRetryAfterMs）。
   *
   * 上游只在**报文文本**里给恢复时刻（bili 闸门："holding outbound sends until
   * 2026-11-08T06:15:51.683Z"），适配层不会把它翻译成 providerRetryAfterMs —— 于是
   * 宿主 dsh-llm-retry 只能按本地 500ms 起步的指数退避重试 5 次，而每次重试都要
   * 把整条 fallback 链重新扫一遍：一次用户消息 = 链长 × 6 次 429。
   *
   * 把恢复时刻换算成 providerRetryAfterMs 交给宿主，dsh-llm-retry 的 normal 策略
   * 会因 `providerRetryAfterMs > maxDelayMs` 直接放弃这次重试，放大链条当场断掉。
   * 上游本来就给了更准的信息，没有理由不用。
   *
   * @param {object} chunk 失败终态帧
   * @returns {object} 原帧，或补了 providerRetryAfterMs 的副本（不改原对象）
   */
  function withRetryHint(chunk) {
    const failure = chunk?.reason?.failure;
    if (!failure || typeof failure !== 'object') return chunk;
    // 适配层已经给出等待时长时尊重它，不覆盖
    if (Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) return chunk;
    const resetAt = parseResetAt(failure.message);
    if (!resetAt) return chunk;
    const waitMs = resetAt - Date.now();
    if (!(waitMs > 0)) return chunk;
    return { ...chunk, reason: { ...chunk.reason, failure: { ...failure, providerRetryAfterMs: waitMs } } };
  }

  // 内部子请求的 options 对象集合：llm/stream 监听器看到它们直接放行，避免递归包裹。
  const internalStreamOptions = new WeakSet();

  async function* runFallbackChain(options) {
    const sessionId = options?.sessionId ?? null;
    const full = buildFallbackChain(sessionId);
    // 插件关闭时不应继续故障转移：只走第一条（P1 会话模型），把行为交还给正常路径。
    // 全熔断时也只试一条（冷却最早到期的）——见 availableFallbackChain 的注释：
    // 旧行为是"整链再打一遍"，用户看到的就是"发一条消息，2 个可用变全红"。
    let chain;
    let allMelted = false;
    if (config.enabled) {
      const picked = availableFallbackChain(full);
      chain = picked.chain;
      allMelted = picked.melted;
      if (allMelted) {
        const one = soonestRecoveringRoute(full);
        chain = one ? [one] : [];
      }
    } else {
      chain = full.slice(0, 1);
    }
    if (chain.length === 0) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: '故障转移队列为空：没有可尝试的路由' } } };
      return;
    }
    // 全熔断时的单发候选不是"可用路由"，面板要如实标成"仍在冷却里试一发"，
    // 否则用户会以为插件又偷偷把整条链扫了一遍。
    if (allMelted) {
      ctx.logger?.info?.('[fallback-queue] all routes tripped; trying only %s/%s (cooldown)', chain[0].provider, chain[0].model);
    }
    let lastFailure = null;
    let lastError = null;
    // 本轮已经试过几条：面板要用它说清「这一轮是第 6 条兜底答的，前面跳过了 5 条」，
    // 否则用户只能看到模型名还挂在 P1 上、以为 P1 在干活。
    let attempts = 0;
    for (const route of chain) {
      attempts += 1;
      if (options?.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: '请求已取消' } } };
        return;
      }
      // 面板「上一轮实际使用」要显示真正接管的这条真实路由，而不是虚拟的 fallback/auto。
      const routeKey = router.keyOf(route);
      const sm = router.sessionModelFor(sessionId);
      const routeIdx = sm && sm.provider === route.provider && sm.model === route.model
        ? -1
        : (config.queue || []).findIndex((r) => router.keyOf(r) === routeKey);
      const markRequest = (state, code) => {
        // 实际发出去的是哪条，就把本会话的 inFlight 指到哪条：面板的「当前」在
        // 请求进行中（还没有 ok 记录）也要显示这条，而不是回退到 selection=P1。
        router.setInFlight(sessionId, routeIdx);
        router.setLastRequest(sessionId, {
          index: routeIdx,
          provider: route.provider,
          model: route.model,
          session: sessionId,
          at: Date.now(),
          state,
          code: code ?? null,
          // 「前面还有几条没接住」：按整条链的位置算（含熔断被跳过、没真正试的），
          // 这样面板说的「跳过 N 条」与用户看到的 P 编号对得上。
          skipped: Math.max(0, full.indexOf(route)),
          attempts,
          settledAt: state === 'sent' ? null : Date.now(),
        });
        router.setPendingConfirm(sessionId, null);
        router.touch();
      };
      markRequest('sent');
      let sub;
      try {
        const subOpts = subCallOptions(options, route);
        internalStreamOptions.add(subOpts);
        sub = llm.stream(subOpts);
      } catch (e) {
        lastError = e;
        router.recordFailure(route, e?.code || 'UNKNOWN', e?.message, null, e?.status);
        markRequest('fail', e?.code || 'UNKNOWN');
        continue;
      }
      let yieldedVisible = false;
      let finished = false;
      try {
        for await (const chunk of sub) {
          const isFinish = chunk?.type === 'finish';
          const kind = chunk?.reason?.kind;
          const failedFinish = isFinish && (kind === 'error' || kind === 'aborted');
          if (!yieldedVisible && failedFinish) {
            // 补上「多久之后再试」：上游把恢复时刻写在报文里，宿主读不到就只能按
            // 本地退避重试 5 次，每次重试又把整链重新扫一遍（放大链长 × 6 倍）。
            lastFailure = withRetryHint(chunk);
            const f = lastFailure.reason?.failure || {};
            router.recordFailure(route, f.code || 'UNKNOWN', f.message, f.providerRetryAfterMs, f.status);
            markRequest('fail', f.code || 'UNKNOWN');
            break; // 还没出内容 → 换下一条
          }
          if (!isFinish && chunk?.type && chunk.type !== 'usage') yieldedVisible = true;
          yield chunk;
          if (isFinish) {
            finished = true;
            if (!failedFinish) {
              router.recordSuccess(route);
              // 锚点：本轮哪条真正作答，下一轮就从哪条起跑（按会话隔离）。
              router.setCursor(sessionId, routeIdx);
              markRequest('ok');
            }
            return;
          }
        }
      } catch (e) {
        // 防御：adapterStream 本应把 adapter 异常转成 finish，但这里再兜一层。
        lastError = e;
        router.recordFailure(route, e?.code || 'UNKNOWN', e?.message, null, e?.status);
        markRequest('fail', e?.code || 'UNKNOWN');
        if (yieldedVisible) {
          // 已吐过可见内容：不能换路（半截回答），但必须把错误终态交给下游，不能悄悄结束。
          yield withRetryHint({
            type: 'finish',
            reason: { kind: 'error', failure: { code: e?.code || 'UNKNOWN', message: e?.message || '流中途失败' } },
          });
          finished = true;
          return;
        }
      } finally {
        if (!finished && typeof sub?.interrupt === 'function') {
          try { await sub.interrupt(); } catch { /* ignore */ }
        }
      }
      if (yieldedVisible) {
        // 已吐内容后子流正常结束却没有 finish：补一个 stop 终态，避免下游挂起。
        router.recordSuccess(route);
        router.setCursor(sessionId, routeIdx);
        markRequest('ok');
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
    }
    if (lastFailure) {
      yield lastFailure;
      return;
    }
    yield {
      type: 'finish',
      reason: {
        kind: options?.signal?.aborted ? 'aborted' : 'error',
        failure: { code: lastError?.code || 'UNKNOWN', message: lastError?.message || '队列全部路由均不可用' },
      },
    };
  }

  // ---- 方案 B：llm/stream 中间件 ----
  // 对「带 sessionId 的 agent 步骤请求」做故障转移：保持 selection 不变（用户选的
  // 真实模型 = P1），但把这条请求的 chunk 流换成「先 P1、失败再按队列物理序」的包装。
  // 探测 / 内部子请求没有 sessionId（或已被 internalStreamOptions 标记）→ 直接 next()。
  ctx.effect(() => ctx.on('llm/stream', (options, next) => {
    try {
      if (!config.enabled) return next();
      if (!(config.queue && config.queue.length)) return next();
      if (!options || typeof options !== 'object') return next();
      if (internalStreamOptions.has(options)) return next(); // 我们自己发起的子请求，别再包
      const sessionId = options.sessionId;
      if (typeof sessionId !== 'string') return next(); // 只拦 agent 步骤（带 sessionId）
      // 兜底：正常 agent/request 已把 P1 写进会话锚点；万一没写，用本请求的
      // provider/model 补一次（它就是用户此刻选的模型），否则 P1 槽会从链里丢掉。
      if (!router.sessionModelFor(sessionId) && options.provider && options.model) {
        router.noteSessionModel(sessionId, options.provider, options.model);
      }
      return runFallbackChain(options);
    } catch (e) {
      ctx.logger?.warn?.('[fallback-queue] llm/stream wrap failed: %s', e?.message);
      return next();
    }
  }), 'fallback-queue llm/stream middleware');

  // ---- 启动加载设置 ----
  ctx.effect(() => {
    void (async () => {
      const legacyQueue = await loadSettings();
      await loadQueue(legacyQueue);
      // ⚠️ 必须在这里**无条件**再排一次周期探测。
      // apply 体里的 schedulePing()（前半区）跑在 loadSettings() 之前，那时
      // config.pingIntervalMs 还是 Config 默认值；而 settings 文档才是真源，
      // settings/document-updated 又只在 UI 保存时才触发。于是「配置文件里预置
      // pingIntervalMs: 60000、重启后从不保存」的路径永远排不上周期探测——
      // 用户实测 70 秒无任何探测（维护者评审必修 2）。
      schedulePing();
    })().catch((e) => ctx.logger?.warn?.('[fallback-queue] boot load failed: %s', e?.message));
  });
  // ---- 运行态 RPC 服务 ----
  serviceBridge = { router, config, saveSettings, saveQueue, probeAllRoutes, probeRoute, probeRealRoute };
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
  pingIntervalMs: s.number().default(DEFAULT_CONFIG.pingIntervalMs).description('周期全员 ping 间隔毫秒（0=关闭）').volatile(),
  pingSkipPaid: s.boolean().default(DEFAULT_CONFIG.pingSkipPaid).description('周期扫描跳过付费条目（省配额）').volatile(),
  // 探测请求的 maxTokens。太小会被一部分网关按 400 拒绝（"max_tokens must be >= N"），
  // 于是「能正常对话的模型」长期显示探测失败——默认 8 是为了让探测请求本身合法。
  pingMaxTokens: s.number().default(DEFAULT_CONFIG.pingMaxTokens).description('探测请求的 maxTokens（默认 8；过小会被部分网关 400 拒绝）').volatile(),
  probeConcurrency: s.number().default(DEFAULT_CONFIG.probeConcurrency).description('「探测全部」并发数（默认 4；越大越快但更易触发网关限流）').volatile(),
  // 跨路由历史适配：这些 provider 要求 tool-call 的 assistant 消息带 thinking 块，
  // 跨适配器切换时宿主会丢 reasoning，于是下发前把该消息的 text 块摘掉（见 index.js）。
  strictThinkingProviders: s.array(s.string()).default(DEFAULT_CONFIG.strictThinkingProviders).description('要求 tool-call assistant 消息带 thinking 的 provider；跨路由时摘掉其 text 块').volatile(),
  // provider → 原生 replayState.response.kind，用于判断历史 thinking 能否被目标重放。
  nativeReplayKinds: s.array(s.string()).default(DEFAULT_CONFIG.nativeReplayKinds).description('provider=原生 replay kind（例如 deepseek-official=deepseek-messages），用于判断历史 thinking 能否重放').volatile(),
});
