/**
 * 涨跌家数自统计链路的断言（源 B / 源 C）。
 *
 * 这里锁的是三条最要紧的东西：
 *  ① 本地计数的口径（>0 上涨 / =0 平盘 / <0 下跌）与"和中必须等于 total"；
 *  ② 新浪那条**边界搜索**必须真的只碰少数几页，而且**顺序不变量**不成立时不许发布数字；
 *  ③ 明显不合理的统计（三者全 0 而 total>0、和与 total 不等、扫过的行数不足）一律按失败处理。
 *
 * 红线：宁可返回失败（界面 `—` + 原因），也不给一个看起来正常但错的数字。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countFromClistPages, countFromSortedPctPages, sanityOfCounts } from './breadthCount.ts'

test('源 B 计数：>0 上涨 / =0 平盘 / <0 下跌，且和等于 total 才通过', () => {
  const ok = countFromClistPages([[1, 2, 0, -1], [-2, 0, 3]], 7)
  assert.deepEqual(ok.counts, { up: 3, down: 2, even: 2, total: 7, scanned: 7, pages: 2 })
  assert.equal(ok.reason, null)
  // 和与 total 不等 ⇒ 失败（分页漏读/重复读）
  const bad = countFromClistPages([[1, 2, 0, -1]], 99)
  assert.equal(bad.counts, null)
  assert.match(bad.reason ?? '', /不一致/)
  // 无效字段不算数（不许当 0），并且计入自检说明
  const dirty = countFromClistPages([[1, Number.NaN, 0, -1]], 3)
  assert.deepEqual(dirty.counts, { up: 1, down: 1, even: 1, total: 3, scanned: 3, pages: 1 })
  assert.ok(dirty.checks.some((c) => c.includes('没有有效涨跌幅')))
})

test('合理性检查：三者全 0 而 total>0 / 扫过行数不足 / total 无效 ⇒ 失败', () => {
  assert.equal(sanityOfCounts({ up: 0, down: 0, even: 0, total: 5000, scanned: 5000 }).ok, false)
  assert.match(sanityOfCounts({ up: 0, down: 0, even: 0, total: 5000, scanned: 5000 }).reason ?? '', /全为 0/)
  assert.equal(sanityOfCounts({ up: 0, down: 0, even: 0, total: 0, scanned: 0 }).ok, false)
  assert.equal(sanityOfCounts({ up: 10, down: 10, even: 0, total: 20, scanned: 5 }, { fullScan: true }).ok, false)
  assert.equal(sanityOfCounts({ up: 10, down: 10, even: 0, total: 20, scanned: 5 }, { fullScan: false }).ok, true, '只扫边界页时不做全量要求')
  assert.equal(sanityOfCounts({ up: 10, down: 8, even: 2, total: 20, scanned: 20 }, { fullScan: true }).ok, true)
})

test('源 C 边界搜索：只碰边界页就能算出三类，且不变量全部成立', () => {
  // total=12、每页 4 行：page1 全正；page2 跨越 0（1 正 / 1 平 / 2 负）；page3 全负
  const pages: Record<number, number[]> = { 1: [5, 4, 3, 2], 2: [1, 0, -1, -2], 3: [-3, -4, -5, -6] }
  const seen: number[] = []
  return countFromSortedPctPages(async (page) => {
    seen.push(page)
    return { rows: pages[page] ?? [], total: 12 }
  }, { num: 4 }).then((r) => {
    assert.deepEqual(r.counts, { up: 5, down: 6, even: 1, total: 12, scanned: 8, pages: 2 })
    assert.equal(r.reason, null)
    assert.ok(seen.length <= 6, `只该碰少数几页（实际 ${seen.join(',')}）`)
    assert.ok(r.checks.some((c) => c.includes('不变量成立')), '必须给出顺序不变量的自检结论')
    assert.ok(r.checks.some((c) => c.includes('三类独立计数')), '三类独立计数之和要核对')
  })
})

test('源 C：整页全正时"全市场上涨"要有证明（新取一次最后一页核对），不是靠没找到边界', () => {
  let calls = 0
  return countFromSortedPctPages(async () => {
    calls += 1
    return { rows: [3, 2, 1], total: 3 }
  }, { num: 4 }).then((r) => {
    assert.deepEqual(r.counts, { up: 3, down: 0, even: 0, total: 3, scanned: 3, pages: 1 })
    assert.ok(r.checks.some((c) => c.includes('均为上涨')), '全市场上涨也要把结论写进自检')
    assert.equal(calls, 2, '首页一次 + 不变量核对时新取一次（只碰少数几页）')
  })
})

test('源 C 不变量自检：页内顺序不是降序 ⇒ 不发布数字（退到失败 + 原因）', () => {
  return countFromSortedPctPages(async () => ({ rows: [1, -1, 0, 0], total: 4 }), { num: 4 }).then((r) => {
    assert.equal(r.counts, null, '顺序不满足降序时绝不能给数字')
    assert.match(r.reason ?? '', /顺序|降序/)
    assert.ok(r.checks.some((c) => c.includes('不是降序')))
  })
})

test('源 C 不变量自检：两次取数不一致（上游分页/排序不稳定）⇒ 不发布数字', () => {
  // 第一次读 page1 = [5,4,3,2]（据此判定分界在 page2）；核对时再被新数据的"非正值"推翻
  let page1Reads = 0
  return countFromSortedPctPages(async (page) => {
    if (page === 1) {
      page1Reads += 1
      return { rows: page1Reads === 1 ? [5, 4, 3, 2] : [5, 4, 0, 0], total: 12 }
    }
    return { rows: page === 2 ? [1, 0, -1, -2] : [-3, -4, -5, -6], total: 12 }
  }, { num: 4 }).then((r) => {
    assert.equal(r.counts, null, '两次快照不一致时绝不能拼一个数出来')
    assert.match(r.reason ?? '', /不变量|顺序/)
    assert.ok(r.checks.some((c) => c.includes('新取末值')), '必须说明是"新取的数据"推翻了判定')
  })
})

test('源 C：上游不给总数 / 预算不够 / 首屏为空 ⇒ 一律失败（不给"看起来正常"的数）', async () => {
  const noTotal = await countFromSortedPctPages(async () => ({ rows: [5, 4, 3, 2], total: null }), { num: 4 })
  assert.equal(noTotal.counts, null)
  assert.match(noTotal.reason ?? '', /未给出总数/)
  const overBudget = await countFromSortedPctPages(async (page) => ({
    rows: Array.from({ length: 4 }, (_, i) => 20 - page * 4 - i),
    total: 400,
  }), { num: 4, maxPages: 2 })
  assert.equal(overBudget.counts, null, '预算内的页找不到边界就失败')
  const empty = await countFromSortedPctPages(async () => ({ rows: [], total: 0 }), { num: 4 })
  assert.equal(empty.counts, null)
  assert.match(empty.reason ?? '', /没有返回可用数据/)
})

test('源 C：全市场平盘（整页 0）按失败处理 —— 宁可不给，也不给一个可疑的 0/0/x', async () => {
  const flat = await countFromSortedPctPages(async () => ({ rows: [0, 0, 0, 0], total: 4 }), { num: 4 })
  assert.equal(flat.counts, null)
  assert.match(flat.reason ?? '', /跨越涨跌分界|不变量/)
})
