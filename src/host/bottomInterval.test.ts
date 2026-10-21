/**
 * 底部概率区间的**已知局限声明**（R2 测量后上屏）—— 文案纪律 + 链路 + 引用面 + 反例注入。
 *
 * 背景：`calibratePooled` 把「通道 × 日」的命中直接喂给 Wilson。同一天多个通道高度相关（同一市场事件），
 * 相邻日的前向窗口又重叠 ⇒ 实际独立样本远少于 `n`，**区间偏窄**。实测（`docs/AUDIT-IMPL89.md` §9）：
 * 去横截面重复后 N 降 46.8%，再去前向窗口重叠后降 81.0%。
 *
 * 本文件锁四件事：
 *  ① 声明**只有一个来源**（`BOTTOM_INTERVAL_CAVEAT`），且校准结果一定带上它；
 *  ② 措辞**不写数字**（不是"准确率"、也不给"偏窄多少"）—— 只声明方向与原因；
 *  ③ 它**不进工具详情页**（`detailModel` / `toolRegistry` / `ToolsPage` 一律不消费）；
 *  ④ 大盘页把它挂在「历史频率」的 `title`/`aria-label`（源码锚 + 注入删除必败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

import { BOTTOM_INTERVAL_CAVEAT } from '../shared/model.ts'
import { buildBottomLane, calibrateAcross, calibratePooled, calibrateBottom } from './bottom.ts'
import type { DailyBarLite } from '../shared/model.ts'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..')

/** 确定性日线（120 根，够 `calibratePooled` 的 80 根门槛）：不依赖任何外部数据 */
function bars(count = 120, seed = 1): DailyBarLite[] {
  const out: DailyBarLite[] = []
  let price = 3 + seed * 0.1
  for (let i = 0; i < count; i += 1) {
    // 正弦 + 轻微漂移：既能造出"低分位"日，也能造出放量日
    price = Math.max(0.5, price * (1 + Math.sin(i / 7 + seed) * 0.01 + 0.0004))
    const vol = 100000 + Math.round(Math.abs(Math.sin(i / 3 + seed)) * 90000)
    const open = price * 0.998
    const high = price * 1.006
    const low = price * 0.994
    out.push({ date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, open, close: price, high, low, vol })
  }
  return out
}

test('① 校准结果一定带声明，且声明只有一个来源（三个入口都一样）', () => {
  const pooled = calibratePooled([bars(), bars(120, 2)])
  assert.equal(pooled.intervalNote, BOTTOM_INTERVAL_CAVEAT, '`calibratePooled` 必须原样带上唯一来源的那句')
  assert.equal(calibrateAcross([bars(), bars(120, 2)]).intervalNote, BOTTOM_INTERVAL_CAVEAT, '`calibrateAcross` 是同一个实现（别名），也必须带')
  assert.equal(calibrateBottom(bars()).intervalNote, BOTTOM_INTERVAL_CAVEAT, '单通道入口同样要带（否则那条路径的界面没有声明）')
})

test('② 措辞纪律：说清"重复计入 + 偏窄"，且**不出现任何数字**（不是准确率、也不给幅度）', () => {
  const note = BOTTOM_INTERVAL_CAVEAT
  assert.ok(note.includes('重复计入'), `必须点明原因（同日多通道重复计入）：${note}`)
  assert.ok(note.includes('偏窄'), `必须点明方向（区间偏窄）：${note}`)
  assert.equal(/\d/.test(note), false, `声明里不许出现数字（会被读成"准确率/误差"）：${note}`)
  assert.equal(/准确率|命中率|精确|可靠/.test(note), false, `不许出现"准确率"类措辞：${note}`)
  // 反例注入：给它加一个数字 / 换成"区间精确" ⇒ 上面两条判据必须失败（证明判据非恒真）
  const withNumber = `${note}（约 80%）`
  assert.throws(() => assert.equal(/\d/.test(withNumber), false, '反例：带数字'), /反例/, '⚠ 带数字的声明必须被判据拒绝')
  const precise = '区间精确'
  assert.throws(() => assert.ok(precise.includes('偏窄'), '反例：换成"区间精确"'), /反例/, '⚠ "区间精确"必须被拒')
})

test('③ 链路：声明随 `buildBottomLane` 走进快照（界面读的是这一份，不是自己算）', () => {
  const lane = buildBottomLane({
    secid: '1.510300',
    name: '沪深300ETF',
    bars: bars(),
    price: 3.2,
    open: 3.19,
    high: 3.21,
    low: 3.18,
    volumeRatio: 1.2,
    calibration: calibratePooled([bars(), bars(120, 2)]),
  })
  assert.equal(lane.calibration.intervalNote, BOTTOM_INTERVAL_CAVEAT, '单通道视图必须带上它（大盘页从这里取）')
})

test('④ 引用面锁定：只有 3 个文件碰它 —— `detailModel` / 工具页一律不消费', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) out.push(p)
    }
    return out
  }
  const files = walk(SRC)
  const hit = files.filter((f) => {
    const src = readFileSync(f, 'utf8')
    return src.includes('BOTTOM_INTERVAL_CAVEAT') || src.includes('intervalNote')
  })
  const rel = hit.map((f) => relative(SRC, f)).sort()
  assert.deepEqual(rel, ['host/bottom.ts', 'shared/model.ts', 'client/RescuePanel.tsx'].sort(), `引用面必须恰好是这三处（实得 ${JSON.stringify(rel)}）`)
  // 工具详情页（模型层 + 页面）不许出现它 —— 它属于大盘页的口径，不属于工具页
  for (const f of ['client/toolRegistry.ts', 'client/ToolsPage.tsx']) {
    const src = readFileSync(join(SRC, f), 'utf8')
    assert.equal(src.includes('intervalNote') || src.includes('BOTTOM_INTERVAL_CAVEAT'), false, `${f} 不许消费该声明（不得进 detailModel）`)
  }
})

test('⑤ 大盘页把它挂在「历史频率」的 title / aria-label（源码锚 + 注入删除必败）', () => {
  const src = readFileSync(join(SRC, 'client/RescuePanel.tsx'), 'utf8')
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const at = clean.indexOf("'历史频率'")
  assert.ok(at > 0, '必须能找到「历史频率」这一处文案')
  const around = clean.slice(Math.max(0, at - 900), at)
  assert.ok(around.includes('calibration.intervalNote'), '「历史频率」的 title 必须来自校准结果上的 `intervalNote`')
  assert.ok(around.includes('title:') && around.includes("'aria-label':"), '标题与读屏标签都要有（只有 title 等于键盘/触屏拿不到）')
  // 注入：把 title 那段删掉 ⇒ 上面的判据必须失败
  const removed = clean.slice(0, at - 900) + clean.slice(Math.max(0, at - 900), at).replace(/title: snapshot\.bottom\.lanes\[0\]\.calibration\.intervalNote/g, '') + clean.slice(at)
  assert.throws(
    () => assert.ok(removed.slice(Math.max(0, at - 900), at).includes('title: snapshot.bottom.lanes[0].calibration.intervalNote'), '反例：删掉 title'),
    /反例/,
    '⚠ 删掉 title 后必须失败（判据非空）',
  )
})
