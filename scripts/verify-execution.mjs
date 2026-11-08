/**
 * 执行验证（execution test）：真的 import 插件、真的调 apply()、真的发探测。
 *
 * 与另外两个脚本的分工：
 *  - verify-health-colors.mjs : 读源码做正则断言（快，能钉住"某段代码还在"）
 *  - test-queue-order.mjs     : 截出纯函数直接跑（能钉住"算法算得对"）
 *  - verify-execution.mjs     : 装配整套插件跑起来（能钉住"它在真实流程里真的能用"）
 *
 * 为什么必须有这一层：PR 里那两条必修 bug（pingAll 参数声明不匹配、周期探测
 * 启动时序）**都不会让源码断言失败**——代码看起来完全正常，只是运行时被网关
 * 拒绝、或永远排不上定时器。只有真跑一遍才抓得到。
 *
 * ⚠️ 本脚本会调 setQueue → 插件把队列写到 $DSH_HOME/fallback-queue-state.json。
 * 而 dsh-home-paths 默认把 DSH_HOME 解析成真实的 ~/.dsh → 直接跑这个脚本会
 * **覆盖用户自己的故障转移队列**（实测：跑完真实文件变成测试夹具
 * {provider:"p", model:"auth"}，且无备份、无法从磁盘恢复）。
 * 所以下面第一件事就是把 DSH_HOME 指向一次性临时目录，测试只脏临时目录。
 *
 * 前置：node scripts/prepare-test-deps.mjs
 * 用法：node scripts/verify-execution.mjs
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ---- 隔离用户数据：必须在 import index.js 之前设好 ----
// state.js 的 statePath() 第一次调用时才会读 env 并缓存，所以这里设完即生效。
const TEST_HOME = join(tmpdir(), `dsh-fallback-queue-test-${process.pid}`);
process.env.DSH_HOME = TEST_HOME;
mkdirSync(TEST_HOME, { recursive: true });
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const results = [];
function ok(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
}

// 取出消息 content 里的纯文本。探测体必须是 block 数组（[{type:'text',text}]），
// 不能是裸字符串——宿主 pi-ai 适配层会对 content 调 .some()，字符串会抛 TypeError。
// 这里同时兼容数组与字符串，用来既读文本、又断言"实际发出去的是什么形状"。
function contentText(content) {
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' ? String(b.text ?? '') : '')).join('');
  }
  return String(content ?? '');
}

// ---- 假 llm：按模型名返回不同的终态，复现四种真实上游行为 ----
const BEHAVIOURS = {
  good: { kind: 'content' },
  auth: { kind: 'error', code: 'AUTH', message: 'invalid api key' },
  empty: { kind: 'empty' },
  rej400: { kind: 'error', code: 'INVALID_REQUEST', message: 'unsupported parameter', status: 400 },
  // 带 "15s" 是刻意的：恢复时刻解析必须只认「在等什么」的措辞，不能把普通超时
  // 文案里的时长读成"15 秒后恢复"。
  slow: { kind: 'error', code: 'TIMEOUT', message: 'upstream timeout after 15s' },
  // 复现用户真机那条：网关嫌 max_tokens 太小直接 400，于是一条能正常对话的模型
  // 在面板上长期"探测失败"。这条假上游就是那个网关的替身。
  tiny: { kind: 'min-tokens', min: 8 },
  // 方案 A 用：先吐一个字再报错——用来验证「已出可见内容后不许换路」。
  partial: { kind: 'partial' },
  // 能力不匹配：模型不支持调用方要求的推理档位（宿主本地就会拒绝）。
  capbad: { kind: 'error', code: 'UNSUPPORTED_REASONING_EFFORT', message: 'does not support reasoning effort "balanced"' },
  // 方案 A P0：复现 2026-11-08 真机的网关闸门。上游限流 1 次后 bili 全局 hold，
  // 报错把恢复时刻写在**报文文本**里（适配层不会翻译成 providerRetryAfterMs）。
  // holdMs 在每次请求时动态算，固定时刻会过期，过期后断言就测不到东西了。
  hold: { kind: 'throttle-hold', holdMs: 180_000 },
};
function makeStream({ provider, model, maxTokens, messages, reasoningEffort, signal }, calls, reqs) {
  if (calls) calls.push(`${provider}/${model}`);
  // 完整请求留档：maxTokens / messages 这类"探测体形状"只能靠它验
  if (reqs) reqs.push({ provider, model, maxTokens, messages, reasoningEffort });
  let b = BEHAVIOURS[model] || { kind: 'content' };
  if (b.kind === 'min-tokens') {
    b = (Number(maxTokens) || 0) < b.min
      ? { kind: 'error', code: 'INVALID_REQUEST', message: `max_tokens must be >= ${b.min}`, status: 400 }
      : { kind: 'content' };
  }
  if (b.kind === 'throttle-hold') {
    const until = new Date(Date.now() + b.holdMs).toISOString();
    b = {
      kind: 'error',
      code: 'RATE_LIMIT',
      status: 429,
      // 原文照抄真机报文：恢复时刻是 ISO 8601，剩下的是"还要等多久"的冗余描述。
      message: `429: {"type":"rate_limit_error","code":"bili_throttle_hold","stage":"forward","message":"upstream rate-limited 1 consecutive request(s) to 192.168.31.4:3425; bili is holding outbound sends until ${until} (~180s, exponential backoff) instead of amplifying — zero egress while held, auto-resumes when the limit clears (#4204)","retryable":true}`,
    };
  }
  const ac = new AbortController();
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  const chunks = [];
  if (b.kind === 'content') {
    chunks.push({ type: 'text-delta', text: 'p' });
    chunks.push({ type: 'finish', reason: { kind: 'stop' } });
  } else if (b.kind === 'partial') {
    chunks.push({ type: 'text-delta', text: 'p' });
    chunks.push({ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'quota exhausted mid-stream' } } });
  } else if (b.kind === 'empty') {
    /* 一个帧都不给 → EMPTY_RESPONSE */
  } else {
    chunks.push({ type: 'finish', reason: { kind: 'error', failure: { code: b.code, message: b.message, status: b.status } } });
  }
  return {
    async *[Symbol.asyncIterator]() {
      // 25ms 延迟模拟网络往返：瞬时返回会让"探测进度"窗口窄到任何轮询都抓不到，
      // 那样测出来的"进度不可观测"是测试假象，不是实现缺陷。
      await new Promise((r) => setTimeout(r, 25));
      for (const c of chunks) { if (ac.signal.aborted) return; yield c; }
    },
    async interrupt() { ac.abort(); return true; },
  };
}
/**
 * 每个场景一份独立的假 llm：它自带 calls 数组。
 * 这样"手动探测探了几条"与"后台周期探测探了几条"天然隔离——
 * 用同一个全局计数器会让周期 timer 的调用混进手动断言里（假阳性）。
 */
function makeLlm() {
  const calls = [];
  const reqs = [];
  return {
    calls,
    reqs,
    stream: (req) => makeStream(req, calls, reqs),
    listProviders: () => [{ id: 'prov' }],
  };
}

