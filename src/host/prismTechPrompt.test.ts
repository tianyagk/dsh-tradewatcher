/** 技术面段落必须真正进入提示词（不是只在 role 里写） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PIPE = readFileSync(new URL('./prismPipeline.ts', import.meta.url), 'utf8')
const ROUTES = readFileSync(new URL('./prismRoutes.ts', import.meta.url), 'utf8')

test('① PrismInputs 有 tech，compileInput 输出【指数技术面】', () => {
  assert.match(PIPE, /tech\?: string/)
  assert.match(PIPE, /inputs\.tech !== undefined && inputs\.tech\.trim\(\) !== ''/)
})

test('② 路由侧真的生成 tech（缓存 5 分钟 + 日线 120 根）', () => {
  assert.match(ROUTES, /indexTechCachedOf/)
  assert.match(ROUTES, /fetchKline\(secid, 101, 120, 0\)/)
  assert.match(ROUTES, /tech: await indexTechCachedOf\(\)/)
})

test('③ 默认骨架顺序已改成「技术面 → 外盘 → 大宗 → 信息面」', () => {
  const s = readFileSync(new URL('../shared/prism.ts', import.meta.url), 'utf8')
  assert.match(s, /顺序：技术面 → 外盘 → 大宗 → 信息面 → 汇总/)
  assert.ok(!/A股宏观/.test(s), '不应再出现「A股宏观」')
})

test('④ 运行时：新闻只进「信息面」这一路（其余三路与汇总都不带新闻）', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { PrismStore } = await import('./prismStore.ts')
  const { runPrismAnalysis } = await import('./prismPipeline.ts')
  const dir = await mkdtemp(join(tmpdir(), 'prism-news-role-'))
  try {
    const store = new PrismStore(dir)
    await store.init()
    const seen: string[] = []
    let n = 0
    const llm = {
      stream: (opts: { messages: Array<{ content: unknown }> }) => {
        n += 1
        const raw = opts.messages[0]?.content
        seen.push(Array.isArray(raw) ? raw.map((b) => (b as { text?: string }).text ?? '').join('') : String(raw))
        const text = n <= 4 ? `报告${n}` : '汇总\n```json\n{"note":"不买：无资金；不卖：未破止损","limits":{"singlePct":20,"totalPct":50,"note":"x"},"orders":[],"cancel":[]}\n```'
        return (async function* () { yield { type: 'text-delta', text } })()
      },
    }
    const get = (name: string): unknown => name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined
    const news = [{ time: '2026-11-23 09:00', text: '独家新闻锚点：降准50bp' }]
    await runPrismAnalysis(store, '10:15', { positions: '—', quotes: '—', account: '总资产：1', news, skeleton: '骨架' } as never, { get, now: () => 1 })
    const withNews = seen.filter((t) => t.includes('独家新闻锚点'))
    assert.equal(withNews.length, 1, `新闻只应出现在 1 路，实际 ${withNews.length}`)
    assert.ok(withNews[0]!.includes('聚焦信息面'), '带新闻的那路必须是信息面')
    assert.ok(seen.slice(0, 4).filter((t) => t.includes('本段不解读新闻')).length === 3, '其余三路必须写明不解读新闻')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
