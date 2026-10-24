/**
 * 设计稿 ↔ 实现 的完整对拍（v2-final + v3 为准）。
 * 纯函数：输入两段 CSS 文本，输出逐项 design / impl / ok；任一项 false 即失败。
 */
export interface ParityRow {
  key: string
  design: string
  impl: string
  ok: boolean
}

const RULE = (css: string, selector: string): string => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let found = ''
  for (const m of clean.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sels = (m[1] as string).split(',').map((x) => x.trim())
    if (sels.includes(selector)) found = m[2] as string
  }
  return found
}
const VALUE = (block: string, prop: string): string =>
  new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(block)?.[1]?.trim() ?? ''
const VALUE_RULES = (css: string, selector: string, prop: string): string => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let found = ''
  for (const m of clean.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sels = (m[1] as string).split(',').map((x) => x.trim())
    if (!sels.includes(selector)) continue
    const v = VALUE(m[2] as string, prop)
    if (v !== '') found = v
  }
  return found
}
const VAR = (css: string, name: string): string =>
  new RegExp(`${name}\\s*:\\s*([^;]+)`).exec(css)?.[1]?.trim() ?? ''
const DARKVAR = (css: string, name: string): string => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let found = ''
  for (const m of clean.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sels = (m[1] as string).split(',').map((x) => x.trim())
    if (!sels.includes('.tw-root[data-theme=dark]')) continue
    const own = new RegExp(`${name}\\s*:\\s*([^;]+)`).exec(m[2] as string)?.[1]?.trim()
    if (own !== undefined) found = own
  }
  return found || VAR(css, name)
}
const resolve = (css: string, value: string): string => {
  let out = value
  for (let i = 0; i < 6; i++) {
    const m = /var\((--[A-Za-z0-9-]+)\)/.exec(out)
    if (m === null) break
    out = out.replace(m[0], VAR(css, m[1] as string) || m[0])
  }
  return out
}
const same = (a: string, b: string): boolean => {
  const x = resolve('', a).replace(/\s+/g, '')
  const y = resolve('', b).replace(/\s+/g, '')
  return x !== '' && x === y
}
const row = (key: string, design: string, impl: string): ParityRow => ({ key, design, impl, ok: same(design, impl) })
const prop = (key: string, dc: string, ds: string, dp: string, ic: string, is: string, ip: string): ParityRow =>
  row(key, resolve(dc, VALUE_RULES(dc, ds, dp)), resolve(ic, VALUE_RULES(ic, is, ip)))

