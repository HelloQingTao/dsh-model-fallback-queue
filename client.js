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
  id: '@local/dsh-model-fallback-queue',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STICKY = 'sticky';
    const PROBE = 'probe';
    const MANUAL = 'manual';

    // ---------- 共享小部件 ----------

    function Badge({ tone, children }) {
      const colors = {
        ok: 'var(--dsw-alias-color-success, #3a9e5f)',
        warn: 'var(--dsw-alias-color-warning, #c98a1b)',
        error: 'var(--dsw-alias-color-danger, #c94141)',
        muted: 'var(--dsw-alias-color-text-secondary, #888)',
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
              ? 'var(--dsw-alias-color-accent, #4f7cf7)'
              : 'var(--dsw-alias-color-border, #ccc)',
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

    // ---------- 设置页 ----------

    const STATE_TONE = { closed: 'ok', half_open: 'warn', open: 'error' };
    const STATE_TEXT = { closed: '正常', half_open: '探测中', open: '熔断' };

    function SettingsPage({ host }) {
      const [cfg, setCfg] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [snap, setSnap] = React.useState(null);

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
        const provider = window.prompt('provider 名（如 workbuddy-xdpool）');
        if (!provider) return;
        const model = window.prompt('model 名（如 deepseek-v4.1-flash）');
        if (!model) return;
        await patch({ queue: [...cfg.queue, { provider, model }] });
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
          busy ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-color-text-secondary)' } }, '保存中…') : null,
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
              ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-color-text-secondary)' } }, '队列为空：添加 P2/P3… 作为 P1 的后备模型')
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
                        border: '1px solid var(--dsw-alias-color-border, #ddd)',
                      },
                    },
                    h('strong', { style: { width: 28 } }, `P${i + 1}`),
                    h('span', { style: { flex: 1, fontSize: 13 } }, `${r.provider} / ${r.model}`),
                    entry
                      ? h(Badge, { tone: STATE_TONE[entry.state] || 'muted' }, `${STATE_TEXT[entry.state] || entry.state}${entry.failures ? ` · 失败${entry.failures}` : ''}`)
                      : null,
                    h('button', { onClick: () => move(i, -1), disabled: i === 0, style: btnSmall }, '↑'),
                    h('button', { onClick: () => move(i, 1), disabled: i === cfg.queue.length - 1, style: btnSmall }, '↓'),
                    h('button', { onClick: () => remove(i), style: btnSmall }, '移除'),
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
                    border: `1px solid ${cfg.failbackMode === value ? 'var(--dsw-alias-color-accent, #4f7cf7)' : 'var(--dsw-alias-color-border, #ddd)'}`,
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
                  h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-color-text-secondary)' } }, desc),
                ),
              ),
            ),
          ),
        ),
        // 运行态
        snap?.lastSwitch
          ? h(
              'div',
              { style: { fontSize: 12, color: 'var(--dsw-alias-color-text-secondary)' } },
              `最近切换：P${snap.lastSwitch.from + 1} → P${snap.lastSwitch.to + 1}${snap.lastSwitch.code ? `（${snap.lastSwitch.code}）` : ''}`,
            )
          : null,
      );
    }

    const btnSmall = {
      fontSize: 12,
      padding: '2px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-color-border, #ddd)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    };

    // ---------- 输入框芯片 ----------

    function Chip({ host, onOpenSettings }) {
      const [snap, setSnap] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);

      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          const st = await host.getRuntimeSnapshot();
          if (alive && st) setSnap(st);
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
      const allOpen = entries.length > 0 && entries.every((e) => e.state === 'open');
      const halfOpen = entries.some((e) => e.state === 'half_open');

      let label;
      let tone = 'muted';
      if (!enabled) label = 'P';
      else if (allOpen) {
        label = 'P!';
        tone = 'error';
      } else if (halfOpen) {
        label = `P${active + 1}`;
        tone = 'warn';
      } else {
        label = `P${active + 1}`;
        tone = active === 0 ? 'ok' : 'warn';
      }

      const toneColor = {
        ok: 'var(--dsw-alias-color-success, #3a9e5f)',
        warn: 'var(--dsw-alias-color-warning, #c98a1b)',
        error: 'var(--dsw-alias-color-danger, #c94141)',
        muted: 'var(--dsw-alias-color-text-secondary, #888)',
      }[tone];

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
              border: '1px solid var(--dsw-alias-color-border, #ddd)',
              background: 'var(--dsw-alias-color-surface, transparent)',
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
          // 右上角健康状态小圆点
          h('span', {
            style: {
              position: 'absolute',
              top: -3,
              right: -3,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: toneColor,
              border: '1.5px solid var(--dsw-alias-color-surface, #fff)',
            },
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
                  border: '1px solid var(--dsw-alias-color-border, #ddd)',
                  background: 'var(--dsw-alias-color-surface, #fff)',
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
                    borderBottom: '1px solid var(--dsw-alias-color-border, #eee)',
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
                entries.length === 0
                  ? h('div', { style: { padding: '10px 6px', fontSize: 12, color: 'var(--dsw-alias-color-text-secondary)' } }, '队列为空，到设置页添加后备模型')
                  : entries.map((e) => {
                      const isActive = e.index === active;
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
                            background: isActive ? 'var(--dsw-alias-color-accent, #4f7cf7)' + '14' : 'transparent',
                          },
                        },
                        h('strong', { style: { width: 22, fontSize: 11, opacity: 0.85 } }, `P${e.index + 1}`),
                        h('span', { style: { flex: 1, opacity: isActive ? 1 : 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${e.provider} / ${e.model}`),
                        isActive
                          ? h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-color-accent, #4f7cf7)', fontWeight: 600 } }, '当前')
                          : null,
                        h(Badge, { tone: STATE_TONE[e.state] || 'muted' }, STATE_TEXT[e.state] || e.state),
                      );
                    }),
              ),
              // 底部：最近切换 + 设置入口
              h(
                'div',
                {
                  style: {
                    padding: '8px 14px',
                    borderTop: '1px solid var(--dsw-alias-color-border, #eee)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: 11,
                    color: 'var(--dsw-alias-color-text-secondary)',
                  },
                },
                snap?.lastSwitch
                  ? `最近切换 P${snap.lastSwitch.from + 1} → P${snap.lastSwitch.to + 1}`
                  : '无切换记录',
                onOpenSettings
                  ? h(
                      'button',
                      {
                        onClick: onOpenSettings,
                        style: {
                          fontSize: 11,
                          padding: '3px 10px',
                          borderRadius: 6,
                          border: '1px solid var(--dsw-alias-color-border, #ddd)',
                          background: 'transparent',
                          color: 'inherit',
                          cursor: 'pointer',
                        },
                      },
                      '设置…',
                    )
                  : null,
              ),
            )
          : null,
      );
    }

    // ---------- 装配 ----------

    return {
      inject: ['slots'],
      apply(ctx) {
        // host 桥：经 ctx（client side）调用 host 侧设置与运行态。
        // v1 先走 cordis inspect/remote 通用通道；具体 RPC 方法由 host 侧 SettingsForms 提供。
        const host = {
          async getSettings() {
            try {
              // settings.describe() 返回 SettingsDescriptor[]（按 entry id 平铺），不是 {namespaces}
              const doc = await ctx.remote?.settings?.describe?.();
              const list = Array.isArray(doc) ? doc : doc?.namespaces;
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
              const list = Array.isArray(doc) ? doc : doc?.namespaces;
              const ns = (list || []).find((n) => n.ns === 'dsh-model-fallback-queue');
              await ctx.remote?.settings?.update?.(
                'dsh-model-fallback-queue',
                patch,
                ns?.revision,
              );
            } catch (e) {
              console.warn('[fallback-queue] update failed', e);
            }
          },
          async getRuntimeSnapshot() {
            // 运行态经 host 侧 FallbackQueueService RPC（typert SRC fallback）获取
            try {
              const remote = ctx.remote?.['dsh-model-fallback-queue'];
              if (!remote?.snapshot) return null;
              return (await remote.snapshot()) ?? null;
            } catch (e) {
              console.warn('[fallback-queue] snapshot failed', e);
              return null;
            }
          },
          async probe(index) {
            try {
              return await ctx.remote?.['dsh-model-fallback-queue']?.probe?.(index) ?? { ok: false };
            } catch (e) {
              console.warn('[fallback-queue] probe failed', e);
              return { ok: false };
            }
          },
          async manualFailback(index) {
            try {
              return await ctx.remote?.['dsh-model-fallback-queue']?.manualFailback?.(index) ?? { ok: false };
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
      },
    };
  },
});
