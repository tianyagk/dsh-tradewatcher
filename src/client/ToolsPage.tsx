/**
 * 工具箱页（主面板里的一个页）：**目录页 + 工具详情页容器**。
 *
 * 布局（用户 v0.81.0 的口径）：
 *   目录页 = 分类标签行（本轮只有「全部」）+ 三列卡片网格；卡片 = 左上角标识 chip / 标题 / 一句话说明，
 *            **整卡可点**（阴影 + 圆角、原生 button）。
 *            ⚠ 已按用户要求删掉的三样（`toolsPage.test.ts` 有"全页不许再出现"的断言）：
 *              页标题与计数那一行（`docs/AUDIT-IMPL43.md` §7）、卡片页脚入口文案、
 *              **页级返回控件**与**搜索框**（v0.81.0：工具页是顶层页签 ⇒ 返回无意义；搜索被判冗余）。
 *   详情页 = 左上角**圆角卡片式回目录按钮**（Material 风格，见 `toolBackButton.ts`）+ **三段式**：
 *           ① Hero：kicker 小标签 + 大标题 + 一段说明，右上角**时间范围分段控件**（90 / 180 / 365 序列日）；
 *           ② 摘要卡 ×2：`资金蛋糕`（五市场合计规模 + 集中度状态词）｜`当前偏好`（份额榜首市场）；
 *           ③ 图表卡：标题 + 右侧 `AS OF <日期>` + **四个 KPI 磁贴**（名称 + 值 + delta）+ 主图
 *              （带图例、右侧纵轴）+ 本地回放滑块；
 *           其后仍是**功能块**：静态饼图 / 市场表（份额 + 变化）/ A股净流入单列 / 边界声明。
 *
 * 数据：由工具自己的 `load()` 取一次（见 `tools/cake.ts` 与 `tools/globalFlowView.ts`），
 * 页面**只渲染** `detailModel()` 的输出 —— 页面里不算份额、不造数、不写第二份占位文案。
 * 时间范围只做**本地切片**（宿主一次构建到最大窗口）⇒ 切档不发请求。
 * 主题：一切都用 `var(--tw-*)`（跟随 DSH 主题）与既有 class（`.tw-panel` / `.tw-tab` / `.tw-hint` / `.tw-empty`），
 * **不硬编码深色**；颜色取 `FLOW_SERIES_COLORS`（全部是主题 token）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  CATEGORY_TABS,
  NOT_FETCHED,
  TOOL_ENTRIES,
  catalogModel,
  detailModel,
  toolById,
  type DetailModel,
  type ToolBarRow,
  type ToolData,
  type ToolPayload,
} from './toolRegistry.ts'
import { CARD_PROPS, CARD_STYLE, CARD_TAG } from './toolCardView.ts'
import {
  BAR,
  CARD_MIN_W,
  CARD_SURFACE,
  CHART_SPLIT,
  CHART_TYPE,
  HERO_TYPE,
  LEGEND_DOT,
  LEGEND_ROW,
  CHART_STACK,
  MOTION_STYLE,
  PIE,
  PLOT,
  RANGE_BOX,
  REPLAY,
  RANGE_OFF,
  RANGE_ON,
  RANGE_TYPE,
  replayCountText,
  SUMMARY_TYPE,
  SWATCH,
  TILE_SURFACE,
  TOOL_SPACE,
  nearestIndex,
  pathStyle,
  pieProblems,
  plotHeightProblems,
  plotX,
} from './toolDetailTheme.ts'
import { FLOW_SERIES_COLORS, hoverRowsOf } from './tools/globalFlowView.ts'
import { EmptyHint } from './ui.tsx'
import {
  BACK_BTN_FOCUS_STYLE,
  BACK_BTN_HOVER_STYLE,
  BACK_BTN_PRESS_STYLE,
  BACK_BTN_PROPS,
  BACK_BTN_STYLE,
  BACK_BTN_TAG,
  BACK_BTN_TITLE,
} from './toolBackButton.ts'

/**
 * 系统「减少动画」偏好（B 组要求 5）：命中 ⇒ 页面把 `data-anim` 置 off，
 * CSS（`styles.ts` 的 `@keyframes`/`[data-anim=off]`/`@media (prefers-reduced-motion)`）随即停掉动效，
 * **图与交互仍然可用**（只是不动画）。与 `.tw-root` 的其它 media query 同源，不引入任何依赖。
 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const on = (e: MediaQueryListEvent): void => setReduced(e.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return reduced
}

/**
 * 绘图区尺寸 = **容器真实像素**（用户 A 组要求：绘图区必须填满卡片、随容器自适应）。
 *
 * 为什么不用固定 viewBox 缩放：固定 viewBox + `preserveAspectRatio` 在容器比例不同时要么留白
 * （`meet`）要么拉伸变形（`none`）—— 用户抱怨的"图比参考版小、图与图例之间有大片空白"正是这个。
 * 这里测量容器盒（ResizeObserver）后**按像素坐标绘制**：线宽/圆点/文字都不缩放，SVG 100% 填满容器。
 * 量不到（未挂载 / 无 ResizeObserver）时退回 `PLOT.fallbackWidth × PLOT.minHeight` 的合理画布
 * ——于是"高度下限"在**任何**情形下都成立（历史事故：只写 `flex:1` ⇒ 塌成 1px）。
 */
function usePlotSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = React.useState<{ w: number; h: number }>({ w: PLOT.fallbackWidth, h: PLOT.fallbackHeight })
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

/** 一次性告警标记：同一会话只提醒一次（不刷屏，也不影响渲染） */
let plotContractWarned = false
let pieContractWarned = false

/** 饼图尺寸契约被破坏时的一次性告警（判据与强制点在 toolDetailTheme.pieProblems + 测试） */
function warnPieContractOnce(problems: readonly string[]): void {
  if (problems.length === 0 || pieContractWarned) return
  pieContractWarned = true
  try {
    console.warn(`[dsh-tradewatcher] 饼图尺寸契约被破坏：${problems.join('；')}`)
  } catch {
    /* console 不可用 */
  }
}

/** 绘图区高度契约被破坏时的一次性告警（判据与强制点在 toolDetailTheme.plotHeightProblems + 测试） */
function warnPlotContractOnce(problems: readonly string[]): void {
  if (problems.length === 0 || plotContractWarned) return
  plotContractWarned = true
  try {
    console.warn(`[dsh-tradewatcher] 绘图区高度契约被破坏：${problems.join('；')}`)
  } catch {
    /* console 不可用 */
  }
}

