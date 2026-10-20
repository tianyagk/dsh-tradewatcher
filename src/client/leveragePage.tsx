/**
 * 工具②「杠杆温度计」的**专用详情页**（本仓库唯一不共享通用三段式骨架的详情页）。
 *
 * 为什么必须专用（用户口径的页面规格逐条落地）：
 *   · 通用详情页自带 Hero 说明段、区的口径行、方法/边界两段散文 —— 而本工具的规格是
 *     **页面上唯一的说明文字是 `截至 YYYY-MM-DD`**（多一个字都不要）⇒ 那些区块一个都不能渲染；
 *   · 通用详情页的时间范围控件是"本地切片 90/180/365 序列日"，本工具的窗口是**查询参数**
 *     （`range=250|750|all`），切档要重新取数 ⇒ 控件与语义都不一样。
 *
 * 页面元素（顺序即渲染顺序；`data-role` 是断言的锚点）：
 *   ① `leverage-hero`：大字温度（1 位小数）+ `/ 100` + `截至 …`（唯一的说明文字）+ 右上角窗口三档；
 *   ② `leverage-cards`：**三张**摘要卡（显性融资 / 杠杆率 / 当日融资净买入）；没有第四张；
 *   ③ `leverage-chart-card`：图例（温度 / 显性融资比例 / 净买入）→ 主图（双轴 + 两条线 + 阈值线 80/95
 *      + 底部净买入柱）；**没有**水平网格线、**没有**浮框与十字光标、**没有**悬停说明。
 *
 * 数据：`api.leverage(range)`（宿主 `/tradewatcher/leverage`）。取数三件套沿用既有做法 ——
 *   · **单飞**：同一个窗口在飞时不再发第二次（`inFlight` 集合）；
 *   · **超时**：`api.ts` 的 `request()` 统一 15 秒上限；
 *   · **代号丢弃旧响应**：`createRequestGen()`（`requestGen.ts` 的既有实现），旧代响应整体丢弃。
 * 每个窗口取到后进本地缓存 ⇒ 切回去命中缓存、**零请求零闪烁**（画布不卸载、不重挂载）。
 *
 * 缺失：任何数值缺失 ⇒ `—`（破折号），不加文字、不进悬停、不写 0（判据见 `tools/leverageView.ts`）。
 * 失败：显示 `ErrorNote` + 可点的「重试」（`data-role="leverage-retry"`），保留已取到的图。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { LeveragePayloadDto, LeverageRange } from './api.ts'
import { api } from './api.ts'
import { createRequestGen } from './requestGen.ts'
import {
  CARD_MIN_W,
  CARD_SURFACE,
  CHART_STACK,
  CHART_TYPE,
  HERO_TYPE,
  LEGEND_DOT,
  LEGEND_ROW,
  PLOT,
  RANGE_BOX,
  RANGE_OFF,
  RANGE_ON,
  RANGE_TYPE,
  SUMMARY_TYPE,
  TOOL_SPACE,
} from './toolDetailTheme.ts'
import {
  DASH,
  LEVERAGE_DEFAULT_RANGE,
  LEVERAGE_LEGEND,
  LEVERAGE_RANGES,
  fmtTemperature,
  leverageAsOfText,
  leverageCards,
  leverageChart,
  type LeverageChart,
} from './tools/leverageView.ts'
import { Btn, ErrorNote, Skeleton } from './ui.tsx'

/* ────────────────────────────── 取数（单飞 + 超时 + 代号） ────────────────────────────── */

interface LeverageFetch {
  payload: LeveragePayloadDto | null
  error: string | null
}

/**
 * 按窗口取数。`attempt` 变化 = 用户点了「重试」（清掉这一档的失败态重发）。
 *
 * ⚠ 这里**不**在切档时清空 `payload`：清空就是一次白屏/骨架闪烁，而用户口径明确要求"不得闪烁"。
 * 代价是切档瞬间画布仍是上一档的数据（通常一帧到几百毫秒），落地即替换；失败时上方有可点重试。
 */
function useLeverageFetch(range: LeverageRange, attempt: number): LeverageFetch {
  const [payload, setPayload] = useState<LeveragePayloadDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 已取到的窗口（切回 ⇒ 直接命中，零请求） */
  const cache = useRef(new Map<LeverageRange, LeveragePayloadDto>())
  /** 在飞窗口集合（单飞：同一档不重复发） */
  const inFlight = useRef(new Set<LeverageRange>())
  /** 请求代号：旧代响应（含错误）整体丢弃 */
  const gen = useRef(createRequestGen())
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const hit = cache.current.get(range)
    if (hit !== undefined) {
      setPayload(hit)
      setError(null)
      return
    }
    if (inFlight.current.has(range)) return
    inFlight.current.add(range)
    const my = gen.current.next()
    setError(null)
    api
      .leverage(range)
      .then((next) => {
        cache.current.set(range, next)
        if (!alive.current || gen.current.stale(my)) return
        setPayload(next)
      })
      .catch((e: unknown) => {
        if (!alive.current || gen.current.stale(my)) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        // ⚠ 无条件复位：只在 alive 时复位会让一次失败把该档永久卡在"在飞"
        inFlight.current.delete(range)
      })
  }, [range, attempt])

  return { payload, error }
}

