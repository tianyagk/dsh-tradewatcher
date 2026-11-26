/** 设置持久化：gateBaseAt / maxCumDDPct 必须在重启（重新 init）后仍然存在 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismStore } from './prismStore.ts'

test('① patchSettings 写入 gateBaseAt / maxCumDDPct 后，重新 init 仍在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-settings-'))
  try {
    const a = new PrismStore(dir)
    await a.init()
    await a.patchSettings({ gateBaseAt: 1_795_497_816_211, maxCumDDPct: 15 })
    const b = new PrismStore(dir)
    await b.init()
    assert.equal(b.settings().gateBaseAt, 1_795_497_816_211, '重启后 gateBaseAt 不得丢')
    assert.equal(b.settings().maxCumDDPct, 15)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('② 缺省时不写 0 / 不猜（undefined）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-settings2-'))
  try {
    const a = new PrismStore(dir)
    await a.init()
    assert.equal(a.settings().gateBaseAt, undefined)
    assert.equal(a.settings().maxCumDDPct, undefined, '默认不带该字段（未设置）')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('③ saveRun 立即归一（rejects/parseError 缺省补齐），重启前后形状一致', async () => {
  const { PrismStore, normalizeRunOf } = await import('./prismStore.ts')
  const dir = await mkdtemp(join(tmpdir(), 'prism-runs-'))
  try {
    const s = new PrismStore(dir); await s.init()
    const raw = { startedAt: 1_795_000_000_000, slot: '10:00', codeVersion: 'x', analyses: [], summary: null, error: null,
      decision: { limits: { singlePct: 30, totalPct: 100, note: null }, orders: [], cancel: [] } } as never
    await s.saveRun(raw)
    const saved = s.runs().at(-1)!
    assert.deepEqual(saved.decision!.rejects, [])
    assert.equal(saved.decision!.parseError, null)
    assert.equal(saved.day, normalizeRunOf(raw).day)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('④ 读回校验：99:99 / 负百分比 / 负金额 ⇒ 丢弃，不写进内存', async () => {
  const { writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'prism-settings3-'))
  try {
    await writeFile(join(dir, 'prism-settings.json'), JSON.stringify({
      v: 1, times: ['09:35', '99:99'], lastFired: { '2026-11-25': ['25:00', '10:00'] },
      perStockPct: -5, stopLossPct: 150, perOrderYuan: -1, maxPosPct: 80, maxDDPct: 5, minCashPct: 0,
    }), 'utf8')
    const s = new PrismStore(dir); await s.init()
    const v = s.settings()
    assert.deepEqual(v.times, ['09:35'])
    assert.equal(v.perStockPct, null)
    assert.equal(v.stopLossPct, null)
    assert.equal(v.perOrderYuan, null)
    assert.equal(v.maxPosPct, 80)
    assert.deepEqual(v.lastFired['2026-11-25'], ['10:00'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('⑤ autoT 开关写→重启→读 必须保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-autot-settings-'))
  try {
    const a = new PrismStore(dir); await a.init()
    await a.patchSettings({ autoT: { enabled: true, positions: { '1.601872': { enabled: true }, '1.510300': { enabled: false } } } })
    const b = new PrismStore(dir); await b.init()
    const v = b.settings().autoT
    assert.equal(v?.enabled, true)
    assert.equal(v?.positions['1.601872']?.enabled, true)
    assert.equal(v?.positions['1.510300']?.enabled, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
