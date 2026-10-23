# 四大功能施工规格 · feature-spec

> 插件：dsh-model-fallback-queue（v0.2.5 → v0.3.0）
> 分支：feat/model-select-and-pin · 状态：规格定稿，供 engineer/verifier/reviewer 依据
> 日期：2026-10-23 · 编写：designer（requirements & design）

## 0. 需求原文（Magi 的权威表述）

> "我想给当前的 dsh 插件 增加一个功能，就是增加 AI 订阅厂商的排序，相当于 dsh 有 ABC 厂商，然后 AB 是免费的，我可以勾选 AB 的一些模型，顺序切换勾选的模型，顺序是 A1，A2，A3，B1 B2 之类的，如果用不了了，就顺序切换。然后添加个置顶，就是可以指定一个厂商下的模型最为大保底，会话页面上也显示出来。并且标记出免费还是付费。而且增加一个类似于 ping 的机制，可以更快检测到哪些模型不能用了，或者死了。"

拆解为四大功能（F1–F4），下文逐条给实现规格。

---

## 1. 总体设计取向（本规格的骨架，先读）

**所有四个功能都是现有架构的「字段 + 选择策略」扩展，不是重写故障转移引擎。**

- 现有引擎已经做了「顺序可用切换」（`resolveIndex` → `pickFrom` → `nextPositions` 环形候选序；失败 `onFailedAttempt` 顺延下一条）。F1/F2 只是**给队列条目加字段**、并**改候选序（nextPositions）的排序规则**，切换的骨架不动。
- 队列仍存在 state 文件（`$DSH_HOME/fallback-queue-state.json`），**只是把 schema 从 v1 升级到 v2**——这是 state.js 的迁移点（现有 `state.js:78-79` 的版本挂载点）。
- 快照（`router.snapshot()`）继续作为前端唯一的数据源（连同 `getQueue()`），**新字段通过快照下发**，前端不必另开通道。
- RPC 面在现有 5 个方法基础上**新增 1 个**：`pingAll()`（快速探测）。其余靠 `snapshot()`/`setQueue()` 承载。

下面每一条都以「**改哪个函数/文件、加什么字段、边界是什么**」的粒度写，engineer 可直接照着实现。

---

## 2. 新队列条目结构（state.js v2）

### 2.1 条目 schema（单条）

```js
{
  provider: string,   // 不变，必填
  model:    string,   // 不变，必填
  pinned:   boolean,  // 新增 · 大保底：true = 该条目永远排到候选序最后才试（见 §3）
  tier?:    string,   // 新增 · 可选 · 厂商分组标签（如 "A"/"B"/"C" 或厂商 id）；用于 UI 分组展示与排序，引擎不依赖它
  paid?:    'free' | 'paid' | 'unknown',  // 新增 · 免费/付费标记；默认 'unknown'（未标注就unknown，不瞎猜）
}
```

- `pinned`：**必须永远存在且为布尔**（v2 normalize 时归一化）。
- `tier` / `paid`：可选，缺省即 `undefined`/`'unknown'`，不写进文件。

### 2.2 为什么 pinned 只能用「候选序排最后」，不能用「固定队尾下标」

用户会**继续自由拖拽排序**（现有 ↑/↓）。若 pinned 语义是「恒定 phys[尾]」，一旦用户拖一个非 pinned 到它后面，pinned 就不再是队尾，语义塌了。所以：

> **pinned = 逻辑恒量，不由物理下标决定**。无论队列怎么排，选择引擎在「候选序」里永远把 pinned 条目排到所有非 pinned 之后；物理列表里 pinned 条目可以出现在任何位置（UI 可加视觉标记，但引擎不依赖它的下标）。

这与 Magi 原话「置顶，指定一个厂商下的模型作为大保底，会话页面上也显示出来」一致——大保底是**兜底**（最后用），不是**置顶**（最优先）。UI 文案用「大保底」，避免与"置顶"字面冲突（文档统一：**大保底 = always-last = 最后兜底**）。

### 2.3 迁移规则（v1 → v2）

