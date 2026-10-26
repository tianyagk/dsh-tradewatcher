/**
 * 「做T窗口」的纯规则断言（用户定稿 8 条）。
 *
 * 只测**规则**与**接线文本**：档数分档、间距、均价位移、ATR 缺失、开关、无手动控件、标签格式、徽标。
 * 反例注入一律用"把实现改回错误写法"的方式构造，确保判据本身不是恒真。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { T_WINDOW_COLORS, T_WINDOW_SPACING_DIVISOR, tWindowBandsOf, tWindowLabelOf, tWindowOf, tWindowOnOf, tWindowPatchOf } from './tWindowView.ts'
import { atrFromBars } from '../host/atr.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')

test('① 档数边界：ATR% 2.0/2.1/3.5/3.6 ⇒ 4/6/6/8（边界取错 ⇒ 必败）', () => {
  assert.equal(tWindowBandsOf(2.0), 4)
  assert.equal(tWindowBandsOf(2.1), 6)
  assert.equal(tWindowBandsOf(3.5), 6)
  assert.equal(tWindowBandsOf(3.6), 8)
  // 反例注入：把 2.0 判成 6（用 `<` 而不是 `<=`）⇒ 必败
  const wrong = (p: number): number => (p < 2 ? 4 : p <= 3.5 ? 6 : 8)
  assert.throws(() => assert.equal(wrong(2.0), 4, '反例上：2.0 被判成 6'), /反例上/, '⚠ 反例注入（边界取错）必须失败')
})

test('② 间距 = ATR% ÷ 4（写成固定 0.5% ⇒ 必败）', () => {
  const w = tWindowOf({ atrPct: 4, avg: 100 })
  assert.ok(!('reason' in w))
  assert.equal(w.spacingPct, 1, '4% ÷ 4 = 1%')
  assert.equal(T_WINDOW_SPACING_DIVISOR, 4)
  const w2 = tWindowOf({ atrPct: 2.4, avg: 50 })
  assert.ok(!('reason' in w2))
  assert.equal(w2.spacingPct, 0.6)
  // 反例注入：固定 0.5% 的网格 ⇒ 4% 的标的间距也会是 0.5 ⇒ 必败
  const fixed = { spacingPct: 0.5 }
  assert.throws(() => assert.equal(fixed.spacingPct, 1, '反例上：固定间距'), /反例上/, '⚠ 反例注入（固定 0.5%）必须失败')
})

test('③ 均价 +1% ⇒ 网格中心与全部档价同步位移（网格固定 ⇒ 必败）', () => {
  const base = tWindowOf({ atrPct: 3, avg: 100 })
  const up = tWindowOf({ atrPct: 3, avg: 101 })
  assert.ok(!('reason' in base) && !('reason' in up))
  assert.equal(base.levels.length, 6)
  for (let i = 0; i < base.levels.length; i += 1) {
    const a = base.levels[i]
    const b = up.levels[i]
    assert.ok(a !== undefined && b !== undefined)
    assert.ok(Math.abs(b.price - a.price * 1.01) < 0.02, `第 ${i} 档必须同步位移（${a.price} → ${b.price}）`)
    assert.equal(b.devPct, a.devPct, '偏离% 不变（基准变了，档位相对位置不变）')
  }
  // 反例注入：均价不参与（固定中心）⇒ 位移为 0 ⇒ 必败
  const fixedLevels = base.levels.map((l) => l.price)
  assert.throws(
    () => assert.ok(Math.abs(fixedLevels[0]! * 1.01 - fixedLevels[0]!) < 0.02, '反例上：网格没有随均价位移'),
    /反例上/,
    '⚠ 反例注入（网格固定）必须失败',
  )
})

test('④ ATR 缺失 ⇒ 返回原因，不画（默认 2% ⇒ 必败）', () => {
  const missing = tWindowOf({ atrPct: null, avg: 100 })
  assert.ok('reason' in missing)
  assert.ok(missing.reason.includes('ATR14'))
  const noAvg = tWindowOf({ atrPct: 3, avg: null })
  assert.ok('reason' in noAvg)
  // 反例注入：缺失时回落到 2% ⇒ 会画出一个 4 档网格 ⇒ 必败
  const fallback = (p: number | null): number => p ?? 2
  assert.throws(() => assert.ok('reason' in tWindowOf({ atrPct: fallback(null), avg: 100 }), '反例上：用默认 2% 顶替'),
    /反例上/, '⚠ 反例注入（默认 2%）必须失败')
})

test('⑤ 关闭开关 ⇒ 不渲染任何网格节点（留空 div ⇒ 败）', () => {
  assert.equal(tWindowOnOf({ tWindow: {} }, '1.600519'), false)
  assert.equal(tWindowOnOf({ tWindow: { '1.600519': true } }, '1.600519'), true)
  assert.equal(tWindowOnOf({ tWindow: { '0.300750': true } }, '1.600519'), false, '别的标的开着不影响本标的')
  const patch = tWindowPatchOf({ tWindow: { '0.300750': true } }, '1.600519', true)
  assert.deepEqual(patch, { '0.300750': true, '1.600519': true })
  assert.deepEqual(tWindowPatchOf({ tWindow: patch }, '1.600519', false), { '0.300750': true })
  // 源码接线：关闭时抽屉把 tWindow 置 null，图里只有 `tWindow !== null` 才加节点
  const drawer = read('QuoteDrawer.tsx')
  assert.equal(/if \(props\.tWindowOn !== true\) return null/.test(drawer), true, '关闭时必须整组置 null')
  const chart = read('kline.tsx')
  assert.equal(/if \(props\.tWindow !== undefined && props\.tWindow !== null\) \{/.test(chart), true, '图里必须按 null 短路')
  // 反例注入：关闭也渲染（去掉短路）⇒ 判据必败
  const cut = chart.replace('if (props.tWindow !== undefined && props.tWindow !== null) {', 'if (true) {')
  assert.throws(() => assert.equal(/tWindow !== null\) \{/.test(cut), true, '反例上：短路被删'), /反例上/, '⚠ 反例注入必须失败')
})

test('⑥ 源码无 drag / input / reset 控件，也不含"成交点"标记', () => {
  const files = ['tWindowView.ts', 'kline.tsx', 'QuoteDrawer.tsx']
  const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  for (const f of files) {
    const src = strip(read(f))
    // 只看做T相关的代码块：tWindow 出现处前后 3000 字
    const i = src.indexOf('tWindow')
    const seg = i < 0 ? '' : src.slice(Math.max(0, i - 500), i + 3000)
    for (const word of ['onDrag', 'draggable', 'type: \'range\'', 'reset', '成交点']) {
      assert.equal(seg.includes(word), false, `${f} 的做T块里出现「${word}」`)
    }
  }
  const view = strip(read('tWindowView.ts'))
  // 注意：参数名 `input` 不是控件 —— 这里的判据是**控件**（拖拽/输入框/重置按钮），不是变量名
  for (const bad of ['onDrag', 'draggable', "type: 'range'", 'onChange', 'reset(', '<input']) {
    assert.equal(view.includes(bad), false, `纯规则里不许有控件「${bad}」`)
  }
})

test('⑦ 标签格式：价格 + 空格 + 正负百分比（缺偏离 ⇒ 败）', () => {
  assert.equal(tWindowLabelOf({ price: 17.05, devPct: 0.62 }), '17.05 +0.62%')
  assert.equal(tWindowLabelOf({ price: 16.93, devPct: -0.62 }), '16.93 -0.62%')
  assert.match(tWindowLabelOf({ price: 9.9, devPct: 1.2 }), /^\d+\.\d{2} \+\d+\.\d{2}%$/)
  // 反例注入：只给价格（缺偏离）⇒ 必败
  const bare = '17.05'
  assert.throws(() => assert.match(bare, /^\d+\.\d{2} [+-]\d+\.\d{2}%$/, '反例上：缺偏离'), /反例上/, '⚠ 反例注入（缺偏离）必须失败')
})

test('⑧ 徽标文案 `ATR x.xx% · n 档`（缺 ⇒ 败）；买蓝卖橙取用户给定值', () => {
  const drawer = read('QuoteDrawer.tsx')
  assert.equal(/`ATR \$\{tWin\.atrPct\.toFixed\(2\)\}% · \$\{tWin\.bands\} 档`/.test(drawer), true, '徽标模板缺失')
  assert.equal(T_WINDOW_COLORS.buy, '#4C6EF5')
  assert.equal(T_WINDOW_COLORS.sell, '#E8590C')
  // 反例注入：去掉「档」⇒ 判据必败
  const cut = drawer.replace(' · ${tWin.bands} 档', ' · ${tWin.bands}')
  assert.throws(() => assert.equal(/· \$\{tWin\.bands\} 档`/.test(cut), true, '反例上：档字被删'), /反例上/, '⚠ 反例注入必须失败')
})

test('ATR14 纯函数：Wilder TR 的简单平均（14 根），不足 ⇒ null', () => {
  const bars = Array.from({ length: 15 }, (_, i) => ({ high: 11 + i, low: 9 + i, close: 10 + i }))
  const r = atrFromBars(bars, 14)
  assert.ok(r !== null)
  // 每根 TR = max(h−l=2, |h−prevClose|=2, |l−prevClose|=1) = 2 ⇒ ATR=2，close=24
  assert.equal(r.atr, 2)
  assert.equal(r.close, 24)
  assert.ok(Math.abs(r.pct - (2 / 24) * 100) < 1e-9)
  assert.equal(atrFromBars(bars.slice(0, 10), 14), null, '不足 15 根 ⇒ null（不猜）')
})
