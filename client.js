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

      const enabled = snap?.enabled;
      const entries = snap?.entries || [];
      const active = snap?.activeIndex ?? 0;
      const allOpen = entries.length > 0 && entries.every((e) => e.state === 'open');
      const halfOpen = entries.some((e) => e.state === 'half_open');

      let label;
      let tone = 'muted';
      if (!enabled) label = 'P-';
      else if (allOpen) {
        label = '全部熔断';
        tone = 'error';
      } else if (halfOpen) {
        label = `P${active + 1} 探测中`;
        tone = 'warn';
      } else {
        label = `P${active + 1}`;
        tone = active === 0 ? 'ok' : 'warn';
      }

      return h(
        'div',
        { style: { position: 'relative' } },
        h(
          'button',
          {
            onClick: () => setOpen((v) => !v),
            style: {
              ...btnSmall,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
            },
          },
          h('span', { 'aria-hidden': true }, '⇄'),
          label,
        ),
        open
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  bottom: 'calc(100% + 8px)',
                  right: 0,
                  minWidth: 280,
                  padding: 10,
                  borderRadius: 10,
                  border: '1px solid var(--dsw-alias-color-border, #ddd)',
                  background: 'var(--dsw-alias-color-surface, #fff)',
                  boxShadow: '0 4px 16px rgba(0,0,0,.12)',
                  zIndex: 30,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                },
              },
              allOpen
                ? h(Badge, { tone: 'error' }, '全部熔断：请求按原模型放行')
                : null,
              entries.length === 0
                ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-color-text-secondary)' } }, '队列为空')
                : entries.map((e) =>
                    h(
                      'div',
                      { key: e.index, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } },
                      h('strong', { style: { width: 24 } }, `P${e.index + 1}`),
                      h('span', { style: { flex: 1, opacity: e.index === active ? 1 : 0.7 } }, `${e.provider} / ${e.model}`),
                      h(Badge, { tone: STATE_TONE[e.state] || 'muted' }, STATE_TEXT[e.state] || e.state),
                    ),
                  ),
              snap?.lastSwitch
                ? h(
                    'div',
                    { style: { fontSize: 11, color: 'var(--dsw-alias-color-text-secondary)' } },
                    `最近切换：P${snap.lastSwitch.from + 1} → P${snap.lastSwitch.to + 1}${snap.lastSwitch.code ? `（${snap.lastSwitch.code}）` : ''}`,
                  )
                : null,
              h(
                'button',
                { onClick: onOpenSettings, style: { ...btnSmall, alignSelf: 'flex-end' } },
                '设置…',
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
              const doc = await ctx.remote?.settings?.describe?.();
              const ns = doc?.namespaces?.find((n) => n.ns === 'dsh-model-fallback-queue');
              return ns?.value;
            } catch {
              return null;
            }
          },
          async updateSettings(patch) {
            try {
              const doc = await ctx.remote?.settings?.describe?.();
              const ns = doc?.namespaces?.find((n) => n.ns === 'dsh-model-fallback-queue');
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
            // v1：运行态经 host 侧轮询转发尚缺；先返回 null，芯片只显示配置态
            try {
              return await ctx.remote?.['dsh-model-fallback-queue']?.snapshot?.() ?? null;
            } catch {
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
            () => Chip({ host }),
          ),
        );
      },
    };
  },
});
