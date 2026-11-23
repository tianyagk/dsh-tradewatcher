/** 决策流「展开闪烁」回归：展开态下批测量不得把 overflow 改回 false */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { clampOverflowApply } from './clampBatch.ts'

const PAGE = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')

test('① 展开态保持 overflow=true（按钮与全文都在）', () => {
  assert.equal(clampOverflowApply(true, false, true), true, '展开时测到"不溢出"也必须保持 true')
  assert.equal(clampOverflowApply(true, true, true), true)
})

test('② 收起态按测量结果决定', () => {
  assert.equal(clampOverflowApply(false, false, true), false)
  assert.equal(clampOverflowApply(false, true, false), true)
})

test('③ FlowTextView 必须用 openRef 守卫，不得直接把 setOverflow 交给批处理器', () => {
  assert.match(PAGE, /const openRef = React\.useRef\(open\)/)
  assert.match(PAGE, /clampOverflowApply\(openRef\.current, measured, prev\)/)
  assert.ok(!/clampBatcher\.watch\(el, setOverflow\)/.test(PAGE), '旧写法（直接 setOverflow）会导致展开闪烁')
  assert.match(PAGE, /clampBatcher\.flush\(\)/, '首测必须同步 flush（微任务阶段可能还没排版 ⇒ 0 高误判）')
})

test('④ 反例：直接把测量结果写回 ⇒ 展开后按钮消失（模型化）', () => {
  const buggy = (_open: boolean, measured: boolean): boolean => measured
  assert.equal(buggy(true, false), false, '反例确实会把展开态打回 false')
  assert.notEqual(clampOverflowApply(true, false, true), buggy(true, false))
})

test('⑤ 隐藏/未排版（clientHeight=0）不得上报"不溢出"，且保留待测', () => {
  const SRC = readFileSync(new URL('./clampBatch.ts', import.meta.url), 'utf8')
  assert.match(SRC, /clientHeight <= 0 \? null : clampOverflowOf/, '零高度必须返回 null（不上报）')
  assert.match(SRC, /if \(next === null \|\| next === undefined\) \{ dirty\.add\(e\);[^}]*continue \}/, '零高度必须留在待测集合里')
})

test('⑥ 隐藏（0 高）→ 显示：批处理器必须补测并把 overflow 报成 true', async () => {
  const { createClampBatcher } = await import('./clampBatch.ts')
  const node = { classList: { tokens: new Set<string>(), contains(t: string) { return this.tokens.has(t) }, add(t: string) { this.tokens.add(t) }, remove(t: string) { this.tokens.delete(t) } }, scrollHeight: 0, clientHeight: 0 }
  let onResize: (() => void) | null = null
  const b = createClampBatcher({
    schedule: () => undefined,
    createObserver: (cb) => { onResize = cb; return { observe: () => undefined, unobserve: () => undefined, disconnect: () => undefined } },
  })
  const seen: boolean[] = []
  b.watch(node, (v) => seen.push(v))
  b.flush()
  assert.deepEqual(seen, [], '隐藏态（clientHeight=0）不得上报 false')
  // 页面显示：有布局了
  node.clientHeight = 56
  node.scrollHeight = 112
  onResize?.()
  b.flush()
  assert.deepEqual(seen, [true], `显示后必须补报 true，实际 ${JSON.stringify(seen)}`)
})