`state.js` 现状：`STATE_VERSION = 1`；`readQueueState()` 在 `state.js:78-79` 对 `version !== STATE_VERSION` 直接 `return null`。

v2 迁移要求：

```js
const STATE_VERSION = 2;
const SUPPORTED_VERSIONS = [1, 2]; // v1 需迁移，其他版本拒绝

export function migrateQueue(rawQueue /* v1 或 v2 条目数组 */) {
  return normalizeQueue(rawQueue); // normalize 负责补 pinned，见 §2.4
}

export function normalizeQueue(raw) {
  // 现有逻辑保留，但每条多补 pinned：
  //   out.push({ provider, model, pinned: !!item.pinned, ...(item.tier ? {tier: String(item.tier)} : {}),
  //             paid: item.paid === 'free' || item.paid === 'paid' ? item.paid : 'unknown' });
}
```

具体迁移语义（readQueueState 内部）：

1. 读到 `version === 2`：直接 `normalizeQueue(parsed.queue)`。
2. 读到 `version === 1`（或旧文件无 version 字段但能解析成 `{queue:[…]}`）：**先迁移**——把原 `{provider,model}` 条目逐条补 `pinned:false, paid:'unknown'`，**再落盘成 v2**（`writeQueueState` 一次），然后返回。迁移是幂等的：下次再读就是 v2。
3. 读到 `version` 非 1/2：`return null`（维持现状，不臆造）。
4. `writeQueueState` 总是写 `{version:2, queue}`。

> 边界：迁移只改结构（补默认字段 + 升 version），**绝不动用户已排好的顺序和已 pin 的标记之外的任何行为**。空的 `[]` 与 `null`（无文件）语义保持：`[]` = 明确空队列不回退，`null` = 回退 settings 历史队列。

---

## 3. F1 厂商勾选排序（A1→A3→B1→B2）

### 3.1 语义

- **厂商 = modelCatalog 的 group**（`window.__fallbackQueueSession.modelCatalog().value.groups[]`，每个 group `{id, name, models:[{id,name}]}`，见 client.js:298-301、client.js:390-410）。所以「厂商」就是 group.id。
- **勾选**：在现有 ModelPicker 里把「点一行加入」升级为「每行一个 checkbox」——可一次勾多个模型，勾完统一「确定添加到队列」。现有单点击 + `onPick(g.id, m.id)` 的立即添加逻辑保留为退化路径（兼容），但主交互改为勾选批处理。
- **排序 A1→A3→B1→B2**：这是一个**用户可见的分组顺序**，不是引擎硬规则。做法：
  - UI 层：新加的模型按「所在 group（厂商）→ 组内顺序」追加进队列，队列就呈现 A1,A2,A3,B1,B2。
  - 引擎层：**无需改动**。引擎只认 `config.queue` 的物理顺序（现有 resolveIndex/pickFrom 已经按物理序顺延）。所以「A 全挂 → 顺延到 B」天然成立，不需要给引擎传 tier。
  - `tier` 字段仅用于：UI 按厂商把队列条目**视觉归组**（分组标题 + 组间拖拽），可选增强，非必须。

### 3.2 边界（F1 不做什么）

- **不做**跨厂商的"自动夺取优先"——顺序完全由用户勾选/拖拽后的 `config.queue` 物理序决定。
- **不做**厂商级健康聚合——熔断仍是 per-model（provider␀model）粒度（现状，保持不变）。
- 勾选窗口允许**跨多个厂商**一次勾（A 勾 3、B 勾 2，确定后得到 A1,A2,A3,B1,B2）。

### 3.3 实现点（client.js 为主）

| 位置 | 改动 |
|---|---|
| `ModelPicker` 模型行（client.js:390-410） | 把 `button` 行升级为 checkbox 行：`checked` 状态变量集合；已存在队列中的模型默认勾选但禁用取消（防重）；「+ 已添加」角标保留 |
| ModelPicker 底部 | 新增「确定添加 N 个」「取消」按钮（批处理提交） |
| `onPick` 调用点（client.js:746-750） | 改为批量：遍历勾选集合，逐个 `writeQueue([...q, {provider, model}])`（防重复兜底保留） |
| 队列渲染（client.js:634-687） | 可选增强：按 `tier` 分组合并显示；每行尾部加 PIN 按钮（F2）、免费/付费角标（F3） |

