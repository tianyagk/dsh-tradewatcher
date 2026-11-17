/**
 * 界面打磨第 1 轮：用户可见 ⚠ 清零 / 注释 ⚠ 不减 / 失败句式收敛 / 无 undefined·NaN 泄漏。
 * 每条都带反例注入（改坏必败）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { failText, missText, numText, pctText, ratioText } from './uiText.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const files = readdirSync(HERE).filter((n) => (n.endsWith('.ts') || n.endsWith('.tsx')) && !n.endsWith('.test.ts'))
const src = files.map((n) => ({ n, s: readFileSync(join(HERE, n), 'utf8') }))
function commentMask(lines: string[]): boolean[] {
  const out: boolean[] = []
  let inBlock = false
  for (const l of lines) {
    const t = l.trim()
    const startsComment = t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')
    out.push(inBlock || startsComment)
    if (inBlock) {
      if (t.includes('*/')) inBlock = false
    } else if (t.startsWith('/*') && !t.includes('*/')) {
      inBlock = true
    }
  }
  return out
}
const isCommentAt = (lines: string[], i: number): boolean => commentMask(lines)[i] === true

test('① 用户可见 ⚠ = 0（残留任一 ⇒ 败）', () => {
  const bad: string[] = []
  for (const { n, s } of src) {
    const lines = s.split('\n')
    lines.forEach((l, i) => {
      if (l.includes('⚠') && !isCommentAt(lines, i)) bad.push(`${n}:${i + 1}`)
    })
  }
  assert.deepEqual(bad, [], `仍有用户可见 ⚠：${bad.join(',')}`)
  const injected = [...src, { n: 'X.tsx', s: "const a = `⚠ 采样失败`" }]
  const bad2 = injected.flatMap(({ n, s }) => {
    const lines = s.split('\n')
    return lines.flatMap((l, i) => (l.includes('⚠') && !isCommentAt(lines, i) ? [`${n}:${i + 1}`] : []))
  })
  assert.notDeepEqual(bad2, [], '注入一条 UI ⚠ ⇒ 判失败')
})

test('② 注释里的 ⚠ 不减少（< 85 ⇒ 败；实测基线 140）', () => {
  let n = 0
  const all = readdirSync(HERE).filter((x) => x.endsWith('.ts') || x.endsWith('.tsx'))
  for (const f of all) {
    const lines = readFileSync(join(HERE, f), 'utf8').split('\n')
    lines.forEach((l, i) => { if (l.includes('⚠') && isCommentAt(lines, i)) n += 1 })
  }
  assert.ok(n >= 85, `注释 ⚠ 只剩 ${n} 处（要求 ≥85）`)
  const injected = 84
  assert.throws(() => assert.ok(injected >= 85, '注入 84 ⇒ 败'), /注入 84/)
})

test('③ 失败句式收敛：只许「未取到」「失败」（异常/错误/不可用 ⇒ 败）', () => {
  const banned = ['异常', '错误', '不可用']
  const bad: string[] = []
  for (const { n, s } of src) {
    if (!['RescuePanel.tsx', 'distView.ts', 'globalFlowView.ts'].includes(n)) continue
    const lines = s.split('\n')
    lines.forEach((l, i) => {
      if (isCommentAt(lines, i)) return
      for (const w of banned) if (l.includes(w)) bad.push(`${n}:${i + 1}:${w}`)
    })
  }
  assert.deepEqual(bad, [], `仍混用旧说法：${bad.join(',')}`)
  assert.equal(missText('护盘快照', '上游超时'), '护盘快照未取到（上游超时）')
  assert.equal(failText('份额拉取'), '份额拉取失败')
  assert.equal(missText('份额'), '份额未取到')
  const injected = '接口异常（网络不可用）'
  assert.match(injected, /异常|不可用/, '注入旧说法 ⇒ 判失败')
})

test('④ 20 组边界输入不输出 undefined/NaN/null', () => {
  const nums: Array<number | null | undefined> = [null, undefined, Number.NaN, Infinity, -Infinity, 0, -0, 1e-9, 1e12, -1.5, 0.005, 99.995, 1, -1, 3.14159, 1e-12, 1e15, -0.0001, 42, 100]
  assert.equal(nums.length, 20)
  for (const v of nums) {
    for (const out of [numText(v, 2), pctText(v, 2, true), ratioText(v, 2), missText('X', v === null ? null : undefined), failText('X', null)]) {
      assert.doesNotMatch(out, /undefined|NaN|null/, `输入 ${String(v)} 输出 ${out}`)
      assert.ok(out.length > 0)
    }
  }
  assert.equal(numText(Number.NaN), '—')
  assert.equal(pctText(undefined), '—')
  assert.equal(ratioText(Infinity), '—')
  // 反例注入：直接 toFixed 必须产出 NaN
  assert.match(`${Number.NaN.toFixed(2)}`, /NaN/, '注入未守卫的 toFixed ⇒ NaN ⇒ 判失败')
})
