/**
 * `robots.txt` 门禁 + 每主机请求预算（用户口径 v0.89.0）—— 单元测试。
 *
 * 两条纪律必须**可执行**，光写在注释里不算：
 *   ① 先读 robots，`Disallow` 的路径**零请求**（含通配符 `*` 与结尾 `$`）；
 *   ② 同一主机 ≤5 次/小时，超限零请求（且计数**落盘**，重启不重置）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOST_BUDGET_MAX, HostBudget, parseRobots, robotsAllows, robotsPatternMatch } from './robotsGate.ts'

test('① robots 解析：`*` 分组、多组取更具体、通配符与 `$` 锚点', () => {
  const text = [
    '# 注释行',
    'User-agent: *',
    'Disallow: /private/',
    'Crawl-delay: 2',
    '',
    'User-agent: dsh-tradewatcher',
    'Disallow: /service/data/secret',
    'Allow: /service/data/secret/public',
    '',
  ].join('\n')
  const { rules, crawlDelayMs } = parseRobots(text)
  assert.deepEqual(rules, [
    { allow: false, pattern: '/service/data/secret' },
    { allow: true, pattern: '/service/data/secret/public' },
  ], '要挑 UA 更具体的那一组（dsh-tradewatcher > *）')
  assert.equal(crawlDelayMs, null, '具体那组没有 Crawl-delay ⇒ 不给（不要拿 * 组的）')
  // 通配符与锚点
  assert.equal(robotsPatternMatch('/api/*.csv', '/api/v3/datasets/x.csv'), true)
  assert.equal(robotsPatternMatch('/api/*.csv$', '/api/v3/datasets/x.csv?rows=2'), false, '带 $ 时查询串不吃')
  assert.equal(robotsPatternMatch('/api/*.csv', '/api/v3/datasets/x.csv?rows=2'), true, '不带 $ 时前缀匹配即可')
  assert.equal(robotsPatternMatch('', '/'), false, '空模式不匹配任何路径')
})

test('② 最长模式优先：`Allow` 能覆盖更宽的 `Disallow`', () => {
  const rules = [{ allow: false, pattern: '/a/' }, { allow: true, pattern: '/a/b/' }]
  assert.deepEqual(robotsAllows(rules, '/a/b/c'), { allowed: true, by: 'allow /a/b/' })
  assert.deepEqual(robotsAllows(rules, '/a/x'), { allowed: false, by: 'disallow /a/' })
  assert.deepEqual(robotsAllows([], '/anything'), { allowed: true, by: 'no-rule' }, '没有规则 ⇒ 允许，且说明是"无规则"')
})

test('③ 每主机预算：5 次/小时，第 6 次必须被拦住（计数可落盘续用）', () => {
  const budget = new HostBudget()
  const host = 'example.test'
  for (let i = 0; i < HOST_BUDGET_MAX; i += 1) {
    assert.equal(budget.canSpend(host), true, `第 ${i + 1} 次应当允许`)
    budget.spend(host)
  }
  assert.equal(budget.used(host), HOST_BUDGET_MAX)
  assert.equal(budget.canSpend(host), false, `第 ${HOST_BUDGET_MAX + 1} 次必须被拦住`)
  // 换个主机不受影响
  assert.equal(budget.canSpend('other.test'), true, '预算是**每主机**的')
  // 一小时前的记录不计入（窗口滑动）
  const old = Date.now() - 61 * 60_000
  const carried = new HostBudget({ [host]: [old, old, old, old, old] })
  assert.equal(carried.canSpend(host), true, '窗口外的旧记录必须过期')
  assert.equal(carried.snapshot()[host], undefined, '导出时也要把过期记录清掉')
  assert.equal(Object.keys(new HostBudget(budget.snapshot()).snapshot()).includes(host), true, '落盘再读回来仍能继续计数')
})

test('③b `$` 锚点必须是**判别性**的：`/private$` 拦 `/private` 但不拦 `/private/x`', () => {
  // ⚠ 上一版用例只测 `/api/*.csv$` vs 带查询串的路径 —— 两种实现下都返回 false ⇒ 靠巧合通过（REVIEW-4-RISK I15）
  assert.equal(robotsPatternMatch('/private$', '/private'), true, '带 $ 的规则必须拦住等长路径本身')
  assert.equal(robotsPatternMatch('/private$', '/private/x'), false, '带 $ 的规则不许顺带拦住子路径')
  assert.equal(robotsPatternMatch('/private', '/private/x'), true, '不带 $ 的规则是前缀匹配（子路径也拦）')
  const rules = [{ allow: false, pattern: '/private$' }]
  assert.equal(robotsAllows(rules, '/private').allowed, false, '`/private` 必须被拦')
  assert.equal(robotsAllows(rules, '/private/x').allowed, true, '`/private/x` 不该被这条规则拦')
  assert.equal(robotsPatternMatch('/api/*.csv$', '/api/v3/x.csv?rows=2'), false, '带查询串不算命中（保留原用例）')
})

test('③c 成功一次请求 ⇒ 该主机 `req` 计数 +1；超限后 ⇒ 零请求且原因可见（I14 的守门断言）', async () => {
  // ⚠ REVIEW-4-RISK I14：此前**没有任何**断言检查"成功请求会让计数 +1" ⇒ 把 spend 删掉也全绿
  const { gatedFetch } = await import('./robotsGate.ts')
  const { __resetRobotsCache } = await import('./robotsGate.ts')
  __resetRobotsCache()
  const original = globalThis.fetch
  const calls: string[] = []
  const reply = (text: string): Response =>
    ({ ok: true, status: 200, text: async () => text, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? '')
    calls.push(url)
    if (url.includes('/robots.txt')) return reply('User-agent: *\nAllow: /\n')
    return reply('ok')
  }) as typeof fetch
  try {
    const budget = new HostBudget()
    const host = 'ledger.test'
    const before = budget.used(host)
    const first = await gatedFetch('https://ledger.test/data/a.csv', { budget, host })
    assert.equal(first.ok, true, '第一次请求应当成功')
    assert.equal(budget.used(host), before + 1, '⚠ 成功一次必须让该主机计数 +1（删掉 spend 就会红）')
    assert.equal(budget.snapshot()[host]?.length, 1, '落盘快照里也要看得见这一次')
    // 用满后：第 6 次零请求 + 原因可见
    for (let i = 1; i < HOST_BUDGET_MAX; i += 1) await gatedFetch(`https://ledger.test/data/${i}.csv`, { budget, host })
    assert.equal(budget.used(host), HOST_BUDGET_MAX, `用满 ${HOST_BUDGET_MAX} 次`)
    const dataCalls = calls.filter((u) => u.includes('/data/')).length
    const sixth = await gatedFetch('https://ledger.test/data/6th.csv', { budget, host })
    assert.equal(sixth.ok, false, '第 6 次必须被拦住')
    assert.ok(sixth.ok === false && sixth.note.includes('预算'), `原因必须写清是预算：${sixth.ok === false ? sixth.note : ''}`)
    assert.equal(calls.filter((u) => u.includes('/data/')).length, dataCalls, '超限之后**零请求**（连 robots 都不该再打数据路径）')
  } finally {
    globalThis.fetch = original
  }
})

test('④ 反例（判据不是恒真）：超预算 / 被 Disallow 都必须能被判出来', () => {
  const budget = new HostBudget({ 'x.test': [Date.now(), Date.now(), Date.now(), Date.now(), Date.now()] })
  assert.equal(budget.canSpend('x.test'), false, '反例：满额时必须拦住')
  const rules = [{ allow: false, pattern: '/data/' }]
  assert.equal(robotsAllows(rules, '/data/x').allowed, false, '反例：Disallow 必须拦住')
})