---

## 4. F2 大保底置顶（pinned = 最后兜底）

### 4.1 语义

- 每个队列条目可**pin/unpin**（每行一个「📌 大保底」按钮）。
- **pinned 条目的选择优先级 = 恒最后**：
  - 其它（非 pinned）条目按用户物理序优先尝试；
  - 所有非 pinned 都不可用时，才轮到 pinned；
  - pinned 之间仍有多个时，**按它们在队列里的物理序**顺延（多个大保底很少见，但语义要定义清楚）。
- 会话页（chip）面板与设置页队列都**显示大保底标记**（📌 + 文案「大保底」）。

### 4.2 引擎改动（index.js）——这是本功能的**核心**，engineer 重点

选择路径现在都走 `pickFrom(cur, …)` → `nextPositions(startIndex)`（index.js:379-394，环形候选序）与 `resolveIndex`（index.js:516-541）。要让 pinned「最后试」，改 **`nextPositions` 的输出顺序**即可（一处改动覆盖 resolveIndex 与 onFailedAttempt 两条调用链，因为后者最终也调 resolveIndex）：

```js
// 候选序重排：把 pinned 条目全部挪到环的末尾（保持各自相对物理序），非 pinned 保持原环序。
// 注意：-1 = P1 槽（p1Follow 下会话模型，无队列条目，恒视为"非 pinned"）→ 自然停留在最前。
function nextPositions(startIndex) {
  const queue = config.queue || [];
  const n = queue.length;
  if (!config.p1Follow) {
    // 静态模式：环 = 物理序（候选 = 除 startIndex 外绕一圈）
    const candidates = [];
    for (let step = 1; step <= n; step += 1) candidates.push((startIndex + step) % n);
    return reorderPinnedLast(candidates, queue);
  }
  // p1Follow：环 = [P1(-1), 队列0=P2, …]；P1 槽恒最先（它是当前会话模型）；队列下标里 pinned 垫后。
  const ring = [-1];
  for (let i = 0; i < n; i += 1) ring.push(i);
  const at = ring.indexOf(startIndex);
  const base = at >= 0 ? at : 0;
  const candidates = [];
  for (let step = 1; step <= ring.length - 1; step += 1) candidates.push(ring[(base + step) % ring.length]);
  return reorderPinnedLast(candidates, queue); // -1 无条目 → 恒留 front，pinned 下标 sink 到 tail
}

// 把属于 pinned 条目的位置抽出来统一追加到序列末尾；保持未 pin 者相对顺序、pinned 者相对物理序。
// position 为 -1（P1 槽）时视为非 pinned（无 queue 条目可查）。
function reorderPinnedLast(positions, queue) {
  const pinned = [], rest = [];
  for (const p of positions) {
    const r = p >= 0 ? queue[p] : null;
    (r && r.pinned ? pinned : rest).push(p);
  }
  return [...rest, ...pinned];
}
```

> 实现提示：现有 `nextPositions` 返回「不含自身、绕一圈」的候选序，`pickFrom` 用 `for (const pos of nextPositions(startIndex))` 逐个 `positionAvailable` 试。**改它的输出顺序 = 全局生效**，无需动 `pickFrom`/`resolveIndex`/`onFailedAttempt`。额外注意：现有 `nextPositions` 对 p1Follow 已经构造了含 -1 的 ring，改时保持 P1(-1) 最优先（P1 是当前会话模型，本就该最先试），只把**队列下标部分**的 pinned 垫后。

### 4.3 边界（F2 不做什么）

