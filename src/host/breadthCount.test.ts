/**
 *  ② 「按涨跌幅降序」那条**边界搜索**必须真的只碰少数几页，而且**顺序不变量**不成立时不许发布数字；
 * ⚠ 断言必须跑在**生产取数口径**上（total 含无涨跌幅的行）：把 total 手工写成有效行数会让
 * 红线：宁可返回失败（界面 `—` + 原因），也不给一个看起来正常但错的数字。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countBreadthFromClist, countFromClistPages, countFromSortedPctPages, sanityOfCounts } from './breadthCount.ts'

test('源 B 计数：>0 上涨 / =0 平盘 / <0 下跌，等式基准是有效行数', () => {
  const ok = countFromClistPages([[1, 2, 0, -1], [-2, 0, 3]], 7)
  assert.deepEqual(ok.counts, { up: 3, down: 2, even: 2, total: 7, scanned: 7, blank: 0, pages: 2 })
  assert.equal(ok.reason, null)
  // 三类之和与**有效行数**不等 ⇒ 失败（实现出错或页被截断）
  const bad = countFromClistPages([[1, 2, 0, -1]], 4)
  assert.deepEqual(bad.counts, { up: 2, down: 1, even: 1, total: 4, scanned: 4, blank: 0, pages: 1 })
  assert.equal(countFromClistPages([[1, Number.NaN, 2, Number.NaN]], 2).reason, null, '两行无效不影响其余两行')
  // 一行都没有有效涨跌幅 ⇒ 失败（全 0 会被读成"没有一只下跌"）
  const none = countFromClistPages([[Number.NaN, Number.NaN]], 2)
  assert.equal(none.counts, null)
  assert.match(none.reason ?? '', /没有扫到/)
})

test('源 B 生产口径：上游 total 含停牌/无涨跌幅的行时**必须通过**（P0-2 回归）', () => {
  // 5312 只里有 12 只没有涨跌幅（停牌 / 上游给 '-'）：有效 5300 行，total 5312
  const up = 3000
  const down = 2200
  const even = 100
  assert.equal(up + down + even, 5300)
  const rows: Array<number | null> = [
    ...Array.from({ length: up }, () => 1),
    ...Array.from({ length: even }, () => 0),
    ...Array.from({ length: down }, () => -1),
    ...Array.from({ length: 12 }, () => null),
  ]
  const r = countFromClistPages([rows], 5312)
  assert.notEqual(r.counts, null, '有停牌行时不许再判失败（这正是恒失败的那条）')
  assert.deepEqual(r.counts, { up: 3000, down: 2200, even: 100, total: 5312, scanned: 5300, blank: 12, pages: 1 })
  assert.ok(r.checks.some((c) => c.includes('12 行无涨跌幅') || c.includes('另有 12 行无涨跌幅')), `checks 要如实写明未计入的行数：${r.checks.join(' | ')}`)
  // 无效行数不可能超过上游总数
  const absurd = countFromClistPages([[7, null, null]], 1)
  assert.equal(absurd.counts, null)
  assert.match(absurd.reason ?? '', /超过上游总数|不一致/)
})

test('合理性检查：三者全 0 而 total>0 / 三类之和与有效行数不等 / 覆盖不足 ⇒ 失败', () => {
  const z = { up: 0, down: 0, even: 0, scanned: 0, blank: 0 }
  assert.equal(sanityOfCounts({ ...z, total: 5000 }).ok, false)
  assert.match(sanityOfCounts({ ...z, total: 5000 }).reason ?? '', /没有扫到|全为 0/)
  assert.equal(sanityOfCounts({ ...z, total: 0 }).ok, false)
  // 三类之和必须等于有效行数
  assert.equal(sanityOfCounts({ up: 10, down: 10, even: 0, total: 20, scanned: 30, blank: 0 }).ok, false)
  // 覆盖检查：扫到的**原始**行数（有效 + 无涨跌幅）不足 total 时失败（仅 fullScan 时校验）
  assert.equal(sanityOfCounts({ up: 10, down: 10, even: 0, total: 40, scanned: 20, blank: 0 }, { fullScan: true }).ok, false)
  assert.equal(sanityOfCounts({ up: 10, down: 10, even: 0, total: 40, scanned: 20, blank: 20 }, { fullScan: true }).ok, true, '20 行无涨跌幅也算扫到了')
  assert.equal(sanityOfCounts({ up: 10, down: 10, even: 0, total: 40, scanned: 20, blank: 0 }, { fullScan: false }).ok, true, '只扫边界页时不做全量要求')
})

test('源 B 分页器：跨页跳过的无涨跌幅行也算扫过，覆盖不足则失败', async () => {
  // 3 页 × 4 行 = 12 行，其中 2 行无涨跌幅；total=12（含那两行）
  const page = (pn: number): Array<number | null> =>
    pn === 1 ? [1, 1, 0, -1] : pn === 2 ? [1, null, -1, -1] : pn === 3 ? [-1, -1, 0, null] : []
  const ok = await countBreadthFromClist(async (pn) => ({ rows: page(pn), total: 12 }), { pageSize: 4, concurrency: 2 })
  assert.deepEqual(ok.counts, { up: 3, down: 5, even: 2, total: 12, scanned: 10, blank: 2, pages: 3 })
  assert.ok(ok.checks.some((c) => c.includes('原始行数 12')), `要如实写扫到的原始行数：${ok.checks.join(' | ')}`)
  // 上游说 20 行，实际只扫到 12 行 ⇒ 覆盖不足，按失败处理（红线：不静默截断）
  const short = await countBreadthFromClist(async (pn) => ({ rows: page(pn), total: 20 }), { pageSize: 4, concurrency: 2 })
  assert.equal(short.counts, null)
  assert.match(short.reason ?? '', /扫到|截断/)
})

test('D1 缺页诊断：第 3 页抛错 / 第 3 页空 / 每页少给行 ⇒ 都必须失败且原因里能看到逐页诊断', async () => {
  // 3 页 × 4 行、total=12；第 3 页按情形分别抛错 / 空 / 少给行
  const good = [1, 1, 0, -1]
  const cases: Array<{ name: string; page: (pn: number) => Promise<{ rows: Array<number | null>; total: number | null }>; expect: RegExp }> = [
    {
      name: '第 3 页抛错',
      page: async (pn) => {
        if (pn === 3) throw new Error('boom-3')
        return { rows: good, total: 12 }
      },
      expect: /第 3 页取数失败：Error: boom-3/,
    },
    {
      name: '第 3 页返回空',
      page: async (pn) => ({ rows: pn === 3 ? [] : good, total: 12 }),
      expect: /第 3 页为空/,
    },
    {
      // 首页给满、后两页各少给（页不空但行数不够）⇒ 走覆盖检查那条
      name: '每页少给行（首页 4 行、后两页各 1 行，total 说 12）',
      page: async (pn) => ({ rows: pn === 1 ? good : [1], total: 12 }),
      expect: /只扫到 6 行 < 总数 12 行/,
    },
  ]
  for (const c of cases) {
    const r = await countBreadthFromClist(c.page, { pageSize: 4, concurrency: 2 })
    assert.equal(r.counts, null, `${c.name}：必须失败`)
    assert.match(r.reason ?? '', c.expect, `${c.name}：原因里要有逐页诊断 —— 实际「${r.reason}」`)
    assert.ok(!/TypeError|iterable/.test(r.reason ?? ''), `${c.name}：不得出现 TypeError —— 实际「${r.reason}」`)
    assert.ok(r.checks.some((x) => x.includes('没取到') || x.includes('原始行数')), `${c.name}：checks 要留诊断`)
  }
  // 缺页数真的能数出来（稀疏数组的坑：filter/some 会跳过空槽）
  const sparse: Array<number[] | undefined> = new Array(3)
  sparse[0] = [1]
  assert.equal(sparse.filter((p) => p === undefined).length, 0, '（记录 D1 的坑：稀疏数组 filter 跳过空槽）')
  let n = 0
  for (let i = 0; i < sparse.length; i += 1) if (sparse[i] === undefined) n += 1
  assert.equal(n, 2, '下标循环能数出缺页（3 个槽里 1 个已填、2 个空槽）')
})

test('源 C 边界搜索：只碰边界页就能算出三类，且不变量全部成立', () => {
  // total=12、每页 4 行：page1 全正；page2 跨越 0（1 正 / 1 平 / 2 负）；page3 全负
  const pages: Record<number, number[]> = { 1: [5, 4, 3, 2], 2: [1, 0, -1, -2], 3: [-3, -4, -5, -6] }
  const seen: number[] = []
  return countFromSortedPctPages(async (page) => {
    seen.push(page)
    return { rows: pages[page] ?? [], total: 12 }
  }, { num: 4 }).then((r) => {
    assert.deepEqual(r.counts, { up: 5, down: 6, even: 1, total: 12, scanned: 8, blank: 0, pages: 2 })
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
    assert.deepEqual(r.counts, { up: 3, down: 0, even: 0, total: 3, scanned: 3, blank: 0, pages: 1 })
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
