# 迁移方案：故障转移适配 dsh 0.2.2-rc.1 新宿主契约

> 插件：dsh-model-fallback-queue（当前 v0.3.5）
> 目标宿主：0.2.2-rc.1
> 状态：**方案 B 已实现（工作区，未提交）**——在 `llm/stream` 瀑布里对带 `sessionId` 的
> 请求做「先 P1、失败再按队列物理序」的包装（`runFallbackChain`），**不注册虚拟 provider、
> 不改 `selection`**：宿主的模型选择器始终显示真实 P1，故障转移只在后台队列里自动进行。
> `npm test` 214/77/103 全过（含重写的场景 F/J）。需重启 dsh 才生效（link 安装，宿主启动时
> 加载插件代码）。
>
> 归因说明：assistant 消息的 `source` 仍是真实 P1（= selection），即使这一次实际由队列里
> 另一条路由接管；面板的「上一轮实际使用」用 `runFallbackChain` 回填的 `runtime.lastRequest`
> 显示**真正接管**的路由——这是「选择器常显 P1」这一产品选择的必然取舍。

> 历史：早先曾实现过**方案 A（虚拟 Provider 适配器）**，后因「模型选择器被迫显示“自动”、
> 关闭开关后仍出现无图标的幽灵 provider」被用户否决，已改为方案 B；下文 §3 保留方案 A 的
> 详细设计仅作历史参考。

---

## 0. 一句话结论

旧的故障转移路径 —— **在 `agent/request` 里改 `provider/model` + 在 `agent/request-error` 里返回 `{kind:'retry'}`** —— 在新宿主被两道硬校验彻底封死，且 `retry` 复用的是冻结的 `selection`。唯一能在**同一个 step 内**把失败请求换成另一条路由的地方，是 LLM 层的 `llm/stream` 瀑布。

**结论：把故障转移“下沉”到 LLM 层，并采用方案 B（`llm/stream` 中间件）**：不注册虚拟 provider、不改 selection，只在流上顺序重试；Agent 层只保留观测与证据记录。

---

## 1. 新宿主的三条硬事实（源码定位）

| 事实 | 源码位置 | 后果 |
|---|---|---|
| `selection` 在 `preStep` 一开始就被捕获，`agent/pre-step` 瀑布之后用 `selection` 覆盖 `decision.selection` | `dsh-agent-loop/lib/index.js:670`（`const selection = this.model.current();`）、`:703`（`return { ...decision, assembly, selection, toolSet }`） | 在 `agent/pre-step` 里改模型，改不到**本** step |
| `prepareRequest` 硬校验提案必须等于 `selection` 的 provider/model/reasoningEffort | `dsh-agent-loop/lib/index.js:1000`、`:1001` | `agent/request` 里 `withRouteOverride` 改路由 → 必抛 `...use agent.model.select() before step preparation` |
| 失败后 `agent/request-error` 只有 `{kind:'retry'}` 能重试，且 `continue` 仍在 `step()` 的 while 里，重新 `prepareRequest(turn, step, decision.selection, ...)` —— 还是那个冻结的 `selection` | `dsh-agent-loop/lib/index.js:929-940`（`if (action?.kind !== "retry") throw ...; continue;`）、`:840` | “换路 + 重试同一步”在新宿主**不可能**（换不了 selection） |
| `agent/request` 已 `@deprecated`：“Use `agent.model.select()` before step preparation” | `dsh-agent/lib/types/runtime-types.d.ts` | 官方意图：模型选择在 step 准备**之前**定，请求瀑布只许调 controls（maxTokens 等） |
| `inbox.claim()` 是 `preStep` 的第一行，且它是**同步 emit** `agent/inbox/claimed`，发生在 `model.current()` 之前 | `dsh-agent-loop/lib/index.js:106`（claim 内 emit）、`:670-671`（先 claim，后取 selection） | `agent/inbox/claimed` 的**同步**监听器里调 `agent.model.select()`，可以影响**本** step 的 selection（这是 step 边界定路由的唯一可用钩子） |
| `llm.stream()` 被 `llm/stream` 瀑布包裹：`this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))` | `dsh-llm/lib/index.js:2398-2402` | **LLM 层可拦截**：可以在适配器真正发请求前接管、换路、重试 |
| `request/header` 与 assistant 消息的 source 在 `buildRequest`/`step()` 里用 `request.provider/model`（即 `selection`）记录 | `dsh-agent-loop/lib/index.js:868`、`:1018-1043` | LLM 层透明换路时，**会话归因仍显示原路由**（这是个取舍点，见 §3） |

