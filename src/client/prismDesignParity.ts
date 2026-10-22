/**
 * 设计稿 ↔ 实现 的数值对拍（纯函数；输入 = 抽取出的 CSS 文本）。
 * 期望值优先取 `docs/mockups/md-hybrid.html`；用户本轮明确覆盖的值（卡片阴影、
 * 卡片内边距、分段内边距、数值字号）单独列出，避免把“设计稿旧值”当成实现错误。
 */
export interface ParityRow {
  key: string
  design: string
  impl: string
  ok: boolean
}

const RULE = (css: string, selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${esc}\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

const VALUE = (block: string, prop: string): string =>
  new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(block)?.[1]?.trim() ?? ''

const VAR = (css: string, name: string): string =>
  new RegExp(`${name}\\s*:\\s*([^;]+)`).exec(css)?.[1]?.trim() ?? ''

const same = (a: string, b: string): boolean =>
  a.replace(/\s+/g, '') !== '' && a.replace(/\s+/g, '') === b.replace(/\s+/g, '')

export function designParityRows(designCss: string, implCss: string): ParityRow[] {
  const designCard = RULE(designCss, '.card')
  const designSeg = RULE(designCss, '.seg')
  const designTd = RULE(designCss, '.tbl td')
  const designSegBtn = RULE(designCss, '.seg button')
  const designSplitter = RULE(designCss, '.splitter')
  const implSegBtn = RULE(implCss, '.tw-prism-segbtn')
  const implCard = RULE(implCss, '.tw-prism-card')
  const implSeg = RULE(implCss, '.tw-prism-seg')
  const implTd = RULE(implCss, '.tw-prism-table th,.tw-prism-table td')
  const implSplitter = RULE(implCss, '.tw-prism-sep')

  const rows: ParityRow[] = [
    { key: '页面底色', design: VAR(designCss, '--s0'), impl: VAR(implCss, '--tw-bg'), ok: same(VAR(designCss, '--s0'), VAR(implCss, '--tw-bg')) },
    { key: '卡片圆角', design: VALUE(designCard, 'border-radius'), impl: VALUE(implCard, 'border-radius'), ok: same(VALUE(designCard, 'border-radius'), VALUE(implCard, 'border-radius')) },
    { key: '卡片阴影 token', design: VAR(designCss, '--elev1'), impl: VAR(implCss, '--tw-elev-1'), ok: same(VAR(designCss, '--elev1'), VAR(implCss, '--tw-elev-1')) },
    { key: '卡片实阴影（本轮指定）', design: '0 1px 2px rgba(0,0,0,.06),0 1px 3px rgba(0,0,0,.04)', impl: VAR(implCss, '--tw-prism-card-shadow'), ok: same('0 1px 2px rgba(0,0,0,.06),0 1px 3px rgba(0,0,0,.04)', VAR(implCss, '--tw-prism-card-shadow')) },
    { key: '卡片内边距（本轮指定）', design: '12px', impl: VALUE(implCard, 'padding'), ok: VALUE(implCard, 'padding').startsWith('12px') },
    { key: '分段圆角', design: VALUE(designSeg, 'border-radius'), impl: VALUE(implSeg, 'border-radius'), ok: same(VALUE(designSeg, 'border-radius'), VALUE(implSeg, 'border-radius')) },
    { key: '分段选中背景', design: VAR(designCss, '--primary-container'), impl: VAR(implCss, '--tw-md-accent-soft'), ok: same(VAR(designCss, '--primary-container'), VAR(implCss, '--tw-md-accent-soft')) },
    { key: '分段内边距（本轮指定）', design: '2px', impl: VALUE(implSeg, 'padding'), ok: VALUE(implSeg, 'padding') === '2px' },
    { key: '分段项高度', design: VALUE(designSegBtn, 'height'), impl: VALUE(implSegBtn, 'height'), ok: same(VALUE(designSegBtn, 'height'), VALUE(implSegBtn, 'height')) },
    { key: '分段选中字重', design: VALUE(RULE(designCss, '.seg button.on'), 'font-weight'), impl: VALUE(RULE(implCss, '.tw-prism-segbtn.on'), 'font-weight'), ok: same(VALUE(RULE(designCss, '.seg button.on'), 'font-weight'), VALUE(RULE(implCss, '.tw-prism-segbtn.on'), 'font-weight')) },
    { key: '表格行高', design: VALUE(designTd, 'height'), impl: VALUE(implTd, 'height'), ok: same(VALUE(designTd, 'height'), VALUE(implTd, 'height')) },
    { key: '表格 tabular-nums', design: 'tabular-nums', impl: /tabular-nums/.test(implTd) ? 'tabular-nums' : '—', ok: /tabular-nums/.test(implTd) },
    { key: '分隔条宽度', design: VALUE(designSplitter, 'width'), impl: VALUE(implSplitter, 'width'), ok: same(VALUE(designSplitter, 'width'), VALUE(implSplitter, 'width')) },
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
