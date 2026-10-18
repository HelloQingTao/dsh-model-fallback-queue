/**
 * dsh-model-fallback-queue — Client half (Web UI).
 *
 * 两个 slot：
 * - settings.section：故障转移设置页（开关 / 队列管理 / 参数 / 回切策略）
 * - conversation.input.right：输入框工具行的状态芯片
 *
 * 规范：只用 --dsw-alias-* 主题 token；不 require @deepseek-ai/dsh-client-ui-*；
 * 组件内样式用 React style/style 标签，卸载即清理。
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-fallback-queue',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STICKY = 'sticky';
    const PROBE = 'probe';
    const MANUAL = 'manual';

    // ---------- 共享小部件 ----------

    function Badge({ tone, children }) {
      const colors = {
        ok: 'var(--dsw-alias-state-success-primary, #3a9e5f)',
        warn: 'var(--dsw-alias-state-warn-primary, #c98a1b)',
        error: 'var(--dsw-alias-state-error-primary, #c94141)',
        muted: 'var(--dsw-alias-label-secondary, #888)',
      };
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '1px 8px',
            borderRadius: 999,
            fontSize: 11,
            lineHeight: '18px',
            color: colors[tone] || colors.muted,
            border: `1px solid ${colors[tone] || colors.muted}44`,
            background: `${colors[tone] || colors.muted}14`,
          },
        },
        children,
      );
    }

    function Switch({ checked, onChange, label }) {
      return h(
        'button',
        {
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          onClick: () => onChange(!checked),
          style: {
            position: 'relative',
            width: 36,
            height: 20,
            borderRadius: 10,
            border: 'none',
            cursor: 'pointer',
            background: checked
              ? 'var(--dsw-alias-brand-primary, #4f7cf7)'
              : 'var(--dsw-elevation-stroke-color, var(--dsw-alias-label-secondary, #ccc))',
            transition: 'background .15s',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: checked ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left .15s',
          },
        }),
      );
    }

    // ---------- 模型选择器（数据来自 remote.session.modelCatalog，同内置模型选择器） ----------

    function ModelPicker({ onClose, onPick, existing = [] }) {
      const [groups, setGroups] = React.useState(null);
      const [err, setErr] = React.useState(null);
      const [openProvider, setOpenProvider] = React.useState(null);
      const rootRef = React.useRef(null);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const r = await window.__fallbackQueueSession?.modelCatalog?.();
            if (!alive) return;
            if (!r?.ok) throw new Error(r?.error?.message || 'modelCatalog failed');
            setGroups(r.value?.groups || []);
          } catch (e) {
            if (alive) setErr(e.message || String(e));
          }
        })();
        return () => { alive = false; };
      }, []);

      // 点外部 / Esc 关闭
      React.useEffect(() => {
        const onDown = (e) => {
          if (rootRef.current && !rootRef.current.contains(e.target)) onClose();
        };
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [onClose]);

      return h(
        'div',
        {
          ref: rootRef,
          style: {
            position: 'fixed', inset: 0, zIndex: 10000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,.35)',
          },
        },
        h(
          'div',
          {
            style: {
              width: 460, maxHeight: '70vh', overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
              borderRadius: 12,
              background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-base, #fff))',
              border: '1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-label-secondary, #ddd))',
              boxShadow: '0 8px 32px rgba(0,0,0,.18)',
              color: 'var(--dsw-alias-label-primary, inherit)',
            },
          },
          h(
            'div',
            {
              style: {
                padding: '12px 16px', fontWeight: 600, fontSize: 14,
                borderBottom: '1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-label-secondary, #eee))',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              },
            },
            '添加后备模型',
            h('button', { onClick: onClose, style: btnSmall }, '关闭'),
          ),
          h(
            'div',
            { style: { overflowY: 'auto', padding: '6px 8px' } },
            err
              ? h('div', { style: { padding: 12, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, `模型目录加载失败：${err}`)
              : !groups
                ? h('div', { style: { padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '加载模型目录…')
                : groups.length === 0
                  ? h('div', { style: { padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '没有可用模型目录')
                  : groups.map((g) =>
                      h(
                        'div',
                        { key: g.id },
                        h(
                          'button',
                          {
                            onClick: () => setOpenProvider(openProvider === g.id ? null : g.id),
                            style: {
                              width: '100%', textAlign: 'left', padding: '8px 10px',
                              background: 'transparent', border: 'none', color: 'inherit',
                              cursor: 'pointer', fontSize: 13, fontWeight: 600,
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              borderRadius: 8,
                            },
                          },
                          g.name || g.id,
                          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, openProvider === g.id ? '▾' : '▸'),
                        ),
                        openProvider === g.id
                          ? h(
                              'div',
                              { style: { paddingBottom: 6 } },
                              (g.models || []).map((m) => {
                                const key = `${g.id}/${m.id}`;
                                const inQueue = existing.includes(key);
                                return h(
                                  'button',
                                  {
                                    key: m.id,
                                    disabled: inQueue,
                                    onClick: () => { if (!inQueue) onPick(g.id, m.id); },
                                    style: {
                                      width: '100%', textAlign: 'left', padding: '7px 14px 7px 22px',
                                      background: 'transparent', border: 'none', color: 'inherit',
                                      cursor: inQueue ? 'not-allowed' : 'pointer', fontSize: 13, borderRadius: 6,
                                      opacity: inQueue ? 0.45 : 1,
                                    },
                                    onMouseEnter: (e) => { if (!inQueue) e.currentTarget.style.background = 'var(--dsw-alias-brand-primary, #4f7cf7)' + '14'; },
                                    onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                                  },
                                  (m.name || m.id) + (inQueue ? ' · 已添加' : ''),
                                );
                              }),
                            )
                          : null,
                      ),
                    ),
          ),
        ),
      );
    }

    // ---------- 设置页 ----------

    const STATE_TONE = { closed: 'ok', half_open: 'warn', open: 'error' };
    const STATE_TEXT = { closed: '正常', half_open: '探测中', open: '熔断' };

    /** 熔断错误码的中文释义：叠在机器码之上，省得用户去查码表 */
    const CODE_HINT = {
      QUOTA: '额度或频率受限',
      ACCOUNT_QUOTA: '账号额度用尽',
      RATE_LIMIT: '请求频率超限',
      AUTH: '鉴权失败（API Key 无效或过期）',
      INVALID_CREDENTIAL: '鉴权失败（凭据无效）',
      NO_ADAPTER: '没有可用适配器（provider 未注册或模型不存在）',
      PI_AI_ERROR: '上游错误（适配层未能识别）',
      UNKNOWN: '未知错误',
      INVALID_ARGS: '请求参数不合法',
      INVALID_REQUEST: '请求不合法',
      BAD_REQUEST: '请求不合法',
      TIMEOUT: '请求超时',
      TRANSPORT: '链路中断',
    };

    /**
     * 毫秒 → 中文短时长（"45 秒" / "2 分 30 秒"）。
     * @param {number} ms 毫秒
     * @returns {string}
     */
    function shortDuration(ms) {
      const total = Math.max(0, Math.round(Number(ms) / 1000));
      if (total < 60) return `${total} 秒`;
      const min = Math.floor(total / 60);
      const sec = total % 60;
      return sec === 0 ? `${min} 分钟` : `${min} 分 ${sec} 秒`;
    }

    /**
     * 时间戳 → HH:mm:ss（本地时区）。
     * @param {number} ts 毫秒时间戳
     * @returns {string}
     */
    function clockText(ts) {
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    /**
     * 拼熔断行的 ⓘ 悬浮提示：直接展示上游报错原文 + 预计恢复时刻。
     * 没有可讲的就返回 null（不渲染 ⓘ）。
     * @param {object} entry snapshot 里的队列条目
     * @param {object} snap 运行时快照（取 cooldownMs）
     * @returns {string|null}
     */
    function circuitInfoText(entry, snap) {
      if (!entry) return null;
      if (entry.invalid) {
        return '配置失效：这个 provider 没有注册适配器，或模型已不存在。\n重试不会恢复，请到设置页把这条换成可用的模型。';
      }
      const err = entry.lastError || {};
      // 调用侧失败不熔断，但用户需要知道"为什么没切"：closed 状态下也给它提示。
      const callerSide = err.source === 'caller';
      if (entry.state === 'closed' && !callerSide) return null;
      const hint = err.code ? CODE_HINT[err.code] : null;
      const lines = callerSide
        ? [`本次未切换：${err.code || '未知'}${hint ? `（${hint}）` : ''}`]
        : [`熔断原因：${err.code || '未知'}${hint ? `（${hint}）` : ''}`];
      if (callerSide) {
        lines.push('来源判定：请求本身或插件自身的问题，换模型也不会好，所以没有切换路由。');
      }
      if (err.message) lines.push(`${callerSide ? '错误原文' : '模型返回'}：${err.message}`);
      if (callerSide && entry.state === 'closed') {
        // 没进熔断，没有恢复时间可谈
      } else if (entry.state === 'half_open') {
        lines.push('当前状态：半开探测中，下一次请求会再试这条路由');
      } else {
        const cooldown = Number(snap?.cooldownMs) > 0 ? Number(snap.cooldownMs) : 60000;
        lines.push(entry.recoverAt
          ? `预计恢复：${clockText(entry.recoverAt)}（冷却 ${shortDuration(cooldown)} 后转半开探测）`
          : `预计恢复：冷却 ${shortDuration(cooldown)} 后转半开探测`);
        if (Number(entry.retryAfterMs) > 0) {
          lines.push(`上游建议：等待 ${shortDuration(entry.retryAfterMs)} 再试`);
        }
      }
      return lines.join('\n');
    }

    /**
     * 熔断 / 配置失效行末尾的 ⓘ 图标（悬浮显示原因与恢复时间）。
     * @param {object} entry snapshot 里的队列条目
     * @param {object} snap 运行时快照
     * @returns {object|null} React 元素；无需提示时为 null
     */
    function circuitInfoIcon(entry, snap) {
      const text = circuitInfoText(entry, snap);
      if (!text) return null;
      return h('span', {
        title: text,
        'aria-label': text,
        style: { cursor: 'help', opacity: 0.65, fontSize: 11, lineHeight: 1, flex: 'none' },
      }, 'ⓘ');
    }

    /**
     * 队列条目的徽章色调：配置失效（invalid）优先于熔断三态。
     * 宿主早就在快照里给了 invalid，并注明"UI 据此直接标配置失效"——之前 UI 没用它，
     * 一条永远跑不通的路由会显示成"正常"。
     * @param {object} entry snapshot 里的队列条目
     * @returns {string|null} entry 缺失时返回 null（由调用方给兜底）
     */
    function entryTone(entry) {
      if (!entry) return null;
      if (entry.invalid) return 'error';
      return STATE_TONE[entry.state] || 'muted';
    }

    /**
     * 队列条目的徽章文案：配置失效优先于熔断三态。
     * @param {object} entry snapshot 里的队列条目
     * @returns {string|null} entry 缺失时返回 null（由调用方给兜底）
     */
    function entryText(entry) {
      if (!entry) return null;
      if (entry.invalid) return '配置失效';
      return STATE_TEXT[entry.state] || entry.state || null;
    }

    function SettingsPage({ host }) {
      const [cfg, setCfg] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [snap, setSnap] = React.useState(null);
      const [pickerOpen, setPickerOpen] = React.useState(false);
      const [confirmRemove, setConfirmRemove] = React.useState(null); // 移除确认中的行索引

      const refresh = React.useCallback(async () => {
        // settings 只出配置；队列来自 state 文件（host.getQueue），两个来源不重叠
        const [s, q] = await Promise.all([host.getSettings(), host.getQueue()]);
        if (s) setCfg({ enabled: false, queue: [], failbackMode: STICKY, ...s, queue: q || [] });
        const st = await host.getRuntimeSnapshot();
        if (st) setSnap(st);
      }, [host]);

      React.useEffect(() => {
        refresh();
      }, [refresh]);

      if (!cfg) return h('div', { style: { padding: 16 } }, '加载中…');

      const patch = async (p) => {
        setBusy(true);
        await host.updateSettings(p);
        await refresh();
        setBusy(false);
      };

      const setMode = (m) => patch({ failbackMode: m });

      // 队列写路径：只落 state 文件，不碰 settings，因此不会触发宿主主题全量重算
      const writeQueue = async (q) => {
        setBusy(true);
        await host.setQueue(q);
        await refresh();
        setBusy(false);
      };

      const move = async (i, dir) => {
        const q = [...cfg.queue];
        const j = i + dir;
        if (j < 0 || j >= q.length) return;
        [q[i], q[j]] = [q[j], q[i]];
        await writeQueue(q);
      };

      const remove = async (i) => {
        await writeQueue(cfg.queue.filter((_, k) => k !== i));
      };

      const add = async () => {
        setPickerOpen(true);
      };

      const modes = [
        [STICKY, '粘滞（推荐）', '切到 P2 后 P2 可用就一直用，即使 P1 恢复也不切回；P2 也挂时才按邻近可用原则（含绕回 P1）'],
        [PROBE, '探测回切', 'P1 冷却到期后由下一个真实请求探测回 P1，成功留下失败回 P2（防抖 5 分钟）'],
        [MANUAL, '手动回切', '切走后永不自动回 P1，需在芯片面板手动切回'],
      ];

      return h(
        'div',
        { style: { padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 } },
        // 总开关
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h('strong', null, '启用故障转移'),
          h(Switch, { checked: !!cfg.enabled, onChange: (v) => patch({ enabled: v }), label: '启用故障转移' }),
          busy ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '保存中…') : null,
        ),
        // 队列
        h(
          'div',
          null,
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '队列（P1 → Pn）'),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            cfg.queue.length === 0
              ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '队列为空：添加 P2/P3… 作为 P1（当前会话模型）的后备')
              : cfg.queue.map((r, i) => {
                  const entry = snap?.entries?.[i];
                  return h(
                    'div',
                    {
                      // key 不能带索引：上移/下移后 index 变化会让 React 卸载重建整行，
                      // 重建那一帧背景是空的，深色模式下就是一次白闪。用 provider/model 做稳定标识。
                      key: `${r.provider}/${r.model}`,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-label-secondary, #ddd))',
                      },
                    },
                    h('strong', { style: { width: 28 } }, cfg.p1Follow ? `P${i + 2}` : `P${i + 1}`),
                    h('span', { style: { flex: 1, fontSize: 13 } }, `${r.provider} / ${r.model}`),
                    entry
                      ? h(Badge, { tone: entryTone(entry) }, `${entryText(entry)}${entry.failures ? ` · 失败${entry.failures}` : ''}`)
                      : null,
                    circuitInfoIcon(entry, snap),
                    h(
                      'button',
                      {
                        onClick: () => move(i, -1),
                        disabled: i === 0,
                        title: i === 0 ? '已经是最高优先级' : '上移',
                        'aria-label': '上移',
                        style: i === 0 ? btnSmallDisabled : btnSmall,
                      },
                      '↑',
                    ),
                    h(
                      'button',
                      {
                        onClick: () => move(i, 1),
                        disabled: i === cfg.queue.length - 1,
                        title: i === cfg.queue.length - 1 ? '已经是最低优先级' : '下移',
                        'aria-label': '下移',
                        style: i === cfg.queue.length - 1 ? btnSmallDisabled : btnSmall,
                      },
                      '↓',
                    ),
                    confirmRemove === i
                      ? h('span', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary, #c94141)' } }, '确认移除？'),
                          h('button', { onClick: () => { setConfirmRemove(null); remove(i); }, style: { ...btnSmall, color: 'var(--dsw-alias-state-error-primary, #c94141)' } }, '移除'),
                          h('button', { onClick: () => setConfirmRemove(null), style: btnSmall }, '取消'),
                        )
                      : h('button', { onClick: () => setConfirmRemove(i), style: btnSmall }, '移除'),
                  );
                }),
          ),
          h('button', { onClick: add, style: { ...btnSmall, marginTop: 8 } }, '+ 添加模型'),
        ),
        // 回切策略
        h(
          'div',
          null,
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, 'P1 恢复策略'),
          h(
            'div',
            { role: 'radiogroup', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            modes.map(([value, title, desc]) =>
              h(
                'label',
                {
                  key: value,
                  style: {
                    display: 'flex',
                    gap: 8,
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: `1px solid ${cfg.failbackMode === value ? 'var(--dsw-alias-brand-primary, #4f7cf7)' : 'var(--dsw-elevation-stroke-color, var(--dsw-alias-label-secondary, #ddd))'}`,
                    cursor: 'pointer',
                  },
                },
                h('input', {
                  type: 'radio',
                  name: 'failbackMode',
                  checked: cfg.failbackMode === value,
                  onChange: () => setMode(value),
                }),
                h(
                  'span',
                  null,
                  h('div', { style: { fontSize: 13, fontWeight: 600 } }, title),
                  h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, desc),
                ),
              ),
            ),
          ),
        ),
        // 运行态
        snap?.lastSwitch
          ? h(
              'div',
              { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
              `最近切换：P${snap.lastSwitch.from + ((snap.p1Follow ?? true) ? 2 : 1)} → P${snap.lastSwitch.to + ((snap.p1Follow ?? true) ? 2 : 1)}${snap.lastSwitch.code ? `（${snap.lastSwitch.code}）` : ''}`,
            )
          : null,
        pickerOpen
          ? h(ModelPicker, {
              onClose: () => setPickerOpen(false),
              existing: cfg.queue.map((r) => `${r.provider}/${r.model}`),
              onPick: async (provider, model) => {
                setPickerOpen(false);
                if (cfg.queue.some((r) => r.provider === provider && r.model === model)) return; // 防重复兜底
                await writeQueue([...cfg.queue, { provider, model }]);
              },
            })
          : null,
        // 功能说明（淡化、与上方内容拉开距离）
        h(
          'div',
          {
            style: {
              marginTop: 20,
              paddingTop: 12,
              borderTop: '1px solid var(--dsw-elevation-stroke-color, transparent)',
              fontSize: 12,
              lineHeight: 1.7,
              color: 'var(--dsw-alias-label-secondary)',
              opacity: 0.65,
            },
          },
          h('div', null, '当队列中某个模型故障（限流、限额、不可用）时，自动切换到下一个可用模型继续会话。P1 始终是当前会话模型，队列中添加的是后备模型（P2、P3…）。'),
          h('div', { style: { marginTop: 2 } }, '🟢 正常 · 🟡 半开探测恢复中 · 🔴 已熔断冷却中 · ⚪ 未启用'),
          h('div', { style: { marginTop: 2 } }, 'ⓘ 悬浮可看到熔断原因（模型返回的原文）与预计恢复时间'),
        ),
      );
    }

    const btnSmall = {
      fontSize: 12,
      padding: '2px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-label-secondary, #ddd))',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    };

    // 禁用态必须显式置灰：Chromium 只在 default 外观下把 disabled 按钮渲染成灰色，
    // 这里 background/color 都是显式值，不手动降权的话箭头看起来仍是可点的。
    const btnSmallDisabled = {
      ...btnSmall,
      opacity: 0.4,
      cursor: 'not-allowed',
    };

    // ---------- 输入框芯片 ----------

    function Chip(props) {
      const host = props.host;
      const onOpenSettings = props.onOpenSettings;
      const [snap, setSnap] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [sessionModelLabel, setSessionModelLabel] = React.useState('当前会话模型');
      const rootRef = React.useRef(null);

      // 从内置模型选择按钮 title 解析当前会话模型名（title 形如「选择模型，当前 GLM-5.3-Flash · x0.06，推理等级 Default」）
      React.useEffect(() => {
        const pull = () => {
          const btn = Array.from(document.querySelectorAll('button')).find((x) => {
            const t = x.title || x.getAttribute('aria-label') || '';
            return t.includes('选择模型') || /^(.+?)\s*·/.test(t) && x.getAttribute('aria-label')?.includes('选择模型');
          });
          // aria-label 形如「选择模型，当前 X，推理等级 Y」；title 形如「X · Y」
          const al = btn?.getAttribute('aria-label') || '';
          const ti = btn?.title || '';
          const m = al.match(/当前 ([^·,，，]+)/) || ti.match(/^(.+?)\s*·/) || ti.match(/^([^·]+)/);
          if (!m) return;
          const next = m[1].trim();
          // 只在值真的变化时才写 state：无条件 setState 会让组件每 3 秒重渲染一次，
          // 而宿主侧栏（dsh-railist）订阅 DOM 变化后会把每次渲染当成一次新变更重算，导致重算不收敛刷屏。
          setSessionModelLabel((prev) => (prev === next ? prev : next));
        };
        pull();
        const t = setInterval(pull, 3000);
        return () => clearInterval(t);
      }, []);

      React.useEffect(() => {
        let alive = true;
        let timer = null;
        const tick = async () => {
          let st = null;
          try {
            st = await host.getRuntimeSnapshot();
          } catch (e) {
            console.warn('[fallback-queue] snapshot failed', e);
          }
          if (!alive) return;
          if (st) setSnap((prev) => (JSON.stringify(prev) === JSON.stringify(st) ? prev : st));
          // 自适应轮询：稳定时 5s 一次；有请求在飞或刚发生过切换/失败时 1s 一次。
          // 固定 5s 会让"切到 P2 了但指示器还显示 P1"最多僵 5 秒，正是被报的问题。
          const live = st && (st.inFlightIndex >= 0 || st.entries?.some((e) => e.state !== 'closed'));
          timer = setTimeout(tick, live ? 1000 : 5000);
        };
        tick();
        return () => {
          alive = false;
          if (timer) clearTimeout(timer);
        };
      }, [host]);

      // 点击弹层外部自动关闭
      React.useEffect(() => {
        if (!open) return;
        const onDown = (e) => {
          if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
        };
        const onKey = (e) => {
          if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      const enabled = snap?.enabled;
      const entries = snap?.entries || [];
      const active = snap?.activeIndex ?? 0;
      // 失效路由游标（activeIndex）表示"已经挂了、等下一级替换"，它会一直停在坏掉的那条；
      // 用户要看的却是"这一轮实际跑在哪条"。inFlightIndex 才是后者，缺省时退回旧字段。
      // 会话隔离：slot 组件由宿主按会话渲染（scope:'session'），props.sessionId 是当前
      // 会话。优先取 per-session inFlight 映射，避免另一个会话的切换覆盖本会话的显示。
      const myInFlight = props.sessionId !== undefined
        && snap?.sessionInFlight
        && Number.isInteger(snap.sessionInFlight[props.sessionId])
        ? snap.sessionInFlight[props.sessionId]
        : undefined;
      const inFlight = myInFlight !== undefined ? myInFlight
        : Number.isInteger(snap?.inFlightIndex) ? snap.inFlightIndex : active;
      const effective = myInFlight !== undefined ? myInFlight
        : Number.isInteger(snap?.effectiveIndex) ? snap.effectiveIndex : inFlight;
      const p1Follow = snap?.p1Follow ?? true;
      // 会话模型快照（宿主侧只在 P1 真实放行时采样）：P1 指的用户手选模型，
      // 不随熔断切走而变化。空 = 本会话尚无采样点（插件刚装/队列关闭过）。
      const sessionModel = snap?.sessionModel || null;
      const allOpen = entries.length > 0 && entries.every((e) => e.state === 'open');
      const halfOpen = entries.some((e) => e.state === 'half_open');
      // P1 已被顶掉（超时/限流失效）但仍在兜底——以 P1 下标而不是 inFlight 判定：
      // 切走之后新一级请求一开工 inFlight 就变了，用 inFlight 会让"P1 已失效"这个信号一闪而过。
      const p1Leaning = entries.some((e) => e.index === 0 && e.state !== 'closed');

      let label;
      let tone = 'muted';
      // p1Follow 下索引 0 = P1（会话模型）；队列索引 i 实际是 P(i+1)
      const lbl = (idx) => (p1Follow ? (idx === 0 ? 'P1' : `P${idx + 1}`) : `P${idx + 1}`);
      if (!enabled) label = 'P';
      else if (allOpen) {
        label = 'P!';
        tone = 'error';
      } else if (halfOpen) {
        label = lbl(effective);
        tone = 'warn';
      } else if (effective === 0 && p1Leaning) {
        // P1 已失效但请求仍由原配置兜着走（全熔断降级）——不能显示成"健康 P1"
        label = lbl(0);
        tone = 'warn';
      } else {
        label = lbl(effective);
        // 非 0 = 正在用后备路由，或本次请求没被覆盖（P1 跟随）
        tone = effective === 0 ? 'ok' : 'warn';
      }

      const routeOf = (idx) => {
        if (idx < 0) return `${sessionModelLabel}（会话模型，未覆盖）`;
        if (idx === 0 && p1Follow) {
          // P1 名称用 DOM 解析值（3s 轮询，手动切模型立即跟上）。
          // 宿主 sessionModel 快照只用于归属判定，不用于显示——它要等下一次
          // P1 放行才更新，手动切换后未发请求期间是旧值。
          return `${sessionModelLabel}（会话模型）`;
        }
        const e = entries.find((x) => x.index === idx);
        return e ? `${e.provider} / ${e.model}` : '—';
      };

      const toneColor = {
        ok: 'var(--dsw-alias-state-success-primary, #3a9e5f)',
        warn: 'var(--dsw-alias-state-warn-primary, #c98a1b)',
        error: 'var(--dsw-alias-state-error-primary, #c94141)',
        muted: 'var(--dsw-alias-label-secondary, #888)',
      }[tone];

      // 手动回切：把生效路由拉回 P1（p1Follow 下 = 当前会话模型）。
      // 「手动回切」模式下这是唯一的回去方式；其它模式也可用它提前结束粘滞。
      const failback = async () => {
        await host.manualFailback(0);
        const st = await host.getRuntimeSnapshot();
        if (st) setSnap(st);
      };

      return h(
        'div',
        { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } },
        h(
          'button',
          {
            onClick: () => setOpen((v) => !v),
            title: '模型故障转移',
            'aria-label': '模型故障转移',
            style: {
              position: 'relative',
              width: 26,
              height: 26,
              borderRadius: 8,
              border: '1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-label-secondary, #ddd))',
              background: 'var(--dsw-alias-bg-base, transparent)',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              lineHeight: '24px',
              padding: 0,
              transition: 'border-color .15s, box-shadow .15s',
              boxShadow: open ? `0 0 0 2px ${toneColor}33` : 'none',
            },
          },
          label,
          // 右上角健康状态小圆点（带呼吸闪烁）
          h('span', {
            className: allOpen ? 'fq-dot fq-dot-fast' : enabled === false ? 'fq-dot fq-dot-off' : 'fq-dot',
            style: { '--fq-dot-color': toneColor },
          }),
        ),
        open
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  bottom: 'calc(100% + 10px)',
                  right: 0,
                  minWidth: 300,
                  borderRadius: 12,
                  border: '1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-label-secondary, #ddd))',
                  // 不用 #fff 兜底：token 拿不到时透明，让宿主背景透出来，
                  // 硬编码白色在深色主题下会是一次整块白闪。
                  background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, transparent))',
                  boxShadow: '0 8px 32px rgba(0,0,0,.16), 0 2px 8px rgba(0,0,0,.08)',
                  zIndex: 30,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                },
              },
              // 标题行
              h(
                'div',
                {
                  style: {
                    padding: '10px 14px',
                    fontSize: 12,
                    fontWeight: 600,
                    borderBottom: '1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-label-secondary, #eee))',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  },
                },
                '模型故障转移',
                !enabled
                  ? h(Badge, { tone: 'muted' }, '已关闭')
                  : allOpen
                    ? h(Badge, { tone: 'error' }, '全部熔断')
                    : h(Badge, { tone: effective === 0 ? 'ok' : 'warn' }, `当前 ${lbl(effective)}`),
              ),
              // 实际在跑的路由：这块是"看报错就知道是谁的锅"的关键——
              // 指示器显示的不是你手选的模型，而是这一轮真实请求发去了哪里。
              h(
                'div',
                {
                  style: {
                    padding: '8px 14px',
                    fontSize: 11,
                    lineHeight: '18px',
                    color: 'var(--dsw-alias-label-secondary)',
                    borderBottom: '1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-label-secondary, #eee))',
                  },
                },
                active >= 0 && active !== effective
                  ? h('div', { style: { opacity: 0.75 } }, `${lbl(active)} 已失效，已切走`)
                  : null,
                inFlight < 0 && enabled
                  ? h('div', { style: { opacity: 0.75 } }, '本轮请求未经过队列（放行原配置）')
                  : null,
              ),
              // 队列条目
              h(
                'div',
                { style: { padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 2 } },
                h('div', {
                    key: 'p1-row',
                    style: {
                      display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 8, fontSize: 12,
                      background: effective === 0 ? 'var(--dsw-alias-brand-primary, #4f7cf7)' + '14' : 'transparent',
                    },
                  },
                  h('strong', { style: { width: 22, fontSize: 11, opacity: 0.85 } }, 'P1'),
                  h('span', { style: { flex: 1, opacity: effective === 0 ? 1 : 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    sessionModelLabel + (p1Follow ? '（会话模型）' : '')),
                  effective === 0
                    ? h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-brand-primary, #4f7cf7)', fontWeight: 600 } }, '当前')
                    : null,
                  h(Badge, { tone: entryTone(entries.find((x) => x.index === 0)) || 'ok' },
                    entryText(entries.find((x) => x.index === 0)) || '正常'),
                  circuitInfoIcon(entries.find((x) => x.index === 0), snap),
                  ),
                ...(entries.length === 0
                  ? [h('div', { key: 'empty', style: { padding: '10px 6px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '暂无后备——到设置页添加 P2/P3…')]
                  : entries.map((e) => {
                      const isActive = effective === e.index && !(p1Follow && e.index === 0);
                      return h(
                        'div',
                        {
                          key: e.index,
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            padding: '7px 8px',
                            borderRadius: 8,
                            fontSize: 12,
                            background: isActive ? 'var(--dsw-alias-brand-primary, #4f7cf7)' + '14' : 'transparent',
                          },
                        },
                        h('strong', { style: { width: 22, fontSize: 11, opacity: 0.85 } }, `P${e.index + (p1Follow ? 1 : 0) + 1}`),
                        h('span', { style: { flex: 1, opacity: isActive ? 1 : 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${e.provider} / ${e.model}`),
                        isActive
                          ? h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-brand-primary, #4f7cf7)', fontWeight: 600 } }, '当前')
                          : null,
                        h(Badge, { tone: entryTone(e) || 'muted' }, entryText(e) || e.state),
                        circuitInfoIcon(e, snap),
                      );
                    })),
              ),
              // 底部：最近切换 + 设置入口
              h(
                'div',
                {
                  style: {
                    padding: '8px 14px',
                    borderTop: '1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-label-secondary, #eee))',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: 11,
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                },
                snap?.lastSwitch
                  ? `最近切换 P${snap.lastSwitch.from + ((snap.p1Follow ?? true) ? 2 : 1)} → P${snap.lastSwitch.to + ((snap.p1Follow ?? true) ? 2 : 1)}`
                  : '无切换记录',
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  enabled && effective !== 0
                    ? h(
                        'button',
                        {
                          onClick: failback,
                          title: '把生效路由切回 P1（p1Follow 下即当前会话模型）',
                          style: {
                            fontSize: 11,
                            padding: '3px 10px',
                            borderRadius: 6,
                            border: '1px solid var(--dsw-alias-brand-primary, #4f7cf7)',
                            background: 'transparent',
                            color: 'var(--dsw-alias-brand-primary, #4f7cf7)',
                            cursor: 'pointer',
                          },
                        },
                        '切回 P1',
                      )
                    : null,
                  onOpenSettings
                    ? h(
                        'button',
                        {
                          onClick: onOpenSettings,
                          style: {
                            fontSize: 11,
                            padding: '3px 10px',
                            borderRadius: 6,
                            border: '1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-label-secondary, #ddd))',
                            background: 'transparent',
                            color: 'inherit',
                            cursor: 'pointer',
                          },
                        },
                        '设置…',
                      )
                    : null,
                ),
              ),
            )
          : null,
      );
    }

    // ---------- 装配 ----------

    // ---------- Typert Remote 契约（SRC fallback：host 侧 Service 无 strict schema，client 描述符走最小 strict codec） ----------

    const jsonCodec = (sym) => ({ mode: 'strict', typeSymbol: sym, create: () => ({}) });

    const TYPERT_REMOTE = {
      package: 'dsh-model-fallback-queue',
      descriptors: [
        {
          id: 'dsh-model-fallback-queue#dsh-model-fallback-queue/snapshot',
          service: 'FallbackQueueService',
          namespace: 'dsh-model-fallback-queue',
          method: 'snapshot',
          invocation: { kind: 'direct' },
          parameters: [],
          result: { mode: 'src-json' },
        },
        {
          id: 'dsh-model-fallback-queue#dsh-model-fallback-queue/probe',
          service: 'FallbackQueueService',
          namespace: 'dsh-model-fallback-queue',
          method: 'probe',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'index', wire: 'index', source: 'json', codec: jsonCodec('dsh-model-fallback-queue#Index') }],
          result: { mode: 'src-json' },
        },
        {
          id: 'dsh-model-fallback-queue#dsh-model-fallback-queue/manualFailback',
          service: 'FallbackQueueService',
          namespace: 'dsh-model-fallback-queue',
          method: 'manualFailback',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'index', wire: 'index', source: 'json', codec: jsonCodec('dsh-model-fallback-queue#Index') }],
          result: { mode: 'src-json' },
        },
        {
          id: 'dsh-model-fallback-queue#dsh-model-fallback-queue/getQueue',
          service: 'FallbackQueueService',
          namespace: 'dsh-model-fallback-queue',
          method: 'getQueue',
          invocation: { kind: 'direct' },
          parameters: [],
          result: { mode: 'src-json' },
        },
        {
          id: 'dsh-model-fallback-queue#dsh-model-fallback-queue/setQueue',
          service: 'FallbackQueueService',
          namespace: 'dsh-model-fallback-queue',
          method: 'setQueue',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'queue', wire: 'queue', source: 'json', codec: jsonCodec('dsh-model-fallback-queue#Queue') }],
          result: { mode: 'src-json' },
        },
      ],
    };

    return {
      inject: ['slots', 'remote', 'remote.settings', 'remote.session'],
      async apply(ctx) {
        // 挂载自己的 Remote namespace，然后在内层 ctx.inject 里拿 remote.dsh-model-fallback-queue face
        const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
        ctx.effect(() => () => { void disposeRemote(); }, 'fallback-queue remote mount');
        // session face 供 ModelPicker 拉模型目录（同内置模型选择器的数据源）
        window.__fallbackQueueSession = ctx.remote.session;
        await ctx.inject(
          ['slots', 'remote', 'remote.settings', 'remote.dsh-model-fallback-queue'],
          (rctx) => registerSlots(rctx, rctx.remote?.['dsh-model-fallback-queue']),
        );
      },
    };

    // typert face 的返回值可能是 {ok,value} 信封，也可能是裸值（取决于 result codec）。
    // 统一拆一次：成功取 value，失败/异常取 null。
    function unwrapEnvelope(r) {
      if (r && typeof r === 'object' && 'ok' in r) return r.ok ? (r.value ?? null) : null;
      return r ?? null;
    }

    function registerSlots(ctx, rpcFace) {
        // 健康圆点动画样式（幂等注入一次）
        if (!document.getElementById('fq-dot-style')) {
          const st = document.createElement('style');
          st.id = 'fq-dot-style';
          st.textContent = `
            .fq-dot{position:absolute;top:-2px;right:-2px;width:5px;height:5px;border-radius:50%;
              background:var(--fq-dot-color,#22c55e);border:1.5px solid var(--dsw-alias-bg-overlay,#fff);
              animation:fq-pulse 2s ease-in-out infinite;}
            .fq-dot-fast{animation-duration:1s;}
            .fq-dot-off{animation:none;opacity:.6;}
            @keyframes fq-pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 var(--fq-dot-color)}50%{opacity:.35;box-shadow:0 0 0 3px transparent}}`;
          document.head.appendChild(st);
        }
        // host 桥：经 ctx（client side）调用 host 侧设置与运行态。
        // rpcFace = 内层 inject 显式注入的 'remote.dsh-model-fallback-queue' face（ctx.remote 上未必有该键）。
        const host = {
          async getSettings() {
            try {
              // ctx.remote.settings.describe() 返回 {ok, value} 信封（原生 UI 同款处理）；
              // value = {writable, hasDocument, namespaces:[{ns, value, revision}...]}
              const doc = await ctx.remote?.settings?.describe?.();
              if (!doc?.ok) return null;
              const v = doc.value;
              const list = Array.isArray(v) ? v : v?.namespaces;
              const ns = (list || []).find((n) => n.ns === 'dsh-model-fallback-queue');
              return ns?.value ?? null;
            } catch (e) {
              console.warn('[fallback-queue] getSettings failed', e);
              return null;
            }
          },
          async updateSettings(patch) {
            try {
              const doc = await ctx.remote?.settings?.describe?.();
              const v = doc?.ok ? doc.value : doc;
              const list = Array.isArray(v) ? v : v?.namespaces;
              const ns = (list || []).find((n) => n.ns === 'dsh-model-fallback-queue');
              // update 返回 {ok, value} 信封；失败时 warn
              const r = await ctx.remote?.settings?.update?.(
                'dsh-model-fallback-queue',
                patch,
                ns?.revision,
              );
              if (r && r.ok === false) console.warn('[fallback-queue] update rejected', r.error?.message);
            } catch (e) {
              console.warn('[fallback-queue] update failed', e);
            }
          },
          // 队列经 host 侧 RPC 读写 state 文件（不走 settings，避免主题全量重算）
          async getQueue() {
            try {
              const remote = rpcFace;
              if (!remote?.getQueue) return null;
              const r = await remote.getQueue();
              const v = r && typeof r === 'object' && 'ok' in r ? (r.ok ? r.value : null) : r;
              return Array.isArray(v?.queue) ? v.queue : null;
            } catch (e) {
              console.warn('[fallback-queue] getQueue failed', e);
              return null;
            }
          },
          async setQueue(queue) {
            try {
              const remote = rpcFace;
              if (!remote?.setQueue) return;
              const r = await remote.setQueue(queue);
              if (r && typeof r === 'object' && 'ok' in r && r.ok === false) {
                console.warn('[fallback-queue] setQueue rejected', r.error?.message);
              }
            } catch (e) {
              console.warn('[fallback-queue] setQueue failed', e);
            }
          },
          async getRuntimeSnapshot() {
            try {
              const remote = rpcFace;
              if (!remote?.snapshot) return null;
              const r = await remote.snapshot();
              // typert face 可能返回 {ok,value} 信封或裸值，两种都兼容
              if (r && typeof r === 'object' && 'ok' in r) return r.ok ? (r.value ?? null) : null;
              return r ?? null;
            } catch (e) {
              console.warn('[fallback-queue] snapshot failed', e);
              return null;
            }
          },
          // typert face 返回值可能是 {ok,value} 信封（失败时 {ok:false,error}），也可能
          // 是裸值。统一在这里拆一次，调用方看到的永远是裸值/null，避免把 {ok:false}
          // 当成真值继续用（probe/manualFailback 以前直接透传信封，UI 判断会失真）。
          async probe(index) {
            try {
              const r = await rpcFace?.probe?.(index);
              return unwrapEnvelope(r);
            } catch (e) {
              console.warn('[fallback-queue] probe failed', e);
              return null;
            }
          },
          async manualFailback(index) {
            try {
              const r = await rpcFace?.manualFailback?.(index);
              return unwrapEnvelope(r);
            } catch (e) {
              console.warn('[fallback-queue] manualFailback failed', e);
              return null;
            }
          },
        };

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-model-fallback-queue', order: 60, label: '故障转移' },
            () => SettingsPage({ host, onOpenSettings: null }),
          ),
        );

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'dsh-model-fallback-queue-chip', order: 20 },
            // slot 是 session scope：宿主渲染时把当前会话的 sessionId 等标准 props 传进来，
            // 原样透传给 Chip（Chip 里读 props.sessionId 取 per-session inFlight）。
            (slotProps) => Chip({ ...slotProps, host }),
          ),
        );
    }
  },
});