**一句话**：step 之前能“选路”（`agent.model.select()`），但**中途失败换路只能在 LLM 层做**。

---

## 2. 候选方案对比

| 维度 | A. 虚拟 Provider 适配器（推荐） | B. `llm/stream` 中间件 | C. 只在 step 边界 select（不满足需求） |
|---|---|---|---|
| 当轮同一条消息内换路 | ✅ 适配器内部顺序试队列 | ✅ 监听器内部顺序试 | ❌ 只能下一 step/下一轮生效 |
| 归因（assistant 消息显示哪条模型） | 统一显示虚拟 provider（如 `fallback/auto`），可在 UI 显示“实际命中 X” | ❌ 仍显示原 selection，实际却走了别的路由（不一致） | ✅ 显示正确 |
| 与 `request/header` 一致性 | ✅ 选择就是虚拟 provider，天然一致 | ❌ header 记原路由 | ✅ |
| 改动量 | 中（新增 adapter + 注册） | 小（一个监听器） | 极小 |
| 与现有熔断/探测/state.js | 复用 | 复用 | 复用 |
| 需要 `retry` 吗 | 不需要 | 不需要 | 需要（但无意义） |
| 主要风险 | 需透传 replayState/usage/图片/工具；模型目录/上下文窗口元数据要伪造 | 归因不一致；需防递归；中断/回放难透传 | 不解决核心诉求 |

> 结论：**A 为准，B 作为临时热修可先上**。C 仅作为“不追求当轮救活”的降级选项。

---

## 3. 方案 A：虚拟 Provider 适配器（详细）

### 3.1 形态

注册一个“聚合 provider”（例如 id = `fallback`，显示名 = “自动故障转移队列”），实现 `LlmAdapter` 子类：

```js
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

class FallbackQueueAdapter extends LlmAdapter {
  constructor(ctx, opts) { super(); this.ctx = ctx; this.opts = opts; }

  providerInfo(provider) {
    return { id: provider, name: '自动故障转移队列' };
  }

  // 供 GUI 选择：把“当前队列首条”或一个固定的 auto 模型暴露出来
  async listModels(provider) {
    return [{ provider, id: 'auto', name: '自动（按队列故障转移）' }];
  }

  async resolveModel(provider, model /*, signal */) {
    // 上下文窗口等元信息可保守取队列里最小值，或按队列首条真实模型透传
    return { provider, id: model, name: '自动故障转移' };
  }

  // 关键：一次 step 的 stream 就是“按队列顺序试，第一条成功即接管”
  stream(options) {
    return runFallbackChain(this.ctx, this.opts, options); // async generator
  }
}
```

注册（在 `apply` 里，服务就绪后）：

```js
ctx.inject(['llm'], (scope) => {
  scope.effect(() =>
    scope.llm.registerAdapter(['fallback'], new FallbackQueueAdapter(scope, { getQueue, getCircuit, state })
  );
});
```

### 3.2 `runFallbackChain`（核心算法，async generator）

```js
async function* runFallbackChain(ctx, opts, options) {
  const chain = buildChain(options); // [P1 当前路由?] + 队列中未熔断条目（保序）
  let lastFailure = null;
  for (const route of chain) {
    if (circuitOf(route).state === 'open') continue;
    // 用“真 provider/model”发起真实调用；provider 属于真实 adapter，
    // 不会再命中本虚拟 provider，天然无递归。
    const sub = ctx.llm.stream({
      ...options,
      provider: route.provider,
      model: route.model,
      // 打标记避免任何再次进入虚拟 provider 的可能（双保险）
      __skipFallback: true,
    });
    let yielded = false;
    for await (const chunk of sub) {
      // 失败终态帧：没吐过任何可见内容 → 换下一条
      if (!yielded && chunk?.type === 'finish'
          && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
        lastFailure = chunk;
        recordFailure(route, chunk.reason?.failure);
        break;
      }
      yielded = true;               // 已经产出内容，就不能再换（否则用户看到拼接的乱流）
      yield chunk;
    }
    if (yielded) { recordSuccess(route); return; }
    // 全是失败/空 → 试下一条
  }
  // 全部失败：抛出/产出最后一条失败帧，等价于原来“全挂降级”
  yield lastFailure ?? { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: '队列全部不可用' } } };
}
```