// ---- 假宿主 ----
function makeCtx(settingsValue, injectedLlm) {
  const doc = { ns: 'dsh-model-fallback-queue', revision: 1, value: { ...settingsValue } };
  const events = [];
  // 钩子表：agent/request 与 agent/request-error 的瀑布必须能被真实调用，
  // 否则"覆盖路由时剥档位"这种逻辑只能靠读源码断言——那测不到真实流程。
  const hooks = {};
  const ctx = {
    settings: {
      describe: () => [doc],
      update: async (ns, patch) => { Object.assign(doc.value, patch); doc.revision += 1; return { ok: true, value: doc }; },
    },
    logger: {
      info: (...a) => events.push(['info', ...a]),
      warn: (...a) => events.push(['warn', ...a]),
      debug: () => {},
    },
    on: (name, fn) => { hooks[name] = fn; return () => {}; },
    effect: (fn) => { fn(); return () => {}; },
    plugin: (p) => {
      const Ctor = p && (p.default || p);
      if (typeof Ctor === 'function') {
        try { ctx.__service = new Ctor(ctx, {}); } catch (e) { events.push(['warn', 'svc ctor failed', e.message]); }
      }
      return () => {};
    },
    get: (name) => (name === 'llm' ? injectedLlm : undefined),
    llm: injectedLlm,
    emit: () => {},
    // ⚠️ cordis 的 Service 基类构造函数会调 ctx.reflect.provide(name, self, check)。
    // 少了它 → new FallbackQueueService() 抛错 → ctx.__service 恒 undefined →
    // 下面所有依赖 svc 的断言（必修1/必修2 的运行时验证）被 `if (svc)` 整块跳过，
    // 脚本却只报「7/9 项通过」——看上去有绿灯，其实最关键的断言一条都没跑。
    reflect: { provide: () => {} },
  };
  return { ctx, doc, events, hooks };
}

const mod = await import(join(root, 'index.js'));
ok('index.js 可被真实 import', typeof mod.apply === 'function');

// ================= 场景 A：插件能装配 =================
{
  const { ctx } = makeCtx({ enabled: true }, makeLlm());
  let threw = null;
  let plug = null;
  try { plug = mod.apply(ctx, { enabled: true }); } catch (e) { threw = e; }
  ok('apply(ctx, config) 不抛', threw === null, threw?.message || '');
  ok('apply 返回 router 句柄', !!plug?.router);
  // 必须能从 ctx 拿到 llm（旧实现把第二参当 llm，拿到的是 Config 对象）
  ok('llm 从 ctx 取到（不是第二参）', typeof ctx.llm?.stream === 'function');
}

// ================= 场景 B：必修 2 —— 配置预置的周期间隔必须真的排上 =================
// 复现维护者的实测：配置文件写着 pingIntervalMs=60000、从未在 UI 保存过、重启。
// 旧实现里 schedulePing() 跑在 loadSettings() 之前，读到默认值 0 直接 return；
// settings/document-updated 又只在 UI 保存时触发 → 周期探测永远排不上。
//
// ⚠️ 判据不能是"存在活跃 timer"：插件本来就有 15s 的 probeTimer 和 60s 的
// 预检定时器，timer 数恒为正——那样断言在 bug 还原后照样通过（测不出问题）。
// 唯一有区分力的判据：**周期探测是否真的发生了**（假 llm 被调用）。
// 把间隔设成极小值，等一小会儿，看 llm.stream 有没有被周期探针调起来。
{
  const slog = makeLlm();
  const { ctx } = makeCtx({
    enabled: true,
    pingIntervalMs: 40,        // 40ms 一轮 → 几百毫秒内必然触发，且不依赖 UI 保存
    pingSkipPaid: false,
  }, slog);
  mod.apply(ctx, { enabled: true });
  // 先放一条队列，否则周期探测没东西可探
  await new Promise((r) => setTimeout(r, 120));
  if (ctx.__service) {
    await ctx.__service.setQueue([{ provider: 'p', model: 'good', paid: 'free' }]);
  }
  const before = slog.calls.length;
  await new Promise((r) => setTimeout(r, 400)); // 等至少一整轮周期探测
  const after = slog.calls.length;
  ok('必修2：settings 预置的间隔真的驱动了周期探测',
    after > before, `probe calls before=${before} after=${after}`);
}

// ================= 场景 C/D：必修 1 —— pingAll 真的能跑 =================
{
  const cllm = makeLlm();
  const { ctx } = makeCtx({ enabled: true, pingIntervalMs: 0, pingSkipPaid: false }, cllm);
  mod.apply(ctx, { enabled: true });
  await new Promise((r) => setTimeout(r, 200));

  const svc = ctx.__service;
  ok('RPC 服务已实例化', !!svc);
  if (svc) {
    // 声明与实现参数个数必须一致：声明错了会让网关拒绝调用（维护者实测的
    // "expected 1 argument(s), got 0"）。现在二者都是 1 个（sessionId，可为 undefined）。
    ok('pingAll 实现声明 1 个形参（与 RPC 声明一致）', svc.pingAll.length === 1, `length=${svc.pingAll.length}`);

    const queue = [
      { provider: 'p', model: 'good', paid: 'free' },
      { provider: 'p', model: 'auth', paid: 'free' },
      { provider: 'p', model: 'empty', paid: 'free' },
      { provider: 'p', model: 'rej400', paid: 'paid' },
      { provider: 'p', model: 'slow', paid: 'paid' },
    ];
    const setRes = await svc.setQueue(queue);
    ok('setQueue 接受队列', setRes?.ok !== false);
    cllm.calls.length = 0; // 只数这次手动探测

    // 探测进行中必须能观测到真实进度（不是恒 0）
    let sawProgress = null;
    const poll = setInterval(async () => {
      try {
        const snap = await svc.snapshot();
        if (snap?.probingAll) sawProgress = { done: snap.probingDone, total: snap.probingTotal };
      } catch { /* 忽略轮询抖动 */ }
    }, 3);

    const pingRes = await svc.pingAll();
    clearInterval(poll);
    const manualCalls = cllm.calls;

    ok('pingAll 返回 ok:true', pingRes?.ok === true, pingRes?.reason || '');
    // 手动探测必须全探：旧默认 pingSkipPaid=true 会让整条付费队列永远"未测"
    ok('手动探测不跳过付费（5 条全探）', manualCalls.length === 5,
      `calls=${manualCalls.length}`);
    ok('探测进度出现真实 done/total', sawProgress !== null && sawProgress.total === 5, JSON.stringify(sawProgress));

    const byModel = Object.fromEntries((pingRes?.results || []).map((r) => [r.model, r.ok]));
    ok('正常路由 → 可用', byModel.good === true, JSON.stringify(byModel));
    ok('AUTH 失效 → 不可用（旧实现会判成健康，比不探更危险）', byModel.auth === false);
    ok('空响应 → 不可用（不冒充可用）', byModel.empty === false);
    ok('上游超时 → 不可用', byModel.slow === false);
    ok('探测体被 400 拒 → 不可用', byModel.rej400 === false);

    const snapAfter = await svc.snapshot();
    const opened = (snapAfter?.entries || []).filter((e) => e.state === 'open').length;
    // 监控不能把自己监控死：探测失败只记证据，不许累计熔断
    ok('探测失败不会自己熔断路由', opened === 0, `open=${opened}`);
    ok('探测结束后进度已清空', snapAfter?.probingAll === false);
  }
}