/** 无数据区的占位框（虚线，跟随主题 token） */
const PLACEHOLDER_BOX: React.CSSProperties = {
  minHeight: 120,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px dashed var(--tw-border-strong)',
  borderRadius: 10,
  background: 'var(--tw-bg2)',
  color: 'var(--tw-muted)',
  fontSize: 12.5,
  padding: '10px 12px',
  textAlign: 'center',
}

const GRID3: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }

/**
 * 工具箱页。**不接任何 props**（v0.81.0：页级返回控件已删 ⇒ `onBack` 与 `toolsNav.ts` 一并删除）。
 */
export function ToolsPage(): React.ReactElement {
  const [category, setCategory] = useState('all')
  /** 打开的工具 id；null = 目录页 */
  const [openId, setOpenId] = useState<string | null>(null)
  /** 工具数据：一次取数（`load()`）+ 本地回放（`at(step, range)`，不发请求） */
  const [payload, setPayload] = useState<ToolPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  /** 曲线窗口档位；null = 用工具声明的默认档（本地切片，不发请求） */
  const [rangeDays, setRangeDays] = useState<number | null>(null)
  /** 回放是否在自动播放（本地步进：只换展示的那一天，不发请求） */
  const [playing, setPlaying] = useState(false)

  /** 系统「减少动画」偏好 ⇒ 详情页所有动效降级（图与交互仍在） */
  const reduced = useReducedMotion()
  const model = useMemo(() => catalogModel(TOOL_ENTRIES, category, CATEGORY_TABS), [category])

  const entry = openId === null ? null : toolById(openId)
  const loader = entry?.load

  useEffect(() => {
    setPayload(null)
    setLoadError(null)
    setStep(0)
    setRangeDays(null)
    setPlaying(false)
    if (loader === undefined) return
    let alive = true
    loader()
      .then((next) => {
        if (alive) setPayload(next)
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      alive = false
    }
  }, [loader])

  // 自动播放：每 REPLAY.tickMs 前进一步，走到最新一步就停下（不循环、不发请求）
  const replayMax = payload === null ? 0 : payload.replayMax
  useEffect(() => {
    if (!playing) return
    if (step >= replayMax) {
      setPlaying(false)
      return
    }
    const timer = window.setTimeout(() => setStep((prev) => Math.min(replayMax, prev + 1)), REPLAY.tickMs)
    return () => window.clearTimeout(timer)
  }, [playing, step, replayMax])

  // 选中档 = 用户选过的档，否则工具声明的默认档
  const selectedRange = rangeDays ?? entry?.ranges?.initial ?? null
  const data: ToolData | null = useMemo(() => {
    if (loader === undefined) return null
    if (loadError !== null) return { status: `${NOT_FETCHED}：${loadError}`, why: loadError }
    if (payload === null) return null
    return payload.at(step, selectedRange ?? undefined)
  }, [loader, loadError, payload, step, selectedRange])

  return React.createElement(
    'div',
    { className: 'tw-tools', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' } },
    entry === null
      ? catalogView(model, { category, setCategory, onOpen: setOpenId })
      : detailView(detailModel(entry, data), () => setOpenId(null), {
          loading: loader !== undefined && data === null && loadError === null,
          step,
          maxStep: payload === null ? 0 : payload.replayMax,
          onStep: setStep,
          onRange: setRangeDays,
          animOff: reduced,
          playing,
          onTogglePlay: () => setPlaying((prev) => !prev),
        }),
  )
}

/** 目录页：分类标签行 + 三列卡片网格（搜索框已按用户要求删除） */
function catalogView(
  model: ReturnType<typeof catalogModel>,
  io: { category: string; setCategory: (v: string) => void; onOpen: (id: string) => void },
): React.ReactElement {
  return React.createElement(
    'div',
    { 'data-role': 'tool-catalog', style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px 12px', minHeight: 0 } },
    // 分类标签行（本轮只有「全部」；工具条目自己的分类字段已落库，标签行下一批再加）
    React.createElement(
      'div',
      { className: 'tw-tabs', style: { border: 'none', background: 'transparent', padding: 0 }, role: 'tablist', 'aria-label': '工具分类' },
      model.categories.map((c) =>
        React.createElement(
          'button',
          { key: c.key, className: 'tw-tab', type: 'button', 'data-on': io.category === c.key, onClick: () => io.setCategory(c.key) },
          c.label,
        ),
      ),
    ),
    // 目录很小时的一句说明（v0.91.1，用户口径）：一页只有 1~2 张卡容易被读成"页面坏了"。
    // 如实说明"会随新增工具变长"——**不是**占位数据，也不新增常驻长文案（一行小字）。
    TOOL_ENTRIES.length <= 2 // 数据源在模块级：目录就是这个数组，渲染处就地判断（不跨组件传局部变量）
      ? React.createElement('div', { className: 'tw-muted', style: { fontSize: 12 }, 'data-role': 'tool-catalog-sparse' },
          `工具箱目前 ${TOOL_ENTRIES.length} 个工具；每接入一个工具，这个目录就会多一张卡（新工具走同一套详情页骨架）。`)
      : null,
    model.empty === null
      ? React.createElement(
          'div',
          { style: GRID3 },
          model.cards.map((card) =>
            // 整卡可点：**原生 button**（键盘可达）+ 阴影/圆角卡片（常量在 toolCardView.ts，断言直接读它）
            // 无障碍名 = 工具名（页脚那行入口文案已按用户要求移除，整卡即入口）
            React.createElement(
              CARD_TAG,
              {
                ...CARD_PROPS,
                key: card.id,
                className: 'tw-panel tw-tool-card',
                title: card.blurb,
                'aria-label': card.title,
                onClick: () => io.onOpen(card.id),
                style: CARD_STYLE,
              },
              React.createElement(
                'span',
                {
                  style: {
                    alignSelf: 'flex-start',
                    fontSize: 12,
                    lineHeight: '16px',
                    padding: '0 6px',
                    borderRadius: 6,
                    border: '1px solid var(--tw-border)',
                    background: 'var(--tw-accent-soft)',
                    color: 'var(--tw-accent)',
                  },
                },
                card.chip,
              ),
              React.createElement('div', { style: { fontWeight: 600, fontSize: 12.5 } }, card.title),
              React.createElement('div', { className: 'tw-hint', style: { margin: 0, flex: 1 } }, card.blurb),
            ),
          ),
        )
      : React.createElement(EmptyHint, null, model.empty),
  )
}

/**
 * 时间范围分段控件（Hero 右上角）：三档可切换，切档只做本地切片。
 *
 * 参考版口径：**凹陷容器**（`--tw-bg2`）+ **选中档 = 浅底圆角块**（`RANGE_ON`，唯一来源在
 * `toolDetailTheme.ts`）；`data-anim` 由系统 reduced-motion 偏好驱动 ⇒ 关掉档位过渡。
 */
function rangeControl(model: DetailModel, io: { onRange: (n: number) => void; animOff: boolean }): React.ReactElement | null {
  if (model.ranges.options.length === 0) return null
  return React.createElement(
    'div',
    {
      className: 'tw-tool-range',
      'data-role': 'tool-range',
      'data-anim': io.animOff ? 'off' : 'on',
      role: 'group',
      'aria-label': '时间范围',
      style: RANGE_BOX,
    },
    model.ranges.options.map((n) =>
      React.createElement(
        'button',
        {
          key: n,
          type: 'button',
          'data-role': 'tool-range-option',
          'data-value': n,
          'data-on': model.ranges.selected === n,
          'aria-pressed': model.ranges.selected === n,
          title: `曲线窗口：最近 ${n} 个序列日（本地切片，不发请求）`,
          onClick: () => io.onRange(n),
          // 选中 = 浅底圆角块；未选中 = 透明底（同一批常量，断言直接读它们）
          style: { ...RANGE_TYPE, ...(model.ranges.selected === n ? RANGE_ON : RANGE_OFF) },
        },
        `${n}日`,
      ),
    ),
  )
}

/**
 * Hero：kicker（**大写、宽字距的纯文字**，不是胶囊）+ **超大标题** + 松行高说明段；右上角范围控件。
 * 三个字号/字重/行高全部来自 `HERO_TYPE`（唯一来源）；版式（左右分栏、折行）由 `.tw-tool-hero` 承担。
 */
function heroView(model: DetailModel, io: { onRange: (n: number) => void; animOff: boolean }): React.ReactElement {
  return React.createElement(
    'div',
    { 'data-role': 'tool-hero', className: 'tw-tool-hero' },
    React.createElement(
      'div',
      { className: 'tw-tool-hero-main', style: { gap: TOOL_SPACE.heroInnerGap } },
      React.createElement('span', { 'data-role': 'tool-hero-kicker', style: HERO_TYPE.kicker }, model.hero.kicker),
      React.createElement('h2', { 'data-role': 'tool-hero-title', style: { margin: 0, ...HERO_TYPE.title } }, model.hero.title),
      React.createElement('div', { 'data-role': 'tool-hero-note', style: HERO_TYPE.note }, model.hero.note),
    ),
    rangeControl(model, io),
  )
}

/**
 * 两张摘要卡：**小号标签在上 → 大号数值在下 → 小号状态词**（参考版层级）。
 *
 * 数值仍一律来自数据（取不到 ⇒ `未取到`，色转次要色）；卡面 = 细边框 + 大圆角 + 无重阴影（`CARD_SURFACE`）。
 */
function summaryCards(model: DetailModel): React.ReactElement | null {
  if (model.summary.length === 0) return null
  return React.createElement(
    'div',
    { 'data-role': 'tool-summary', style: { display: 'grid', gridTemplateColumns: `repeat(${Math.min(2, Math.max(1, model.summary.length))}, minmax(0, 1fr))`, gap: TOOL_SPACE.tileGap } },
    model.summary.map((card) =>
      React.createElement(
        'div',
        { key: card.key, 'data-role': 'tool-summary-card', className: 'tw-tool-card', style: { ...CARD_SURFACE, display: 'flex', flexDirection: 'column', gap: 6 } },
        React.createElement('div', { 'data-role': 'tool-summary-label', style: SUMMARY_TYPE.label }, card.label),
        React.createElement(
          'div',
          {
            'data-role': 'tool-summary-value',
            style: { ...SUMMARY_TYPE.value, color: card.value === NOT_FETCHED ? 'var(--tw-muted)' : 'var(--tw-text)' },
          },
          card.value,
        ),
        card.note === null ? null : React.createElement('div', {
          'data-role': 'tool-summary-note',
          // 事实不丢：常驻行只留短句，完整口径进 title/aria-label（悬停/读屏都能读到）
          ...(card.noteTitle === null || card.noteTitle === undefined ? {} : { title: card.noteTitle, 'aria-label': `${card.label} ${card.value}——${card.noteTitle}` }),
          style: SUMMARY_TYPE.note,
        }, card.note),
      ),
    ),
  )
}


/**
 * 详情页左上角的**回目录按钮**（圆角卡片按钮，Material 风格）。
 *
 * 三态反馈都用**内联样式**实现（悬停 → 抬升一级的阴影；按下 → 下沉 1px + 强调色底的等效涟漪；
 * focus → 2px 可见环）：不引入动画库、也不新增全局 CSS，因此不受紧凑/隐身视图影响。
 * 外观与判据的唯一来源是 `toolBackButton.ts`（断言直接读那份常量）。
 */
function BackToCatalog(props: { onClick: () => void; label: string }): React.ReactElement {
  const [hover, setHover] = React.useState(false)
  const [press, setPress] = React.useState(false)
  const [focus, setFocus] = React.useState(false)
  return React.createElement(
    BACK_BTN_TAG,
    {
      ...BACK_BTN_PROPS,
      'data-role': 'tool-back',
      title: BACK_BTN_TITLE,
      'aria-label': BACK_BTN_TITLE,
      onClick: props.onClick,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => {
        setHover(false)
        setPress(false)
      },
      onMouseDown: () => setPress(true),
      onMouseUp: () => setPress(false),
      onFocus: () => setFocus(true),
      onBlur: () => setFocus(false),
      style: {
        ...BACK_BTN_STYLE,
        ...(hover ? BACK_BTN_HOVER_STYLE : null),
        ...(press ? BACK_BTN_PRESS_STYLE : null),
        ...(focus ? BACK_BTN_FOCUS_STYLE : null),
      },
    },
    // 图标（内联 SVG，跟主题 currentColor）
    React.createElement(
      'svg',
      { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false, style: { display: 'block', flexShrink: 0 } },
      React.createElement('path', { key: 'grid', d: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9' }),
    ),
    React.createElement('span', { style: { whiteSpace: 'nowrap' } }, props.label),
  )
}

/**
 * 回放控件（右列底部，用户口径）：**播放/暂停按钮 + 滑块 + `N/30` 计数**（+ 当前显示日）。
 *
 * 播放是**本地步进**（每 `REPLAY.tickMs` 前进一步，走到最新一步停下），不发任何请求；
 * 拖动滑块时折线由 `pathStyle` 平滑跟随。计数文本由 `replayCountText` 统一生成（唯一来源）。
 */
function replayEl(model: DetailModel, io: { step: number; maxStep: number; onStep: (n: number) => void; playing: boolean; onTogglePlay: () => void }): React.ReactElement {
  return React.createElement(
    'div',
    { 'data-role': 'tool-replay', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      React.createElement(
        'button',
        {
          'data-role': 'tool-replay-toggle',
          type: 'button',
          'aria-label': io.playing ? '暂停回放' : '播放回放',
          title: io.playing ? '暂停回放（本地切换，不发请求）' : '播放最近三十个交易日（本地切换，不发请求）',
          onClick: io.onTogglePlay,
          style: {
            flexShrink: 0,
            width: 26,
            height: 26,
            borderRadius: 8,
            border: '1px solid var(--tw-border-strong)',
            background: 'var(--tw-card)',
            color: 'var(--tw-text)',
            fontSize: 12,
            lineHeight: '24px',
            cursor: 'pointer',
          },
        },
        io.playing ? '⏸' : '▶',
      ),
      React.createElement('span', { 'data-role': 'tool-replay-count', style: { fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--tw-muted)' } }, replayCountText(io.step, io.maxStep)),
      React.createElement(
        'span',
        { style: { fontSize: 12.5, fontVariantNumeric: 'tabular-nums', marginLeft: 'auto' } },
        model.replay?.days[Math.min(io.step, (model.replay?.days.length ?? 1) - 1)] ?? '—',
      ),
    ),
    React.createElement('input', {
      type: 'range',
      min: 0,
      max: Math.max(0, io.maxStep),
      step: 1,
      value: Math.min(io.step, Math.max(0, io.maxStep)),
      'aria-label': '回放最近三十个交易日',
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => io.onStep(Number(e.target.value)),
      style: { width: '100%' },
    }),
  )
}

/** 详情页：三段式（Hero → 摘要卡 → 图表卡）+ 市场表 / 附加块 / 边界声明 */
function detailView(
  model: DetailModel,
  backToCatalog: () => void,
  io: {
    loading: boolean
    step: number
    maxStep: number
    onStep: (n: number) => void
    onRange: (n: number) => void
    animOff: boolean
    playing: boolean
    onTogglePlay: () => void
  },
): React.ReactElement {
  const hasCurve = model.curve.series.length > 0 && model.curve.days.length > 0
  const hasPie = model.pie.slices.length > 0
  const hasRows = model.market.rows.length > 0
  return React.createElement(
    'div',
    // 纵向节奏（参考版：区块间距大、内边距 16–20）—— 数字只在 TOOL_SPACE 里写一次
    { 'data-role': 'tool-detail', className: 'tw-tool-detail', style: { display: 'flex', flexDirection: 'column', gap: TOOL_SPACE.sectionGap, padding: '12px 16px 24px' } },
    React.createElement(BackToCatalog, { onClick: backToCatalog, label: model.backAction }),
    // ── ① Hero（右上角时间范围）② 摘要卡 ────────────────────────────────────────
    heroView(model, io),
    summaryCards(model),
    // ── ③ 图表卡：卡内标题 + AS OF + 四个 KPI 磁贴（含色标）+ 主图（图例在上、悬停十字线） ──
    React.createElement(
      'div',
      { className: 'tw-tool-card', 'data-role': 'tool-chart-card', style: { ...CARD_SURFACE, display: 'flex', flexDirection: 'column', gap: TOOL_SPACE.cardHeadGap } },
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
        // 卡内标题（16–18px 粗）：口径行降噪进 title/aria-label（B 档：事实仍可读）
        React.createElement(
          'span',
          { 'data-role': 'tool-chart-title', style: CHART_TYPE.cardTitle, title: `${model.curve.title}｜${model.kpi.note}`, 'aria-label': `${model.curve.title}：${model.kpi.note}` },
          model.curve.title,
        ),
        // 常驻状态行（A 档：数据时刻 + 降级/陈旧标记必须默认可见；完整口径进 title）
        React.createElement(
          'span',
          {
            'data-role': 'tool-status',
            title: model.statusTitle,
            'aria-label': model.statusTitle,
            style: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--tw-muted)', flex: 1, minWidth: 0 },
          },
          io.loading ? '正在取数…' : model.status,
        ),
        model.chartAsOf === null
          ? null
          : React.createElement('span', { 'data-role': 'tool-chart-asof', style: { ...CHART_TYPE.asOf, whiteSpace: 'nowrap' } }, `AS OF ${model.chartAsOf}`),
      ),
      // 四个 KPI 磁贴：色标 + 小号标签 +（右端）较上日 ±x + 大号数值；值/名称/delta 全部来自模型
      React.createElement(
        'div',
        { 'data-role': 'tool-kpi-tiles', className: 'tw-tool-tiles', style: { gap: TOOL_SPACE.tileGap } },
        model.kpi.cells.map((cell) =>
          React.createElement(
            'div',
            {
              key: cell.label,
              'data-role': 'tool-kpi-tile',
              // 来源与口径（用户口径 v0.86.0）：进 title/aria-label，悬停/读屏都能读到；缺数据时不出现
              ...(cell.source === null ? {} : { title: cell.source, 'aria-label': `${cell.label} ${cell.text}${cell.delta === null ? '' : `，${cell.delta}`}——${cell.source}` }),
              style: { ...TILE_SURFACE, display: 'flex', flexDirection: 'column' },
            },
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
              // 色标方块：与曲线/图例同色（序列序号来自模型）；不对应任何序列 ⇒ 中性色标
              React.createElement('span', {
                'data-role': 'tool-kpi-swatch',
                'data-swatch': cell.swatch === null ? 'none' : String(cell.swatch),
                style: { ...SWATCH, background: cell.swatch === null ? 'var(--tw-muted)' : FLOW_SERIES_COLORS[cell.swatch % FLOW_SERIES_COLORS.length] },
              }),
              React.createElement('span', { style: { ...CHART_TYPE.tileLabel, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, cell.label),
              cell.delta === null
                ? null
                : React.createElement('span', { 'data-role': 'tool-kpi-delta', style: { ...CHART_TYPE.tileDelta, marginLeft: 'auto', textAlign: 'right', whiteSpace: 'nowrap' } }, cell.delta),
            ),
            React.createElement(
              'div',
              { 'data-role': 'tool-kpi-value', style: { ...CHART_TYPE.tileValue, marginTop: 6, color: cell.value === null ? 'var(--tw-muted)' : 'var(--tw-text)', wordBreak: 'break-word' } },
              cell.text,
            ),
          ),
        ),
      ),
      // ③ 两列（参考版口径）：左 = 折线图；右 = 饼图 + 回放滑块。窄屏由 `.tw-tool-split` 的媒体查询回落为上下堆叠。
      //    顺序的唯一来源 = CHART_SPLIT（判据 toolDetailTheme.chartSplitProblems：折线在左、饼在右）
      React.createElement(
        'div',
        { 'data-role': 'tool-split', className: 'tw-tool-split', style: { gap: TOOL_SPACE.cardHeadGap } },
        ...CHART_SPLIT.map((slot) =>
          slot === 'plot'
            ? React.createElement(
                'div',
                { key: 'plot', 'data-role': 'tool-split-left', style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } },
                hasCurve
                  ? React.createElement(curveChart, { days: model.curve.days, series: model.curve.series, marks: model.curve.marks, animOff: io.animOff })
                  : React.createElement('div', { style: PLACEHOLDER_BOX }, model.curve.empty),
              )
            : React.createElement(
                'div',
                { key: 'pie', 'data-role': 'tool-split-right', style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, alignItems: 'stretch' } },
                sectionHead(model.pie.title, model.pie.note),
                hasPie
                  ? React.createElement(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 } },
                      // 实心饼：日期不再挖孔放中心，改为饼**上方**的小字（信息不丢、不吃直径）
                      model.pie.center === null
                        ? null
                        : React.createElement('div', { 'data-role': 'tool-pie-day', style: { fontSize: 12.5, color: 'var(--tw-muted)', fontVariantNumeric: 'tabular-nums' } }, model.pie.center),
                      React.createElement(pieChart, { slices: model.pie.slices, center: model.pie.center }),
                      // 图例在饼**下方**、居中；色标与折线图同一套（FLOW_SERIES_COLORS + LEGEND_DOT）
                      React.createElement(
                        'div',
                        { 'data-role': 'tool-pie-legend', className: 'tw-tool-pie-legend' },
                        model.pie.slices.map((slice) =>
                          React.createElement(
                            'span',
                            { key: slice.label, style: { display: 'inline-flex', alignItems: 'center', gap: 4, ...CHART_TYPE.legend } },
                            React.createElement('span', { style: { ...LEGEND_DOT, width: 7, height: 7, background: FLOW_SERIES_COLORS[(slice.index ?? 0) % FLOW_SERIES_COLORS.length] } }),
                            slice.label,
                            React.createElement('span', { style: { color: 'var(--tw-muted)', fontVariantNumeric: 'tabular-nums' } }, slice.text),
                          ),
                        ),
                      ),
                    )
                  : React.createElement('div', { style: PLACEHOLDER_BOX }, model.pie.empty),
                model.pie.slices.length === 0 || model.pie.slices.length === model.market.rows.length
                  ? null
                  : React.createElement(
                      'div',
                      // ⚠ A 档事实（缺数据的出口）：**不用 `tw-hint`**（紧凑/隐身档会隐藏）⇒ 内联样式常驻可见
                      { 'data-role': 'tool-pie-missing', style: { margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--tw-muted)' } },
                      `${NOT_FETCHED} 的市场未进饼图（原因见下表逐行说明）`,
                    ),
                // 回放滑块（本地切换：只换展示的那一天，不发请求）；线条平滑跟随见 curveChart 的 MOTION_STYLE
                model.replay === null ? null : replayEl(model, { step: io.step, maxStep: io.maxStep, onStep: io.onStep, playing: io.playing, onTogglePlay: io.onTogglePlay }),
              ),
        ),
      ),
    ),
    React.createElement(
      'div',
      { className: 'tw-tool-card', style: CARD_SURFACE },
      sectionHead(model.market.title, model.market.note, model.market.subtitle),
      // 主视图 = 五行**横条**（用户口径）；载荷没给 bars 时回退到表格（诚实信息一处不少）
      model.market.bars.length > 0
        ? React.createElement('div', { 'data-role': 'tool-flow-bars', style: { display: 'flex', flexDirection: 'column', gap: BAR.rowGap } }, model.market.bars.map(barRow))
        : React.createElement(
        'table',
        { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 } },
        React.createElement(
          'thead',
          null,
          React.createElement(
            'tr',
            null,
            model.market.columns.map((col) => React.createElement('th', { key: col, style: { textAlign: 'left', padding: '4px 6px', color: 'var(--tw-muted)', fontWeight: 500 } }, col)),
          ),
        ),
        React.createElement(
          'tbody',
          null,
          hasRows
            ? model.market.rows.flatMap((row, i) => {
                const cells = React.createElement(
                  'tr',
                  { key: `${i}-row`, className: 'tw-rowhover' },
                  row.map((text, j) =>
                    React.createElement(
                      'td',
                      { key: `${i}-${j}`, style: { padding: '4px 6px', color: text === NOT_FETCHED ? 'var(--tw-muted)' : 'var(--tw-text)', whiteSpace: 'nowrap' } },
                      text,
                    ),
                  ),
                )
                const note = model.market.rowNotes[i]
                if (note === null || note === undefined) return [cells]
                return [
                  cells,
                  React.createElement(
                    'tr',
                    { key: `${i}-note` },
                    // ⚠ 逐行缺口原因**不用 `tw-hint`**：红线是"缺数据必须给原因"，
                    // 而紧凑/隐身档会隐藏 `.tw-hint` ⇒ 那一行只剩「未取到」没有原因（AUDIT-IMPL46 §2）。
                    // 只有缺数据的行才有这行说明，正常情形零成本。
                    React.createElement(
                      'td',
                      { 'data-role': 'tool-row-note', colSpan: Math.max(1, model.market.columns.length), style: { padding: '0 6px 6px', color: 'var(--tw-muted)', fontSize: 12, lineHeight: 1.5 } },
                      `${NOT_FETCHED}：${note}`,
                    ),
                  ),
                ]
              })
            : React.createElement(
                'tr',
                null,
                React.createElement(
                  'td',
                  { colSpan: Math.max(1, model.market.columns.length), style: { padding: '8px 6px', color: 'var(--tw-muted)' } },
                  model.market.empty,
                ),
              ),
        ),
      ),
      // 段末**一行结论**（用户口径：`→ 近5日资金偏好显示：…`；KPI 磁贴仍保留简短版）
      model.conclusion === null
        ? null
        : React.createElement(
            'div',
            { 'data-role': 'tool-conclusion', style: { marginTop: 10, fontSize: 12.5, lineHeight: 1.6, color: 'var(--tw-text)' } },
            model.conclusion,
          ),
      model.market.footnotes.length === 0
        ? null
        : React.createElement(
            'div',
            // ⚠ 第一行是**分母口径**（份额合计 = …）⇒ A 档常驻可见、不用 `tw-hint`；
            // 其余（动量列口径、回放不下发动量…）属 B 档：进 title/aria-label，事实仍可读。
            {
              'data-role': 'tool-market-total',
              title: model.market.footnotes.join('｜'),
              'aria-label': model.market.footnotes.join('；'),
              style: { marginTop: 8, fontSize: 12.5, lineHeight: 1.55, color: 'var(--tw-muted)' },
            },
            model.market.footnotes[0],
          ),
    ),
    // 附加块（A股净流入：单列，不参与份额计算）
    model.extras.map((extra) =>
      React.createElement(
        'div',
        { className: 'tw-tool-card', key: extra.title, style: CARD_SURFACE },
        sectionHead(extra.title, model.boundary.note),
        React.createElement('div', { style: { fontSize: 12.5, lineHeight: 1.6 } }, extra.text),
      ),
    ),
    // 底部**两段散文**（用户口径）：方法一段、边界一段。
    // ⚠ `proseSection` 用内联样式、**不复用 `tw-hint`** ⇒ 紧凑/隐身档下两段都默认可见（红线）。
    React.createElement(
      'div',
      { className: 'tw-tool-card', style: { ...CARD_SURFACE, display: 'flex', flexDirection: 'column', gap: TOOL_SPACE.cardHeadGap } },
      proseSection(model.method.title, model.method.lines, 'tool-method', 'tool-method-line'),
      proseSection(model.boundary.title, model.boundary.lines, 'tool-legal', 'tool-legal-line'),
    ),
  )
}

/**
 * 一行市场**横条**（用户口径）：市场名 +（当前最多的徽标）→ 当前相对份额 → 长条 → 右端「近5日 升温/降温」。
 *
 * 诚实信息（规模 / 偏好分 / 动量 / 横截面排名）在条下方的小字里（同时进 `title`/`aria-label`，悬停可读）；
 * 缺数据的行仍有 `未取到 + 原因`（**不用 `tw-hint`**：紧凑/隐身档会隐藏）。
 */
function barRow(bar: ToolBarRow): React.ReactElement {
  const deltaColor = bar.deltaKind === 'warm' ? BAR.warm : bar.deltaKind === 'cool' ? BAR.cool : BAR.flat
  return React.createElement(
    'div',
    { key: bar.name, 'data-role': 'tool-flow-bar', 'data-top': bar.top ? '1' : '0', style: { display: 'flex', flexDirection: 'column', gap: BAR.headGap, minWidth: 0 } },
    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
      React.createElement('span', { style: { fontWeight: 600, fontSize: 13 } }, bar.name),
      bar.top
        ? React.createElement(
            'span',
            {
              'data-role': 'tool-bar-badge',
              style: { flexShrink: 0, fontSize: 12, lineHeight: '16px', padding: '0 6px', borderRadius: 6, border: '1px solid var(--tw-border)', background: 'var(--tw-accent-soft)', color: 'var(--tw-accent)' },
            },
            '当前最多',
          )
        : null,
      React.createElement('span', { style: { marginLeft: 'auto', fontSize: 12.5, color: 'var(--tw-muted)', whiteSpace: 'nowrap' } }, `当前相对份额 ${bar.shareText}`),
    ),
    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: BAR.barGap, minWidth: 0 } },
      React.createElement(
        'div',
        { 'data-role': 'tool-bar-track', style: { flex: 1, minWidth: 0, height: BAR.trackHeight, borderRadius: BAR.radius, background: BAR.track, overflow: 'hidden' } },
        bar.sharePct === null
          ? null
          : React.createElement('div', {
              'data-role': 'tool-bar-fill',
              style: { width: `${Math.max(0, Math.min(100, bar.sharePct))}%`, height: '100%', borderRadius: BAR.radius, background: BAR.fill },
            }),
      ),
      React.createElement('span', { 'data-role': 'tool-bar-delta', style: { flexShrink: 0, fontSize: 12.5, color: deltaColor, whiteSpace: 'nowrap' } }, `近5日 ${bar.deltaText}`),
    ),
    React.createElement(
      'div',
      { 'data-role': 'tool-bar-detail', title: bar.detail, 'aria-label': bar.detail, style: { fontSize: 12, lineHeight: 1.5, color: 'var(--tw-muted)' } },
      bar.detail,
    ),
    bar.note === null
      ? null
      : React.createElement('div', { 'data-role': 'tool-row-note', style: { fontSize: 12, lineHeight: 1.5, color: 'var(--tw-muted)' } }, `${NOT_FETCHED}：${bar.note}`),
  )
}

