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

test('④ 反例（判据不是恒真）：超预算 / 被 Disallow 都必须能被判出来', () => {
  const budget = new HostBudget({ 'x.test': [Date.now(), Date.now(), Date.now(), Date.now(), Date.now()] })
  assert.equal(budget.canSpend('x.test'), false, '反例：满额时必须拦住')
  const rules = [{ allow: false, pattern: '/data/' }]
  assert.equal(robotsAllows(rules, '/data/x').allowed, false, '反例：Disallow 必须拦住')
})
