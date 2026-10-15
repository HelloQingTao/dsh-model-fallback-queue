# 模型故障转移队列插件 · 施工方案

> dsh 插件：dsh-model-fallback-queue
> 日期：2026-10-15 · 状态：设计已拍板，待开工

## 1. 现状与问题

- **现状**：dsh（CLI 0.2.0-rc.2，profile=web）已启用 workbuddy-xdpool 多账号池 + 自动继续插件（dsh-client-auto-continue）。会话用某个模型时，如果它限额（5 小时/周/月窗口用尽）、限流或不可用，请求直接失败，会话卡住，只能手动换模型再让会话继续。
- **问题判据**：会话日志出现 `QUOTA` / `ACCOUNT_QUOTA` / `RATE_LIMIT` 等错误码，且没有第二个模型顶上。
- **影响**：每次限额都打断工作流，等窗口恢复可能要等数小时。
- **为什么现在做**：需求已明确（P1→P2→P3 队列自动切换 + UI 配置），设计点已全部拍板，参考项目源码调研完成。

## 2. 这个方案解决什么

- **解决**：
  1. 请求失败按熔断码自动切队列下一个模型继续；
  2. 全挂自动停止（降级放行原模型 + UI 红色「全部熔断」徽章）；
  3. P1 恢复回切策略三档可配（见 §3 failbackMode）；
  4. 全部配置走设置页图形界面，零命令行。
- **不解决**：不做余额查询、不做跨会话的模型用量统计、不改 dsh 核心、不动 workbuddy-xdpool 的单号轮换逻辑（它在号池内部先换号，整池到顶才轮到本插件跨模型切换，两层天然分层）。
- **为什么不用别的办法**：装现成的 dsh-failover-queue —— 缺 QUOTA 默认码、无回切滞后防抖、非自研不可控，且用户明确要自研；纯会话级切换 —— 要动 session 状态、和模型选择 UI 抢写权限，被请求级覆盖方案替代。

## 3. 做完后用起来什么样

### 用户视角（UI 五步）

- **入口**：Web GUI 设置左侧导航新增「故障转移」页 + 输入框右侧（模型选择器与输入等级之间）新增状态芯片。
- **触发**：打开设置页总开关「启用故障转移」。
- **步骤**：
  1. 队列列表点「添加模型」，从模型目录（modelCatalog）选 provider+model，可拖拽排序；
  2. P1 显示为「跟随当前模型」，可点锁定改为手动指定（lockManual）；
  3. 按需调冷却（默认 60s）、失败阈值（2）、即时熔断码列表、P1 恢复策略。
- **成功反馈**：芯片显示当前 P1 路由名；发生切换时会话里出现核心自带的「模型已切换」通知，芯片切到新路由名。
- **失败反馈**：全部熔断时芯片显示红色「全部熔断」徽章，请求按原模型放行；检测到同类插件已启用时，设置页显示黄条「已检测到其他故障转移插件，本插件已停用」。

### 芯片设计（conversation.input.right slot）

| 状态 | 芯片显示 | 点击展开面板内容 |
|---|---|---|
| 正常运行 | 「P1」+ 当前路由名，无角标 | 队列列表 + 面板开关 |
| 已切换 | 「P2」高亮 + 路由名 + 黄色角标 | 同上，P2 行高亮 |
| 半开探测 | 当前路由名 + 🟡点（探测中） | 同上 |
| 全部熔断 | 红色「全部熔断」徽章 | 同上 + 红色横幅提示 |
| 插件关闭 | 灰色「P-」无角标 | 面板置灰 +「开关在设置页」提示 |

面板每行：优先级序号、路由名（provider/model）、健康徽章（🟢正常 / 🟡探测中 / 🔴熔断）、连续失败数。
行内快捷操作：拖拽排序、开关本插件（与设置页同步）、「立即探测 P1」手动触发。
面板底部：最近一次切换记录（时间 + 从 P1 → P2 + 触发码 QUOTA）。

### 开发视角（不涉及数据库/后端服务）

- 宿主插件：`agent/request` 覆盖、`agent/request-error`（prepend）熔断、`agent/assistant-stream` 判成功；设置经 settingsScope namespace（不带点）+ revision 乐观写。
- 客户端插件：settings.section + conversation.input.right 两个 slot 注册。
- 配置旋钮：`enabled` 总开关、`immediateCodes` 熔断码表、`cooldownMs`（默认 60000）、`failureThreshold`（默认 2）、`failbackMode`（粘滞/探测回切/手动回切）、`failbackDelayMs`（探测模式防抖，默认 5 分钟）、P1 `lockManual` 锁定开关。

### P1 恢复策略（failbackMode 三档，设置页单选）

1. **粘滞（推荐，默认）**：切到 P2 后 P2 可用就一直用 P2，即使 P1 恢复也不切回；P2 也挂时按「邻近可用」原则——按队列序找 P3、P4…，绕到队尾都没有且 P1 已过冷却期可用，才回 P1。零抖动，缓存最稳。
2. **探测回切**：P1 冷却到期后由下一个真实请求探测回 P1（不插额外流量），成功留下失败回 P2；配 failbackDelayMs 防抖。
3. **手动回切**：切走后永不自动回 P1；芯片面板里点「切回 P1」手动恢复。

## 4. 出错怎么办

