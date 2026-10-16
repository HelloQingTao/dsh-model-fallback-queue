# dsh-model-fallback-queue

> DeepSeek Harness（dsh）插件：当前模型限额、限流或不可用时，自动切换到队列里的下一个模型，把会话接着跑完。
> 队列和开关都在设置页里点，不需要命令行。

- npm：`@helloqingtao/dsh-model-fallback-queue`
- 宿主插件 + Web 客户端插件（设置页 + 输入框状态芯片）
- 零依赖、不写任何文件、不改 dsh 核心

## 解决什么问题

会话用某个模型时，如果它 5 小时/周/月限额用尽（`QUOTA` / `ACCOUNT_QUOTA`）、被限流（`RATE_LIMIT`）或凭据失效（`AUTH` / `INVALID_CREDENTIAL`），请求直接失败，会话卡住，只能手动换模型再让会话继续。

本插件把「换模型」这件事自动化：请求失败 → 熔断当前路由 → 同一步用队列里下一个可用模型重试 → 成功后稳定留在新路由上。

## 功能

- **请求级自动切换**：命中熔断码立刻熔断当前路由；非即时码连续失败 2 次也熔断（软熔断）。
- **队列 P1 → Pn**：P1 默认跟随当前会话模型（你在模型选择器里换模型，P1 跟着换），队列里添加的是后备 P2、P3…
- **三档 P1 恢复策略**：粘滞（默认）/ 探测回切 / 手动回切。
- **输入框状态芯片**：显示当前生效路由与健康状态；全熔断时显示红色「全部熔断」徽章；点开是队列面板，可以「切回 P1」或跳到设置页。
- **全熔断降级放行**：所有路由都不可用时按原配置放行，插件绝不拦截请求。
- **不抢 dsh-llm-retry 的活**：非致命错误一律 `next()` 让路，同路由重试仍由核心的重试插件负责。

## 安装

```sh
dsh plugin --profile web add @helloqingtao/dsh-model-fallback-queue
```

装完重启 dsh（或刷新 Web GUI）即可，bundle 会随插件自带的 `cordis.patch.yml` 自动注册。

## 用法（全程图形界面）

1. **设置 → 故障转移** → 打开「启用故障转移」。
2. **+ 添加模型**：从模型目录里挑后备模型（P2、P3…），↑ / ↓ 调整顺序，「移除」删掉。
3. **P1 恢复策略**：按需选粘滞 / 探测回切 / 手动回切。
4. 回到会话：输入框右侧出现状态芯片，显示当前生效的 P1 路由。

发生切换时，会话里会出现核心自带的「模型已切换」通知，芯片同步切到新路由。

### 芯片状态

| 显示 | 含义 |
| --- | --- |
| `P1` + 绿点 | 正常走 P1 |
| `P2`（黄点） | 已切换到 P2；黄点表示半开探测中 |
| `P!` + 红点 | 队列全部熔断，已降级放行原配置 |
| `P`（灰点） | 插件未启用 |

面板行为：每行显示优先级、provider/model、健康徽章（🟢 正常 / 🟡 探测中 / 🔴 熔断，带连续失败数）；当前生效行有「当前」标记；底部是最近一次切换记录（`P1 → P2（QUOTA）`）、「切回 P1」按钮（已切走时出现）和「设置…」入口。

### 恢复策略三档

| 档位 | 行为 |
| --- | --- |
| **粘滞**（默认，推荐） | 切到 P2 后只要 P2 可用就一直用，P1 恢复了也不切回；P2 也挂时按「邻近可用」往后找，绕回 P1 是最后手段。零抖动，缓存最稳。 |
| **探测回切** | P1 冷却到期后，由下一个真实请求探测回 P1；成功留下，失败回 P2（防抖 5 分钟，不额外发探测流量）。 |
| **手动回切** | 切走后永不自动回 P1，用芯片面板里的「切回 P1」手动恢复。 |

## 配置项

| 字段 | 默认值 | 说明 | 设置页可改 |
| --- | --- | --- | --- |
| `enabled` | `false` | 总开关 | ✅ |
| `queue` | `[]` | 后备队列，数组顺序即优先级 | ✅ |
| `failbackMode` | `sticky` | P1 恢复策略：`sticky` / `probe` / `manual` | ✅ |
| `p1Follow` | `true` | P1 跟随当前会话模型 | — |
| `immediateCodes` | `QUOTA`, `ACCOUNT_QUOTA`, `RATE_LIMIT`, `AUTH`, `INVALID_CREDENTIAL`, `NO_ADAPTER` | 命中即熔断的错误码 | — |
| `failureThreshold` | `2` | 非即时码的连续失败阈值 | — |
| `cooldownMs` | `60000` | 熔断冷却毫秒数 | — |
| `failbackDelayMs` | `300000` | 探测回切防抖毫秒数 | — |

> 带 — 的高级旋钮当前通过 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里本插件那一行的 `config` 配置（默认值适用于绝大多数场景）。日常使用的开关、队列、恢复策略都在设置页。

## 工作原理

宿主侧三个扩展点（全部 try/catch 兜底，任何异常都不拦截请求）：

- `agent/request`（waterfall）：生效路由不是 P1 时，返回 `{...cfg, provider, model}` 覆盖本次请求；
- `agent/request-error`（prepend）：判定熔断码 → 熔断当前路由 → 返回 `{ kind: 'retry' }` 让 agent-loop 换路由重试同一步；非致命码 `next()` 让路；
- `agent/assistant-stream`：`end` 帧即认为该路由走通，复位熔断计数。

熔断器为三态（closed / half_open / open），纯内存，进程重启自动归零。运行态经 typert Remote 暴露 `snapshot` / `probe` / `manualFailback` 给 Web 客户端。

## 兼容与注意

- 与 `dsh-client-auto-continue` 天然兼容：自动续发走的是同一条请求瀑布，一样享受队列切换。
- 与 `dsh-llm-retry` 分层：它管同路由退避重试，本插件管跨路由切换，不互相抢。
- 熔断态不持久化，重启即全部恢复为正常。
- 队列为空或只有一项时不会发生切换。
- 如果同时装了别的故障转移插件，建议只留一个，避免两个插件争抢 `agent/request-error`。

## 开发

```sh
git clone https://github.com/HelloQingTao/dsh-model-fallback-queue.git
cd dsh-model-fallback-queue
```

在 profile 里以 `link:` 方式引用本目录即可热改：

```json
"dependencies": { "@helloqingtao/dsh-model-fallback-queue": "link:/path/to/dsh-model-fallback-queue" }
```

设计文档见 [docs/design-plan.md](docs/design-plan.md)。

## License

[MIT](LICENSE)