/* ────────────────────────────── 绘图区尺寸 ────────────────────────────── */

/**
 * 绘图区尺寸 = **容器真实像素**（与详情页同一套做法：ResizeObserver 量盒子后按像素坐标绘制，
 * 线宽/文字不缩放；量不到时退回 `PLOT` 的回退画布 ⇒ 高度下限在任何情形下都成立）。
 */
function useChartBox(ref: React.RefObject<HTMLDivElement | null>): { w: number; h: number } {
  const [size, setSize] = useState<{ w: number; h: number }>({ w: PLOT.fallbackWidth, h: PLOT.fallbackHeight })
  useEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box === undefined) return
      const w = Math.max(240, Math.round(box.width))
      const h = Math.max(PLOT.heightMin, Math.round(box.height))
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

/* ────────────────────────────── 主图 ────────────────────────────── */

/**
 * 主图：把 `leverageChart()` 的纯数据画成 SVG。
 *
 * · 双轴：左 = 温度 0–100（刻度 0 / 50 / 100），右 = 比例 %（由数据定域）；
 * · 水平线只有两种来源：阈值线（虚线）与柱图零轴（实线）—— **没有网格线**（模型里就没有这一档角色）；
 * · 柱色来自模型（正 = `--tw-up`、负 = `--tw-down`），此处不碰颜色语义；
 * · 没有鼠标事件 ⇒ 没有浮框、没有十字光标（用户口径：删掉）。
 */