- **不影响**熔断/冷却/半开状态——pinned 条目一样熔断、一样冷却，只是候选序靠后。
- **不强制唯一**：允许多个 pinned（多保险），按物理序顺延。
- **不写死队尾**：物理下标可变（见 §2.2 的论证）。
- 若队列中**所有条目都被 pin**：等效于没 pin（候选序仍是物理序），不特殊处理。
- p1Follow 下的 P1 槽（会话模型）**不能**被 pin（它不在队列里，没有条目可 pin）；UI 不显示 P1 行的 pin 按钮。

### 4.4 快照与前端下发

`router.snapshot().entries[i]` 目前在 `index.js:659` 构造 `{index, provider, model, ...view(r)}`。**新增**透传：

```js
entries: queue.map((r, i) => ({
  index: i, provider: r.provider, model: r.model,
  pinned: !!r.pinned, paid: r.paid || 'unknown', tier: r.tier || null,  // + 新字段
  ...view(r),
}))
```

前端 `SettingsPage` 每行（client.js:634-687）据此加：
- PIN 开关按钮（切换 `pinned`）；开关态用 📌 高亮；
- 免费/付费角标（见 F3）；
- 大保底行在**徽章前**显示「📌 大保底」tag。

`Chip` 面板同理：列出行时显示 📌 标记（读 `snap.entries[i].pinned`）。

---

## 5. F3 免费/付费标记

### 5.1 语义

- 每个队列条目显示**免费/付费**标记：`免费` / `付费` / `未标注`（`paid: 'free'|'paid'|'unknown'`）。
- 标记**由用户在添加时/设置页手动指定或修改**，**不是**引擎自动判定（没有可靠的免费/付费数据源——modelCatalog 不含价格注解；不要从别处猜）。

### 5.2 数据入口

- **添加时**：ModelPicker 每行或批处理面板提供「免费/付费」下拉（默认 `unknown`）。
- **设置页每行**：一个免费/付费切换（点击在 free/paid/unknown 之间轮转，或一个小选择器）。
- 写回 `config.queue[i].paid` 后 `setQueue` 落 state 文件。

### 5.3 显示

- 设置页队列行、chip 面板的行：模型名旁一个小标记。
  - `free` → 绿点/「免费」
  - `paid` → 琥珀色点/「付费」
  - `unknown` → 无标记（不显示，避免噪音）
- 新增文案键（见 §9 双语表）。

### 5.4 边界（F3 不做什么）

- **不做**成本估算、余额查询、用量统计（原 design-plan §2「不解决」保持）。
- **不做**基于付费状态的自动分流（付费/免费只是一个标签，不改变调度优先级——优先级只由队列物理序 + pinned 决定）。
- `paid` 不参与候选序排序。

---

## 6. F4 快速 ping 探测（全员周期健康扫描）

### 6.1 语义

- **现有**：只有「半开且超时」的路由才被主动探测（`staleHalfOpen`，`PROBE_TIMEOUT_MS=90s`，每 15s 扫一次，`probeRoute` 串行，index.js:295-308、945-948）。这只能探测**已经熔断过**的路由。
- **新增**：「快速 ping」= 一个**手动触发 / 周期可选**的全员健康扫描：对队列里**每条路由**发微型探测（复用现有 `probeRoute` 的 `llm.stream({…messages:[{role:'user',name:'fallback-queue-probe',content:'ping'}], maxTokens:1})` 方法，首 chunk 即成功）。
- 目的：**更快发现"还没熔断但已经死了"的模型**（比如 API key 失效、模型下架、网络不通但没沉到一个请求去撞）。探测结果写进电路（成功 `recordSuccess` / 失败 `recordFailure`），让 UI 徽章立即反映真实健康。

### 6.2 触发方式（两种，都实现）

1. **手动**：设置页 + chip 面板一个「🔍 立即探测全部」按钮 → RPC `pingAll()` → 逐条探测，UI 显示进度（n/N）。
2. **周期（可选，默认关）**：新配置项 `pingIntervalMs`（默认 `0` = 关闭）。>0 时，插件的 `probeTimer setInterval(15s)` 扫描逻辑扩展为：每 `pingIntervalMs` 跑一轮全员探测（复用同一串行 `probing` 锁，不重叠）。

