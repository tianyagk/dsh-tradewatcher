/**
 * 筹码分布区块（抽屉内、`chartBody()` 之后）：可折叠、默认展开 ~160px；**与页签无关**。
 *
 * 合规要点：
 *  - 获利/套牢是**盈亏语义** ⇒ 着色走 `dirClass`（跟随 `prefs.redUp`），不写死红绿；
 *  - 支撑/压力是**分布统计量**（P5/P95），tooltip 明写"不是预测、不是买卖建议"；
 *  - 容器与数字登记进 `styles.ts` 的两条 `data-blur=1` 清单（隐身档下与其它数字一起糊）；
 *  - **与页签无关**：筹码是**标的的属性**（由日线筹码成本推出），六个页签都显示、DOM 与状态逐字不变；
 *    只有**标的/数据**的原因才给一行说明（不复权标的、样本不足、口径偏离默认）。
 */
import React, { useEffect, useState } from 'react'
import { dirClass } from './format.ts'
import { clampIndex } from './chipsView.ts'
import { countMount } from './mounts.ts'
import { CHIPS_LINE_TOKENS } from './theme.ts'
import { axisTicks, caliberDeviates, chipAxisOf, chipsLinesOf, chipsRowHeight } from './chipsView.ts'
import type { ChipsState } from './useChips.ts'

export interface ChipsPanelProps {
  state: ChipsState
  redUp: boolean
  /** 该标的是否支持前复权（指数/期货 ⇒ 宿主不给模块） */
  fqSupported: boolean
  onRetry: () => void
  /** 下窗可用高度（由分割线决定；不再写死 160px 上限） */
  maxBottom?: number
  /** 折叠状态上报（抽屉据此决定是否渲染分割线） */
  onOpenChange?: (open: boolean) => void
}

