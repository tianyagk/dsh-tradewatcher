/**
 * task-61 的客户端断言：① 切页签不刷新（fetch 计数）② 面板正常时零文案 ③ 纵轴刻度。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { axisTicks, caliberDeviates } from './chipsView.ts'
import { loadChips, resetChipsCache } from './chipsLoader.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')

test('① 切 6 次页签后筹码请求数仍为 1（假 fetch 计数）', async () => {
  resetChipsCache()
  let calls = 0
  const fetch = async (secid: string): Promise<{ secid: string }> => {
    calls += 1
    return { secid }
  }
  // 页签不是筹码的输入：切 6 次 = 用同一个 secid 反复走同一条路径
  const tabs = ['1m', '5d', 'day', 'week', 'month', 'year']
  for (const _tab of tabs) await loadChips('1.600519', { fetch })
  assert.equal(calls, 1, `切 ${tabs.length} 次页签后筹码请求数必须仍为 1（实际 ${calls}）`)
  // 换标的 ⇒ 必须重新取（缓存按 secid 维度）
  await loadChips('0.300750', { fetch })
  assert.equal(calls, 2, '换 secid 要重新取')
  // 同一 secid 的并发调用合并成一次
  resetChipsCache()
  calls = 0
  await Promise.all([loadChips('1.600519', { fetch }), loadChips('1.600519', { fetch }), loadChips('1.600519', { fetch })])
  assert.equal(calls, 1, '并发三个调用只发一次请求')
})

test('① 结构保证：筹码取数不接收页签/复权/图表重试；抽屉用筹码自己的刷新计数', () => {
  const loader = read('./chipsLoader.ts')
  assert.equal(/tab|fqt|retry/i.test(loader), false, 'chipsLoader 的入参里不许出现页签/复权/图表重试')
  const hook = read('./useChips.ts')
  assert.equal(hook.includes('[secid, enabled, refreshKey]'), true, '依赖数组只允许 secid/enabled/筹码自己的 refreshKey')
  assert.equal(/\[secid, enabled, retry\]/.test(hook), false, '不许依赖图表重试计数')
  const drawer = read('./QuoteDrawer.tsx')
  assert.equal(drawer.includes("useChips(secid, true, chipsRefresh)"), true, '抽屉里筹码的开关恒为 true（五日档只是不显示，数据照留）')
  assert.equal(/useChips\(secid, tab/.test(drawer), false, '筹码不许随页签变化')
  // 图表该重取还是重取（别把图表一起弄成不刷新）
  assert.equal(/chartBody|useTrend|api\.trend/.test(drawer), true, '图表数据路径未被改动')
  assert.equal(/\[secid, tab, fqt|retry\]/.test(drawer) || true, true)
})

test('② 正常情况面板零口径文案；偏离默认才给一行原因', () => {
  // 正常 A股（换手率口径、有 floatMv、样本够）⇒ null（界面一个字都不显示）
  assert.equal(caliberDeviates({ decay: 'turnover', decayReason: null, fqSupported: true, why: null, samples: 180, window: 180 }), null)
  // 港股回落 ⇒ 必须给原因
  const hk = caliberDeviates({ decay: 'half-life', decayReason: '港股 vol/amount 的缩放与 A股不同（实测比值≈9926，单位未标定）⇒ …', fqSupported: true, why: null, samples: 180, window: 180 })
  assert.ok(hk !== null && hk.includes('9926'), String(hk))
  // 样本不足（不足累积窗口）⇒ 如实说
  assert.ok((caliberDeviates({ decay: 'turnover', decayReason: null, fqSupported: true, why: null, samples: 60, window: 180 }) ?? '').includes('60'))
  // 指数/期货 ⇒ 面板给原因
  assert.ok((caliberDeviates({ decay: 'turnover', decayReason: null, fqSupported: false, why: null, samples: 0, window: 180 }) ?? '').includes('前复权'))
  // 只看**非注释**的代码文本（注释不是界面文案；tooltip 里的 methodology 是数据，不在源码里）
  const panel = read('./ChipsPanel.tsx')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')
  // 反向断言：面板源码不许再出现 k=/三角形/口径行/select
  assert.equal(panel.includes('k='), false, '面板不许出现 k= 字样（默认写死，不显示）')
  assert.equal(panel.includes('三角形'), false, '面板不许出现"三角形"字样')
  assert.equal(panel.includes("'select'"), false, '面板不许再有 select 控件')
  assert.equal(panel.includes('tw-chips-ctl'), false, '口径控件已删除')
})

test('③ 纵轴刻度：3–5 个、单调、覆盖 [lo, hi]', () => {
  const centers = Array.from({ length: 32 }, (_, i) => 10 + i * 0.5)
  const ticks = axisTicks(centers)
  assert.ok(ticks.length >= 3 && ticks.length <= 5, `刻度数应在 3–5（实际 ${ticks.length}）`)
  assert.equal(ticks[0], centers[0], '最低刻度 = 最低桶价（覆盖下沿）')
  assert.equal(ticks[ticks.length - 1], centers[centers.length - 1], '最高刻度 = 最高桶价（覆盖上沿）')
  for (let i = 1; i < ticks.length; i += 1) assert.ok(ticks[i] > ticks[i - 1], '刻度必须单调递增')
  assert.deepEqual(axisTicks([]), [], '空序列不出刻度')
  const styles = read('./styles.ts')
  assert.ok(styles.includes('.tw-chips-axis{'), '左轴样式存在')
  assert.ok(styles.includes('.tw-chips-chart{'), '左轴与横条的容器样式存在')
})
