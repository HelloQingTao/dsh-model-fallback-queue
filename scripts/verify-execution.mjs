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

// ---- 假 llm：按模型名返回不同的终态，复现四种真实上游行为 ----
const BEHAVIOURS = {
  good: { kind: 'content' },
  auth: { kind: 'error', code: 'AUTH', message: 'invalid api key' },
  empty: { kind: 'empty' },
  rej400: { kind: 'error', code: 'INVALID_REQUEST', message: 'unsupported parameter', status: 400 },
  slow: { kind: 'error', code: 'TIMEOUT', message: 'upstream timeout' },
  // 复现用户真机那条：网关嫌 max_tokens 太小直接 400，于是一条能正常对话的模型
  // 在面板上长期"探测失败"。这条假上游就是那个网关的替身。
  tiny: { kind: 'min-tokens', min: 8 },
};
function makeStream({ provider, model, maxTokens, messages, signal }, calls, reqs) {
  if (calls) calls.push(`${provider}/${model}`);
  // 完整请求留档：maxTokens / messages 这类"探测体形状"只能靠它验
  if (reqs) reqs.push({ provider, model, maxTokens, messages });
  let b = BEHAVIOURS[model] || { kind: 'content' };
  if (b.kind === 'min-tokens') {
    b = (Number(maxTokens) || 0) < b.min
      ? { kind: 'error', code: 'INVALID_REQUEST', message: `max_tokens must be >= ${b.min}`, status: 400 }
      : { kind: 'content' };
  }
  const ac = new AbortController();
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  const chunks = [];
  if (b.kind === 'content') {
    chunks.push({ type: 'text-delta', text: 'p' });
    chunks.push({ type: 'finish', reason: { kind: 'stop' } });
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
    await ctx.__service.setQueue([{ provider: 'p', model: 'good', pinned: false, paid: 'free' }]);
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
    // 声明与实现同为 0 参：声明错了会让网关拒绝调用（维护者实测的
    // "expected 1 argument(s), got 0"），而实现本身从来不需要参数。
    ok('pingAll 实现声明 0 个形参（与 RPC 声明一致）', svc.pingAll.length === 0, `length=${svc.pingAll.length}`);

    const queue = [
      { provider: 'p', model: 'good', pinned: false, paid: 'free' },
      { provider: 'p', model: 'auth', pinned: false, paid: 'free' },
      { provider: 'p', model: 'empty', pinned: false, paid: 'free' },
      { provider: 'p', model: 'rej400', pinned: false, paid: 'paid' },
      { provider: 'p', model: 'slow', pinned: false, paid: 'paid' },
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
    /OK/.test(String(llmC.reqs.at(-1)?.messages?.[0]?.content || '')),
    String(llmC.reqs.at(-1)?.messages?.[0]?.content || '').slice(0, 40));
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

// ================= 场景 F：推理档位 —— 覆盖路由必须剥掉，能力不匹配不算路由死亡 =======
// 复现真实报错：会话模型（支持 balanced）→ 插件覆盖到 qodercn/qfmodel（不支持）→
// 宿主 resolveCallWithInfo 本地抛 UNSUPPORTED_REASONING_EFFORT，请求一条都没发出去。
// 旧实现 `{ ...cfg, provider, model }` 会把 reasoningEffort 原样带过去，于是：
//   探测（不带档位）判健康 → 真实请求必挂 → 挂的还记在路由头上。
{
  const { ctx, hooks } = makeCtx({ enabled: true, pingIntervalMs: 0, p1Follow: false }, makeLlm());
  const plug = mod.apply(ctx, { enabled: true });
  await new Promise((r) => setTimeout(r, 150));
  const svc = ctx.__service;
  ok('捕获到 agent/request 钩子', typeof hooks['agent/request'] === 'function');
  ok('捕获到 agent/request-error 钩子', typeof hooks['agent/request-error'] === 'function');

  if (svc && hooks['agent/request']) {
    await svc.setQueue([
      { provider: 'p', model: 'good', pinned: false },
      { provider: 'p', model: 'auth', pinned: false },
    ]);
    const cfg = { provider: 'host', model: 'flagship', reasoningEffort: 'balanced', maxTokens: 100, temperature: 0.5 };
    const out = await hooks['agent/request'](
      { agent: { session: { id: 'sess-reasoning' } } },
      async () => cfg,
    );
    ok('覆盖到队列路由', out?.provider === 'p' && out?.model === 'good', `${out?.provider}/${out?.model}`);
    ok('覆盖路由时剥离 reasoningEffort（否则宿主本地拒绝，请求发不出去）',
      out?.reasoningEffort === undefined, `reasoningEffort=${JSON.stringify(out?.reasoningEffort)}`);
    ok('其余请求字段原样保留', out?.maxTokens === 100 && out?.temperature === 0.5);
    ok('不修改宿主传进来的原对象', cfg.reasoningEffort === 'balanced');

    // 能力不匹配：不能算路由死亡，但必须允许切走（换台支持档位的模型就能救）
    const errRes = await hooks['agent/request-error']({
      provider: 'p',
      agent: { session: { id: 'sess-reasoning' }, callConfig: { model: 'good' } },
      failure: {
        code: 'UNSUPPORTED_REASONING_EFFORT',
        message: 'provider "p" model "good" does not support reasoning effort "balanced"',
      },
    }, async () => undefined);
    const snap = await svc.snapshot();
    const failedEntry = (snap?.entries || []).find((e) => e.model === 'good');
    ok('能力不匹配不熔断失败路由（模型本身没坏）',
      failedEntry?.state !== 'open', `state=${failedEntry?.state}`);
    ok('能力不匹配被识别为 capability 而不是 unknown（否则会被当路由故障）',
      failedEntry?.lastError?.source === 'capability', `source=${failedEntry?.lastError?.source}`);
    ok('能力不匹配仍然切换（换路由能救这一轮请求）', errRes?.kind === 'retry', JSON.stringify(errRes));
  }
}

// ================= 场景 G：P1 放行时不动用户自己的档位 =================
{
  const { ctx, hooks } = makeCtx({ enabled: true, pingIntervalMs: 0, p1Follow: true }, makeLlm());
  const plug = mod.apply(ctx, { enabled: true });
  await new Promise((r) => setTimeout(r, 150));
  const svc = ctx.__service;
  if (svc && hooks['agent/request']) {
    await svc.setQueue([{ provider: 'p', model: 'auth', pinned: false }]);
    const out = await hooks['agent/request'](
      { agent: { session: { id: 'sess-p1' } } },
      async () => ({ provider: 'host', model: 'flagship', reasoningEffort: 'balanced' }),
    );
    ok('P1 放行时保留用户档位（没换模型就别动它）',
      out?.reasoningEffort === 'balanced' && out?.provider === 'host',
      `${out?.provider}/${out?.model} effort=${JSON.stringify(out?.reasoningEffort)}`);
  }
}

// ================= 场景 E：全部 pinned 时退化为原顺序 =================
{
  const { ctx } = makeCtx({ enabled: true, pingIntervalMs: 0 }, makeLlm());
  const plug = mod.apply(ctx, { enabled: true });
  await new Promise((r) => setTimeout(r, 200));
  const svc = ctx.__service;
  if (svc) {
    await svc.setQueue([
      { provider: 'p', model: 'good', pinned: true, paid: 'free' },
      { provider: 'p', model: 'auth', pinned: true, paid: 'free' },
    ]);
    const snap = await svc.snapshot();
    ok('全 pinned 时条目仍完整可见', (snap?.entries || []).length === 2);
    ok('snapshot 透出 pinned 字段', snap?.entries?.every((e) => e.pinned === true) === true);
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
    await svc.setQueue([{ provider: 'p', model: 'auth', pinned: false, paid: 'free' }]);
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
    await svc.setQueue([{ provider: 'p', model: 'good', pinned: false, paid: 'free' }]);
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

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.error(`\n失败项：`);
  for (const f of failed) console.error(`  - ${f.name}${f.extra ? ` (${f.extra})` : ''}`);
}
// 插件自带 15s/60s 常驻 timer（宿主进程里本就常驻），验证脚本必须显式退出。
process.exit(failed.length ? 1 : 0);