// ================= 场景 S：探测体的大小 + 「用真实请求验证」 =================
// 用户真机现象：P5（本地 780k 模型）确定能用，但每次探测都显示"不可用"。
// 根因候选之一就是探测体形状——maxTokens=1 被网关 400 拒绝，于是"探测失败"
// 冒充了"模型不可用"。这一组把两条路都钉住：
//   S1 默认探测体是 8（不是 1），同一条"挑剔网关"上的模型能被判活
//   S2 探测体被拒时记成「探测不支持」（灰），既不刷绿也不冒充黄色风险
//   S3 real 模式发普通问话、maxTokens=32，且不被"形状被拒"豁免
{
  // —— S1：默认 8 → 挑剔网关放行 ——
  const llmA = makeLlm();
  const { ctx: ctxA } = makeCtx({ enabled: true, pingIntervalMs: 0, pingSkipPaid: false }, llmA);
  mod.apply(ctxA, { enabled: true });
  await new Promise((r) => setTimeout(r, 150));
  const svcA = ctxA.__service;
  await svcA.setQueue([{ provider: 'p', model: 'tiny' }]);
  llmA.calls.length = 0;
  llmA.reqs.length = 0;
  const pingA = await svcA.pingAll();
  ok('默认探测体 maxTokens=8（不是历史默认的 1）', llmA.reqs[0]?.maxTokens === 8,
    `maxTokens=${llmA.reqs[0]?.maxTokens}`);
  ok('挑剔网关（要求 max_tokens>=8）下的模型能被判活', pingA?.results?.[0]?.ok === true,
    JSON.stringify(pingA?.results?.[0]));
  // 回归：ping 探测请求的 content 必须是 block 数组。裸字符串会被 0.2.2-rc.1 的
  // pi-ai 适配层（assertSupportedHistory 调 content.some()）整条拒掉，表现为
  // 用户看到的「点击探测全部，所有路由都探测失败」。
  ok('ping 探测请求 content 是 block 数组（不是裸字符串）',
    Array.isArray(llmA.reqs[0]?.messages?.[0]?.content)
      && llmA.reqs[0].messages[0].content[0]?.type === 'text',
    JSON.stringify(llmA.reqs[0]?.messages?.[0]?.content));

  // —— S2：把探测体改回 1 → 被 400 拒 → 「探测不支持」，不是黄色风险 ——
  const llmB = makeLlm();
  const { ctx: ctxB } = makeCtx({ enabled: true, pingIntervalMs: 0, pingSkipPaid: false, pingMaxTokens: 1 }, llmB);
  mod.apply(ctxB, { enabled: true });
  await new Promise((r) => setTimeout(r, 150));
  const svcB = ctxB.__service;
  await svcB.setQueue([{ provider: 'p', model: 'tiny' }]);
  llmB.reqs.length = 0;
  const pingB = await svcB.pingAll();
  ok('显式把探测体设成 1 时确实按 1 发（配置生效）', llmB.reqs[0]?.maxTokens === 1,
    `maxTokens=${llmB.reqs[0]?.maxTokens}`);
  const entryB = (await svcB.snapshot())?.entries?.[0];
  ok('探测体被 400 拒 → 记「探测不支持」而不是真实故障',
    entryB?.probeError?.code === 'PROBE_UNSUPPORTED', `code=${entryB?.probeError?.code}`);
  ok('探测体被拒时 probeOk=null（UI 走灰色「未测」，不冒充黄色风险）',
    entryB?.probeOk === null, `probeOk=${JSON.stringify(entryB?.probeOk)}`);
  ok('探测体被拒仍如实返回 ok:false', pingB?.results?.[0]?.ok === false);

  // —— S3：用真实请求验证（real 模式）——
  const llmC = makeLlm();
  const { ctx: ctxC } = makeCtx({ enabled: true, pingIntervalMs: 0, pingSkipPaid: false }, llmC);
  mod.apply(ctxC, { enabled: true });
  await new Promise((r) => setTimeout(r, 150));
  const svcC = ctxC.__service;
  await svcC.setQueue([
    { provider: 'p', model: 'good' },
    { provider: 'p', model: 'rej400' },
  ]);
  llmC.reqs.length = 0;

  const realOk = await svcC.probeReal(0);
  ok('probeReal 走真实请求并拿到回执', realOk?.ok === true && realOk?.receipt?.ok === true,
    JSON.stringify(realOk?.receipt));
  ok('real 模式 maxTokens=32（不是微型探测体）', llmC.reqs.at(-1)?.maxTokens === 32,
    `maxTokens=${llmC.reqs.at(-1)?.maxTokens}`);
  ok('real 模式发的是一句普通问话',
    /OK/.test(contentText(llmC.reqs.at(-1)?.messages?.[0]?.content)),
    contentText(llmC.reqs.at(-1)?.messages?.[0]?.content).slice(0, 40));
  ok('real 模式 content 也是 block 数组（不是裸字符串）',
    Array.isArray(llmC.reqs.at(-1)?.messages?.[0]?.content)
      && llmC.reqs.at(-1).messages[0].content[0]?.type === 'text',
    JSON.stringify(llmC.reqs.at(-1)?.messages?.[0]?.content));
  ok('real 模式回执带耗时', Number(realOk?.receipt?.latencyMs) >= 0, `latencyMs=${realOk?.receipt?.latencyMs}`);

  const realBad = await svcC.probeReal(1);
  ok('real 模式不会被"形状被拒"豁免（真实 400 就是 400）',
    realBad?.receipt?.rejected === false && realBad?.receipt?.code === 'INVALID_REQUEST',
    JSON.stringify(realBad?.receipt));
  const entryC = (await svcC.snapshot())?.entries?.[1];
  ok('real 失败记成真实故障码（不是 PROBE_UNSUPPORTED）',
    entryC?.probeError?.code === 'INVALID_REQUEST' && entryC?.probeOk === false,
    `code=${entryC?.probeError?.code} probeOk=${JSON.stringify(entryC?.probeOk)}`);
}