/**
 * **散文段**（用户口径：底部两段散文 `当前偏好怎么判断` / `这份数据的边界`）。
 *
 * ⚠ 事实一条不许少：每段把该组的句子**逐句**渲染（不是摘要），且**不用 `tw-hint`**
 * （那个类在紧凑/隐身档 `display:none`，会把免责与口径整块藏掉）。
 */
function proseSection(title: string, lines: readonly string[], role: 'tool-method' | 'tool-legal', lineRole: 'tool-method-line' | 'tool-legal-line'): React.ReactElement {
  return React.createElement(
    'section',
    { 'data-role': role, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    React.createElement('h3', { 'data-role': `${role}-title`, style: { margin: 0, ...CHART_TYPE.cardTitle } }, title),
    // 逐句渲染成一段连续散文（句号/分号分隔），每句都带 data-role ⇒ 断言可以核对"一条都没删"
    React.createElement(
      'p',
      { 'data-role': lineRole, style: { margin: 0, fontSize: 12.5, lineHeight: 1.8, color: 'var(--tw-muted)' } },
      lines.map((line, i) => React.createElement('span', { key: i, style: { marginRight: 2 } }, line)),
    ),
  )
}

/**
 * 区块标题行。**降噪（B 档）**：口径行不再常驻占版面，改为标题的 `title` + `aria-label`
 * ——悬停/读屏仍能读到完整口径，事实一个字都不少；而"缺数据的原因"另有常驻出口：
 * 空态框（`未取到：原因`）、逐行缺口原因、饼图缺块说明、状态行，都保持默认可见（A 档）。
 *
 * 反例（测试里会注入）：把 note 直接当可见文本渲染回来 ⇒ 判据非空。
 */
function sectionHead(title: string, note: string, subtitle: string | null = null): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'tw-panel-h', style: { paddingBottom: TOOL_SPACE.cardHeadGap, flexDirection: 'column', alignItems: 'flex-start', gap: 4 } },
    React.createElement('span', { className: 't', 'data-role': 'tool-section-title', title: note, 'aria-label': `${title}：${note}`, style: { ...CHART_TYPE.cardTitle, flex: 'none', whiteSpace: 'normal' } }, title),
    subtitle === null
      ? null
      : React.createElement(
          'span',
          { 'data-role': 'tool-section-subtitle', style: { margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--tw-muted)' } },
          subtitle,
        ),
  )
}