### 6.3 RPC 契约（新增第 6 个方法）

```js
// index.js FallbackQueueService
// markRemoteMethods 列表追加 'pingAll'（index.js:767）
async pingAll() {
  if (this.router.runtime.probeInFlight) return { ok: false, reason: 'busy' }; // 已有探测在飞
  this.router.runtime.probeInFlight = true;
  const queue = this.config.queue || [];
  const results = [];
  for (const [i, r] of queue.entries()) {
    const ok = await this.probeOne(r);        // 复用 probeRoute 的核心逻辑（抽成可被 index.js 与 RPC 调用的内部函数）
    results.push({ index: i, provider: r.provider, model: r.model, ok });
  }
  this.router.runtime.probeInFlight = false;
  return { ok: true, results };
}
```

- 新增内部函数 `probeOne(route): Promise<boolean>`（从现有 `probeRoute` 抽出可复用部分，index.js:917-944），供 `probeRoute`（半开扫描）与 `pingAll`（全员扫描）共用。
- `snapshot()` 新增 `probingAll: boolean`（由 `runtime.probeInFlight` 派生），供 UI 显示「探测中… n/N」进度。把运行态 `probeInFlight` 并进 `runtime`（现 stub 已有 `probeInFlight`，见压缩记忆——直接落到它）。

### 6.4 成本节制（付费模型要节制 —— 关键边界）

Magi 的语境里免费/付费模型混用，**ping 是对服务器发真实请求**（虽然 maxTokens=1，仍消耗配额/可能扣费）。规格强制：

1. **探测内容恒定最简**：`maxTokens: 1`、`messages:[单条 'ping']`，首个 chunk 即 `interrupt()` 中断（现有 probeRoute 已如此，probeOne 保持）。
2. **周期扫描默认关**（`pingIntervalMs=0`）。打开需用户在设置页显式开启，并给文案警告「可能消耗配额/费用」。
3. **付费条目在周期扫描里可跳过**：设置项 `pingSkipPaid`（默认 `true`）——周期全员扫描**跳过 `paid==='paid'` 的条目**（避免定时给付费模型制造请求）。手动按钮不受此限（用户明确点了就探）。
4. 探测串行（复用 `probing` 锁），同一时刻至多一个探测在飞，避免并发风暴；每次探测 15s 超时（index.js:933）。

### 6.5 边界（F4 不做什么）

- **不做** TCP/ICMP 层 ping（探测的是「模型能不能回话」，不是「网络通不通」——后者无意义，端点由 DSH 适配层管理）。
- **不做**并发探测（保持串行）。
- **不改变**熔断/回切逻辑——ping 结果只是给电路 `recordSuccess`/`recordFailure`，之后走既有判定。
- `pingAll` 不 ping `P1` 槽（会话模型，不在队列里）——与 `probe(index)` 现有语义一致（probe 只对 `config.queue[index]` 生效，index.js:717-726）。P1 由真实请求自然探测。

---

## 7. 前端/后端契约汇总（interface contract）

### 7.1 RPC 方法面（`FallbackQueueService`，namespace `dsh-model-fallback-queue`）

| 方法 | 现状 | 变更 |
|---|---|---|
| `snapshot()` | 有 | 返回体加 `entries[].pinned/.paid/.tier` + `probingAll`（见 7.2） |
| `probe(index)` | 有 | 不变 |
| `manualFailback(index)` | 有 | 不变 |
| `getQueue()` | 有 | 不变（条目带新字段天然透传） |
| `setQueue(queue)` | 有 | 不变（`normalizeQueue` 在 v2 补 pinned/paid，见 §2） |
| **`pingAll()`** | **新增** | 见 §6.3 |

`markRemoteMethods`（index.js:767）列表追加 `'pingAll'`。

### 7.2 `snapshot()` 返回体 diff