- **用户看到**：切换成功 → 会话模型变更通知；全挂 → 红徽章 + 原样放行；插件异常 → 不拦截任何请求（所有 try/catch 兜底直接 `next()` 放行）。
- **系统兜底**：熔断状态纯内存，进程重启自动全 Closed；设置读写失败回退默认值；每路由熔断器互不影响。
- **重试/补偿**：非致命码让路给 dsh-llm-retry 同路由重试（自带 5 次退避）；本插件只负责跨路由。
- **回滚**：设置页关总开关即恢复原状（插件代码仍在但零行为）；彻底回滚用 `plugin_manager remove_bundle`，两步都即时生效、无需停机。
- **排查**：会话日志搜错误码 + 芯片状态；设置页有各路由健康徽章（正常/探测中/熔断）。

## 5. 对现有功能影响 / 兼容

- **影响的老功能**：无改动。dsh-llm-retry 继续管同路由重试（本插件 prepend 抢注册但让路放行）；auto-continue 只管续发消息，走的也是同一请求瀑布流，自动享受队列，零冲突。
- **兼容**：不写任何文件、不动 session；同类插件检测——profile 里曾有 dsh-failover-queue（已卸载干净），若日后装回，本插件默认关闭并黄条提醒。
- **停机/迁移**：不需要。插件安装后 `plugin_manager` 返回 applied 即生效。
- **风险点**（按可能性×后果）：
  1. 回切时机判断错误导致缓存反复失效 → 粘滞默认档兜底（不主动回切）；
  2. 熔断码误判（把客户端错误当熔断）→ 增加 neutral 三态，4xx 客户端错误不计健康只还 permit；
  3. 与 llm-retry 抢注册顺序 → 已核实核心用 prepend 保证本插件先看到错误。

## 6. 实施顺序

1. **写包骨架**：本目录——package.json（dsh.bundle + dsh.client 字段）、cordis.patch.yml（一条 insert）、宿主 index.js 熔断+队列+事件逻辑。验收：语法检查通过。
2. **写客户端 UI**：client.js 设置页 + 芯片，主题 token 样式。验收：安装后设置页可见。
3. **安装**（`plugin_manager install_bundle`，用户确认后执行）：验收：安装结果 `application: applied`，`cordis_inspect_query` 确认 slot 注册。
4. **功能验证**：设置页加 P2 路由 → 模拟 P1 限流（配错误码或真实限额）→ 观察自动切换 + 芯片变化 → 回切策略生效 → auto-continue 续发正常。每步可单独回滚（关开关）。
5. **收尾**：确认无缺陷后交付位置与验证结论，不留预览页/变体。

## 7. 验收标准

- **用户验收**：在设置页独立完成「开开关 → 加两个模型 → 拖排序 → 锁定/解锁 P1 → 选恢复策略」，全程无需命令行。
- **功能验收**：
  1. P1 命中 QUOTA 码时同一步自动用 P2 重试成功；
  2. 粘滞模式：P1 恢复不切回，P2 挂才按邻近可用原则换；
  3. 探测模式：P1 冷却+滞后后才被探测回切；
  4. 连续 2 次非即时失败也熔断；
  5. 全熔断放行 + 红徽章；
  6. 队列只有 1 项时不切换。
- **数据验收**：设置页改动的字段重读一致（revision 写回成功），重启进程后队列配置仍在（settings 持久）、熔断态归零（内存态符合设计）。
- **监控验收**：芯片与设置页徽章状态与会话日志错误码一致。
- **回归验收**：auto-continue 正常续发一轮会话；dsh-llm-retry 对偶发 TIMEOUT 仍同路由重试（未被本插件抢切）；xdpool 单号限流时仍由号池内部换号，不触发跨模型切换。

---

## 附：关键技术事实（源码已核实）

- 扩展点：`agent/request` 瀑布（每请求前返回 provider/model 覆盖）+ `agent/request-error` 瀑布（返回 `{kind:'retry'}` 让 agent-loop 重新选模型重试同一步，dsh-agent-loop/lib/index.js:1124）+ `agent/assistant-stream`（frame.type='end' 且 outcome.kind='committed' 且 eventType='assistant/message' 判成功）。
- 错误码（dsh-llm/lib/types/error.js）：QUOTA（402/窗口用尽）、ACCOUNT_QUOTA、RATE_LIMIT、AUTH、INVALID_CREDENTIAL、NO_ADAPTER、SERVER、TIMEOUT、TRANSPORT；dsh-llm-retry 默认只重试 EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT。
- 默认即时熔断码：`['QUOTA','ACCOUNT_QUOTA','RATE_LIMIT','AUTH','INVALID_CREDENTIAL','NO_ADAPTER','SERVER','TIMEOUT','TRANSPORT']`，设置页可增删。
- 熔断器三态 Closed/Open/HalfOpen：failureThreshold=2、successThreshold=2、cooldown=60s、单 permit 探测、2 次成功闭合；纯内存不持久。
- 切换粒度=请求级覆盖：P1 挂期间稳定留在 P2，上下文缓存按 provider/model 分，P2 缓存持续命中；换路由必然冷启动，靠粘滞模式杜绝抖动。
- UI slots：settings.section（设置左导航独立页）+ conversation.input.right（芯片）；候选模型 remote.session.modelCatalog()，fallback 斜杠命令 marker+JSON。
- 设置：settingsScope namespace（不能带点）+ revision 乐观并发写；运行时字段 `.extra('volatile', true)`。
- 兼容：非致命码 `await next()` 让路 llm-retry；检测到同类插件则默认关闭+黄条提醒；auto-continue 天然兼容。
- 参考项目：LunFengChen/dsh-failover-queue（架构主体）、farion1231/cc-switch（neutral 错误三态、错误率熔断维度、全熔断降级放行+徽章）。