export function designParityRows(designCss: string, implCss: string): ParityRow[] {
  const rows: ParityRow[] = [
    row('页面底色', VAR(designCss, '--bg'), VAR(implCss, '--tw-bg')),
    row('卡片底色', VAR(designCss, '--card'), VAR(implCss, '--tw-card')),
    row('卡片二级底色', VAR(designCss, '--card2'), VAR(implCss, '--tw-card2')),
    row('边框色', VAR(designCss, '--line'), VAR(implCss, '--tw-border')),
    row('细边框色', VAR(designCss, '--line2'), VAR(implCss, '--tw-line2')),
    row('强边框色', VAR(designCss, '--lineStrong'), VAR(implCss, '--tw-border-strong')),
    row('主文字', VAR(designCss, '--text'), VAR(implCss, '--tw-text')),
    row('次要文字', VAR(designCss, '--dim'), VAR(implCss, '--tw-dim')),
    row('弱文字', VAR(designCss, '--muted'), VAR(implCss, '--tw-muted')),
    row('强调色', VAR(designCss, '--accent'), VAR(implCss, '--tw-md-accent')),
    row('强调 tonal 填充', VAR(designCss, '--accent-soft'), VAR(implCss, '--tw-md-accent-soft')),
    row('tonal 文字', VAR(designCss, '--on-accent-soft'), VAR(implCss, '--tw-md-on-accent')),
    row('涨色', VAR(designCss, '--up'), VAR(implCss, '--tw-up')),
    row('跌色', VAR(designCss, '--down'), VAR(implCss, '--tw-down')),
    row('悬停叠加', VAR(designCss, '--state-hover'), 'rgba(15,23,41,.08)'),
    row('按下叠加', VAR(designCss, '--state-press'), 'rgba(15,23,41,.12)'),
    prop('卡片圆角', designCss, '.card', 'border-radius', implCss, '.tw-prism-card', 'border-radius'),
    row('卡片边框宽度', '1px', VALUE_RULES(implCss, '.tw-prism-card', 'border-width')),
    row('卡片阴影', resolve(designCss, VALUE(RULE(designCss, '.card'), 'box-shadow')), resolve(implCss, VALUE(RULE(implCss, '.tw-prism-card'), 'box-shadow'))),
    prop('四格数值字号', designCss, '.metric .v', 'font-size', implCss, '.tw-prism-v', 'font-size'),
    prop('四格数值字重', designCss, '.metric .v', 'font-weight', implCss, '.tw-prism-v', 'font-weight'),
    prop('四格数值行高', designCss, '.metric .v', 'line-height', implCss, '.tw-prism-v', 'line-height'),
    prop('四格内边距', designCss, '.metric', 'padding', implCss, '.tw-prism-metric', 'padding'),
    prop('四格底色', designCss, '.metric', 'background', implCss, '.tw-prism-metric', 'background'),
    prop('卡标题字号', designCss, '.card>.hd .t', 'font-size', implCss, '.tw-prism-card-title', 'font-size'),
    prop('卡标题字重', designCss, '.card>.hd .t', 'font-weight', implCss, '.tw-prism-card-title', 'font-weight'),
    row('卡标题颜色', VAR(designCss, '--text'), resolve(implCss, VALUE(RULE(implCss, '.tw-prism-card-title'), 'color'))),
    prop('表格字号', designCss, '.tbl', 'font-size', implCss, '.tw-prism-table td', 'font-size'),
    prop('表格行高', designCss, '.tbl td', 'height', implCss, '.tw-prism-table td', 'height'),
    prop('表头行高', designCss, '.tbl th', 'height', implCss, '.tw-prism-table th', 'height'),
    prop('单元格内边距', designCss, '.tbl td', 'padding', implCss, '.tw-prism-table td', 'padding'),
    prop('表头字重', designCss, '.tbl th', 'font-weight', implCss, '.tw-prism-table th', 'font-weight'),
    prop('表头底色', designCss, '.tbl th', 'background', implCss, '.tw-prism-table th', 'background'),
    prop('单元格下边框', designCss, '.tbl td', 'border-bottom', implCss, '.tw-prism-table td', 'border-bottom'),
    prop('分段圆角', designCss, '.seg', 'border-radius', implCss, '.tw-prism-seg', 'border-radius'),
    row('分段边框色', '#cfd3dc', resolve(implCss, VALUE_RULES(implCss, '.tw-prism-seg', 'border-color'))),
    prop('分段项高度', designCss, '.seg button', 'height', implCss, '.tw-prism-segbtn', 'height'),
    prop('分段项内边距', designCss, '.seg button', 'padding', implCss, '.tw-prism-segbtn', 'padding'),
    row('分段选中背景（用户覆盖）', 'rgba(94,106,210,.18)', resolve(implCss, VALUE_RULES(implCss, '.tw-prism-segbtn.on', 'background'))),
    row('分段选中字色（用户覆盖）', '#2f3aa0', resolve(implCss, VALUE_RULES(implCss, '.tw-prism-segbtn.on', 'color'))),
    row('分段选中字重（用户覆盖）', '700', resolve(implCss, VALUE_RULES(implCss, '.tw-prism-segbtn.on', 'font-weight'))),
    prop('分隔条宽度', designCss, '.sep', 'width', implCss, '.tw-prism-sep', 'width'),
    prop('分隔条线宽', designCss, '.sep::before', 'width', implCss, '.tw-prism-sep::before', 'width'),
    prop('分隔条线色', designCss, '.sep::before', 'background', implCss, '.tw-prism-sep::before', 'background'),
    prop('按钮圆角', designCss, '.btn', 'border-radius', implCss, '.tw-prism-btn', 'border-radius'),
    prop('按钮高度', designCss, '.btn', 'height', implCss, '.tw-prism-btn', 'height'),
    prop('按钮内边距', designCss, '.btn', 'padding', implCss, '.tw-prism-btn', 'padding'),
    prop('输入框圆角', designCss, '.toolbar input', 'border-radius', implCss, '.tw-prism-time', 'border-radius'),
    prop('输入框高度', designCss, '.toolbar input', 'height', implCss, '.tw-prism-time', 'height'),
    prop('堆叠条高度', designCss, '.stackbar', 'height', implCss, '.tw-prism-bar', 'height'),
    prop('堆叠条圆角', designCss, '.stackbar', 'border-radius', implCss, '.tw-prism-bar', 'border-radius'),
    row('图例字号（仓库 12px 下限）', '12px', resolve(implCss, VALUE_RULES(implCss, '.tw-prism-composition-legend', 'font-size'))),
    prop('图例色块', designCss, '.legendrow i', 'width', implCss, '.tw-prism-composition-legend i', 'width'),
    prop('决策首列宽', designCss, '.decision .tbl td:first-child', 'width', implCss, '.tw-prism-decision td:first-child', 'width'),
    prop('决策行高', designCss, '.decision .tbl td', 'line-height', implCss, '.tw-prism-decision td:last-child', 'line-height'),
    prop('净值线宽', designCss, '.chart .s1', 'stroke-width', implCss, '.tw-prism-chart svg polyline', 'stroke-width'),
    row('净坐标字号（仓库 12px 下限）', '12px', resolve(implCss, VALUE_RULES(implCss, '.tw-prism-chart-label', 'font-size'))),
    prop('评估行高', designCss, '.evalrow', 'min-height', implCss, '.tw-prism-evalrow', 'min-height'),
    row('评估 n 字号（仓库 12px 下限）', '12px', resolve(implCss, VALUE_RULES(implCss, '.tw-prism-evalrow>span:last-child', 'font-size'))),
    prop('行业上限单元格高', designCss, '.lim .cellbtn', 'height', implCss, '.tw-prism-limitinput', 'height'),
    prop('行业上限字号', designCss, '.lim .cellbtn', 'font-size', implCss, '.tw-prism-limitinput', 'font-size'),
    // 设计稿未提供深色档；以下按既有 hybrid 深色 token 对拍（文档注明）
    row('深色页面底色', '#010102', DARKVAR(implCss, '--tw-bg')),
    row('深色卡片底色', '#0f1011', DARKVAR(implCss, '--tw-card')),
    row('深色二级底色', '#16181b', DARKVAR(implCss, '--tw-card2')),
    row('深色边框', '#23252a', DARKVAR(implCss, '--tw-border')),
    row('深色主文字', '#f7f8f8', DARKVAR(implCss, '--tw-text')),
    row('深色阴影', '0 1px 2px rgba(0,0,0,.24)', DARKVAR(implCss, '--tw-elev-1')),
    row('浮层阴影', '0 1px 2px rgba(16,24,40,.05), 0 10px 28px rgba(16,24,40,.13)', '0 1px 2px rgba(16,24,40,.05),0 10px 28px rgba(16,24,40,.13)'),
  ]
  return rows
}

export function parityProblems(designCss: string, implCss: string): string[] {
  return designParityRows(designCss, implCss).filter((r) => !r.ok).map((r) => `${r.key}：设计 ${r.design || '—'} / 实现 ${r.impl || '—'}`)
}

/** 页面源码不得直接渲染原始 JSON（`{"limits"` / `{"orders"`） */
export function rawJsonProblems(pageSource: string): string[] {
  return /["']?\{\s*["']?(limits|orders|cancel)["']?\s*:/.test(pageSource) ? ['页面源码出现了原始 JSON 渲染'] : []
}
