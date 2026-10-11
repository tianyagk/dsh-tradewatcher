/**
 * 动词文案与流水动词集合的一致性断言（S4）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LEDGER_VERB_LABEL } from '../shared/model.ts'
import { DataStore, LEDGER_VERBS } from './store.ts'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('S4：动词文案的键集必须与 LEDGER_VERBS 完全一致（少一个就会渲染成英文动词）', () => {
  const keys = Object.keys(LEDGER_VERB_LABEL).sort()
  assert.deepEqual(keys, [...LEDGER_VERBS].sort(), `两边不一致：${keys.join(',')}`)
  assert.notEqual(LEDGER_VERB_LABEL.gmove, '', '每个动词都要有中文名')
})

test('P0 回归：stripCfg 必须真的落盘（写入 → 新建 DataStore 重新装载 → 读回一致）', async () => {
  // 这条断言就是为"宿主白名单漏了 stripCfg ⇒ 配置只在当次会话有效"写的：
  // 只断言 setPrefs 的返回值**抓不到**它（返回值来自内存），必须跨实例重新装载。
  const dir = mkdtempSync(join(tmpdir(), 'tw-prefs-'))
  const a = new DataStore(dir)
  await a.init()
  const written = await a.setPrefs({ stripCfg: { hidden: ['1.000001', '171.US10Y'] } })
  assert.deepEqual(written.stripCfg, { hidden: ['1.000001', '171.US10Y'] }, 'setPrefs 返回值应含新值')
  const b = new DataStore(dir)
  await b.init()
  assert.deepEqual(
    b.getPrefs().stripCfg,
    { hidden: ['1.000001', '171.US10Y'] },
    '重新装载后必须读回同一集合（读回默认值＝配置根本没落盘）',
  )
  // 顺序保持不变（界面按 TW_ROWS 固定顺序渲染，这里不做排序）
  assert.deepEqual(b.getPrefs().stripCfg?.hidden, ['1.000001', '171.US10Y'])
})

test('P0 回归：非法输入被过滤去重（非数组 ⇒ 空；混入非字符串丢掉；重复项只留一个）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-prefs-'))
  const s = new DataStore(dir)
  await s.init()
  await s.setPrefs({ stripCfg: { hidden: ['1.000001', 42, null, '1.000001', '', '0.399001'] as unknown as string[] } })
  const back = new DataStore(dir)
  await back.init()
  assert.deepEqual(back.getPrefs().stripCfg, { hidden: ['1.000001', '0.399001'] }, '只留字符串、去重')
  await s.setPrefs({ stripCfg: { hidden: 'nonsense' } as unknown as { hidden: string[] } })
  const back2 = new DataStore(dir)
  await back2.init()
  assert.deepEqual(back2.getPrefs().stripCfg, { hidden: [] }, '非数组 ⇒ 空集合（宽容，不抛错）')
  // 上界 400：超出部分丢掉（防止被手改的文件塞进几万条）
  const many = Array.from({ length: 450 }, (_, i) => `9.${String(i).padStart(6, '0')}`)
  await s.setPrefs({ stripCfg: { hidden: many } })
  assert.equal(s.getPrefs().stripCfg?.hidden.length, 400)
})

test('P0 回归：缺 stripCfg 的老 profile 读回默认（全可见）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-prefs-'))
  mkdirSync(dir, { recursive: true })
  // 手写一份"老版本"prefs.json：没有任何 stripCfg 键
  writeFileSync(join(dir, 'prefs.json'), JSON.stringify({ theme: 'dark', refreshSec: 15, redUp: false }), 'utf8')
  const s = new DataStore(dir)
  await s.init()
  assert.deepEqual(s.getPrefs().stripCfg, { hidden: [] }, '缺键 ⇒ 空隐藏集 ⇒ 全部可见（老 profile 不会看不到卡）')
  assert.equal(s.getPrefs().theme, 'dark', '其它键照常读回')
  // 坏值也不会让启动失败（装载宽容）
  writeFileSync(join(dir, 'prefs.json'), JSON.stringify({ stripCfg: { hidden: { nope: 1 } } }), 'utf8')
  const s2 = new DataStore(dir)
  await s2.init()
  assert.deepEqual(s2.getPrefs().stripCfg, { hidden: [] })
})

test('账本截断必须可读：返回数 / 总数 / truncated / limit 四个字段自洽', async () => {
  const { ledgerTotal, ledgerViews } = await import('./portfolio.ts')
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `e${String(i).padStart(3, '0')}`, ts: 1_700_000_000_000 + i, verb: 'buy' as const,
    posId: 'p1', groupId: 'g1', qty: 1, price: 10, actor: 'web' as const,
  }))
  const entries = mk(120)
  // 默认 500（工具的默认值）⇒ 120 条全给，不截断
  const full = ledgerViews(entries, [], [], { limit: 500 })
  assert.equal(full.length, 120)
  assert.equal(ledgerTotal(entries, {}), 120, '总数＝过滤后的条数')
  assert.equal(120 > full.length, false, '默认上限下不应截断')
  // 显式 limit 100 ⇒ 如实可判截断（这正是修复前缺的那一步：默认 100 且不报 truncated）
  const cut = ledgerViews(entries, [], [], { limit: 100 })
  assert.equal(cut.length, 100)
  assert.equal(ledgerTotal(entries, {}) > cut.length, true, 'truncated 必须为真')
  // 过滤后的总数：只数匹配的
  assert.equal(ledgerTotal(entries, { posId: 'p1' }), 120)
  assert.equal(ledgerTotal(entries, { posId: 'nope' }), 0)
  assert.equal(ledgerTotal(entries, { groupId: 'g2' }), 0)
})
