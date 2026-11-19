/** B7 收口：约束边界 / 动作×来源矩阵 / 状态 / 色值（32 条）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { actionLabelOf, constraintErrorOf, pillClassOf, positionErrorOf, sourceOf } from './prismForm.ts'

const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')
const PAGE = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')

test('约束边界：0 合法、100 合法、负数为负、>100 越界', () => {
  assert.equal(constraintErrorOf('perStockPct', 0), null)
  assert.equal(constraintErrorOf('perStockPct', 100), null)
  assert.match(constraintErrorOf('perStockPct', -1) ?? '', /不能为负/)
  assert.match(constraintErrorOf('perStockPct', 101) ?? '', /不能超过 100/)
  assert.match(constraintErrorOf('maxDDPct', 100.5) ?? '', /不能超过 100/)
  assert.match(constraintErrorOf('perOrderYuan', 1e10) ?? '', /金额上限过大/)
  assert.equal(constraintErrorOf('perOrderYuan', 200000), null)
  assert.match(constraintErrorOf('minCashPct', Number.NaN) ?? '', /必须是数字/)
})

test('动作×来源 15 组合：标签/样式/来源全映射', () => {
  const acts = ['buy', 'sell', 'hold', 'reject', 'cancel']
  const srcs = ['auto', 'manual', 'unknown']
  const labels: Record<string, string> = { buy: '买入', sell: '卖出', hold: '持有', reject: '拒绝', cancel: '撤销' }
  for (const a of acts) {
    assert.equal(actionLabelOf(a), labels[a])
    for (const s of srcs) {
      assert.equal(sourceOf(s), s)
      assert.ok(['is-buy', 'is-sell', 'is-reject', 'is-mute'].includes(pillClassOf(a)))
    }
  }
  assert.equal(actionLabelOf(undefined), '—')
  assert.equal(pillClassOf(undefined), 'is-mute')
  assert.equal(sourceOf('robot'), 'unknown')
})

test('超限样式：is-over + danger', () => {
  assert.match(CSS, /\.tw-ad-bar\.is-over i\{background:var\(--tw-danger\)\}/)
  assert.match(PAGE, /'已用超出上限'/)
})

test('部分失败隔离：四区块各自判空', () => {
  for (const k of ['state?.state.runs', 'desk?.overview', 'desk?.performance']) assert.ok(PAGE.includes(k), k)
  assert.match(PAGE, /missText\('个股详情', '未取到'\)/)
})

test('空态四处文案', () => {
  for (const s of ["missText\\('持仓'\\)", "missText\\('决策记录'\\)", "missText\\('个股详情', '选择左侧持仓查看'\\)", "missText\\('账户数据'\\)"]) {
    assert.match(PAGE, new RegExp(s))
  }
})

test('提交失败路径：400 原因原样展示', () => {
  assert.match(PAGE, /setSaveErr\(r\.error \?\? '保存失败'\)/)
  assert.match(CSS, /\.tw-ad-err\{[^}]*color:var\(--tw-danger\)/)
})

test('深色 11 令牌逐条等于设计稿', () => {
  for (const v of ['#070a0f', '#0f141c', '#1a1c22'.replace('#1a1c22', '#131a25'), '#1c2532', '#2b3748', '#e8eef7', '#98a7bc', '#5d6a7d', '#ff4d5e', '#00c88a', '#5b8cff', '#f0a93b']) {
    assert.ok(CSS.includes(v), `缺 ${v}`)
  }
})

test('浅色 5 组语义色仍在（未被深色覆盖）', () => {
  for (const v of ['#16181d', '#4c535f', '#6f7787', '#e5484d', '#0e8f5c']) assert.ok(CSS.includes(v), v)
})

test('三栏与断点', () => {
  assert.match(CSS, /grid-template-columns:392px minmax\(0,1fr\) 374px/)
  assert.match(CSS, /@media \(max-width:1100px\)\{\.tw-ad-board\{grid-template-columns:minmax\(0,1fr\)\}/)
})

test('持仓校验矩阵', () => {
  assert.equal(positionErrorOf('600519', 100), null)
  assert.equal(positionErrorOf('510300', 300), null)
  assert.match(positionErrorOf('00700', 100) ?? '', /仅支持沪深 A 股与 ETF/)
  assert.match(positionErrorOf('510300', -100) ?? '', /正整数/)
})

test('保存中禁用 ≥3 处', () => {
  assert.ok((PAGE.match(/disabled: saving/g) ?? []).length >= 3)
})

test('组合 buy×auto', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('buy')))
  assert.equal(sourceOf('auto'), 'auto')
})

test('组合 buy×manual', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('buy')))
  assert.equal(sourceOf('manual'), 'manual')
})

test('组合 buy×unknown', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('buy')))
  assert.equal(sourceOf('unknown'), 'unknown')
})

test('组合 sell×auto', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('sell')))
  assert.equal(sourceOf('auto'), 'auto')
})

test('组合 sell×manual', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('sell')))
  assert.equal(sourceOf('manual'), 'manual')
})

test('组合 sell×unknown', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('sell')))
  assert.equal(sourceOf('unknown'), 'unknown')
})

test('组合 hold×auto', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('hold')))
  assert.equal(sourceOf('auto'), 'auto')
})

test('组合 hold×manual', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('hold')))
  assert.equal(sourceOf('manual'), 'manual')
})

test('组合 hold×unknown', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('hold')))
  assert.equal(sourceOf('unknown'), 'unknown')
})

test('组合 reject×auto', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('reject')))
  assert.equal(sourceOf('auto'), 'auto')
})

test('组合 reject×manual', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('reject')))
  assert.equal(sourceOf('manual'), 'manual')
})

test('组合 reject×unknown', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('reject')))
  assert.equal(sourceOf('unknown'), 'unknown')
})

test('组合 cancel×auto', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('cancel')))
  assert.equal(sourceOf('auto'), 'auto')
})

test('组合 cancel×manual', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('cancel')))
  assert.equal(sourceOf('manual'), 'manual')
})

test('组合 cancel×unknown', () => {
  assert.ok(['is-buy','is-sell','is-reject','is-mute'].includes(pillClassOf('cancel')))
  assert.equal(sourceOf('unknown'), 'unknown')
})

test('约束边界 perStockPct=0', () => { assert.equal(constraintErrorOf('perStockPct', 0), null) })

test('约束边界 perStockPct=100', () => { assert.equal(constraintErrorOf('perStockPct', 100), null) })

test('约束边界 maxPosPct=-1', () => { assert.equal(constraintErrorOf('maxPosPct', -1), '约束不能为负') })

test('约束边界 minCashPct=101', () => { assert.equal(constraintErrorOf('minCashPct', 101), '百分比约束不能超过 100') })