```js
{
  …现有字段不变（enabled/p1Follow/activeIndex/inFlightIndex/sessionInFlight/
    effectiveIndex/lastProposal/sessionModel/sessionModelBySession/p1/
    lastSwitch/revision/cooldownMs）,
  probingAll: boolean,                        // + 新增，F4 进度指示
  entries: [{ index, provider, model,
              pinned: boolean,                // + 新增，F2
              paid: 'free'|'paid'|'unknown',  // + 新增，F3
              tier: string|null,              // + 新增，F1 分组展示（可选）
              …view(r)（state/failures/invalid/lastError/source/openedAt/recoverAt/retryAfterMs）},
            …],
}
```

### 7.3 新配置项（Config schema，index.js:1168-1178，全部 `.volatile()`）

```js
pingIntervalMs: s.number().default(0)      // 周期全员 ping 间隔毫秒；0=关闭。默认 0。
pingSkipPaid:    s.boolean().default(true) // 周期扫描跳过 paid 条目；默认 true（省钱省配额）。
```

> 说明：`queue` 仍**不进** settings schema（现值 state 文件，v2 同理），避免 ui-theme 全量重算（state.js 顶部注释的既定取舍，维持）。

### 7.4 前端 host 桥新增（client.js:1312-1404）

```js
async pingAll() {
  try {
    const r = await rpcFace?.pingAll?.();
    return unwrapEnvelope(r); // {ok, results:[{index,provider,model,ok}]} 或 null
  } catch (e) { console.warn('[fallback-queue] pingAll failed', e); return null; }
}
```

设置页 + chip 各加「探测全部」按钮，调用 `host.pingAll()` 后 `refresh()`；`snap.probingAll` 为 true 时按钮置灰 + 显示进度。

---

## 8. 每功能验收标准（供 verifier / reviewer 沿用）

> 这些直接成为 team.json 里 engineer 验收判据的种子。每条都要可执行验证。

**根验（不影响四大前置）**：v1 老 state 文件升级到 v2：读 → 迁移 → 落 v2 一次成功；用户原有队列顺序不变；无额外字段丢失。

**F1 勾选排序**
1. ModelPicker 能跨厂商一次勾多个模型；
2. 确定后队列呈现 A1,A2,A3,B1,B2（按先厂商、后组内序追加）；
3. 队列可继续拖拽/↑↓ 调序，顺序即切换顺序（引擎无额外规则）。
4. 防重复：已入队模型在 picker 里勾选态置灰且不可取消。

**F2 大保底**
1. pin 一个条目后，其余非 pinned 条目按序优先；把非 pinned 全部弄挂（模拟 fault），最后才落到 pinned；
2. 取消 pin 后立即恢复物理序优先级；
3. 会话页 chip 面板与设置页队列行都显示 📌/「大保底」标记；
4. P1 槽（p1Follow 下会话模型）无 pin 按钮；
5. 全 pin 时行为 = 无 pin（退化安全）。
6. **引擎单测/手工**：构造 queue=[A(非pin),B(pin),C(非pin)]，`nextPositions(A下标的候选序)` 首个可用应优先 C 而非 B；`nextPositions` 输出里 pinned(B) 必在 C 之后。

**F3 免费/付费**
1. 添加时可指免费/付费/未标注；
2. 设置页每行可改 paid，落 state 文件重启后仍在；
3. UI 免费/付费标记正确渲染（free 绿 / paid 琥珀 / unknown 无标记），chip 面板同步；
4. paid 不参与候选序排序（顺序只由物理序 + pinned 决定）。

**F4 ping**
1. 「探测全部」按钮触发后，每个队列条目收到探测，结果为 ok/fail 反映到徽章；
2. 探测内容 = 单条 'ping'、maxTokens=1、15s 超时、串行（探测期间按钮禁用、`probingAll=true`）；
3. 周期 ping 默认关；打开后默认跳过 paid 条目（`pingSkipPaid=true`）且不并发；
4. 探测成功 `recordSuccess`（熔断闭合）、失败 `recordFailure`（计入熔断路径）——与既有判定一致。

