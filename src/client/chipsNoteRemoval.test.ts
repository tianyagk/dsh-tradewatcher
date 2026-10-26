/**
 * 筹码卡「冗长注解」删除的断言（v0.159.0，用户要求**纯删除**）。
 *
 * 被删的那段（红框）从「只取到近 60 日（不足 360 日）——历史越长越准」一直到
 * 「…判不了，未改动（只报数，不猜量纲）」，中间夹着 回包体积预算 256 KB / 384 档降到 242 /
 * 实际档宽 0.0913 / 成交量 998180 与同日报价 229866913（手）相差。
 *
 * 保留：`▾ 筹码分布` 标题、四格（平均成本/支撑/压力/盈利比例）、`YYYY-MM-DD · 样本 N 天`、百分位列表、图例。
 * **纯删除**：不得留任何替代文案（不许出现「量纲未确认」之类），也不许留 `⚠`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chipsPlotHeightOf } from './chipsView.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 面板源码的**非注释**文本（注释不是界面文案） */
function panelCode(): string {
  return readFileSync(join(HERE, 'ChipsPanel.tsx'), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

/** 只取字符串字面量里的文本（渲染文案都在这里；避免把变量名/注释算进来） */
function stringLiterals(src: string): string {
  return [...src.matchAll(/'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
    .join('\n')
}

const BANNED = [
  '回包体积预算',
  '384 档降到 242',
  '判不了',
  '只报数',
  '历史越长越准',
  // 用户追加：纯删除，不许留"量纲"类替代文案与告警符
  '量纲',
  '未确认',
  '⚠',
]

test('① 页面源码与渲染文案都不含那五句 + `量纲`/`未确认`/`⚠`（出现任一 ⇒ 必败）', () => {
  const code = panelCode()
  const texts = stringLiterals(code)
  for (const word of BANNED) {
    assert.equal(code.includes(word), false, `面板源码仍含「${word}」`)
    assert.equal(texts.includes(word), false, `面板渲染文案仍含「${word}」`)
  }
  // 口径生成器里也不许残留（历史越长越准 原来就在 chipsView.ts）
  const view = readFileSync(join(HERE, 'chipsView.ts'), 'utf8')
  assert.equal(view.includes('历史越长越准'), false, 'chipsView.ts 仍含「历史越长越准」')
  assert.equal(view.includes('caliberDeviates'), false, 'caliberDeviates 已整体下线')
  // 反例注入：把旧句子放回面板 ⇒ 判据必败
  const legacy = `仅取到近 60 日（不足 360 日）——历史越长越准`
  assert.throws(
    () => assert.equal(legacy.includes('历史越长越准'), false, '反例上：旧句子还在'),
    /反例上/,
    '⚠ 反例注入（旧句子回流）必须失败',
  )
})

test('② 四格仍在：平均成本 / 支撑 / 压力 / 盈利比例（删掉任一 ⇒ 必败）', () => {
  const code = panelCode()
  for (const cell of ['平均成本', '支撑', '压力', '盈利比例']) {
    assert.equal(code.includes(cell), true, `四格缺「${cell}」`)
  }
  // 反例注入：删掉「盈利比例」⇒ 判据必败
  const cut = code.replace("`盈利比例 ${pct(profitPct)}`", "`${pct(profitPct)}`")
  assert.throws(
    () => assert.equal(cut.includes('盈利比例'), true, '反例上：盈利比例被删了'),
    /反例上/,
    '⚠ 反例注入（删四格）必须失败',
  )
})

test('③ `样本 N 天` 仍在（模板必须是 `${day.date} · 样本 ${day.samples} 天`）', () => {
  const code = panelCode()
  assert.equal(/样本 \$\{day\.samples\} 天/.test(code), true, '样本行模板被删/改写')
  // 反例注入：改成只写日期 ⇒ 判据必败
  const cut = code.replace('样本 ${day.samples} 天', '${day.samples}')
  assert.throws(
    () => assert.equal(/样本 \$\{day\.samples\} 天/.test(cut), true, '反例上：样本行没了'),
    /反例上/,
    '⚠ 反例注入（删样本行）必须失败',
  )
})

test('④ 删除后少一行、且不留空容器（留空 div / role=note ⇒ 必败）', () => {
  const code = panelCode()
  // ① 可选行只剩「区间过窄」一行 —— 旧写法是 `(deviate !== null ? 1 : 0) + (d.narrow ? 1 : 0)`
  assert.equal(/const optionalLines = d\.narrow \? 1 : 0$/m.test(code), true, '可选行仍按两条计（说明旧块残留）')
  // ② 不再有任何 note 容器、也没有 deviate 变量（空 div 的典型来源）
  assert.equal(code.includes('role: \'note\''), false, '仍存在 role=note 的容器')
  assert.equal(/\bdeviate\b/.test(code), false, '仍存在 deviate 变量/渲染')
  // ③ `tw-chips-narrow` 只允许出现一次（区间过窄那一行），不允许留空壳
  assert.equal((code.match(/tw-chips-narrow/g) ?? []).length, 1, 'tw-chips-narrow 出现次数不为 1（可能留了空容器）')
  // ④ 几何：少一行 ⇒ 绘图区多出那一行的高度（同一块高度下固定项越少、可画区越大）
  const withNote = chipsPlotHeightOf({ blockPx: 220, hasSlider: true, extraLines: 2 })
  const without = chipsPlotHeightOf({ blockPx: 220, hasSlider: true, extraLines: 1 })
  assert.ok(without > withNote, `删掉一行后绘图区应变高（${withNote} → ${without}）`)
  // 反例注入：把旧的可选行表达式改回来 ⇒ 判据必败
  const legacy = code.replace('const optionalLines = d.narrow ? 1 : 0', 'const optionalLines = 1 + (d.narrow ? 1 : 0)')
  assert.throws(
    () => assert.equal(/const optionalLines = d\.narrow \? 1 : 0$/m.test(legacy), true, '反例上：旧表达式回来了'),
    /反例上/,
    '⚠ 反例注入（旧行计回两条）必须失败',
  )
})