要点：
- **只在“还没吐内容”时换路**；一旦有可见 chunk，就不能再换（避免输出拼流）。
- 复用现有 `state.js` 的熔断（`recordSuccess/recordFailure`）、`circuitOf`、探测证据。
- **P1 语义**：把当前会话真实模型作为链首（如果它不在队列里），与老逻辑一致。
- **中断**：`options.signal` 透传给 `ctx.llm.stream`；外层生成器被 `return()` 时，确保子流 `interrupt()`/`return()`（沿用现在探测代码里的收口写法）。

### 3.3 需要额外处理的细节（A 的坑，逐条列清）

1. **replayState 透传**：`llm.stream` 只有在“同一 adapter 实例拥有历史 provider 与目标 provider”时才保留 replayState（见 dsh-llm 的 doc 注释）。虚拟 provider 会让每个真实路由都变成“跨 adapter”，**历史回放可能失效**。若依赖 PiAi 的 replay，需要在 `prepareCall` 层透传，或接受回放降级（仅影响缓存/重放精度，不影响正确性）——需实测确认。
2. **usage / token 计量**：透传真实子流的 `usage` chunk，避免计量丢失。
3. **图片 / 工具投影**：虚拟 adapter 的 `imageRequestTarget`、`resolveModel` 需转发真实路由的能力；否则会被当成“无图片能力/默认上下文窗口”。
4. **上下文窗口**：`resolveModel` 返回值里若伪造过大窗口，会在长上下文时越过真实模型上限；**保守取队列内最小值**最安全。
5. **模型目录**：GUI 的模型选择页需要 `listModels` 返回可选项，否则用户选不到 `fallback/auto`。

### 3.4 归因（产品取舍，需拍板）

- 方案 A 下，assistant 消息的 `source` 会记成 `fallback/auto`，用户**看不到“这次实际用了哪个真模型”**。
- 建议：插件在自己的 UI（会话面板/设置页）显示“本次请求实际命中 magpie/workbuddy/glm-5.3-flash”；会话正文里保持 `auto`。
- 若一定要在会话正文里显示真实模型 → 只能用方案 B，但方案 B 的 header/source 归因是错的（显示原 selection，实际走别的），更糟。**两害相权，A 更真实**。

---

## 4. 方案 B：`llm/stream` 中间件（轻量热修，可先止血）

```js
ctx.on('llm/stream', (options, next) => {
  if (options.__skipFallback) return next();
  if (!options.sessionId) return next();                 // 非 agent 主请求不介入
  return fallbackStream(ctx, options, next);             // 见 §3.2 同款算法
}, { global: true, prepend: true });
```

优点：改动最小，能立刻恢复“当轮内换路”。
缺点（务必知情）：
- `request/header` 和 assistant `source` 仍记原 `selection`，**会话里看到的模型名与实际不符**。
- 需要在 `next()` 前**就地改写 options.provider/model**，或对新路由调用 `ctx.llm.stream({...})`；后者要打 `__skipFallback` 防递归。
- 中断/回放同样要自己收口。

适用：先止血一层，后续再升级到 A。

---

## 5. 方案 C：只在 step 边界用 `agent.model.select()`（不推荐单独使用）

```js
ctx.on('agent/inbox/claimed', ({ message, turn }) => {
  // 同步监听器：claim 在 model.current() 之前 emit，select 能影响本 step
  const route = pickRouteFor(message);
  ctx.agents.get(message.sessionId ?? /* what? */)?.model.select(route);
});
```

