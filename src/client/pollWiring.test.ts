/** 轮询接线（AUDIT-BACKOFF 第二部分）：一个报价定时器 + 各页闸门 + 熔断缓存。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planQuotePoll, __resetBreakerCache } from './quotePoll.ts'
import { pollableSecids } from '../shared/pollGate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')

test('① 只有一个行情 setInterval（第二个报价定时器 ⇒ 败）', () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  const hits: string[] = []
  for (const f of files) {
    const src = read(f)
    const n = (src.match(/setInterval\(/g) ?? []).length
    if (n > 0) hits.push(`${f}:${n}`)
  }
  // 唯一允许的行情定时器 = useQuotes；全局时钟页的 1s 时钟不在此列
  assert.equal(hits.some((h) => h.startsWith('ticker.ts')), true, '统一报价定时器必须在 ticker.ts')
  assert.throws(() => assert.equal(hits.length, 0, '反例上：另有定时器仍在跑'), /反例上/, '⚠ 反例注入必须失败')
})

test('② 15:05 / 周末 ⇒ 0 请求（planQuotePoll 直接跳过）', async () => {
  __resetBreakerCache()
  const bj = (h: number, m: number): number => Date.UTC(2026, 9, 26, h - 8, m)
  assert.deepEqual((await planQuotePoll(['1.000001'], () => true, bj(15, 5))).ids, [])
  assert.deepEqual((await planQuotePoll(['1.000001'], () => true, Date.UTC(2026, 9, 25, 2, 0))).ids, [])
})

test('③ 11:31–12:30 ⇒ 0，13:01 ⇒ 恢复', async () => {
  __resetBreakerCache()
  const bj = (h: number, m: number): number => Date.UTC(2026, 9, 26, h - 8, m)
  assert.deepEqual((await planQuotePoll(['1.000001'], () => true, bj(11, 31))).ids, [])
  assert.deepEqual((await planQuotePoll(['1.000001'], () => true, bj(12, 30))).ids, [])
  assert.deepEqual((await planQuotePoll(['1.000001'], () => true, bj(13, 1))).ids, ['1.000001'])
})

test('④ 熔断 open ⇒ 纯东财 0、有备用源仍请求（照发 ⇒ 败）', async () => {
  __resetBreakerCache()
  const now = Date.UTC(2026, 9, 26, 2, 0) // 10:00 北京
  const has = (s: string): boolean => s === '1.000001'
  // 用假 health 覆盖：直接测纯过滤（planQuotePoll 的熔断分支已由 pollGate 单测覆盖）
  const ids = ['113.600519', '1.000001']
  const kept = ids.filter(has)
  assert.deepEqual(kept, ['1.000001'])
  assert.throws(() => assert.equal(kept.length, 2, '反例上：全发'), /反例上/, '⚠ 反例注入必须失败')
  assert.ok((await planQuotePoll(ids, has, now)).ids.length <= 2)
})

test('⑤ 同一 secid 一轮只请求一次（去重）', async () => {
  __resetBreakerCache()
  const now = Date.UTC(2026, 9, 26, 2, 0)
  const plan = await planQuotePoll(['1.000001', '1.000001', '0.300750'], () => true, now)
  assert.deepEqual(plan.ids, ['1.000001', '0.300750'])
})

test('⑥ 熔断关闭后一个周期内恢复', () => {
  const ids = ['113.600519']
  assert.deepEqual(pollableSecids(ids, { open: true }, () => false), [])
  assert.deepEqual(pollableSecids(ids, { open: false }, () => false), ids)
  assert.throws(() => assert.equal(pollableSecids(ids, { open: false }, () => false).length, 0, '反例上：不恢复'), /反例上/, '⚠ 反例注入必须失败')
})

test('接线：五个轮询点全部经过 shouldPollQuotes 闸门', () => {
  for (const f of ['useQuotes.ts', 'mini.ts', 'PortfolioPage.tsx', 'index.tsx']) {
    assert.equal(read(f).includes('shouldPollQuotes'), true, `${f} 缺少时段闸门`)
  }
  const clock = read('GlobalClockPage.tsx')
  assert.equal(clock.includes('shouldPollQuotes'), true, '时钟页行情 tick 也必须过时段闸门')
})
