/**
 * 筹码分布区块（抽屉内、`chartBody()` 之后）：可折叠、默认展开 ~160px。
 *
 * 合规要点：
 *  - 获利/套牢是**盈亏语义** ⇒ 着色走 `dirClass`（跟随 `prefs.redUp`），不写死红绿；
 *  - 支撑/压力是**分布统计量**（P5/P95），tooltip 明写"不是预测、不是买卖建议"；
 *  - 容器与数字登记进 `styles.ts` 的两条 `data-blur=1` 清单（隐身档下与其它数字一起糊）；
 *  - 五日档隐藏（多日分时不是日线序列），并给一行原因。
 */
import React, { useState } from 'react'
import { dirClass } from './format.ts'
import { clampIndex } from './chipsView.ts'
import { axisTicks, caliberDeviates } from './chipsView.ts'
import type { ChipsState } from './useChips.ts'

export interface ChipsPanelProps {
  state: ChipsState
  redUp: boolean
  /** 当前档位是否是五日（五日档隐藏并说明原因） */
  isFiveDay: boolean
  /** 该标的是否支持前复权（指数/期货 ⇒ 宿主不给模块） */
  fqSupported: boolean
  onRetry: () => void
}

export function ChipsPanel(props: ChipsPanelProps): React.ReactElement | null {
  const [open, setOpen] = useState(true)
  const [idx, setIdx] = useState<number | null>(null)
  const d = props.state.data
  const days = d?.days ?? []
  const at = clampIndex(idx === null ? days.length - 1 : idx, days.length)
  const day = at >= 0 ? days[at] : null

  if (props.isFiveDay) {
    return React.createElement('div', { className: 'tw-chips tw-chips-off' },
      React.createElement('span', { className: 'tw-muted' }, '筹码分布只在分时/日K 及以上显示（五日档是多日分时，不是日线序列）'))
  }
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
      React.createElement('span', { className: 'tw-muted' }, props.state.loading ? '筹码分布计算中…' : '暂无筹码分布'))
  }
  const max = Math.max(...day.buckets, 1e-9)
  const price = day.avgCost
  const profitPct = day.profitRatio
  const hint = `${d.methodology}\n${d.disclaimer}`
  const deviate = caliberDeviates({
    decay: d.decay, decayReason: d.decayReason, fqSupported: props.fqSupported,
    why: d.why, samples: d.samples, window: d.window,
  })
  const ticks = axisTicks(day.centers.map((c) => c))
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
            React.createElement('div', { className: 'tw-chips-axis' },
              ...ticks.slice().reverse().map((t) => React.createElement('span', { key: t.toFixed(2) }, t.toFixed(2))),
            ),
            React.createElement('div', { className: 'tw-chips-bars' },
              ...day.buckets.map((w, i) => React.createElement('div', {
                key: i,
                className: `tw-chips-bar ${price === null ? 'tw-flat' : dirClass(day.centers[i] - price, props.redUp)}`,
                style: { width: `${(w / max) * 100}%` },
                title: `${day.centers[i].toFixed(2)} 元 · 权重 ${(w * 100).toFixed(2)}%`,
              })),
            ),
          ),
        )
      : null,
  )
}