注意：`agent/inbox/claimed` 的 payload 是 `{message, turn}`，**没有直接给 agent**；要用插件持有的 `ctx.agents` + 会话 id 反查，且 message 上是否带 sessionId 需核实（可能要靠 `message.source` 或监听器闭包）。而且**没有消息 claim 的续步（空 next-step）不会触发**，只能靠 `lastUsed` 沿用上一路由。

能力边界：能让“下一条 user 消息/下一步”落到正确路由，但**救不了正在失败的那一次请求**。因此只作为 A/B 的补充（“让下一步也更新为切换后的路由”），不单独用。

---

## 6. 分步落地计划（建议 v0.4.0 或按发布规范 patch 递增）

1. **Spike（1 天）**：在 `llm/stream` 监听里做最小原型——首路由返回 `finish{error}` → 自动切第二条 → 产出成功 chunk；验证 generator 的 `yield` 透传、`interrupt()` 收口、`usage` 保留。
2. **抽核心**：把现有 `index.js` 里 agent 层的 `withRouteOverride` / `agent/request-error` 换路逻辑，抽成 `runFallbackChain()`（LLM 层）+ `pickRouteFor()`（step 边界）。
3. **接适配器**：新增 `FallbackQueueAdapter`，`ctx.llm.registerAdapter(['fallback'], …)`；GUI 增加“自动（队列）”模型项。
4. **收口 agent 层**：`agent/request` 只保留 controls（maxTokens 等），**删除改 provider/model 的代码**；`agent/request-error` 不再返回 `{kind:'retry'}` 用于换路由。
5. **测试**：见 §7。
6. **文档/CHANGELOG**：按 `dsh-plugin-release` 规范写双语条目，版本号 patch 递增。

---

## 7. 验收标准与测试

新增执行测试（`scripts/verify-execution.mjs`）：
- [ ] 首路由返回 `finish{error: QUOTA}` → 自动切第二条 → 最终拿到 `stop`，且 `usage` 保留。
- [ ] 首路由 **已经吐出 text-delta 后**再报错 → 不换路（避免拼流），如实上抛。
- [ ] 全队列失败 → 只产出最后一条失败帧，UI 显示“全部熔断”。
- [ ] 熔断中的路由被跳过；成功路由复位熔断。
- [ ] 中断（`signal.abort`）→ 子流被 `interrupt()`，无悬挂。
- [ ] 端到端：真实网关（P1 限额）下，一条普通消息能成功返回，不再出现 `agent/request proposed ... use agent.model.select()`。

**真机验证**：用 `session-549a0dab` 同类场景复现（P1 = qwenwork/flash 限额），确认不再报错且能拿到第二条模型的回复。

---

## 8. 需要用户拍板的问题

1. **产品呈现**：接受“虚拟 provider（`fallback/auto`，正文不显示真实模型）”吗？还是坚持正文显示真实模型（则只能选 B，但归因会不一致）？
2. **归因位置**：真实命中的模型放在「插件面板/设置页」展示，可接受吗？
3. **范围**：先上 B 止血、再换 A 正解？还是一步到位直接 A？
4. **兼容**：旧设置（`p1Follow`、`failbackMode` 三档）在虚拟 provider 下如何映射（P1 是否仍单独探测、是否仍回切）？

---

## 附：源码索引（便于评审时对照）

- `dsh-agent-loop/lib/index.js:670` selection 捕获；`:703` 覆盖；`:840` prepareRequest；`:929-940` request-error/retry；`:1018-1043` buildRequest/request-header
- `dsh-agent/lib/types/runtime-types.d.ts` agent/request @deprecated、modelSelection 说明
- `dsh-llm/lib/index.js:2398-2402` `llm/stream` 瀑布；`:1666+` `LlmAdapter` 接口；`:1838-1854` `registerAdapter`
- `dsh-llm-pi-ai/lib/index.js:1870+` `PiAiAdapter`（`prepareCall`/`stream` 实现参考）
- `dsh-session-title/lib/index.js:252`、`dsh-session-checkpoint-policy/lib/index.js:61` 现有 `llm/stream` 监听器写法参考
