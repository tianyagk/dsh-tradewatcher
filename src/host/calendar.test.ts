/**
 * 这里用注入的失败源把那条路径钉死：全失败后 `syncedAt` 必须保持不变、`missing` 必须非空。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CalendarStore, type CalSyncFetchers } from './calendar.ts'

const dir = (): string => mkdtempSync(join(tmpdir(), 'tw-cal-'))

const okFetchers = (): CalSyncFetchers => ({
  report: async (name) => {
    if (name === 'RPTA_APP_IPOAPPLY') {
      return [{ SECURITY_CODE: '600519', SECURITY_NAME_ABBR: '贵州茅台', APPLY_DATE: '2026-10-09', LISTING_DATE: '2026-10-20' }]
    }
    if (name === 'RPT_PUBLIC_BS_APPOIN') {
      return [{ SECURITY_CODE: '600519', SECURITY_NAME_ABBR: '贵州茅台', APPOINT_PUBLISH_DATE: '2026-10-25', REPORT_TYPE_NAME: '三季报', IS_PUBLISH: '0', REPORT_DATE: '2026-09-30' }]
    }
    return [{ SECURITY_CODE: '600519', SECURITY_NAME_ABBR: '贵州茅台', EX_DIVIDEND_DATE: '2026-10-15', EQUITY_RECORD_DATE: '2026-10-14', IMPL_PLAN_PROFILE: '10派1元', REPORT_DATE: '2026-06-30' }]
  },
  macroCal: async () => [],
})

const failFetchers = (): CalSyncFetchers => ({
  report: async () => { throw new Error('upstream timeout') },
  macroCal: async () => { throw new Error('upstream timeout') },
})

test('日历：全部源失败时 syncedAt 保持不变、syncAttemptAt 推进、missing 非空', async () => {
  const d = dir()
  const store = new CalendarStore(d)
  await store.init()

  // 先一次成功同步（四个源里 ipo / 财报 / 分红 有数据，宏观返回空数组也算成功）
  await store.sync(['600519'], true, okFetchers())
  const afterOk = store.syncStatus()
  assert.notEqual(afterOk.syncedAt, null, '有源成功时 syncedAt 必须被写入')
  assert.equal(afterOk.stale, false, '全部尝试的源都成功 → 不是降级')
  assert.equal(afterOk.allFailed, false)
  assert.equal(afterOk.missing.length, 0)
  const syncedAtAfterOk = afterOk.syncedAt
  const eventsAfterOk = store.list('2026-10-01', '2026-10-31').length
  assert.ok(eventsAfterOk >= 3, '成功同步的事件应入库')

  // 再一次全失败：数据时刻不得被改写
  await store.sync(['600519'], true, failFetchers())
  const afterFail = store.syncStatus()
  assert.equal(afterFail.syncedAt, syncedAtAfterOk, '全失败后 syncedAt 必须停留在上次成功时刻（失败时刻不改写数据时刻）')
  assert.ok(afterFail.attemptAt !== null && syncedAtAfterOk !== null && afterFail.attemptAt >= syncedAtAfterOk, '尝试时刻必须推进')
  assert.equal(afterFail.stale, true)
  assert.equal(afterFail.allFailed, true)
  assert.equal(afterFail.missing.length, 4, '四个源各一条缺失（含具体原因）')
  // 措辞统一走 MISSING_TIER_ADVICE.transient（S19）：同一档全局只留一种说法
  assert.ok(afterFail.missing.every((m) => m.why === 'transient' && m.note.includes('稍后自动重试')))
  assert.ok(afterFail.missing.every((m) => m.note.includes('upstream timeout')), '缺失原因里要带上游给的原因')
  assert.equal(store.list('2026-10-01', '2026-10-31').length, eventsAfterOk, '全失败时不伪造新事件，也不清空旧事件')

  // 落盘：尝试时刻写进文件（重启后仍能解释"上次尝试是什么时候"）
  const raw = JSON.parse(readFileSync(join(d, 'calendar.json'), 'utf8')) as { syncedAt: number; syncAttemptAt: number }
  assert.equal(raw.syncedAt, syncedAtAfterOk)
  assert.ok(raw.syncAttemptAt > 0)
})

test('日历：从未成功同步过 → syncedAt 为 null 且 stale=true（不拿"现在"顶替）', async () => {
  const store = new CalendarStore(dir())
  await store.init()
  const before = store.syncStatus()
  assert.equal(before.syncedAt, null)
  assert.equal(before.attemptAt, null)
  assert.equal(before.stale, true, '从未同步过时必须算降级（没有可信的数据时刻）')

  await store.sync(['600519'], true, failFetchers())
  const after = store.syncStatus()
  assert.equal(after.syncedAt, null, '全失败且从未成功过 → asOf 只能是 null')
  assert.equal(after.stale, true)
  assert.ok(after.missing.length > 0)
})

test('日历：没有关注标的时"财报/分红"记 skipped（未尝试），不算失败', async () => {
  const store = new CalendarStore(dir())
  await store.init()
  await store.sync([], true, okFetchers())
  const st = store.syncStatus()
  const byKey = new Map(st.sources.map((s) => [s.key, s]))
  assert.equal(byKey.get('earnings')?.state, 'skipped')
  assert.equal(byKey.get('dividend')?.state, 'skipped')
  assert.equal(byKey.get('ipo')?.state, 'ok')
  assert.equal(byKey.get('macro')?.state, 'ok')
  assert.equal(st.allFailed, false)
  assert.equal(st.missing.length, 0, 'skipped 不能算成失败（否则每次没有自选都会报"降级"）')
  assert.equal(st.stale, false)
})