/**
 * 份额曲线（页面内联 SVG）。
 *
 * A 组（**有界高度**）：绘图区高度 = `PLOT.heightCss`（`clamp(280px, 26vh, 380px)`：既有下限、又有上限），
 *   并用 ResizeObserver 量到的**真实像素**当 viewBox ⇒ 线宽/圆点/文字都不缩放、SVG 100% 填满容器，
 *   **图例紧贴在画布上方**（不再有"图与图例之间的大片空白"）。
 * B 组（动效，全部 CSS/SVG，无依赖）：
 *   · 悬停十字线 + 提示框：竖线 + 每条序列一个焦点圆点；提示框逐行列出五个市场，**缺值写「未取到」绝不写 0**；
 *   · 切档（90/180/365）：按窗口长度重新挂载绘图组 ⇒ 走 `MOTION_STYLE.fadeIn`（200ms 淡入）；
 *   · 回放拖动：**不改 key**（节点不重建、不闪），靠 `transition: d/cx/cy`（`pathStyle`）平滑跟随；
 *   · 尊重 reduced-motion：`animOff` ⇒ 容器 `data-anim="off"`，CSS 把动画/过渡全停（图与交互仍可用）。
 *
 * 缺的点仍然**画断**（不插值、不补 0）：某个市场某天没有值就断开，绝不连成假线。
 */
