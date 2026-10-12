import { test } from 'node:test'
import assert from 'node:assert/strict'

/** task-77：盘中未完成 bar 不许被当成最终 bar（缓存版本 / partial / TTL 三重保护） */
import { isPartialBar, klineCacheUsable, KLINE_CACHE_V, PARTIAL_TTL_MS } from './em.ts'

test('task-77：09:33 抓到的当日 bar 判为未完成；收盘后抓到的同日 bar 判为最终', () => {
  const night = Date.parse('2026-10-09T22:30:00+08:00')
  const morning = Date.parse('2026-10-09T09:33:00+08:00')
  const afterClose = Date.parse('2026-10-09T15:30:00+08:00')
  assert.equal(isPartialBar('2026-10-09', morning), true, '盘中 09:33 ⇒ 未完成 bar')
  assert.equal(isPartialBar('2026-10-09', afterClose), false, '收盘后 ⇒ 最终 bar（可缓存）')
  assert.equal(isPartialBar('2026-10-09', night), false, '隔天夜里读到同日 bar ⇒ 已是最终')
  assert.equal(isPartialBar('2026-10-08', night), false, '不是当日的 bar ⇒ 与 partial 无关')
})

test('task-77：缓存可用性三闸（版本 / partial TTL）', () => {
  const now = Date.parse('2026-10-12T10:00:00+08:00')
  // ① 旧版本（v2 及以前可能冻着未完成 bar）⇒ 一律不采用
  const old = klineCacheUsable({ v: 2, partial: false, updatedAt: now - 1000 }, now)
  assert.equal(old.usable, false, 'v2 文件必须被忽略（含未完成 bar 的那份就在其中）')
  assert.ok((old.reason ?? '').includes('v2'), '理由要写清版本不符')
  // ② v3 + partial 且超 TTL ⇒ 必须回源
  const stale = klineCacheUsable({ v: KLINE_CACHE_V, partial: true, updatedAt: now - PARTIAL_TTL_MS - 1 }, now)
  assert.equal(stale.usable, false, '未完成 bar 超 TTL ⇒ 回源重取')
  assert.equal(stale.partial, true)
  // ③ v3 + partial 且在 TTL 内 ⇒ 可用（但仍标记 partial）
  const fresh = klineCacheUsable({ v: KLINE_CACHE_V, partial: true, updatedAt: now - 1000 }, now)
  assert.equal(fresh.usable, true)
  assert.equal(fresh.partial, true, 'TTL 内可用但仍要如实标 partial')
  // ④ v3 + 非 partial ⇒ 可用
  const final = klineCacheUsable({ v: KLINE_CACHE_V, partial: false, updatedAt: now - 86_400_000 }, now)
  assert.equal(final.usable, true)
  assert.equal(final.partial, false)
  // ⑤ 缺字段（更老的文件）⇒ 不采用
  assert.equal(klineCacheUsable({}, now).usable, false, '没有版本标记 ⇒ 不采用')
})