// ================= 场景 F：方案B —— 子请求剥档位；能力不匹配不算路由死亡 =========
// 方案B 里 agent/request 不再覆盖路由（只观测），真正换路发生在 llm/stream 中间件。
// 因此"覆盖到队列路由必须剥掉 reasoningEffort"这条语义现在落在 runFallbackChain 的
// subCallOptions 里；能力不匹配（模型不支持档位）仍要让链继续往下走，但**不能**把
// 那条路由记成熔断（模型本身没坏，换个支持档位的模型就能救这一轮）。
{
  const fllm = makeLlm();
  const { ctx, hooks } = makeCtx({ enabled: true, pingIntervalMs: 0, p1Follow: false }, fllm);
  mod.apply(ctx, { enabled: true });
  await new Promise((r) => setTimeout(r, 150));
  const svc = ctx.__service;
  ok('捕获到 agent/request 钩子', typeof hooks['agent/request'] === 'function');
  ok('捕获到 agent/request-error 钩子', typeof hooks['agent/request-error'] === 'function');
  ok('捕获到 llm/stream 中间件', typeof hooks['llm/stream'] === 'function');

  if (svc) {
    await svc.setQueue([
      { provider: 'p', model: 'capbad' },
      { provider: 'p', model: 'good' },
    ]);

    // 1) agent/request 只观测，不改 provider/model/档位
    const cfg = { provider: 'host', model: 'flagship', reasoningEffort: 'balanced', maxTokens: 100, temperature: 0.5 };
    const out = await hooks['agent/request'](
      { agent: { session: { id: 'sess-reasoning' } } },
      async () => cfg,
    );
    ok('方案B：agent/request 原样放行（不覆盖路由）', out?.provider === 'host' && out?.model === 'flagship', `${out?.provider}/${out?.model}`);
    ok('方案B：agent/request 不剥用户档位', out?.reasoningEffort === 'balanced');
    ok('方案B：不修改宿主传进来的原对象', cfg.reasoningEffort === 'balanced');

    // 2) llm/stream 中间件：capbad 能力不匹配 → 剥档位后换 good 成功
    const collect = async (options) => {
      const uit = hooks['llm/stream'](options, () => fllm.stream(options));
      const arr = [];
      for await (const c of uit) arr.push(c);
      return arr;
    };
    fllm.calls.length = 0; fllm.reqs.length = 0;
    const frames = await collect({
      sessionId: 'sess-reasoning',
      provider: 'host', model: 'flagship', reasoningEffort: 'balanced',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 100,
    });
    ok('方案B：先试 capbad（能力不匹配）再换 good', fllm.calls[0] === 'p/capbad' && fllm.calls[1] === 'p/good', fllm.calls.join(','));
    ok('方案B：子请求剥离 reasoningEffort（否则宿主本地拒绝）', fllm.reqs.every((r) => r.reasoningEffort === undefined), JSON.stringify(fllm.reqs.map((r) => r.reasoningEffort)));
    const lastFinish = [...frames].reverse().find((c) => c.type === 'finish');
    ok('方案B：换到 good 后正常结束', lastFinish?.reason?.kind === 'stop', JSON.stringify(lastFinish?.reason));
    const snapF = await svc.snapshot();
    const capEntry = (snapF?.entries || []).find((e) => e.model === 'capbad');
    ok('能力不匹配不熔断失败路由（模型本身没坏）', capEntry?.state !== 'open', `state=${capEntry?.state}`);
    ok('能力不匹配被识别为 capability 而不是 unknown', capEntry?.lastError?.source === 'capability', `source=${capEntry?.lastError?.source}`);

    // 3) agent/request-error 在启用+有队列时早退（已由 LLM 层记账，不再派 retry）
    const errRes = await hooks['agent/request-error']({
      provider: 'p',
      agent: { session: { id: 'sess-reasoning' }, callConfig: { model: 'good' } },
      failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'x' },
    }, async () => undefined);
    ok('方案B：agent/request-error 早退不派 retry', errRes?.kind === undefined, JSON.stringify(errRes));
  }
}

// ================= 场景 G：P1 放行时不动用户自己的档位 =================
{
  const { ctx, hooks } = makeCtx({ enabled: true, pingIntervalMs: 0, p1Follow: true }, makeLlm());
  const plug = mod.apply(ctx, { enabled: true });
  await new Promise((r) => setTimeout(r, 150));
  const svc = ctx.__service;
  if (svc && hooks['agent/request']) {
    await svc.setQueue([{ provider: 'p', model: 'auth' }]);
    const out = await hooks['agent/request'](
      { agent: { session: { id: 'sess-p1' } } },
      async () => ({ provider: 'host', model: 'flagship', reasoningEffort: 'balanced' }),
    );
    ok('P1 放行时保留用户档位（没换模型就别动它）',
      out?.reasoningEffort === 'balanced' && out?.provider === 'host',
      `${out?.provider}/${out?.model} effort=${JSON.stringify(out?.reasoningEffort)}`);

    // P1 槽按调用方会话取：面板/芯片带着自己的 sessionId 来，新会话不该看到
    // 上一个会话的模型（用户实测：新会话点「探测全部」，P1 行红的是别人的模型）。
    plug?.router?.noteSessionModel?.('sess-p1-a', 'host', 'flagship');
    plug?.router?.noteSessionModel?.('sess-p1-b', 'host', 'flagship-b');
    const snapPa = svc.snapshot('sess-p1-a');
    const snapPb = svc.snapshot('sess-p1-b');
    ok('P1 槽按 sessionId 取模型（会话 A）', snapPa?.p1?.model === 'flagship', JSON.stringify(snapPa?.p1));
    ok('P1 槽按 sessionId 取模型（会话 B）', snapPb?.p1?.model === 'flagship-b', JSON.stringify(snapPb?.p1));
  }
}

// ================= 场景 E：队列条目完整透出（方案A 已移除 pinned） =================
{
  const { ctx } = makeCtx({ enabled: true, pingIntervalMs: 0 }, makeLlm());
  const plug = mod.apply(ctx, { enabled: true });
  await new Promise((r) => setTimeout(r, 200));
  const svc = ctx.__service;
  if (svc) {
    await svc.setQueue([
      { provider: 'p', model: 'good', paid: 'free' },
      { provider: 'p', model: 'auth', paid: 'paid' },
    ]);
    const snap = await svc.snapshot();
    ok('队列条目完整可见', (snap?.entries || []).length === 2);
    ok('snapshot 不再透出 pinned 字段（方案A）', snap?.entries?.every((e) => !('pinned' in e)) === true);
    ok('snapshot 保留 paid 字段', (snap?.entries || []).every((e) => e.paid === 'free' || e.paid === 'paid') === true);
  }
  ok('router 暴露 circuitOf（探测记账所需）', typeof plug?.router?.circuitOf === 'function');
}

// ================= 场景 H：全员探测必须包含 P1 槽；失败也要记时间戳 =================
// 用户实测的两个"完全确定不了"：
//  ① P1 永远灰「未测」——旧 probeAllRoutes 只遍历 config.queue，p1Follow 下
//     P1 = 会话模型根本不在队列里，永远轮不到探测（哪怕它正在给用户回话）。
//  ② 探测失败显示成「从没测过」——旧 stampFailure 不写 lastProbeAt，而前端
//     判「有没有证据」看的正是它；失败与未测在界面上无法区分。
{
  const hllm = makeLlm();
  const { ctx, hooks } = makeCtx({ enabled: true, pingIntervalMs: 0, p1Follow: true }, hllm);
  mod.apply(ctx, { enabled: true });
  await new Promise((r) => setTimeout(r, 150));
  const svc = ctx.__service;
  if (svc && hooks['agent/request']) {
    await svc.setQueue([{ provider: 'p', model: 'auth', paid: 'free' }]);
    // 先走一次 P1 真实放行，让插件采样到会话模型（P1 槽的"本尊"）
    const out = await hooks['agent/request'](
      { agent: { session: { id: 'sess-p1probe' } } },
      async () => ({ provider: 'host', model: 'good', maxTokens: 10 }),
    );
    ok('P1 放行返回原配置', out?.provider === 'host' && out?.model === 'good');

    hllm.calls.length = 0;
    const pingRes = await svc.pingAll();
    const snapH = await svc.snapshot();
    const p1Res = (pingRes?.results || []).find((x) => x.index === -1);
    ok('全员探测包含 P1 槽（旧实现永远漏掉它）', !!p1Res, JSON.stringify(pingRes?.results));
    ok('P1 槽探测真实发出请求', hllm.calls.includes('host/good'), hllm.calls.join(','));
    ok('P1 槽探测成功', p1Res?.ok === true);
    ok('P1 视图带上探测证据（前端据此脱灰）',
      typeof snapH?.p1?.lastProbeAt === 'number' && snapH.p1.lastProbeAt > 0,
      JSON.stringify(snapH?.p1?.lastProbeAt));

    // ② 探测失败的路由：必须有时间戳 + probeOk=false，前端才能画黄「探测失败」
    //    而不是灰「未测」——这是"测过且挂了"与"压根没测"的唯一区分。
    const failedEntry = (snapH?.entries || []).find((e) => e.model === 'auth');
    ok('探测失败也记时间戳（旧实现不记，失败=未测无法区分）',
      typeof failedEntry?.lastProbeAt === 'number' && failedEntry.lastProbeAt > 0,
      JSON.stringify(failedEntry?.lastProbeAt));
    ok('探测失败 probeOk=false 且带错误码',
      failedEntry?.probeOk === false && !!failedEntry?.probeError?.code,
      JSON.stringify(failedEntry?.probeError));
  }
}