function curveChart(props: { days: string[]; series: Array<{ name: string; points: Array<number | null> }>; marks: Array<{ index: number; label: string }>; animOff: boolean }): React.ReactElement {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const size = usePlotSize(boxRef)
  const [hover, setHover] = useState<number | null>(null)
  const W = size.w
  const H = size.h
  /**
   * 绘图区尺寸契约：宽度 100%（由两列布局决定），高度 = `PLOT.heightCss`（有界 clamp）。
   * ⚠ 高度**不再**由 `aspect-ratio` 承担 —— 整卡宽度会把它算成几百像素高（上一版的病根）。
   */
  const boxStyle: React.CSSProperties = { position: 'relative', width: '100%', height: PLOT.heightCss }
  // 自检：高度契约缺一不可（min-height + 高度来源）。
  // ⚠ 这里**只告警、不抛错**：判据的强制点在测试（注入必败），展示层配置写坏不该把整块面板打崩。
  warnPlotContractOnce(plotHeightProblems(boxStyle))
  const values: number[] = []
  for (const s of props.series) for (const v of s.points) if (v !== null && Number.isFinite(v)) values.push(v)
  const legend = React.createElement(
    'div',
    { 'data-role': 'tool-chart-legend', style: LEGEND_ROW },
    props.series.map((s, i) =>
      React.createElement(
        'span',
        { key: s.name, style: { display: 'inline-flex', alignItems: 'center', gap: 6, ...CHART_TYPE.legend } },
        React.createElement('span', { 'data-role': 'tool-legend-dot', style: { ...LEGEND_DOT, background: FLOW_SERIES_COLORS[i % FLOW_SERIES_COLORS.length] } }),
        s.name,
      ),
    ),
  )
  const marksNote = props.marks.length === 0
    ? null
    : React.createElement(
        'div',
        {
          'data-role': 'tool-marks-note',
          // A 档事实（实测日 / 重建日的区分）：内联样式常驻可见，不用会被紧凑/隐身档隐藏的 class
          style: { fontSize: 12.5, lineHeight: 1.55, color: 'var(--tw-muted)' },
        },
        `曲线上的圆点 = 实测日（${props.marks.map((m) => m.label.replace(' 实测', '')).slice(-3).join('、')}）；其余为重建日`,
      )
  if (values.length === 0) {
    const emptyPlot = React.createElement(
      'div',
      { 'data-role': 'tool-plot', 'data-anim': props.animOff ? 'off' : 'on', ref: boxRef, className: 'tw-tool-plot', style: boxStyle },
      React.createElement('div', { style: PLACEHOLDER_BOX }, `${NOT_FETCHED}：曲线里没有任何可用份额`),
    )
    return React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      // 渲染顺序的唯一来源：CHART_STACK（图例在上、画布在下）
      ...CHART_STACK.map((slot) => (slot === 'legend' ? legend : emptyPlot)),
      marksNote,
    )
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min < 0.05 ? 0.05 : max - min
  const x = (i: number): number => plotX(i, props.days.length, W)
  const y = (v: number): number => PLOT.pad.top + (1 - (v - min) / span) * (H - PLOT.pad.top - PLOT.pad.bottom)
  const paths: React.ReactElement[] = []
  props.series.forEach((s, si) => {
    let d = ''
    let open = false
    s.points.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        open = false
        return
      }
      d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `
      open = true
    })
    if (d !== '') {
      paths.push(
        React.createElement('path', {
          // key 只跟序列序号有关（**不含回放步**）⇒ 拖动滑块时节点不重建、不闪
          key: `line-${si}`,
          d: d.trim(),
          // 同时交给 CSS（支持 CSS `d` 的浏览器据此做 transition ⇒ 回放平滑跟随；不支持则忽略）
          style: pathStyle(d.trim()),
          fill: 'none',
          stroke: FLOW_SERIES_COLORS[si % FLOW_SERIES_COLORS.length],
          strokeWidth: 1.8,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
      )
    }
  })
  const yTicks = [min, min + span / 2, max]
  const hoverRows = hoverRowsOf(props.series, hover)
  const hoverX = hover === null ? null : x(hover)
  const tipLeft = hoverX === null ? 0 : Math.min(Math.max(6, hoverX - 70), Math.max(6, W - 210))
  const plotEl = React.createElement(
      'div',
      {
        'data-role': 'tool-plot',
        'data-anim': props.animOff ? 'off' : 'on',
        ref: boxRef,
        className: 'tw-tool-plot',
        style: boxStyle,
        onMouseMove: (e: React.MouseEvent<HTMLDivElement>) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setHover(nearestIndex(e.clientX - rect.left, props.days.length, Math.max(1, rect.width)))
        },
        onMouseLeave: () => setHover(null),
      },
      React.createElement(
        'svg',
        {
          width: W,
          height: H,
          viewBox: `0 0 ${W} ${H}`,
          style: { display: 'block', width: '100%', height: '100%' },
          role: 'img',
          'aria-label': `份额曲线（${props.days[0]} 至 ${props.days[props.days.length - 1]}，共 ${props.days.length} 个序列日）`,
        },
        // 纵轴在右侧：刻度线从左侧画到右轴，标签贴右边
        yTicks.map((t, i) =>
          React.createElement(
            'g',
            { key: `tick-${i}` },
            React.createElement('line', { x1: PLOT.pad.left, x2: W - PLOT.pad.right, y1: y(t), y2: y(t), stroke: 'var(--tw-border)', strokeWidth: 0.7, strokeDasharray: i === 1 ? '3 3' : undefined }),
            React.createElement('text', { x: W - PLOT.pad.right + 6, y: y(t) + 3.5, fontSize: 12, fill: 'var(--tw-muted)' }, `${t.toFixed(1)}%`),
          ),
        ),
        // 切档淡入：key 随窗口长度变化 ⇒ 只有换档才重放动画；回放拖动不改 key（不闪）
        React.createElement(
          'g',
          { key: `range-${props.days.length}`, className: 'tw-tool-fade', style: MOTION_STYLE.fadeIn },
          props.marks.map((mk) =>
            React.createElement('circle', {
              key: `mark-${mk.index}`,
              cx: x(mk.index),
              cy: H - PLOT.pad.bottom,
              r: 2.4,
              fill: 'var(--tw-accent)',
              'aria-label': mk.label,
            }),
          ),
          paths,
        ),
        // 悬停十字线 + 每条序列的焦点圆点（值见提示框；缺值的那条没有焦点）
        hoverX === null
          ? null
          : React.createElement('line', {
              'data-role': 'tool-crosshair',
              className: 'tw-tool-cross',
              x1: hoverX,
              x2: hoverX,
              y1: PLOT.pad.top,
              y2: H - PLOT.pad.bottom,
              stroke: 'var(--tw-border-strong)',
              strokeWidth: 1,
              strokeDasharray: '3 3',
            }),
        hover === null
          ? null
          : props.series.map((s, i) => {
              const v = s.points[hover]
              if (v === null || v === undefined || !Number.isFinite(v)) return null
              return React.createElement('circle', {
                key: `focus-${i}`,
                'data-role': 'tool-hover-dot',
                cx: x(hover),
                cy: y(v),
                r: 3,
                fill: FLOW_SERIES_COLORS[i % FLOW_SERIES_COLORS.length],
              })
            }),
        React.createElement('text', { x: PLOT.pad.left, y: H - 6, fontSize: 12, fill: 'var(--tw-muted)' }, props.days[0]),
        React.createElement('text', { x: W - PLOT.pad.right, y: H - 6, fontSize: 12, fill: 'var(--tw-muted)', textAnchor: 'end' }, props.days[props.days.length - 1]),
      ),
      // 悬停提示框（复用既有 `.tw-chart-tip` 观感；**逐序列**列出五个市场的值，缺值 ⇒ 未取到）
      hover === null || hoverRows.length === 0
        ? null
        : React.createElement(
            'div',
            { 'data-role': 'tool-hover-tip', className: 'tw-chart-tip tw-glass', 'data-open': 'true', style: { left: tipLeft, top: 10, minWidth: CARD_MIN_W } },
            React.createElement(
              'div',
              { className: 'tw-chart-tip-row' },
              React.createElement('span', { className: 'tw-chart-tip-k' }, props.days[hover] ?? ''),
            ),
            hoverRows.map((r) =>
              React.createElement(
                'div',
                { key: r.name, className: 'tw-chart-tip-row' },
                React.createElement(
                  'span',
                  { className: 'tw-chart-tip-k', style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                  React.createElement('span', { 'data-role': 'tool-tip-dot', style: { ...LEGEND_DOT, width: 7, height: 7, background: FLOW_SERIES_COLORS[r.swatch % FLOW_SERIES_COLORS.length] } }),
                  r.name,
                ),
                React.createElement('span', { className: `tw-chart-tip-v${r.value === null ? ' tw-muted' : ''}` }, r.text),
              ),
            ),
          ),
    )
  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    // 渲染顺序的唯一来源：CHART_STACK（图例在上、画布在下）—— 判据见 toolDetailTheme.chartStackProblems
    ...CHART_STACK.map((slot) => (slot === 'legend' ? legend : plotEl)),
    marksNote,
  )
}

/**
 * 静态饼图（无动画、无自动播放；缺份额的市场不进饼图，说明由模型给出）。
 *
 * 尺寸（用户第四批）：直径 `clamp(220px, 22vh, 320px)`、**居中**；饼在 100×100 的 viewBox 里作画
 * （半径 = `PIE.radiusRatio × 100`）⇒ 画面直径 = 尺寸契约 × 2 × radiusRatio，落在 [202, 294]。
 * 不随整列宽度拉伸（判据 `pieProblems` 拒 `width: 100%`）。
 */
function pieChart(props: { slices: Array<{ label: string; text: string; value: number | null; index?: number }>; center: string | null }): React.ReactElement {
  const box = { width: PIE.sizeCss, height: PIE.sizeCss }
  warnPieContractOnce(pieProblems(box))
  const SIZE = 100
  const R = PIE.radiusRatio * SIZE
  const CX = SIZE / 2
  const CY = SIZE / 2
  const total = props.slices.reduce((s, x) => s + (x.value ?? 0), 0)
  let angle = -Math.PI / 2
  const arcs: React.ReactElement[] = []
  props.slices.forEach((slice, i) => {
    const value = slice.value ?? 0
    if (!(value > 0) || total <= 0) return
    const sweep = (value / total) * Math.PI * 2
    const a1 = angle
    const a2 = angle + sweep
    angle = a2
    const x1 = CX + R * Math.cos(a1)
    const y1 = CY + R * Math.sin(a1)
    const x2 = CX + R * Math.cos(a2)
    const y2 = CY + R * Math.sin(a2)
    const large = sweep > Math.PI ? 1 : 0
    arcs.push(
      React.createElement('path', {
        key: `arc-${slice.label}`,
        d: `M ${CX} ${CY} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`,
        fill: FLOW_SERIES_COLORS[(slice.index ?? i) % FLOW_SERIES_COLORS.length],
        stroke: 'var(--tw-card)',
        strokeWidth: 0.6,
      }),
    )
  })
  return React.createElement(
    'svg',
    {
      'data-role': 'tool-pie',
      viewBox: `0 0 ${SIZE} ${SIZE}`,
      style: { ...box, display: 'block', margin: '0 auto' },
      role: 'img',
      'aria-label': `份额饼图${props.center === null ? '' : `（${props.center}）`}`,
    },
    arcs,
    // ⚠ **实心饼**（用户口径）：不再挖中心孔、也不在中心写字 —— 选中日改到饼上方的小字
    //（`data-role="tool-pie-day"`，见右列渲染处）。断言会检查这里**没有** tool-pie-center。
  )
}
