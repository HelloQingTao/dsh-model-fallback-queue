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

    function SettingsPage({ host }) {
      const [cfg, setCfg] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [snap, setSnap] = React.useState(null);
      const [pickerOpen, setPickerOpen] = React.useState(false);
      const [confirmRemove, setConfirmRemove] = React.useState(null); // 移除确认中的行索引

      const refresh = React.useCallback(async () => {
        const s = await host.getSettings();
        if (s) setCfg({ enabled: false, queue: [], failbackMode: STICKY, ...s });
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

      const move = async (i, dir) => {
        const q = [...cfg.queue];
        const j = i + dir;
        if (j < 0 || j >= q.length) return;
        [q[i], q[j]] = [q[j], q[i]];
        await patch({ queue: q });
      };

      const remove = async (i) => {
        const q = cfg.queue.filter((_, k) => k !== i);
        await patch({ queue: q });
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
                      key: `${r.provider}/${r.model}/${i}`,
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
                      ? h(Badge, { tone: STATE_TONE[entry.state] || 'muted' }, `${STATE_TEXT[entry.state] || entry.state}${entry.failures ? ` · 失败${entry.failures}` : ''}`)
                      : null,
                    h('button', { onClick: () => move(i, -1), disabled: i === 0, style: btnSmall }, '↑'),
                    h('button', { onClick: () => move(i, 1), disabled: i === cfg.queue.length - 1, style: btnSmall }, '↓'),
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
                await patch({ queue: [...cfg.queue, { provider, model }] });
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

    // ---------- 输入框芯片 ----------

    function Chip({ host, onOpenSettings }) {
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
        const tick = async () => {
          const st = await host.getRuntimeSnapshot();
          // 同上：快照内容没变就不写 state，避免每 5 秒一次的无谓重渲染。
          if (alive && st) setSnap((prev) => (JSON.stringify(prev) === JSON.stringify(st) ? prev : st));
        };
        tick();
        const t = setInterval(tick, 5000);
        return () => {
          alive = false;
          clearInterval(t);
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
      const p1Follow = snap?.p1Follow ?? true;
      const allOpen = entries.length > 0 && entries.every((e) => e.state === 'open');
      const halfOpen = entries.some((e) => e.state === 'half_open');

      let label;
      let tone = 'muted';
      // p1Follow 下 activeIndex 0 = P1（会话模型）；队列索引 i 实际是 P(i+1)
      const lbl = (idx) => (p1Follow ? (idx === 0 ? 'P1' : `P${idx + 1}`) : `P${idx + 1}`);
      if (!enabled) label = 'P';
      else if (allOpen) {
        label = 'P!';
        tone = 'error';
      } else if (halfOpen) {
        label = lbl(active);
        tone = 'warn';
      } else {
        label = lbl(active);
        tone = active === 0 ? 'ok' : 'warn';
      }

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
                  background: 'var(--dsw-alias-bg-overlay, #fff)',
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
                allOpen
                  ? h(Badge, { tone: 'error' }, '全部熔断')
                  : h(Badge, { tone: enabled ? 'ok' : 'muted' }, enabled ? '运行中' : '已关闭'),
              ),
              // 队列条目
              h(
                'div',
                { style: { padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 2 } },
                h('div', {
                    key: 'p1-row',
                    style: {
                      display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 8, fontSize: 12,
                      background: (active === -1 || (active === 0 && p1Follow)) ? 'var(--dsw-alias-brand-primary, #4f7cf7)' + '14' : 'transparent',
                    },
                  },
                  h('strong', { style: { width: 22, fontSize: 11, opacity: 0.85 } }, 'P1'),
                  h('span', { style: { flex: 1, opacity: (active === 0 && p1Follow) ? 1 : 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    sessionModelLabel + (p1Follow ? '（会话模型）' : '')),
                  (active === 0 && p1Follow)
                    ? h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-brand-primary, #4f7cf7)', fontWeight: 600 } }, '当前')
                    : null,
                  h(Badge, { tone: 'ok' }, '正常'),
                  ),
                ...(entries.length === 0
                  ? [h('div', { key: 'empty', style: { padding: '10px 6px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '暂无后备——到设置页添加 P2/P3…')]
                  : entries.map((e) => {
                      const isActive = e.index === active && !(p1Follow && e.index === 0);
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
                        h(Badge, { tone: STATE_TONE[e.state] || 'muted' }, STATE_TEXT[e.state] || e.state),
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
                  enabled && active !== 0
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
          async getRuntimeSnapshot() {
            // 运行态经 host 侧 FallbackQueueService RPC（typert SRC fallback）获取
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
          async probe(index) {
            try {
              return await rpcFace?.probe?.(index) ?? { ok: false };
            } catch (e) {
              console.warn('[fallback-queue] probe failed', e);
              return { ok: false };
            }
          },
          async manualFailback(index) {
            try {
              return await rpcFace?.manualFailback?.(index) ?? { ok: false };
            } catch (e) {
              console.warn('[fallback-queue] manualFailback failed', e);
              return { ok: false };
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
            () => Chip({ host }),
          ),
        );
    }
  },
});
