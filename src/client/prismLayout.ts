/**
 * 棱镜页布局/材质判据（纯函数，页面与测试共用）。
 * 只做几何与 token 约束，不碰数据/引擎。
 */
export const PRISM_SPLIT_DEFAULT = 62
export const PRISM_SPLIT_MIN = 40
export const PRISM_SPLIT_MAX = 75
export const PRISM_SEP_PX = 6

/** 两栏宽度夹在 40%–75%；非法输入回到 62 */
export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return PRISM_SPLIT_DEFAULT
  return Math.min(PRISM_SPLIT_MAX, Math.max(PRISM_SPLIT_MIN, value))
}

/** 拖拽：起始百分比 + 横向位移 / 容器宽度；结果仍夹在 40–75 */
export function splitPctFromDrag(startPct: number, startX: number, clientX: number, containerWidth: number): number {
  if (!(containerWidth > 0)) return clampSplit(startPct)
  return clampSplit(startPct + ((clientX - startX) / containerWidth) * 100)
}

/** 块间距只允许 0 / 8 / 16（只检查 .tw-prism* 规则里的 gap） */
export function spacingProblems(css: string): string[] {
  const bad: string[] = []
  for (const block of css.matchAll(/(\.tw-prism[^{]*)\{([^}]*)\}/g)) {
    const selector = block[1] ?? ''
    if (selector.includes('.tw-prism-seg') || selector.includes('.tw-prism-netseg') || selector.includes('.tw-prism-basis')) continue // 组件内部间距（用户指定 4px/2px），不属于块间距
    const body = block[2] ?? ''
    for (const m of body.matchAll(/(?:^|;)\s*(?:row-|column-)?gap\s*:\s*([^;]+)/g)) {
      const raw = (m[1] ?? '').trim()
      const values = raw.split(/\s+/).map((v) => Number.parseFloat(v))
      for (const v of values) {
        if (!Number.isFinite(v) || v % 8 !== 0) bad.push(`${raw}（必须是 8 的倍数）`)
      }
    }
  }
  return bad
}

/** elevation 三层必须都用上：页面底 0 / 卡片 1 / 分段与浮层 3 */
export function elevationProblems(css: string): string[] {
  const bad: string[] = []
  if (!/\.tw-prism\{[^}]*box-shadow:var\(--tw-elev-0\)/.test(css)) bad.push('页面底缺 elevation 0')
  if (!/\.tw-prism-card\{[^}]*box-shadow:(var\(--tw-prism-card-shadow\)|0 1px 2px rgba\(0,0,0,\.06\),0 1px 3px rgba\(0,0,0,\.04\)|0 1px 2px rgba\(16,24,40,\.05\))/.test(css)) bad.push('卡片缺 elevation 1')
  if (!/\.tw-prism-seg\{[^}]*box-shadow:var\(--tw-elev-3\)/.test(css)) bad.push('分段缺 elevation 3')
  return bad
}

/** 深色模式：用更浅表面色分层，不放大阴影 */
export function darkSurfaceProblems(css: string): string[] {
  const blocks = [...css.matchAll(/\.tw-root\[data-theme=dark\]\{([^}]*)\}/g)].map((m) => m[1] ?? '')
  const dark = blocks.find((b) => b.includes('--tw-prism-surface-1')) ?? blocks[blocks.length - 1]
  if (dark === undefined) return ['缺深色 token 覆盖']
  const bad: string[] = []
  for (const token of ['--tw-prism-surface-1', '--tw-prism-surface-2', '--tw-prism-surface-3']) {
    if (!new RegExp(`${token}:`).test(dark)) bad.push(`深色缺 ${token}`)
  }
  // 深色 elevation 不得比浅色更大（只允许 0 1px/0 2px 级）
  const e1 = /--tw-elev-1:([^;]+)/.exec(dark)?.[1] ?? ''
  if (/0\s+([3-9]|\d{2,})px/.test(e1)) bad.push(`深色 elevation-1 被放大：${e1}`)
  return bad
}

/** MD dataviz 8 系列色：必须 8 个、去重、均为 hex */
export function seriesProblems(series: readonly string[]): string[] {
  const bad: string[] = []
  if (series.length !== 8) bad.push(`系列色必须是 8 个（实际 ${series.length}）`)
  if (new Set(series).size !== series.length) bad.push('系列色有重复')
  for (const c of series) if (!/^#[0-9A-Fa-f]{6}$/.test(c)) bad.push(`非法色值 ${c}`)
  return bad
}

/** 表格行高/字号口径：12px、24–26px */
export function tableRhythmProblems(css: string): string[] {
  const bad: string[] = []
  const block = /\.tw-prism-table th,\.tw-prism-table td\{([^}]*)\}/.exec(css)?.[1] ?? ''
  if (!/font-size:12px/.test(block)) bad.push('表格字号必须是 12px')
  const h = /height:(\d+)px/.exec(block)?.[1]
  if (h === undefined || Number(h) < 24 || Number(h) > 26) bad.push('表格行高必须是 24–26px')
  return bad
}

/** 页面根可滚动 + 两栏 min-height:0（含 <900px 折叠） */
export function scrollProblems(css: string): string[] {
  const bad: string[] = []
  const rule = (selector: string): string => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`${esc}\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
  }
  const root = rule('.tw-prism')
  if (!/overflow-y\s*:\s*auto/.test(root)) bad.push('页面根缺 overflow-y:auto')
  if (/(^|;)\s*overflow\s*:\s*hidden/.test(root)) bad.push('页面根不得 overflow:hidden')
  if (/(^|;)\s*height\s*:\s*\d/.test(root)) bad.push('页面根不得写固定 height')
  const body = rule('.tw-prism-body')
  if (!/min-height\s*:\s*0/.test(body)) bad.push('两栏容器缺 min-height:0')
  const mobile = /@media\s*\(max-width:899px\)\{([^\n]*)/.exec(css)?.[1] ?? ''
  if (!/@media\s*\(max-width:899px\)/.test(css)) bad.push('缺 <900px 折叠媒体查询')
  if (/(^|;)\s*height\s*:\s*\d/.test(mobile)) bad.push('移动端折叠容器不得写固定 height')
  return bad
}


/** 最终生效的卡片阴影（同选择器后写覆盖前写；解析 var） */
export function finalCardShadow(css: string): string {
  const blocks = [...css.matchAll(/\.tw-prism-card\{([^}]*)\}/g)]
  const last = blocks[blocks.length - 1]?.[1] ?? ''
  const raw = /(?:^|;)\s*box-shadow\s*:\s*([^;]+)/.exec(last)?.[1]?.trim() ?? ''
  if (!raw.startsWith('var(')) return raw.replace(/\s+/g, ' ').trim()
  const name = /var\((--[\w-]+)\)/.exec(raw)?.[1] ?? ''
  const value = new RegExp(`${name}\s*:\s*([^;]+)`).exec(css)?.[1]?.trim() ?? ''
  return value.replace(/\s+/g, ' ').trim()
}
