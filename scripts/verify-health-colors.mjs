/**
 * 颜色语义回归：健康色只表示"多久前确认过可用"。
 *
 * 这次修的三个问题，都会在这里变成断言：
 *  1. 免费/付费不得再用绿/琥珀着色（价格和健康抢同一个颜色通道）；
 *  2. 芯片颜色必须来自生效路由的健康，不再是 `p1Active ? ok : warn`（"离开 P1 就黄"）；
 *  3. 熔断状态 closed 但没有新鲜证据时不能给绿色（否则"没测过"冒充"健康"）。
 *
 * 用法：node scripts/verify-health-colors.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const client = readFileSync(join(root, 'client.js'), 'utf8');
const index = readFileSync(join(root, 'index.js'), 'utf8');

let pass = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
}
function mustMatch(name, src, re) {
  check(name, re.test(src), re.toString());
}
function mustNotMatch(name, src, re) {
  check(name, !re.test(src), re.toString());
}

/** 从源码里按大括号配平截出一个函数声明（用于在 node 里直接跑纯函数）。 */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}
function extractConst(src, name) {
  const m = src.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!m) throw new Error(`const ${name} not found`);
  return m[1];
}

// ---------- 1. 价格不再占用颜色通道 ----------
const paidBtnSrc = extractFunction(client, 'paidBadge');
mustNotMatch('paidBadge 不用绿色', paidBtnSrc, /state-success/);
mustNotMatch('paidBadge 不用琥珀/警告色', paidBtnSrc, /state-warning/);
mustMatch('paidBadge 使用中性 secondary 色', paidBtnSrc, /label-secondary/);
mustNotMatch('paidBadge 不再有 paidTag 旧实现', client, /function paidTag\(/);
// 标准功能做在 chip 本身上：paidBadge 支持 onClick 时渲染成可点击 button，不再额外挂「标记」图标按钮
mustMatch('paidBadge 支持点击切换', paidBtnSrc, /onClick/);
mustMatch('paidBadge 可点击时渲染 button', paidBtnSrc, /h\('button'/);
mustNotMatch('队列行不再单独挂 paidCycleBtn 标记按钮', client, /t\('paidCycleBtn'\)/);
// tip 尺寸回到原来那个小胶囊（12px 字体 + 90px 最小宽 / 18~20px 行高那一版），别再抽大
mustMatch('paidBadge 恢复原小尺寸（fontSize 10 + 窄 padding）', paidBtnSrc, /fontSize: 10[\s\S]{0,200}?padding: '0 4px'/);
mustNotMatch('paidBadge 不再是药丸大胶囊', paidBtnSrc, /borderRadius: 999/);
// 关键坑回归：button 上绝不能出现 `font: 'inherit'` 简写——它会重置 base 的 fontSize/lineHeight，
// 让胶囊瞬间变成大字号（用户两次反馈「tip 还是这么大」的真凶）。
mustNotMatch('paidBadge 不用 font 简写（会重置字号变大）', paidBtnSrc, /font:\s*'inherit'/);
mustMatch('paidBadge 只继承字体族/字重', paidBtnSrc, /fontFamily:\s*'inherit'/);
// 底部要有「费用标注用途」说明：只是备注，不参与排序/故障转移/自动判定
mustMatch('底部有费用标注用途说明', client, /t\('paidHint'\)/);
mustMatch('说明点明不参与排序与故障转移', client, /paidHint: '[^']*不参与排序[^']*故障转移/);

// ---------- 2. 芯片颜色来自健康，而不是"在不在 P1" ----------
mustNotMatch('芯片 tone 不再由 p1Active 决定', client, /tone = p1Active \? 'ok' : 'warn'/);
// 芯片取"现在谁在答"那条（有成功记录时），不是游标——否则 P1 熔断、P6 兜底时
// 芯片红着却一直在正常回话（用户实测的自相矛盾）。
mustMatch('芯片取当前作答路由条目', client, /const effEntry = currentIdx < 0 \? p1Entry : entries\.find/);
mustMatch('芯片颜色来自 healthOf', client, /tone = effHealth\.tone/);
mustMatch('标题徽章颜色也来自 health', client, /h\(Badge, \{ tone: effHealth\.tone \}, t\('badgeCurrent'/);

// ---------- 3. 服务端下发前瞻证据 ----------
mustMatch('探测成功记账', index, /stampProbe\(true\)/);
// 失败路径不再调 stampProbe(false)，而是 stampFailure(code,msg[,probeOk])：
// 探测被拒（PROBE_UNSUPPORTED）要写成 probeOk=null，不能一概 false。
mustMatch('探测失败记账（stampFailure）', index, /stampFailure\(/);
mustMatch('探测记录耗时', index, /c\.probeLatencyMs = Date\.now\(\) - startedAt/);
mustMatch('真实成功也刷新 lastOkAt', index, /c\.lastOkAt = Date\.now\(\)/);
for (const f of ['lastOkAt', 'lastProbeAt', 'probeLatencyMs', 'probeOk']) {
  mustMatch(`snapshot 暴露 ${f}`, index, new RegExp(`${f}: c\\.${f}`));
}
mustMatch('snapshot 暴露 pingIntervalMs', index, /pingIntervalMs: Number\(config\.pingIntervalMs\) \|\| 0/);
mustMatch('snapshot 暴露 pingSkipPaid', index, /pingSkipPaid: config\.pingSkipPaid !== false/);
mustMatch('默认周期探测为关闭（0）', index, /pingIntervalMs: 0,/);
mustMatch('默认跳过付费条目', index, /pingSkipPaid: true,/);
// 默认值口径统一：周期探测默认关、默认跳过付费，且**不再**有"升级时强制翻转
// 存量用户设置"的一次性迁移（那会把用户显式写的 0 改成 60000，等于替用户
// 打开花钱的开关）。用户设置了多少就是多少。
mustNotMatch('不再有强制翻转存量设置的迁移', index, /migratePingDefaults/);
mustNotMatch('不再有 pingDefaultsMigrated 闸门', index, /pingDefaultsMigrated/);
mustNotMatch('不再有 pingSkipPaidMigrated 闸门', index, /pingSkipPaidMigrated/);

// ---------- 维护者评审：两条必修 + 一条建议的回归锁 ----------
// 必修 1：pingAll 的 RPC 声明必须与实现、调用点**三者参数个数一致**。
// 曾声明 [{name:'opts'}] 而三个调用点全不传参 → 网关拒绝每次点击：
// client api: ...expected 1 argument(s), got 0，而失败只 console.warn，
// 界面毫无动静，用户以为"探测完成、一切正常"。
// 现在这个参数是 sessionId（P1 槽按发起方会话取），调用点一律显式传。
{
  const declStart = client.indexOf("method: 'pingAll'");
  check('pingAll 声明存在于 client', declStart > 0);
  const declEnd = client.indexOf('result:', declStart);
  // 先剥掉行注释：说明性注释里也会出现 parameters / opts 字样，
  // 不剥的话断言会被自己的注释命中（假阴性）。
  const decl = client
    .slice(declStart, declEnd)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  mustMatch('pingAll RPC 声明含 sessionId 形参', decl, /parameters:\s*\[[\s\S]*?name: 'sessionId'/);
  mustNotMatch('pingAll 不再要求 opts 参数', decl, /name:\s*'opts'/);
}
mustMatch('pingAll 实现收 sessionId（P1 按会话取）', index, /async pingAll\(sessionId\)\s*\{/);
// 设置页「探测全部」排除 P1：拆出独立 pingQueue；两个入口各调各的，不互相污染。
// sessionId 只是为了与 pingAll 同签名（设置页无会话上下文，传 undefined）。
mustMatch('pingQueue 实现收 sessionId（设置页探测全部排除 P1）', index, /async pingQueue\(sessionId\)\s*\{/);
mustMatch('pingQueue 声明含 sessionId 形参', client, /method: 'pingQueue'[\s\S]{0,300}?name: 'sessionId'/);
mustMatch('设置页探测全部调用 pingQueue', client, /const r = await host\.pingQueue\(\)/);
mustMatch('芯片面板探测全部透传 sessionId', client, /host\.pingAll\(props\.sessionId\)/);
mustMatch('pingQueue 已挂 markRemoteMethods', index, /'pingQueue'/);
mustMatch('设置页探测失败会提示', client, /setErr\(t\('probeAllFailed'/);
// 用户要求：探测全部按钮在队列标题右侧；周期探测收进高级折叠区（UI 隐藏、后端保留）
mustMatch('探测全部按钮在队列标题行（标题+按钮同一行）', client, /justifyContent: 'space-between'[\s\S]{0,400}?onClick: probeAll/);
mustMatch('周期探测收进默认折叠的高级区', client, /showProbeAdv/);
mustMatch('周期探测折叠默认关闭', client, /\[showProbeAdv,\s*setShowProbeAdv\]\s*=\s*React\.useState\(false\)/);
mustMatch('后端 pingIntervalMs 能力保留', index, /pingIntervalMs/);
mustMatch('芯片面板探测失败会提示', client, /t\('probeAllFailed'/);
mustMatch('探测失败文案存在', client, /probeAllFailed:/);
mustMatch('探测失败原因映射存在', client, /PROBE_REASON_KEYS/);

// ---- 「探测 2 个可用 → 等会全红」的回归锁 ----
// 两件事必须同时成立，否则用户永远只能怀疑插件坏了：
//  a) 探测通过但仍在熔断冷却里的路由，状态不能说成"完全不能用"，要能一键放行；
//  b) 全熔断时一条消息只发一条，不能把整条链再打一遍（否则冷却被不断刷新）。
mustMatch('快照下发 revivable（探测通过但仍在熔断）', index, /revivable: c\.state === CIRCUIT\.OPEN/);
mustMatch('revivable 要求探测发生在这次熔断之后', index, /\(c\.lastProbeAt \|\| 0\) > \(c\.openedAt \|\| 0\)/);
mustMatch('reviveRoute 只降到 half_open（不是无条件复原）', index, /function reviveRoute\(route\)[\s\S]{0,400}?c\.state = CIRCUIT\.HALF_OPEN/);
mustMatch('reviveRoute 校验证据（没有熔断后探测成功就拒绝）', index, /if \(!isRevivable\(route\)\) return \{ ok: false, reason: 'no-evidence' \}/);
mustMatch('reviveRoute 已挂 RPC 服务', index, /reviveRoute\(index, sessionId\)/);
mustMatch('reviveRoute 已挂 markRemoteMethods', index, /'reviveRoute'\]/);
mustMatch('reviveRoute 已在 client 声明', client, /method: 'reviveRoute'/);
mustMatch('前端有可恢复状态文案', client, /stateRevivable: '可恢复'/);
mustMatch('前端红色里先判 revivable', client, /if \(e\.revivable\) \{\s*\n\s*return \{\s*\n?\s*tone: 'warn'/);
mustMatch('行内恢复按钮只在 revivable 时出现', client, /const reviveButton = \(e, idx\) => \(enabled && e\?\.revivable\)/);
mustMatch('恢复按钮拦冒泡（否则顺手切路由）', client, /onClick: \(ev\) => \{ ev\.stopPropagation\(\); void revive\(idx, e\); \}/);
mustMatch('探测汇总单列「可用但仍在冷却」', client, /probeAllRevivable/);
mustMatch('全熔断时只留一条候选', index, /function soonestRecoveringRoute\(chain\)/);
mustMatch('全熔断分支真的用上单发候选', index, /if \(allMelted\) \{\s*\n\s*const one = soonestRecoveringRoute\(full\)/);
mustMatch('芯片/面板认可恢复的全熔断（不再整片报红）', client, /allTripped[\s\S]{0,200}?anyRevivable \? 'warn' : 'error'/);
mustMatch('全熔断但可恢复时徽章单独用词', client, /badgeTrippedRevivable: '全部熔断 · 可恢复'/);

// 必修 2：周期探测必须在 settings 加载完之后再排一次。
// apply 体里的 schedulePing() 跑在 loadSettings() 之前，那时 config 还是默认值，
// 而 settings/document-updated 只在 UI 保存时触发 —— 配置预置的间隔永远排不上。
{
  const bootStart = index.indexOf('// ---- 启动加载设置 ----');
  check('启动加载设置区块存在', bootStart > 0);
  const bootBlock = index.slice(bootStart, bootStart + 1200);
  mustMatch('loadSettings 之后无条件补排周期探测',
    bootBlock, /await loadQueue\(legacyQueue\)[\s\S]*?schedulePing\(\)/);
}

// 建议 1：探测进度必须是真实 n/N，不能硬编码 done:0
mustMatch('探测进度 done 由 host 记账', index, /runtime\.probeProgress = \{ done, total: planned \}/);
mustMatch('snapshot 暴露真实探测进度', index, /probingDone: runtime\.probeProgress/);
mustNotMatch('进度文案不再硬编码 done: 0', client, /done: 0, total/);

// 建议 2：paid 按钮 title 必须写「点击后」，不能拿当前态取键
mustNotMatch('paid title 不再用当前态取键', client, /qValPaid\(r\) === 'free' \? t\('setPaidFree'\)/);
mustMatch('paid title 使用点击后语义', client, /t\('paidNextFree'\)/);

// ---- 切换的真实性：只能由「真实请求」证明，不能由探测伪造 ----
mustNotMatch('切换时不再发探测（旧实现会写出 NO_SESSION_MODEL 假失败）', index, /verifyRoute/);
mustMatch('切换只记等待位', index, /setPendingConfirm\(sessionId, \{ index: i, at: Date\.now\(\) \}\)/);
mustMatch('manualFailback 返回 pending', index, /return \{ ok: true, pending:/);
mustMatch('快照下发 pendingConfirm', index, /pendingConfirm: runtime\.pendingConfirm/);
mustMatch('快照下发 lastRequest', index, /lastRequest: runtime\.lastRequest/);
// ---- 手动切换会话隔离 ----
mustMatch('manualFailback 接收 sessionId', index, /manualFailback\(index, sessionId\)/);
mustMatch('手动切换按会话写游标（不经全局 resetSessionCursors）', index, /manualSwitch\(sessionId, i\)/);
mustMatch('快照下发 sessionManual', index, /sessionManual: Object\.fromEntries\(sessionManual\)/);
mustMatch('快照下发 sessionLastSwitch', index, /sessionLastSwitch: Object\.fromEntries\(sessionLastSwitch\)/);
mustMatch('快照下发 sessionLastRequest', index, /sessionLastRequest: Object\.fromEntries\(sessionLastRequest\)/);
mustMatch('客户端切换透传 sessionId', client, /host\.manualFailback\(idx, props\.sessionId\)/);
mustMatch('客户端读 per-session 手动目标', client, /snap\.sessionManual\[props\.sessionId\]/);
mustMatch('客户端读 per-session 最近请求', client, /snap\?\.sessionLastRequest\?\.\[sid\]/);
mustMatch('buildFallbackChain 从会话手动目标起步', index, /const manual = manualFor\(sessionId\)/);
mustMatch('agent/request 只观测会话模型（方案B：不改 provider/model）', index, /noteSessionModel\(sessionId, cfg\.provider, cfg\.model\)/);
mustNotMatch('agent/request 不再用提案覆盖 lastRequest（防瞬变 P1）', index, /noteRequest\(-1, cfg\.provider, cfg\.model, sessionId\)/);
mustNotMatch('agent/request 不再把 inFlight 重置成 -1（防瞬变 P1）', index, /setInFlight\(sessionId, -1\)/);
mustMatch('markRequest 同步 inFlight 到实际路由', index, /router\.setInFlight\(sessionId, routeIdx\)/);
mustMatch('换路链从本会话锚点起跑', index, /const cursorPos = router\.cursorFor\(sessionId\)\.activeIndex/);
mustMatch('成功后把锚点钉到实际作答路由', index, /router\.setCursor\(sessionId, routeIdx\)/);
mustMatch('探测回切只在 probe 模式按防抖回 P1', index, /config\.failbackMode === 'probe'/);
mustMatch('方案B：agent/request 不再覆盖路由', index, /return cfg;/);
mustMatch('方案B：llm/stream 中间件存在', index, /ctx\.on\('llm\/stream'/);
mustMatch('方案B：子请求标记 internal 防递归', index, /internalStreamOptions\.add\(subOpts\)/);
mustMatch('真实请求失败改判 lastRequest', index, /state: 'fail',/);
mustMatch('真实请求成功改判 lastRequest', index, /lr\.state === 'sent'/);
// 探测体只带最小合法字段；两个模式共用同一个请求构造（real 只是换了一条普通问话）
// content 必须是 block 数组（[{type:'text',text}]）：裸字符串会被 0.2.2-rc.1 的
// pi-ai 适配层 assertSupportedHistory 的 content.some() 整条拒掉。
mustMatch('探测体只用最小字段', index, /messages: \[\{\s*role: 'user',\s*content: \[\{\s*type: 'text',\s*text: mode === 'real'/s);
mustMatch('探测被拒不冒充风险', index, /PROBE_UNSUPPORTED/);
mustMatch('默认探测跳过付费条目', index, /pingSkipPaid: true/);
// 探测体大小可配（1 是会被网关拒绝的历史默认，默认值必须是更安全的值）
mustMatch('探测 maxTokens 可配置', index, /pingMaxTokens: s\.number\(\)/);
mustMatch('探测 maxTokens 默认 8', index, /pingMaxTokens: 8,/);

// ---------- 熔断语义：探测成功不等于路由恢复 ----------
// 探测是刻意精简的异形请求：厂商可能不计费、不校验余额。让它去改熔断账本，
// 会把已熔断的路由一次 ping 洗回 closed（冷却期失效 + 失败计数被清零 +
// 熔断原因被抹掉），熔断阈值因此永远触发不了。
// 规则：只有真实请求能决定熔断与恢复；
//   - mode='ping'（微型探测）→ recordProbeSuccess：最多把「半开」推进回闭合；
//   - mode='real'（真实形状的请求）→ recordSuccess：它就是真实请求级别的证据。
mustMatch('探测成功走 recordProbeSuccess', index, /router\.recordProbeSuccess\(route\)/);
mustMatch('recordProbeSuccess 只复位半开', index, /if \(c\.state === CIRCUIT\.HALF_OPEN\)/);
mustMatch('真实形状的验证请求允许复位熔断', index, /if \(mode === 'real'\) router\.recordSuccess\(route\)/);
{
  // 探测路径内部不允许出现「无条件的」recordSuccess（只能挂在 mode==='real' 分支上）
  const probeStart = index.indexOf('async function runProbe(');
  const probeBlock = index.slice(probeStart, probeStart + 6000);
  mustNotMatch('探测路径没有无条件的 recordSuccess', probeBlock, /^\s*router\.recordSuccess\(route\);/m);
}

// ---------- 3b. 三个"静默失效"的硬约束（字符串断言曾全部漏掉） ----------
// 这些 bug 的共同点：不抛错、不报警，只是功能悄悄不工作。
// 用正则把它们钉死，避免以后又被"看起来对"的代码蒙混。
mustMatch('apply 第二参是 Config（不是 llm 服务）', index, /export function apply\(ctx, pluginConfig/);
mustNotMatch('apply 不得把服务写成第二参', index, /export function apply\(ctx, llm\)/);
mustMatch('llm 必须经 ctx 取服务', index, /const llm = ctx\.get \? ctx\.get\('llm'\) : ctx\.llm/);
mustMatch('router 暴露 circuitOf 给探测半区', index, /^\s{4}circuitOf,\s*$/m);
// probeOne 里不得再出现裸 circuitOf（那是 ReferenceError 的原始形态）
// 注：探测实现已抽成 runProbe(route, opts)——probeOne 只是取 .ok 的薄包装，
// 断言必须钉在真正干活的 runProbe 上，否则测的是一具空壳。
{
  const probeStart = index.indexOf('async function runProbe(');
  const probeEnd = index.indexOf('async function probeOne(', probeStart);
  const probeBody = index.slice(probeStart, probeEnd);
  check('runProbe 不裸调 circuitOf（跨作用域）', !/(?<!router\.)\bcircuitOf\(/.test(probeBody));
  // 两处记账入口（stampProbe / stampFailure）都必须经 router
  check('runProbe 记账经 router.circuitOf', (probeBody.match(/router\.circuitOf\(/g) || []).length >= 2);
}
// 探测成功判定必须逐 chunk 判 finish.reason.kind，不能"拿到第一帧就通过"
{
  const probeStart = index.indexOf('async function runProbe(');
  const probeEnd = index.indexOf('async function probeOne(', probeStart);
  const probeBody = index.slice(probeStart, probeEnd);
  check('探测判定读 finish.reason.kind', /chunk\.reason\?\.kind/.test(probeBody));
  check('探测把 error/aborted 判为失败', /'error'\s*\|\|\s*kind === 'aborted'|kind === 'error'/.test(probeBody));
  check('探测不再"首个 chunk 即成功"', !/首个 chunk 即视为可用/.test(probeBody));
  check('探测超时改用 AbortSignal', /AbortController/.test(probeBody) && /controller\.abort\(\)/.test(probeBody));
  check('探测定时器必须清理', /finally\s*\{[\s\S]*clearTimeout\(timer\)/.test(probeBody));
  check('探测把 signal 传给宿主', /signal: controller\.signal/.test(probeBody));
  // 回执必须有 code/耗时——"说不清到底怎么了"正是这轮要修的病根
  check('runProbe 返回回执而非裸布尔', /return \{\s*ok: (true|false), mode/.test(probeBody));
}
// 回切策略三态必须真的被区分：probe 要读防抖，manual 不得自动回切
mustMatch('probe 模式读取 failbackDelayMs 防抖', index, /config\.failbackDelayMs/);
mustMatch('manual 模式禁止自动回切', index, /mode === 'manual'\)\s*return false/);
mustMatch('probe 回切打 PROBE_FAILBACK 标记', index, /PROBE_FAILBACK/);
// 客户端轮询必须有快轮预算，不能永久 1s
mustMatch('芯片轮询有 fastBudget 上限', client, /fastBudget/);
mustNotMatch('芯片轮询不再用全局 inFlightIndex 判活跃', client, /st\.inFlightIndex >= 0\s*\|\|/);

// ---------- 4. 双语键齐全 ----------
const keys = [
  'healthOk', 'healthSlow', 'healthProbeFailed', 'healthUnprobed', 'healthUnprobedHint',
  'healthSkipPaidHint', 'healthStale', 'healthAgo', 'healthProbeMs', 'healthVerifying',
  'healthRecoverIn', 'healthUnknown', 'healthProbeUnsupported',
  // 探测失败的归因文案：缺一个键，面板上就退回那句没信息量的「探测失败」
  'healthQuota', 'healthFreeQuota', 'healthRateLimited', 'healthUnreachable',
  'healthProbeTimeout', 'healthAuthFail',
  'reqSent', 'reqOk', 'reqFail', 'reqNone', 'pendingConfirm',
];
const zhStart = client.indexOf('      zh: {');
const enStart = client.indexOf('      en: {');
const zhBlock = client.slice(zhStart, enStart);
const enBlock = client.slice(enStart, client.indexOf('    function t(key, params)'));
for (const k of keys) {
  check(`中文键 ${k}`, new RegExp(`\\b${k}:`).test(zhBlock));
  check(`英文键 ${k}`, new RegExp(`\\b${k}:`).test(enBlock));
}

// ---------- 5. 真跑 healthOf：状态矩阵 ----------
const fmtAgeSrc = extractFunction(client, 'fmtAge');
const staleSrc = extractConst(client, 'HEALTH_STALE_MS');
const slowSrc = extractConst(client, 'HEALTH_SLOW_MS');
const healthSrc = extractFunction(client, 'healthOf');
const stubT = (key, params) => (params ? `${key}(${JSON.stringify(params)})` : key);
const makeHealth = new Function(
  't',
  `${fmtAgeSrc}\nconst HEALTH_STALE_MS = ${staleSrc};\nconst HEALTH_SLOW_MS = ${slowSrc};\n${healthSrc}\nreturn healthOf;`,
);
const healthOf = makeHealth(stubT);
const now = 1_000_000_000;
const snap = { pingIntervalMs: 60_000, pingSkipPaid: true };

const cases = [
  ['null 条目 → 灰', healthOf(null, snap, now), 'muted'],
  ['配置失效 → 红', healthOf({ invalid: true }, snap, now), 'error'],
  ['熔断中 → 红', healthOf({ state: 'open', recoverAt: now + 30_000 }, snap, now), 'error'],
  ['半开 → 黄', healthOf({ state: 'half_open' }, snap, now), 'warn'],
  ['closed 且从未测过 → 灰', healthOf({ state: 'closed', lastOkAt: null, lastProbeAt: null }, snap, now), 'muted'],
  ['closed 且刚探测成功 → 绿', healthOf({ state: 'closed', lastProbeAt: now - 5_000, lastOkAt: now - 5_000, probeOk: true, probeLatencyMs: 800 }, snap, now), 'ok'],
  ['closed 且探测失败 → 黄', healthOf({ state: 'closed', lastProbeAt: now - 5_000, probeOk: false }, snap, now), 'warn'],
  ['closed 且证据很旧仍显示上次结果 → 绿（不再降级为过期）', healthOf({ state: 'closed', lastProbeAt: now - 60 * 60_000, lastOkAt: now - 60 * 60_000, probeOk: true }, snap, now), 'ok'],
  ['closed 但响应很慢 → 黄', healthOf({ state: 'closed', lastProbeAt: now - 5_000, lastOkAt: now - 5_000, probeOk: true, probeLatencyMs: 9_000 }, snap, now), 'warn'],
  ['真实请求成功也算证据', healthOf({ state: 'closed', lastOkAt: now - 5_000 }, snap, now), 'ok'],
  ['付费且未测过 → 灰并解释跳过', healthOf({ state: 'closed', paid: 'paid', lastOkAt: null, lastProbeAt: null }, snap, now), 'muted'],
  ['老宿主快照（无证据字段）→ 退回旧语义绿', healthOf({ state: 'closed' }, snap, now), 'ok'],
];
for (const [name, got, want] of cases) {
  check(name, got && got.tone === want, `got ${got && got.tone} want ${want}`);
}
const skipPaidDetail = healthOf({ state: 'closed', paid: 'paid', lastOkAt: null, lastProbeAt: null }, snap, now).detail;
check('未验证的付费条目解释"跳过付费"', skipPaidDetail === 'healthSkipPaidHint', skipPaidDetail);
const unverifiedFree = healthOf({ state: 'closed', paid: 'free', lastOkAt: null, lastProbeAt: null }, snap, now).detail;
check('未验证的免费条目解释"没有结果"', unverifiedFree === 'healthUnprobedHint', unverifiedFree);
// 用户要求：不再有「证据过期」降级——没有新一轮检测/状态更新就一直显示上次结果
const offSnap = { pingIntervalMs: 0, pingSkipPaid: true };
check('探测关闭时 16 分钟前的证据仍显示上次结果（不降级过期）',
  healthOf({ state: 'closed', lastOkAt: now - 16 * 60_000 }, offSnap, now).tone === 'ok');
check('探测关闭时 10 分钟前的证据仍算可用',
  healthOf({ state: 'closed', lastOkAt: now - 10 * 60_000 }, offSnap, now).tone === 'ok');

// ---- 上一轮真实请求：面板唯一的事实行 ----
// 用户的原话是"切换了到底有没有真的改模型我不知道"，所以这里钉死：
// 面板必须显示真实请求走了哪条、成没成，而且没实证时不能编结论。
check('面板渲染上一轮真实请求', /t\('reqOk'/.test(client) && /t\('reqFail'/.test(client));
check('没发过消息时如实说没有', /t\('reqNone'\)/.test(client));
check('刚切换时显示等待确认', /t\('pendingConfirm'/.test(client));
check('面板不再有验证横幅', !/verifyText/.test(client));
check('面板不再有颜色图例占位', !/t\('legendHealth'\)/.test(client));
check('面板不再有宿主确认行', !/snap\?\.hostConfirmed/.test(client));
// 芯片面板精简（用户实测要求）：① 删掉「上一轮真实请求」独立行（用户说"没啥必要"）
// ② 探测/切换反馈并到底部工具条左侧同一行，不再单独占一行
// ③ 队列行间距缩小（padding 7px→4px 8px）并加极淡分割线。
check('面板删掉上一轮真实请求独立行', !/const line = requestLineText\(/.test(client));
check('面板探测/切换反馈并入底部工具条（flash 在左槽）', /bottom:\s*'calc\(100% \+ 10px\)'/.test(client)
  && /flash\s*\?\s*h\(\s*'span'/.test(client));
check('面板行间距缩小 + 极淡分割线', (client.match(/padding: '4px 8px'/g) || []).length >= 2
  && /borderBottom: '1px solid var\(--dsw-elevation-stroke-color/.test(client));
check('没有 P1 视图时不写"正常"', !/healthBadge\(p1Entry, snap, now\) \|\| h\(Badge, \{ tone: 'muted' \}, t\('stateOk'\)\)/.test(client));
// 用户嫌 emoji 圆点「好复古」：健康状态点改成扁平的纯色实心小圆点（无渐变无高光），取宿主静态色板
check('健康状态点用扁平纯色（非 emoji）', /HEALTH_DOT/.test(client) && /--dsw-static-green-500/.test(client));
check('健康状态点不用渐变高光', !/radial-gradient/.test(client));
check('健康状态点不再用 emoji 圆点', !/🟢|🟡|🔴|⚪/.test(client));
check('健康状态点尺寸小巧（8px 圆点）', /width: 8[\s\S]{0,80}?height: 8/.test(client));
check('设置页图例不再用 emoji 圆点', !/legend: '[^']*🟢/.test(client));
// 用户要求图例前恢复彩色小圆点（和队列行同款扁平点，不用 emoji）：用一个 legendItem(tone,labelKey)
// 渲染四个 HEALTH_DOT 颜色点 + 文字，而不再是一整串纯文本。
check('设置页图例恢复彩色圆点（legendItem + HEALTH_DOT 四色）', /function legendItem\(tone, labelKey\)/.test(client)
  && /legendItem\('ok', 'legendOk'\)/.test(client)
  && /legendItem\('warn', 'legendWarn'\)/.test(client)
  && /legendItem\('error', 'legendError'\)/.test(client)
  && /legendItem\('muted', 'legendMuted'\)/.test(client)
  && /background: HEALTH_DOT\[tone\]/.test(client));
// 逐条探测状态（探测中 → 探测完成 → 消失）：后端下发 probeStatus + TTL 自动清空，前端逐行渲染 probeBadge
check('后端：探测逐条状态 probeStatus + TTL', /probeStatus: null/.test(index) && /probeStatusUntil/.test(index)
  && /probeStatusTtlMs/.test(index));
check('后端：probeAllRoutes 写 probing/done 状态', /state: 'probing'/.test(index) && /state: 'done'/.test(index));
check('前端：逐行渲染 probeBadge（设置页 + 芯片面板）', /function probeBadge\(status\)/.test(client)
  && (client.match(/probeBadge\(/g) || []).length >= 3);
// 探测汇总必须报「总条数」并说明含 P1：队列只显示 P2..Pn，但探测会把 P1（会话模型）
// 一起探，旧文案只报 X/Y，用户数队列 4 条却看到 3+2=5 会质疑（实测）。
check('前端：探测汇总报总条数 + 注明含 P1', /function probeSummary\(results\)/.test(client)
  && /hasP1 = list\.some\(\(x\) => x\.index === -1\)/.test(client)
  && /共 \{total\} 条/.test(client) && /含 P1 当前模型/.test(client)
  && !/probeAllDone: '探测完成：\{ok\} 可用/.test(client));
check('前端：探测中设置页实时轮询快照', /probeLive/.test(client) && /setInterval\(async \(\) =>/.test(client));
// 模型选择弹框底部漏出横向滚动条：行 width:100% + 左右 padding 缺 box-sizing → 溢出。
// 修法：滚动容器 overflowX:'hidden' + 组头/模型行都加 boxSizing:'border-box'。
check('弹框列表不横向溢出（overflowX hidden + box-sizing）', /overflowY: 'auto', overflowX: 'hidden'/.test(client)
  && (client.match(/boxSizing: 'border-box'/g) || []).length >= 2);
check('设置页上报表单失败', /if \(!r\?\.ok\) setErr\(t\('saveFailed'/.test(client));
check('设置页不再永久卡在加载中', /\.\.\.\(s \|\| \{\}\)/.test(client));
check('探测被拒不画成黄色风险', /PROBE_UNSUPPORTED/.test(client));
// 快照里保留字段名给老客户端，但恒为 null，不会被误读成"验证失败"
check('lastVerify 恒为 null（老客户端兼容）', /lastVerify: null,/.test(index));

// ---------- 6. 真跑 requestLineText：面板唯一事实行的状态矩阵 ----------
const fmtAge2 = extractFunction(client, 'fmtAge');
const rlSrc = extractFunction(client, 'requestLineText');
const makeLine = new Function('t', 'fmtAge', `${rlSrc}\nreturn requestLineText;`);
const lineOf = makeLine(stubT, new Function(`return ${fmtAge2}`)());
const T0 = 1_000_000_000;
const P = (snap) => lineOf(snap, T0);
const cases2 = [
  ['没发过消息 → 如实说没有', P(null), 'reqNone'],
  ['请求已发出待结果', P({ lastRequest: { index: 1, state: 'sent', at: T0 - 1000 } }), 'reqSent'],
  ['请求成功 → 事实', P({ lastRequest: { index: 1, state: 'ok', at: T0 - 5000, settledAt: T0 - 4000 } }), 'reqOk'],
  ['请求失败 → 事实 + 错误码', P({ lastRequest: { index: 2, state: 'fail', at: T0 - 5000, code: 'QUOTA' } }), 'reqFail'],
  ['刚切换且没有更新的请求 → 等待确认', P({ pendingConfirm: { index: 2, at: T0 }, lastRequest: { index: 0, state: 'ok', at: T0 - 60_000 } }), 'pendingConfirm'],
  ['切换之后已有真实请求 → 以请求为准', P({ pendingConfirm: { index: 2, at: T0 - 10_000 }, lastRequest: { index: 2, state: 'ok', at: T0 - 5000, settledAt: T0 - 4000 } }), 'reqOk'],
];
for (const [name, got, want] of cases2) {
  check(name, got && got.text.startsWith(want), `got ${got && got.text} want ${want}`);
}
check('失败用红色（其余用中性色）', P({ lastRequest: { index: 1, state: 'fail', at: T0, code: 'AUTH' } }).color.includes('error')
  && P({ lastRequest: { index: 1, state: 'ok', at: T0, settledAt: T0 } }).color.includes('label-secondary'));
check('P1 槽显示成 P1', P({ lastRequest: { index: -1, state: 'ok', at: T0, settledAt: T0 } }).text.includes('P1'));
check('队列下标按 p1Follow 换算', P({ p1Follow: true, lastRequest: { index: 1, state: 'ok', at: T0, settledAt: T0 } }).text.includes('P3'));

// ---------- 7. 探测被拒 ≠ 模型不可用 ----------
check('探测被拒显示为未测（灰）',
  healthOf({ state: 'closed', lastProbeAt: now - 5_000, probeOk: null, probeError: { code: 'PROBE_UNSUPPORTED' } }, snap, now).tone === 'muted');
check('探测被拒的解释说明不影响可用性',
  healthOf({ state: 'closed', lastProbeAt: now - 5_000, probeOk: null, probeError: { code: 'PROBE_UNSUPPORTED' } }, snap, now).detail === 'healthProbeUnsupportedHint');

// ---------- 8. 探测失败必须说清「为什么失败」 ----------
// 用户原话："无论是手动探测全部还是自动，都显示有问题，到底是显示有问题还是没探测"。
// 根因是归因缺失：额度用尽（等到点自己恢复）、免费池超额、网关连不上、密钥失效
// 在面板上完全是同一个词，用户只能猜成"模型被删了"。下面把归因矩阵钉死。
const probeFailed = (err) => healthOf({ state: 'closed', lastProbeAt: now - 5_000, probeOk: false, probeError: err }, snap, now);
const quotaCase = probeFailed({ code: 'QUOTA_EXCEEDED', message: 'X：模型 gfmodel 的可用账号均在限流中，最近一个将于 2026/10/30 00:00:00 解锁。' });
check('额度用尽 → 主标签直接写原因', quotaCase.text === 'healthQuota', quotaCase.text);
check('额度用尽 → 右耳给解锁倒计时', /healthRecoverIn/.test(quotaCase.short), quotaCase.short);
check('额度用尽 → 悬浮提示保留上游原话', quotaCase.detail.includes('解锁'), quotaCase.detail);
const freeCase = probeFailed({ code: 'THROTTLED', message: 'Free usage limit reached. Free models work in OpenCode' });
check('免费池超额 → 单独文案', freeCase.text === 'healthFreeQuota', freeCase.text);
const netCase = probeFailed({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1234' });
check('网关连不上 → 单独文案', netCase.text === 'healthUnreachable', netCase.text);
const authCase = probeFailed({ code: 'AUTH', message: 'invalid api key' });
check('钥匙失效 → 单独文案', authCase.text === 'healthAuthFail', authCase.text);
const unknownCase = probeFailed({ code: 'WEIRD', message: 'boom' });
check('无法归因时退回「探测失败」', unknownCase.text === 'healthProbeFailed', unknownCase.text);
check('没有解锁时刻时不编倒计时', !/healthRecoverIn/.test(unknownCase.short), unknownCase.short);
check('宿主下发 probeResetAt', /probeResetAt: c\.probeResetAt/.test(index));
check('探测成功清掉解锁时刻', /c\.probeResetAt = 0;/.test(index));

// ---------- 9. 「当前」必须标在真正作答的那条上 ----------
// 用户实测的困惑：P1–P5 全红、P6 兜底答了话，面板却写「当前 P1」+「无切换记录」，
// 连模型自述都是 P1 的名字（它看到的就是 P1 的模型名）。根因是「当前」绑的是游标，
// 不是"这一轮谁答的"。下面把这套口径钉死。
check('失败请求带跳过条数', /skipped: Math\.max\(0, full\.indexOf\(route\)\)/.test(index));
check('失败请求带实际尝试次数', /attempts,/.test(index));
check('前端用成功记录判定真正作答的路由', /lastReq\.state === 'ok'/.test(client));
check('「当前」优先取真实作答位', /const currentIdx = servedIdx !== null \? servedIdx : effective;/.test(client));
check('P1 行也用同一口径判当前', /const p1IsCurrent = servedIdx !== null \? servedIdx === p1Slot : p1Active;/.test(client));
check('队列行高亮跟真实作答位走', /const isActive = servedIdx !== null \? servedIdx === e\.index : effective === e\.index;/.test(client));
check('游标与作答位不同时标「起点」', /startTag/.test(client) && /const startHere = servedIdx !== null && servedIdx !== p1Slot/.test(client));
check('芯片标签跟真实作答位走', /label = lbl\(currentIdx\);/.test(client));
check('标题徽章跟真实作答位走', /badgeCurrent', \{ label: lbl\(currentIdx\) \}/.test(client));
check('芯片 title 跟真实作答位走', /\$\{lbl\(currentIdx\)\} \$\{effHealth\.text\}/.test(client));
check('P1 行可切换态也按作答位判', /enabled && !p1IsCurrent/.test(client));
check('不再用游标口径画「当前」', !/lbl\(effective\)/.test(client));
check('底部先说上一轮谁答的（跳过 N 条）', /reqServed/.test(client) && /reqServedDirect/.test(client));

if (failures.length) {
  console.error(`✗ ${failures.length} 项失败 / ${pass + failures.length} 项`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