// ================= 场景 I：熔断语义 —— 探测成功不等于路由恢复 =================
// 探测是一条刻意精简的异形请求：厂商可能不计费、不校验余额。它成功不代表
// 真实请求能成。让探测去改熔断账本，后果是：
//   ① 已熔断（open）的路由被一次 ping 洗回 closed → 冷却期形同虚设；
//   ② failures 被清零 → 连续失败永远攒不到阈值 → 熔断永远不触发（插件核心功能失效）；
//   ③ lastCode/lastMessage 被抹掉 → 排障证据丢失。
// 正确规则：只有真实请求能决定熔断与恢复；探测成功最多把「半开」推进回闭合
// （半开的定义就是"等一条成功证据"，半开扫描 timer 靠它救活路由，这条要保留）。
{
  const illm = makeLlm();
  const { ctx } = makeCtx({ enabled: true, pingIntervalMs: 0, pingSkipPaid: false }, illm);
  const plug = mod.apply(ctx, { enabled: true });
  await new Promise((r) => setTimeout(r, 150));
  const svc = ctx.__service;
  if (svc && plug?.router?.circuitOf) {
    await svc.setQueue([{ provider: 'p', model: 'good', paid: 'free' }]);
    const c = plug.router.circuitOf('p\u0000good');

    // ① open（额度耗尽被熔断）——探测成功后必须仍是 open
    c.state = 'open';
    c.failures = 2;
    c.openedAt = Date.now();
    c.lastCode = 'QUOTA';
    c.lastMessage = 'insufficient balance';
    await svc.pingAll();
    ok('探测成功不复活已熔断路由（熔断只认真实请求）', c.state === 'open', `state=${c.state}`);
    ok('探测成功不清失败计数（阈值不被偷清）', c.failures === 2, `failures=${c.failures}`);
    ok('探测成功保留熔断原因（排障证据不被抹掉）', c.lastCode === 'QUOTA', `lastCode=${c.lastCode}`);

    // ② half_open ——探测成功应把它推进回 closed（半开救活能力必须保留）
    c.state = 'half_open';
    c.halfOpenAt = Date.now();
    c.failures = 2;
    await svc.pingAll();
    ok('半开态被探测成功推进回闭合（半开救活能力保留）', c.state === 'closed', `state=${c.state}`);

    // ③ closed ——探测成功不得清零真实请求攒下的失败计数
    c.state = 'closed';
    c.failures = 1;
    c.lastCode = 'TIMEOUT';
    await svc.pingAll();
    ok('闭合态探测成功不重置失败计数', c.failures === 1, `failures=${c.failures}`);
    ok('闭合态探测成功不改真实请求的失败原因', c.lastCode === 'TIMEOUT', `lastCode=${c.lastCode}`);
  }
}

