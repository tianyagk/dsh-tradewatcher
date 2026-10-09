/**
 */
import React, { useEffect, useMemo, useState } from 'react'
import type { BoardRow } from '../shared/model.ts'
import { api } from './api.ts'
import { UPDOWN_MISSING_NOTE, upDownPair } from './breadthView.ts'
import { fmtAmt, fmtPct } from './format.ts'
import { Skeleton } from './ui.tsx'
import { squarify } from './treemap.ts'

/** 涨跌幅 → 颜色（红涨绿跌跟随主题；0 附近为中性灰） */
function cellColor(pct: number | null, redUp: boolean): string {
  if (pct === null) return 'var(--tw-card2)'
  const up = redUp ? pct > 0 : pct < 0
  const mag = Math.min(1, Math.abs(pct) / 5) // ±5% 封顶，避免一个涨停把整图压成同色
  const alpha = 0.14 + mag * 0.62
  const base = pct === 0 ? '138,143,152' : up ? (redUp ? '229,72,77' : '39,166,68') : (redUp ? '39,166,68' : '229,72,77')
  return `rgba(${base},${alpha.toFixed(2)})`
}

export function IndustryHeatmap(props: { redUp: boolean; width: number; height: number }): React.ReactElement {
  const { redUp, width, height } = props
  const [rows, setRows] = useState<BoardRow[] | null>(null)
  const [meta, setMeta] = useState<{ asOf?: number; source?: string; stale?: boolean; error?: string } | null>(null)

  useEffect(() => {
    let alive = true
    // 按成交额取（面积用成交额，因此排序键与面积口径一致）
    api
      .board('industry', 'amount', 1)
      .then((r) => {
        if (!alive) return
        setRows(r.rows.slice(0, 60))
        setMeta({ asOf: r.asOf, source: r.source, stale: r.stale })
      })
      .catch((e: Error) => {
        if (alive) {
          setRows([])
          setMeta({ error: e.message })
        }
      })
    return () => {
      alive = false
    }
  }, [])

  // 面积必须为正数才可布局：成交额缺失的行不参与（而不是当 0 塞进去占一个空块）
  const usable = useMemo(
    () => (rows ?? []).filter((r) => typeof r.amount === 'number' && Number.isFinite(r.amount) && (r.amount as number) > 0),
    [rows],
  )
  const rects = useMemo(
    () => squarify(usable.map((r) => r.amount as number), width, height),
    [usable, width, height],
  )
  const dropped = (rows ?? []).length - usable.length

  return React.createElement('div', { className: 'tw-panel' },
    React.createElement('div', { className: 'tw-panel-h' },
      React.createElement('span', { className: 't' }, '行业热力（自绘）'),
      React.createElement('span', { className: 'tw-hint', style: { margin: 0 } },
        `面积＝成交额 · 色深＝涨跌幅（±5% 封顶）` +
        (meta?.asOf !== undefined ? ` · 数据 ${new Date(meta.asOf).toLocaleTimeString('zh-CN', { hour12: false })}` : '') +
        (meta?.source !== undefined ? ` · 来源 ${meta.source}${meta.stale === true ? '（上次成功结果）' : ''}` : ''),
      ),
    ),
    meta?.error !== undefined
      ? React.createElement('div', { className: 'tw-hint', style: { color: 'var(--tw-up)' } },
          `行业排行本次未取到：${meta.error}（热力图需要板块成交额与涨跌幅；稍后刷新重试）`)
      : null,
    dropped > 0
      ? React.createElement('div', { className: 'tw-hint' },
          `${dropped} 个板块无成交额，未计入面积`)
      : null,
    rows === null
      ? React.createElement(Skeleton, { lines: 6, height: 40 })
      : usable.length === 0
        ? React.createElement('div', { className: 'tw-muted', style: { padding: 10 } }, '暂无可绘制的板块数据。')
        : React.createElement('svg', {
            width, height, viewBox: `0 0 ${width} ${height}`,
            style: { display: 'block', background: 'var(--tw-card2)' },
          },
            ...rects.map((r, i) => {
              const row = usable[i]
              const showLabel = r.w > 46 && r.h > 22
              return React.createElement('g', { key: `${row.code}-${i}` },
                React.createElement('rect', {
                  x: r.x, y: r.y, width: Math.max(0, r.w - 1), height: Math.max(0, r.h - 1),
                  style: { fill: cellColor(row.pct, redUp), stroke: 'var(--tw-bg)', strokeWidth: 1 },
                }),
                showLabel
                  ? React.createElement('text', {
                      x: r.x + 5, y: r.y + 13,
                      style: { fill: 'var(--tw-text)', fontSize: 10.5, fontWeight: 600, paintOrder: 'stroke', stroke: 'var(--tw-card)', strokeWidth: 2 },
                    }, row.name)
                  : null,
                showLabel
                  ? React.createElement('text', {
                      x: r.x + 5, y: r.y + 26,
                      style: { fill: 'var(--tw-dim)', fontSize: 10, fontFamily: 'var(--tw-mono)' },
                    }, `${fmtPct(row.pct)} · ${fmtAmt(row.amount)}`)
                  : null,
                React.createElement('title', null,
                  `${row.name}\n涨跌幅 ${fmtPct(row.pct)}\n成交额 ${fmtAmt(row.amount)}` +
                  // 涨/跌家数成对判：一侧缺失就说"未取到"，不写成 `上涨 1234 / 下跌 0`
                  (upDownPair(row.up, row.down).ok
                    ? `\n上涨 ${row.up} / 下跌 ${row.down}`
                    : `\n${UPDOWN_MISSING_NOTE}`)),
              )
            }),
          ),
    // 口径说明写进图里而不是藏起来：这是自绘相对 iframe 的唯一意义
    React.createElement('div', { className: 'tw-hint', style: { marginTop: 4 } },
      '口径：面积为板块成交额（按成交额取前 60 个板块，因此图不是全市场）；色深为当日涨跌幅，±5% 封顶以免单个涨停压平色阶。',
    ),
  )
}