function LeveragePlot(props: { payload: LeveragePayloadDto | null }): React.ReactElement {
  const box = useRef<HTMLDivElement | null>(null)
  const size = useChartBox(box)
  const chart: LeverageChart = useMemo(() => leverageChart(props.payload, size.w, size.h), [props.payload, size.w, size.h])
  return React.createElement(
    'div',
    {
      'data-role': 'leverage-plot',
      ref: box,
      className: 'tw-tool-plot',
      // 高度契约与详情页同一条（`clamp(280px, 26vh, 380px)`）：有下限，不许塌陷
      style: { position: 'relative', width: '100%', height: PLOT.heightCss },
    },
    React.createElement(
      'svg',
      {
        'data-role': 'leverage-svg',
        width: chart.width,
        height: chart.height,
        viewBox: `0 0 ${chart.width} ${chart.height}`,
        style: { display: 'block', width: '100%', height: '100%' },
        role: 'img',
        'aria-label': '杠杆温度计',
      },
      chart.lines.map((line, i) =>
        React.createElement('line', {
          key: `line-${i}`,
          'data-role': line.role === 'threshold' ? 'leverage-threshold' : 'leverage-zero',
          x1: line.x1,
          x2: line.x2,
          y1: line.y1,
          y2: line.y2,
          stroke: line.role === 'zero' ? 'var(--tw-border-strong)' : 'var(--tw-border)',
          strokeWidth: line.role === 'zero' ? 1 : 0.8,
          strokeDasharray: line.dash ? '3 3' : undefined,
        }),
      ),
      chart.bars.map((bar, i) =>
        React.createElement('rect', {
          key: `bar-${i}`,
          'data-role': 'leverage-net-bar',
          x: bar.x,
          y: bar.y,
          width: bar.w,
          height: bar.h,
          fill: bar.color,
        }),
      ),
      chart.paths.map((path) =>
        React.createElement('path', {
          key: `path-${path.role}`,
          'data-role': `leverage-line-${path.role}`,
          d: path.d,
          fill: 'none',
          stroke: path.color,
          strokeWidth: 1.8,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
      ),
      chart.texts.map((text, i) =>
        React.createElement(
          'text',
          {
            key: `text-${i}`,
            'data-role': `leverage-${text.role}`,
            x: text.x,
            y: text.y,
            fontSize: 12,
            fill: 'var(--tw-muted)',
            textAnchor: text.anchor,
          },
          text.text,
        ),
      ),
    ),
  )
}

/* ────────────────────────────── 图例 / 窗口控件 ────────────────────────────── */

/** 图例（**居中**、圆点；名称与颜色来自模型，画出来的线取同一份颜色） */
function legendRow(): React.ReactElement {
  return React.createElement(
    'div',
    { 'data-role': 'leverage-legend', style: LEGEND_ROW },
    LEVERAGE_LEGEND.map((item) =>
      React.createElement(
        'span',
        { key: item.name, style: { display: 'inline-flex', alignItems: 'center', gap: 6, ...CHART_TYPE.legend } },
        React.createElement('span', { 'data-role': 'leverage-legend-dot', style: { ...LEGEND_DOT, background: item.color } }),
        item.name,
      ),
    ),
  )
}

/**
 * 窗口三档（`1 年 / 3 年 / 全历史`）：凹陷容器 + 选中档浅底圆角块（与详情页同一批令牌）。
 * 点击只改 `range` ⇒ 只换同一个接口的查询参数（不新增接口、不做本地切片）。
 */
function rangeSwitch(range: LeverageRange, onPick: (next: LeverageRange) => void): React.ReactElement {
  return React.createElement(
    'div',
    { 'data-role': 'leverage-range', className: 'tw-tool-range', role: 'group', 'aria-label': '窗口', style: RANGE_BOX },
    LEVERAGE_RANGES.map((option) =>
      React.createElement(
        'button',
        {
          key: option.range,
          type: 'button',
          'data-role': 'leverage-range-option',
          'data-range': option.range,
          'data-on': range === option.range,
          'aria-pressed': range === option.range,
          onClick: () => onPick(option.range),
          style: { ...RANGE_TYPE, ...(range === option.range ? RANGE_ON : RANGE_OFF) },
        },
        option.label,
      ),
    ),
  )
}

/* ────────────────────────────── 详情页 ────────────────────────────── */

/**
 * 详情页本体。`back` 是左上角的回目录控件（由工具箱页注入 ⇒ 回目录按钮仍然只有一份实现）。
 */
export function LeverageDetail(props: { back?: React.ReactNode }): React.ReactElement {
  const [range, setRange] = useState<LeverageRange>(LEVERAGE_DEFAULT_RANGE)
  const [attempt, setAttempt] = useState(0)
  const { payload, error } = useLeverageFetch(range, attempt)
  const cards = leverageCards(payload)
  const asOf = leverageAsOfText(payload)
  const temperature = fmtTemperature(payload?.temperature ?? null)
  const loading = payload === null && error === null

  return React.createElement(
    'div',
    {
      'data-role': 'leverage-detail',
      className: 'tw-tool-detail',
      style: { display: 'flex', flexDirection: 'column', gap: TOOL_SPACE.sectionGap, padding: '12px 16px 24px' },
    },
    props.back ?? null,
    // ── ① Hero：大字温度 + `/ 100` + `截至 …`；右上角窗口三档 ─────────────────────
    React.createElement(
      'div',
      { 'data-role': 'leverage-hero', className: 'tw-tool-hero' },
      React.createElement(
        'div',
        { className: 'tw-tool-hero-main', style: { gap: TOOL_SPACE.heroInnerGap } },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          React.createElement(
            'span',
            { 'data-role': 'leverage-temperature', style: { ...HERO_TYPE.title, fontVariantNumeric: 'tabular-nums' } },
            temperature,
          ),
          React.createElement(
            'span',
            { 'data-role': 'leverage-scale', style: { ...CHART_TYPE.tileValue, fontWeight: 500, color: 'var(--tw-muted)' } },
            '/ 100',
          ),
        ),
        React.createElement('span', { 'data-role': 'leverage-asof', style: CHART_TYPE.asOf }, asOf),
      ),
      rangeSwitch(range, setRange),
    ),
    // ── ② 三张摘要卡（**只有三张**；缺值就是 `—`）────────────────────────────────
    React.createElement(
      'div',
      {
        'data-role': 'leverage-cards',
        style: { display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${CARD_MIN_W}px, 1fr))`, gap: TOOL_SPACE.tileGap },
      },
      cards.map((card) =>
        React.createElement(
          'div',
          { key: card.key, 'data-role': 'leverage-card', className: 'tw-tool-card', style: { ...CARD_SURFACE, display: 'flex', flexDirection: 'column', gap: 6 } },
          React.createElement('div', { 'data-role': 'leverage-card-label', style: SUMMARY_TYPE.label }, card.label),
          React.createElement(
            'div',
            {
              'data-role': 'leverage-card-value',
              style: {
                ...SUMMARY_TYPE.value,
                fontVariantNumeric: 'tabular-nums',
                color: card.value === DASH ? 'var(--tw-muted)' : 'var(--tw-text)',
              },
            },
            card.value,
          ),
        ),
      ),
    ),
    // ── ③ 主图卡：图例在上、画布在下（顺序的唯一来源 = CHART_STACK）────────────────
    React.createElement(
      'div',
      {
        'data-role': 'leverage-chart-card',
        className: 'tw-tool-card',
        style: { ...CARD_SURFACE, display: 'flex', flexDirection: 'column', gap: TOOL_SPACE.cardHeadGap },
      },
      ...CHART_STACK.map((slot) =>
        slot === 'legend'
          ? legendRow()
          : loading
            ? // 骨架也占住同一份高度契约 ⇒ 首屏与加载完成之间没有高度跳变（不闪）
              React.createElement(
                'div',
                { key: 'loading', style: { height: PLOT.heightCss, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
                React.createElement(Skeleton, { lines: 3 }),
              )
            : React.createElement(LeveragePlot, { key: 'plot', payload }),
      ),
      error === null
        ? null
        : React.createElement(
            'div',
            { 'data-role': 'leverage-error', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            React.createElement(ErrorNote, { error }),
            React.createElement(
              Btn,
              { onClick: () => setAttempt((n) => n + 1), 'data-verb': 'leverage-retry', 'aria-label': '重试' },
              '重试',
            ),
          ),
    ),
  )
}