// ================= 崩溃防护：异常不许逃到宿主 =================
// 背景：插件里凡"没人接的 promise / 同步监听器直接抛"都是**整个宿主进程退出**
// 级别的故障（Node 24 默认 --unhandled-rejections=throw）。代码看起来完全正常，
// 只在于某次数据异常时才炸——所以必须真的把它喂进去，看会不会穿出来。
{
  const xllm = makeLlm();
  const { ctx, hooks } = makeCtx({ enabled: true, pingIntervalMs: 0 }, xllm);
  mod.apply(ctx, { enabled: true });
  await new Promise((r) => setTimeout(r, 120));

  // ① session/event：payload 的 data 取景抛出（模拟宿主给了畸形事件）
  let escaped = null;
  const evilEvent = { type: 'model/selection' };
  Object.defineProperty(evilEvent, 'data', {
    get() { throw new Error('boom-data'); },
  });
  try {
    hooks['session/event']?.({ id: 'sess-evil' }, evilEvent);
  } catch (e) {
    escaped = e;
  }
  ok('session/event 监听器异常不穿透到宿主', escaped === null, escaped?.message || '');

  // ② session/disposed：session.id 取值抛出
  let escaped2 = null;
  const evilSession = {};
  Object.defineProperty(evilSession, 'id', {
    get() { throw new Error('boom-id'); },
  });
  try {
    hooks['session/disposed']?.(evilSession);
  } catch (e) {
    escaped2 = e;
  }
  ok('session/disposed 监听器异常不穿透到宿主', escaped2 === null, escaped2?.message || '');

  // ③ 源码守卫：后台探测不得再把 promise 丢掉；probeTimer 必须 unref
  const src = await import('node:fs').then((m) => m.readFileSync(join(root, 'index.js'), 'utf8'));
  ok('index.js 不再有 `void probeRoute(`（会把 rejection 丢成未捕获）', !/void\s+probeRoute\s*\(/.test(src));
  ok('index.js 不再有裸 `void probeAllRoutes(`', !/void\s+probeAllRoutes\s*\(/.test(src));
  ok('probeTimer 已 unref（不拖住进程退出）', /probeTimer\.unref/.test(src));
  ok('预检两个调用点走 preflightSafe（含 .catch 收口）',
    (src.match(/preflightSafe\(/g) || []).length >= 3);
}

// ================= 场景 J：方案 B —— llm/stream 中间件做故障转移 =================
// 方案B：不改 selection、不注册虚拟 provider；在 llm/stream 瀑布里对带 sessionId 的
// 请求做「先 P1、失败再按队列物理序」的包装。验证：失败换下一条、出内容后不换、
// 全失败只出末帧、熔断路由被跳过、不再有 inbox/claimed 改写、不再注册 adapter。
{
  const jllm = makeLlm();
  jllm.resolveModelInfo = async (provider, model) => ({
    provider, id: model, name: model,
    context: { contextWindow: 200000 },
    inputModalities: ['text'],
  });
  // p1Follow=false：让链只由队列决定，避免会话模型锚点混进来干扰断言。
  const { ctx, hooks } = makeCtx({ enabled: true, pingIntervalMs: 0, p1Follow: false }, jllm);
  const plug = mod.apply(ctx, { enabled: true });
  await new Promise((r) => setTimeout(r, 150));
  const svc = ctx.__service;

  ok('方案B：不再注册虚拟 provider（没有 adapter）', jllm.__adapter === undefined && typeof jllm.registerAdapter !== 'function');
  ok('方案B：不再监听 agent/inbox/claimed（不改 selection）', hooks['agent/inbox/claimed'] === undefined);
  ok('方案B：注册了 llm/stream 中间件', typeof hooks['llm/stream'] === 'function');

  if (svc) {
    const runStream = (options) => {
      // 模拟 dsh-llm 的瀑布：next() 落到真实 adapter（这里 = 假 llm 的 stream）
      return hooks['llm/stream'](options, () => jllm.stream(options));
    };
    const collect = async (options) => {
      const out = [];
      for await (const c of runStream(options)) out.push(c);
      return out;
    };
    const ask = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 16 };

    // —— 1) 第一条失败 → 切到第二条成功 ——
    await svc.setQueue([
      { provider: 'p', model: 'auth', paid: 'free' },
      { provider: 'p', model: 'good', paid: 'free' },
    ]);
    jllm.calls.length = 0;
    const chunks = await collect({ ...ask, sessionId: 'chain-1' });
    ok('方案B：第一条失败自动切到第二条成功',
      jllm.calls[0] === 'p/auth' && jllm.calls.includes('p/good'),
      jllm.calls.join(','));
    ok('方案B：最终给出正常 finish stop',
      chunks.some((c) => c.type === 'text-delta')
        && chunks.at(-1)?.type === 'finish' && chunks.at(-1)?.reason?.kind === 'stop',
      JSON.stringify(chunks.at(-1)));

    // —— 2) 已经吐出可见内容后报错 → 不再换路 ——
    await svc.setQueue([
      { provider: 'p', model: 'partial', paid: 'free' },
      { provider: 'p', model: 'good', paid: 'free' },
    ]);
    jllm.calls.length = 0;
    const partialChunks = await collect({ ...ask, sessionId: 'chain-2' });
    ok('方案B：已出可见内容后报错不再换路（半截回答不拼接）',
      jllm.calls.length === 1 && jllm.calls[0] === 'p/partial',
      jllm.calls.join(','));
    ok('方案B：半截内容保留、末帧是错误 finish',
      partialChunks[0]?.type === 'text-delta' && partialChunks.at(-1)?.reason?.kind === 'error',
      JSON.stringify(partialChunks.map((c) => c.type)));

    // —— 3) 全队列失败 → 只出一个失败 finish ——
    await svc.setQueue([
      { provider: 'p', model: 'auth', paid: 'free' },
      { provider: 'p', model: 'slow', paid: 'free' },
    ]);
    jllm.calls.length = 0;
    // auth 上一轮已因 AUTH 被立即熔断，这一轮会被跳过，只剩 slow 报 TIMEOUT。
    const allFail = await collect({ ...ask, sessionId: 'chain-3' });
    ok('方案B：全队列失败时只返回一个失败 finish（不泄漏中间帧）',
      allFail.length === 1 && allFail[0]?.type === 'finish' && allFail[0]?.reason?.kind === 'error',
      JSON.stringify(allFail));

    // —— 4) 熔断中的路由被跳过 ——
    await svc.setQueue([
      { provider: 'p', model: 'auth', paid: 'free' },
      { provider: 'p', model: 'good', paid: 'free' },
    ]);
    const cAuth = plug?.router?.circuitOf?.('p\u0000auth');
    if (cAuth) {
      cAuth.state = 'open';
      cAuth.openedAt = Date.now();
      cAuth.failures = 2;
    }
    jllm.calls.length = 0;
    await collect({ ...ask, sessionId: 'chain-4' });
    ok('方案B：熔断中的路由被跳过，直接试下一条',
      !jllm.calls.includes('p/auth') && jllm.calls.includes('p/good'),
      jllm.calls.join(','));

    // —— 4b) 全熔断：一条消息只打一条（冷却最早到期），不再把整条链重打一遍 ——
    // 旧行为：全熔断时 availableFallbackChain 返回原链 → 每条消息把 5 条路由各打一次，
    // 用户看到"2 个可用瞬间变全红"；更糟的是每条 openedAt 都被刷新，60s 冷却永远滑不到头。
    await svc.setQueue([
      { provider: 'p', model: 'good', paid: 'free' },
      { provider: 'p', model: 'good2', paid: 'free' },
      { provider: 'p', model: 'slow', paid: 'free' },
    ]);
    const trip = (key, openedAt) => {
      const c = plug?.router?.circuitOf?.(key);
      if (c) {
        c.state = 'open';
        c.openedAt = openedAt;
        c.failures = 0;
        c.lastProbeAt = 0;
        c.probeOk = null;
      }
      return c;
    };
    const tMelt = Date.now();
    trip('host\u0000flagship', tMelt - 40_000);
    trip('p\u0000good', tMelt - 55_000); // 冷却最早到期 → 唯一候选
    trip('p\u0000good2', tMelt - 30_000);
    trip('p\u0000slow', tMelt - 10_000);
    jllm.calls.length = 0;
    const melted = await collect({ ...ask, sessionId: 'chain-melted' });
    ok('全熔断：一条消息只打一条路由（不再扫全链）', jllm.calls.length === 1, jllm.calls.join(','));
    ok('全熔断：选的是冷却最早到期的那条', jllm.calls[0] === 'p/good', jllm.calls.join(','));
    ok('全熔断：单发一次就收尾（成功或失败，都不重扫整链）',
      melted.filter((c) => c.type === 'finish').length === 1,
      JSON.stringify(melted));

    // —— 4c) 「探测已通过但仍在熔断」→ revivable + 手动恢复 ——
    const cGoodR = plug?.router?.circuitOf?.('p\u0000good');
    if (cGoodR) {
      cGoodR.state = 'open';
      cGoodR.openedAt = Date.now() - 1_000; // 刚才那一发失败后的新熔断
      cGoodR.probeOk = true;
      cGoodR.lastProbeAt = Date.now(); // 熔断之后探测成功过 = 合法证据
    }
    const snapR = svc.snapshot();
    const eGoodR = (snapR?.entries || []).find((e) => e.provider === 'p' && e.model === 'good');
    ok('可恢复：探测通过但仍在熔断 → revivable=true', eGoodR?.revivable === true, JSON.stringify(eGoodR));
    ok('可恢复：revivable 不掩盖熔断事实（state 仍是 open）', eGoodR?.state === 'open', JSON.stringify(eGoodR));
    const rv = await svc.reviveRoute(0, 'chain-melted');
    ok('可恢复：reviveRoute 放行该路由', rv?.ok === true, JSON.stringify(rv));
    ok('可恢复：放行后进入 half_open（下一条真实请求说了算）',
      plug?.router?.circuitOf?.('p\u0000good')?.state === 'half_open',
      plug?.router?.circuitOf?.('p\u0000good')?.state);
    const cSlowR = plug?.router?.circuitOf?.('p\u0000slow');
    if (cSlowR) {
      cSlowR.state = 'open';
      cSlowR.openedAt = Date.now() - 1_000;
      cSlowR.probeOk = false;
      cSlowR.lastProbeAt = Date.now();
    }
    const rv2 = await svc.reviveRoute(2, 'chain-melted');
    ok('可恢复：没有"熔断后探测成功"的证据时拒绝放开（不把熔断变摆设）',
      rv2?.ok === false && plug?.router?.circuitOf?.('p\u0000slow')?.state === 'open', JSON.stringify(rv2));
    // 探测成功但发生在**熔断之前**也不算证据（旧证据不能给新熔断背书）
    const cGoodOld = plug?.router?.circuitOf?.('p\u0000good');
    if (cGoodOld) {
      cGoodOld.state = 'open';
      cGoodOld.openedAt = Date.now();
      cGoodOld.probeOk = true;
      cGoodOld.lastProbeAt = Date.now() - 60_000;
    }
    const rv3 = await svc.reviveRoute(0, 'chain-melted');
    ok('可恢复：熔断前的旧探测证据不算数', rv3?.ok === false, JSON.stringify(rv3));

    // 熔断表是全局共享的（按 provider/model），本段留下的状态会把后面的用例带偏：
    // 统一清回健康态再用。
    for (const k of ['p\u0000good', 'p\u0000good2', 'p\u0000slow', 'p\u0000auth']) {
      const c = plug?.router?.circuitOf?.(k);
      if (c) {
        c.state = 'closed';
        c.failures = 0;
        c.openedAt = 0;
        c.halfOpenAt = 0;
        c.probeOk = null;
        c.lastProbeAt = 0;
      }
    }

    // —— 5) 不改 selection：没有 inbox/claimed 钩子，model.current 保持原样 ——
    const agent = {
      session: { id: 'sess-claim' },
      model: {
        current: () => ({ provider: 'host', model: 'flagship', reasoningEffort: 'balanced' }),
        select: () => { throw new Error('方案B 不应调用 agent.model.select'); },
      },
    };
    ok('方案B：不存在 inbox/claimed 钩子（无法改写 selection）', hooks['agent/inbox/claimed'] === undefined);
    const cur = agent.model.current();
    ok('方案B：选择器仍显示真实 P1（selection 未被改成 fallback/auto）',
      cur.provider === 'host' && cur.model === 'flagship', JSON.stringify(cur));

    // —— 6) 无 sessionId 的请求（探测/内部）原样放行，不包装 ——
    jllm.calls.length = 0;
    await collect({ ...ask });
    ok('方案B：无 sessionId 的请求直接放行（不触发队列）', jllm.calls.length === 1, jllm.calls.join(','));

    // —— 7) 纯物理顺序：链完全按 setQueue 的物理序尝试 ——
    await svc.setQueue([
      { provider: 'p', model: 'good', paid: 'free' },
      { provider: 'p', model: 'auth', paid: 'paid' },
    ]);
    jllm.calls.length = 0;
    await collect({ ...ask, sessionId: 'chain-order' });
    ok('方案B：第一条可用就不再试后面（物理序第一条优先）',
      jllm.calls[0] === 'p/good' && !jllm.calls.includes('p/auth'),
      jllm.calls.join(','));

    // —— 8) 手动切换会话隔离：只影响当前会话，不拖走别的会话 ——
    await svc.setQueue([
      { provider: 'p', model: 'good', paid: 'free' },
      { provider: 'p', model: 'good2', paid: 'free' },
    ]);
    await svc.manualFailback(1, 'sess-A');
    const snapX = svc.snapshot();
    ok('会话隔离：A 的手动目标=1、B 没有手动目标',
      snapX.sessionManual['sess-A'] === 1 && snapX.sessionManual['sess-B'] === undefined,
      JSON.stringify(snapX.sessionManual));
    ok('会话隔离：快照下发 sessionManual',
      snapX.sessionManual && typeof snapX.sessionManual === 'object');
    jllm.calls.length = 0;
    await collect({ ...ask, sessionId: 'sess-A' });
    ok('会话隔离：A 从手动目标那条起步', jllm.calls[0] === 'p/good2', jllm.calls.join(','));
    jllm.calls.length = 0;
    await collect({ ...ask, sessionId: 'sess-B' });
    ok('会话隔离：B 未受影响，仍从第一条起步', jllm.calls[0] === 'p/good', jllm.calls.join(','));
    await svc.manualFailback(-1, 'sess-B');
    const snapY = svc.snapshot();
    ok('会话隔离：B 切回 P1 不清 A 的手动目标',
      snapY.sessionManual['sess-A'] === 1,
      JSON.stringify(snapY.sessionManual));

    // —— 9) P0：网关级 hold 不许被放大；ISO 到期时刻换算成 providerRetryAfterMs ——
    await svc.setQueue([{ provider: 'p', model: 'hold', paid: 'free' }]);
    jllm.calls.length = 0;
    const holdChunks = await collect({ ...ask, sessionId: 'chain-hold' });
    const holdFailure = holdChunks.at(-1)?.reason?.failure;
    ok('P0：闸门报文里的 ISO 到期时刻被换算成 providerRetryAfterMs',
      Number.isFinite(holdFailure?.providerRetryAfterMs) && holdFailure.providerRetryAfterMs > 170_000,
      JSON.stringify(holdFailure));
    ok('P0：该值必须大于宿主 maxDelayMs(10s)，宿主才会放弃重试',
      holdFailure?.providerRetryAfterMs > 10_000, `wait=${holdFailure?.providerRetryAfterMs}`);
    const holdCircuit = plug?.router?.circuitOf?.('p\u0000hold');
    ok('P0：电路记下同一个 retryAfterMs（面板可显示恢复倒计时）',
      holdCircuit?.retryAfterMs > 170_000, `retryAfterMs=${holdCircuit?.retryAfterMs}`);

    // 反向：普通超时文案里也有 "15s"，绝不能被读成恢复时刻（否则面板凭空造倒计时）
    await svc.setQueue([{ provider: 'p', model: 'slow', paid: 'free' }]);
    const slowChunks = await collect({ ...ask, sessionId: 'chain-slow-p0' });
    const slowFailure = slowChunks.at(-1)?.reason?.failure;
    ok('P0：普通超时不凭空造恢复时刻（providerRetryAfterMs 不出现）',
      slowFailure?.providerRetryAfterMs === undefined, JSON.stringify(slowFailure));
  }
}

// ================= 场景 K：探测全部必须并发（用户抱怨"太慢了"） =================
// 旧实现对队列串行一条条 await，队列一长就要等「全部之和」。这里用一组各 120ms
// 的慢探测验证：5 条并发（默认 4）应显著快于串行的 5×120=600ms。
// 同时验证：结果按展示顺序返回、限并发（峰值不超过 probeConcurrency）。
{
  // 带并发计数 + 可配延迟的假 llm
  function makeTimedLlm(delayMs) {
    const calls = [];
    let live = 0;
    let peak = 0;
    return {
      calls,
      peak: () => peak,
      stream: ({ provider, model }) => {
        calls.push(`${provider}/${model}`);
        live += 1; peak = Math.max(peak, live);
        let done = false;
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise((r) => setTimeout(r, delayMs));
            yield { type: 'text-delta', text: 'p' };
            yield { type: 'finish', reason: { kind: 'stop' } };
            if (!done) { done = true; live -= 1; }
          },
          async interrupt() { if (!done) { done = true; live -= 1; } return true; },
        };
      },
      listProviders: () => [{ id: 'prov' }],
    };
  }
  const dllm = makeTimedLlm(120);
  const { ctx } = makeCtx({ enabled: true, pingIntervalMs: 0, pingSkipPaid: false, probeConcurrency: 4 }, dllm);
  mod.apply(ctx, { enabled: true });
  await new Promise((r) => setTimeout(r, 150));
  const svc = ctx.__service;
  if (svc) {
    await svc.setQueue([
      { provider: 'p', model: 'a', paid: 'free' },
      { provider: 'p', model: 'b', paid: 'free' },
      { provider: 'p', model: 'c', paid: 'free' },
      { provider: 'p', model: 'd', paid: 'free' },
      { provider: 'p', model: 'e', paid: 'free' },
    ]);
    dllm.calls.length = 0;
    const t0 = Date.now();
    const res = await svc.pingAll();
    const elapsed = Date.now() - t0;
    ok('并发探测：5 条全探', (res?.results || []).length === 5, JSON.stringify(res?.results?.length));
    // 串行需 ≥600ms；并发 4 应明显更快（留余量：< 500ms）
    ok('并发探测：墙钟时间明显短于串行（5×120ms）', elapsed < 500, `elapsed=${elapsed}ms`);
    ok('并发探测：峰值并发不超过 probeConcurrency(4)', dllm.peak() <= 4 && dllm.peak() >= 2, `peak=${dllm.peak()}`);
    // 结果按展示顺序返回（index 0..4）
    ok('并发探测：结果按队列顺序返回', (res?.results || []).map((r) => r.index).join(',') === '0,1,2,3,4',
      JSON.stringify((res?.results || []).map((r) => r.index)));

    // 同一条路由（同 provider/model）本轮只真正发一次请求，结果复用（去重）
    await svc.setQueue([
      { provider: 'p', model: 'dup', paid: 'free' },
      { provider: 'p', model: 'dup', paid: 'free' },
    ]);
    dllm.calls.length = 0;
    const res2 = await svc.pingAll();
    const dupCalls = dllm.calls.filter((c) => c === 'p/dup').length;
    ok('并发探测：同一路由本轮只探一次（去重）', dupCalls === 1, `calls=${dupCalls}`);
    ok('并发探测：去重后两条都拿到结果', (res2?.results || []).length === 2 && (res2?.results || []).every((r) => r.ok === true),
      JSON.stringify(res2?.results));
  }
}