**双语**：新增文案必须同时进 `TEXT.zh` 与 `TEXT.en`（见 §9），缺失视为 leak。

---

## 9. 新增双语文案清单（直接进 client.js `TEXT` 表）

### zh

| key | 文案 |
|---|---|
| `pinLast` | 设为最后兜底（大保底） |
| `unpin` | 取消大保底 |
| `pinnedTag` | 大保底 |
| `paidFree` | 免费 |
| `paidPaid` | 付费 |
| `paidUnknown` | 未标注|
| `setPaidFree` | 标为免费 |
| `setPaidPaid` | 标为付费 |
| `setPaidUnknown` | 清除标记 |
| `probeAll` | 探测全部 |
| `probingAll` | 探测中… {done}/{total} |
| `probeAllDone` | 探测完成：{ok} 可用 / {fail} 不可用 |
| `pickerAddN` | 添加 {n} 个到队列 |
| `pickerTierHeader` | 厂商：{name} |
| `pingInterval` | 周期健康探测间隔（毫秒，0=关闭） |
| `pingSkipPaid` | 周期探测跳过付费模型（省配额） |
| `pingCostWarn` | ⚠ 周期探测会向模型发送真实请求，可能消耗配额/费用；付费模型默认跳过，可在下方关闭跳过 |
| `queueRowHint` | 📌=最后兜底（大保底）· ●绿=免费 ●琥珀=付费 |

### en

| key | 文案 |
|---|---|
| `pinLast` | Pin as last-resort (safety net) |
| `unpin` | Unpin (not last-resort) |
| `pinnedTag` | Safety net |
| `paidFree` | Free |
| `paidPaid` | Paid |
| `paidUnknown` | Unmarked |
| `setPaidFree` | Mark as free |
| `setPaidPaid` | Mark as paid |
| `setPaidUnknown` | Clear mark |
| `probeAll` | Probe all |
| `probingAll` | Probing… {done}/{total} |
| `probeAllDone` | Probe done: {ok} ok / {fail} unavailable |
| `pickerAddN` | Add {n} to queue |
| `pickerTierHeader` | Vendor: {name} |
| `pingInterval` | Periodic health probe interval (ms, 0 = off) |
| `pingSkipPaid` | Skip paid models in periodic probes (saves quota) |
| `pingCostWarn` | ⚠ Periodic probing sends real requests to models and may use quota/charges; paid models are skipped by default, disable the skip below to include them |
| `queueRowHint` | 📌 = last-resort (safety net) · ●green=free ●amber=paid |

> 命名遵循现有 `TEXT` 表 camelCase 风格；`t(key, params)` 已支持 `{done}/{total}/{n}/{ok}/{fail}/{name}` 插值（client.js:200-205）。

---

## 10. 影响面与回归 (regression)

- **不改** settings schema 的现有 6 键（enabled/p1Follow/immediateCodes/failureThreshold/cooldownMs/failbackMode/failbackDelayMs）。
- **不改** 熔断三态、失败分层、会话隔离、粘滞回切的核心路径，只在 `nextPositions` 输出排序列上做 pinned 垫后。
- **state.js 升级到 v2**：老用户升级打开即自动迁移一次（读 v1 → 补字段 → 写 v2），零手动。
- **P1 槽**（p1Follow 下会话模型）语义不变；pin 与 pingAll 都不触碰它。
- client 侧新字段全部向后兼容：`snap.entries[i].pinned/paid` 缺失时前端用默认值（`false`/`'unknown'`）兜底，老 host + 新 client / 新 host + 老 client 不崩。

## 11. 交付顺序建议（engineer 可参考）

1. state.js v2 迁移 + normalize 补字段（含迁移单测）→ 2. index.js `nextPositions` pinned 垫后 + snapshot 透传新字段 → 3. RPC `pingAll` + `probeOne` 抽取 + 新配置项 → 4. client.js ModelPicker 勾选批处理 → 5. 设置页行内 PIN/paid + chip 标记 → 6. probe all 按钮 + 周期项 UI → 7. 文案全量、回归、PR。
