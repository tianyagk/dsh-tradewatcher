import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prismPageProblems, rippleCssProblems } from './prismView.ts'
import { TW_CSS } from './styles.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
const page = read('./PrismPage.tsx')
const index = read('./index.tsx')

test('① 页签最右、第 8 个（挪走/少一个 ⇒ 必败）', () => {
  const tabs = [...index.matchAll(/\{ key: '(watch|portfolio|market|cloud|calendar|tools|fupan|prism)', label: '/g)].map((m) => m[1])
  assert.equal(tabs.length, 8)
  assert.equal(tabs[tabs.length - 1], 'prism')
  const injected = index.replace("key: 'prism', label: '棱镜'", "key: 'prism', label: '棱镜'").replace("{ key: 'fupan', label: '复盘'", "{ key: 'prism', label: '棱镜' },\n    { key: 'fupan', label: '复盘'")
  assert.notEqual(injected, index)
  assert.notEqual(injected.match(/key: 'prism'/g)?.length, 1, '⚠ 反例（挪到中间/重复）必须能区分')
})

test('⑧ MD：ripple 固定尺寸 + 只动 transform/opacity；elevation 六档；字号 12/14', () => {
  assert.deepEqual(rippleCssProblems(TW_CSS), [], `ripple 判据必须通过：${JSON.stringify(rippleCssProblems(TW_CSS))}`)
  for (const token of ['--tw-elev-0', '--tw-elev-1', '--tw-elev-3', '--tw-elev-6', '--tw-elev-8', '--tw-elev-12']) {
    assert.ok(TW_CSS.includes(token), `缺少 elevation token ${token}`)
  }
  assert.ok(TW_CSS.includes('.tw-root[data-theme=dark]{--tw-elev-0'), '深色 elevation 必须单独给值')
  assert.deepEqual(prismPageProblems(page), [], `页面判据必须通过：${JSON.stringify(prismPageProblems(page))}`)
  assert.ok(page.includes("querySelectorAll('.tw-prism-ripple')"), 'data-idle 转真时必须移除 ripple 节点')
  // 反例注入：加免责文案 / 非 12·14 字号 ⇒ 判据必须非空
  const injected = `${page}\nconst bad = '免责声明'; const s = { fontSize: 11 }\n`
  assert.notDeepEqual(prismPageProblems(injected), [], '⚠ 反例（免责/11px）必须被抓到')
  assert.throws(() => assert.deepEqual(prismPageProblems(injected), [], '反例'), /反例/, '⚠ 反例注入必须失败')
})

test('⑨ 页面不写免责文案；缺数据 — + 原因', () => {
  assert.equal(/免责|风险提示|不构成投资建议|仅供参考/.test(page), false)
  const view = read('./prismView.ts')
  assert.ok(view.includes('`—（${a.error ??') || view.includes('—（'), '缺失必须给 — + 原因')
})