export function ChipsPanel(props: ChipsPanelProps): React.ReactElement | null {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    props.onOpenChange?.(open)
  }, [open])
  const [idx, setIdx] = useState<number | null>(null)
  // 挂载计数：切页签后这个数必须**保持 1**（滑杆/折叠状态跟着一起没丢）
  useEffect(() => {
    countMount('chips')
  }, [])
  const d = props.state.data
  const days = d?.days ?? []
  const at = clampIndex(idx === null ? days.length - 1 : idx, days.length)
  const day = at >= 0 ? days[at] : null

  if (!props.fqSupported || d?.why !== null && d?.why !== undefined) {
    return React.createElement('div', { className: 'tw-chips tw-chips-off' },
      React.createElement('span', { className: 'tw-muted' }, d?.why ?? '该标的不提供筹码分布（指数/期货/板块没有前复权序列）'))
  }
  if (props.state.error !== null) {
    return React.createElement('div', { className: 'tw-chips tw-chips-off' },
      React.createElement('span', { className: 'tw-muted' }, `筹码分布取不到：${props.state.error}`))
  }
  if (d === null || day === null) {
    return React.createElement('div', { className: 'tw-chips tw-chips-off' },
      React.createElement('span', { className: 'tw-muted' }, props.state.loading ? '筹码分布计算中…' : '未取到'))
  }
  const price = day.avgCost
  const profitPct = day.profitRatio
  const hint0 = `${d.methodology}`
  const deviate = caliberDeviates({
    decay: d.decay, decayReason: d.decayReason, fqSupported: props.fqSupported,
    why: d.why, samples: d.samples, window: d.window,
  })
  // 价格轴裁到筹码密集区（覆盖 99% 质量）+ 横轴与条宽**同一来源**（axisOf）
  const axis = chipAxisOf(day.centers, day.buckets)
  const win = axis.window
  const viewCenters = day.centers.slice(win.from, win.to + 1)
  const viewBuckets = day.buckets.slice(win.from, win.to + 1)
  const rowH = chipsRowHeight(props.maxBottom === undefined ? 140 : props.maxBottom, Math.max(1, win.rows))
  const ticks = axisTicks(viewCenters)
  const xTicks = axis.ticks
  const lines = chipsLinesOf({ avgCost: day.avgCost, support: day.support, resistance: day.resistance })
  const hint = `${hint0}\n显示区间按筹码质量覆盖裁剪：${(axis.window.covered * 100).toFixed(2)}% 的筹码在轴内，` +
    `${(axis.window.dropped * 100).toFixed(2)}% 在轴外（未显示，权重未改）\n` +
    `横轴自适应：轴顶 ${(axis.top * 100).toFixed(2)}%（当前展示日单桶峰值 ${(axis.peak * 100).toFixed(2)}%）\n${d.disclaimer}`
  const colorOf = (k: 'avg' | 'resistance' | 'support'): string =>
    k === 'avg' ? CHIPS_LINE_TOKENS.avg : k === 'resistance' ? CHIPS_LINE_TOKENS.resistance : CHIPS_LINE_TOKENS.support
  const money = (v: number | null): string => (v === null ? '—' : v.toFixed(2))
  const pct = (v: number | null): string => (v === null ? '—' : `${v.toFixed(2)}%`)

  return React.createElement('div', { className: 'tw-chips' },
    React.createElement('div', { className: 'tw-chips-head' },
      React.createElement('button', {
        type: 'button', className: 'tw-chips-toggle', 'aria-expanded': open,
        onClick: () => setOpen((v) => !v),
        title: hint, 'aria-label': `筹码分布，${open ? '收起' : '展开'}`,
      }, `${open ? '▾' : '▸'} 筹码分布`),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('span', { className: 'tw-chips-nums' },
        React.createElement('span', { title: 'Σ(桶价×权重)/Σ权重' }, `平均成本 ${money(day.avgCost)}`),
        React.createElement('span', { className: 'tw-chips-sep' }),
        React.createElement('span', { title: `筹码累积分布 P5；${d.disclaimer}` }, `支撑 ${d.narrow ? '—' : money(day.support)}`),
        React.createElement('span', { className: 'tw-chips-sep' }),
        React.createElement('span', { title: `筹码累积分布 P95；${d.disclaimer}` }, `压力 ${d.narrow ? '—' : money(day.resistance)}`),
        React.createElement('span', { className: 'tw-chips-sep' }),
        React.createElement('span', { title: 'Σ(桶价 < 现价 的权重)/Σ权重；现价缺失时为 —' }, `盈利比例 ${pct(profitPct)}`),
      ),
    ),
    // 只有**偏离默认口径**时才给一行原因（正常情况一个字都不显示：k=1.5 + 三角形是写死的默认）
    deviate !== null
      ? React.createElement('div', { className: 'tw-chips-narrow', tabIndex: 0, role: 'note', title: `${deviate}\n${d.methodology}` }, deviate)
      : null,
    d.narrow && open
      ? React.createElement('div', { className: 'tw-chips-narrow' }, '区间过窄（P95−P5 不足价格区间 3%），仅供参考')
      : null,
    open
      ? React.createElement('div', { className: 'tw-chips-body' },
          days.length > 1
            ? React.createElement('input', {
                className: 'tw-chips-slider', type: 'range', min: 0, max: days.length - 1, value: at,
                'aria-label': `筹码分布日期（近 ${days.length} 日，第 ${at + 1} 天）`,
                title: `逐日切换：${days[0]?.date ?? ''} → ${days[days.length - 1]?.date ?? ''}（展示窗口 ${d.displayWindow} 天）`,
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => setIdx(Number(e.target.value)),
              })
            : null,
          React.createElement('div', { className: 'tw-chips-date tw-muted' }, `${day.date} · 样本 ${day.samples} 天`),
          // 左轴（3–5 个价格刻度）+ 横条：同一个 flex 行内 ⇒ 自然逐行对齐
          React.createElement('div', { className: 'tw-chips-chart' },
            // 左轴：价格刻度（11px，与其它轴同字体族，不加粗）
            React.createElement('div', { className: 'tw-chips-axis' },
              ...ticks.slice().reverse().map((t) => React.createElement('span', { key: t.toFixed(2) }, t.toFixed(2))),
            ),
            React.createElement('div', { className: 'tw-chips-plot', style: { flex: 1 } },
              // 网格线（层级：网格在下、横条在上；颜色走 token，不写死 hex）
              ...xTicks.map((t, i) => React.createElement('div', {
                // 竖网格位置 = 刻度在轴上的**真实比例**（旧实现的 `- pct*44px` 偏移把线拉左 ⇒ 看起来"分布压扁在左侧"）
                key: `gv${i}`, className: 'tw-chips-grid-v', style: { left: `${t.pct}%` },
              })),
              ...ticks.map((_t, i) => React.createElement('div', {
                key: `gh${i}`, className: 'tw-chips-grid-h',
                style: { top: `${(i / Math.max(1, ticks.length - 1)) * 100}%` },
              })),
              // 三条**语义线**（横跨分布区，右端标注数值；不是涨跌 ⇒ 不用红/绿）
              ...lines.map((l) => {
                const lo = win.lo
                const hi = win.hi
                const topPct = hi > lo ? ((hi - l.price) / (hi - lo)) * 100 : 50
                return React.createElement('div', {
                  key: `ln-${l.kind}`, className: 'tw-chips-refline',
                  style: { top: `${Math.min(100, Math.max(0, topPct))}%`, color: colorOf(l.kind) },
                  title: l.kind === 'avg' ? '平均成本（Σ(桶价×权重)/Σ权重）' : l.kind === 'resistance' ? '压力位 = 筹码累积分布 P95' : '支撑位 = 筹码累积分布 P5',
                  'aria-hidden': true,
                })
              }),
              ...lines.map((l) => {
                const lo = win.lo
                const hi = win.hi
                const topPct = hi > lo ? ((hi - l.price) / (hi - lo)) * 100 : 50
                return React.createElement('span', {
                  key: `lb-${l.kind}`, className: 'tw-chips-reflabel',
                  style: { top: `${Math.min(100, Math.max(0, topPct))}%`, color: colorOf(l.kind) },
                  title: `${l.kind === 'avg' ? '平均成本' : l.kind === 'resistance' ? '压力位 P95' : '支撑位 P5'} = ${l.label}`,
                }, l.label)
              }),
              // 横条（96 桶：每行 ≥1px，低于 1px 也照画 ⇒ 不静默丢桶）
              // 只画**裁剪窗口内**的行；条宽按轴顶换算（axis.widthOf）⇒ 与刻度同尺度
              ...viewBuckets.map((w, i) => React.createElement('div', {
                key: i,
                className: `tw-chips-bar ${price === null ? 'tw-flat' : dirClass(viewCenters[i] - price, props.redUp)}`,
                style: { height: rowH, width: `${axis.widthOf(w)}%` },
                title: `${viewCenters[i].toFixed(2)} 元 · 权重 ${(w * 100).toFixed(2)}%（占总筹码）`,
              })),
            ),
          ),
          // 横坐标刻度：该价位筹码占总筹码的比例（nice step，小数位与步长匹配）
          xTicks.length > 0
            ? React.createElement('div', { className: 'tw-chips-xaxis' },
                ...xTicks.map((t) => React.createElement('span', { key: `x${t.label}` }, t.label)),
              )
            : null,
        )
      : null,
  )
}