// ================= 场景 L：逐条探测状态（探测中 → 探测完成 → 消失） =================
// 用户要：点「探测全部」，每条开始探测的路由旁显示「探测中」，探完显示「探测完成」，
// 过一会自动消失。后端用 snapshot.probeStatus 下发逐条状态、并带 TTL 自动清空。
{
  function makeTimedLlm2(delayMs) {
    return {
      calls: [],
      stream: ({ provider, model }) => {
        let done = false;
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise((r) => setTimeout(r, delayMs));
            yield { type: 'text-delta', text: 'p' };
            yield { type: 'finish', reason: { kind: 'stop' } };
            if (!done) done = true;
          },
          async interrupt() { done = true; return true; },
        };
      },
      listProviders: () => [{ id: 'prov' }],
    };
  }
  const dllm = makeTimedLlm2(160);
  const { ctx } = makeCtx({ enabled: true, pingIntervalMs: 0, pingSkipPaid: false, probeStatusTtlMs: 200 }, dllm);
  mod.apply(ctx, { enabled: true, probeStatusTtlMs: 200 });
  await new Promise((r) => setTimeout(r, 150));
  const svc = ctx.__service;
  if (svc) {
    await svc.setQueue([
      { provider: 'p', model: 'a', paid: 'free' },
      { provider: 'p', model: 'b', paid: 'free' },
    ]);
    // 不 await：探测进行中，读一次快照应看到 probing 状态
    const pending = svc.pingAll();
    await new Promise((r) => setTimeout(r, 60));
    const midSnap = await svc.snapshot();
    const ps = midSnap?.probeStatus || {};
    const midStates = Object.values(ps).map((x) => x.state);
    ok('逐条状态：探测进行中显示 probing', midStates.length >= 1 && midStates.every((s) => s === 'probing'), JSON.stringify(midStates));
    // 每条的 key 都用 provider\0model 组织（前端据此按行取）
    ok('逐条状态：key 形如 provider\\0model', Object.keys(ps).every((k) => k.includes('\u0000')), JSON.stringify(Object.keys(ps)));
    await pending;
    const afterSnap = await svc.snapshot();
    const ps2 = afterSnap?.probeStatus || {};
    const doneStates = Object.values(ps2);
    ok('逐条状态：探完全部显示 done', doneStates.length === 2 && doneStates.every((x) => x.state === 'done'), JSON.stringify(doneStates));
    ok('逐条状态：done 带 ok 结论', doneStates.every((x) => x.ok === true), JSON.stringify(doneStates));
    // TTL（200ms）过后应自动清空
    await new Promise((r) => setTimeout(r, 320));
    const laterSnap = await svc.snapshot();
    ok('逐条状态：TTL 过后自动消失', !laterSnap?.probeStatus || Object.keys(laterSnap.probeStatus).length === 0,
      JSON.stringify(laterSnap?.probeStatus));
  }
}

