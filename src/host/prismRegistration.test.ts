/**
 * 棱镜注册面/接线判据（批次 1）：第 9 行、8 页签、inject llm、单路由、路由账 31。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

function injectProblems(src: string): string[] {
  const bad: string[] = []
  if (!/export const inject = \[[^\]]*'llm'/.test(src)) bad.push('inject 里没有 llm')
  if (!/try\s*\{\s*return ctx\.get\(name\)\s*\}\s*catch/.test(src)) bad.push('ctx.get 没有 try/catch（宿主 Proxy 会抛）')
  return bad
}

test('② inject 含 llm 且 ctx.get 有 try/catch（删掉 ⇒ 必败）', () => {
  const src = read('src/index.ts')
  assert.deepEqual(injectProblems(src), [])
  const injected = src.replace("'webRuntime', 'llm'", "'webRuntime'")
  assert.notDeepEqual(injectProblems(injected), [], '⚠ 反例（去掉 llm）必须被抓到')
  assert.throws(() => assert.deepEqual(injectProblems(injected), [], '反例'), /反例/, '⚠ 反例注入必须失败')
})

test('① 第 9 行 / 8 页签 / 主路由 + 自检 / 路由账 32', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /- id: tradewatcher-prism\n\s+name: 'dsh-tradewatcher\/rows\/prism'\n\s+config: \{ row: prism \}/)
  const ids = [...patch.matchAll(/^\s+- id: tradewatcher-(\w+)$/gm)].map((m) => m[1])
  assert.equal(ids.length, 9)
  assert.equal(ids[ids.length - 1], 'prism')
  const index = read('src/client/index.tsx')
  const tabs = [...index.matchAll(/\{ key: '(watch|portfolio|market|cloud|calendar|tools|fupan|prism)', label: '/g)].map((m) => m[1])
  assert.equal(tabs.length, 8)
  assert.equal(tabs[tabs.length - 1], 'prism')
  const routes = read('src/host/prismRoutes.ts')
  const paths = [...routes.matchAll(/path: '(\/tradewatcher\/[a-z0-9/-]+)'/g)].map((m) => m[1])
  assert.deepEqual(paths, ['/tradewatcher/prism', '/tradewatcher/prism/selftest'], '五类操作复用同一条主路由 + 自检')
  assert.match(routes, /action === 'run'/)
  assert.match(routes, /path: '\/tradewatcher\/prism\/selftest'/)
  const design = read('docs/DESIGN-SUBPLUGINS.md')
  assert.match(design, /路由账 32 =/)
  // 反例注入：多开一条路由 ⇒ 路由账不再是 31（判据必须能区分）
  assert.throws(() => assert.equal(paths.length, 3, '反例'), /反例/, '⚠ 反例（多路由）必须失败')
})