// ================= 场景 M：探测全部把 P1 槽一起探（结果条数 > 队列行数） =================
// 用户实测质疑：「队列就 4 个，哪里来的 3 个可用 2 个不可用？」
// 根因：探测会把 P1（p1Follow 下 = 当前会话模型，不在队列行里）一起探，
// results 里多一条 index=-1。前端汇总必须按实际条数报并注明含 P1。
// 这里从后端钉住这条事实：先通过 session/event 记一个会话模型当 P1，再 pingAll。
{
  const mllm = makeLlm();
  const { ctx, hooks } = makeCtx({ enabled: true, pingIntervalMs: 0, pingSkipPaid: false }, mllm);
  mod.apply(ctx, { enabled: true });
  await new Promise((r) => setTimeout(r, 60));
  const svc = ctx.__service;
  if (svc && typeof hooks['session/event'] === 'function') {
    await svc.setQueue([
      { provider: 'p', model: 'good', paid: 'free' },
      { provider: 'p', model: 'good', paid: 'free' },
      { provider: 'p', model: 'auth', paid: 'free' },
    ]);
    // 模拟用户手选模型 → 宿主派发 session/event model/selection → 记为该会话的 P1
    await hooks['session/event']({ id: 'sess-M' }, {
      type: 'model/selection',
      data: { provider: 'p', model: 'good', reasoningEffort: undefined },
    });
    const r = await svc.pingAll();
    const p1 = (r?.results || []).filter((x) => x.index === -1);
    ok('探测全部：P1 槽（会话模型）被一起探，results 含 index=-1',
      r?.ok === true && p1.length === 1 && p1[0].provider === 'p' && p1[0].model === 'good',
      JSON.stringify(r?.results?.map((x) => x.index)));
    // 队列 3 条 + P1 = 4 条；正是「结果数 > 队列行数」的那条事实
    ok('探测全部：结果条数 = 队列条数 + P1',
      (r?.results || []).length === 4, `results=${(r?.results || []).length}`);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.error(`\n失败项：`);
  for (const f of failed) console.error(`  - ${f.name}${f.extra ? ` (${f.extra})` : ''}`);
}
// 插件自带 15s/60s 常驻 timer（宿主进程里本就常驻），验证脚本必须显式退出。
process.exit(failed.length ? 1 : 0);
