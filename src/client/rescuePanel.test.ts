/**
 * 「同时点量能」极端档阈值的一致性：`RescuePanel.tsx` 里的字面量与标定值必须同源。
 *
 * 背景（REVIEW-1 §5.1-⑥ / §5.3 的客户端魔数）：面板用 `>= 1.63` 决定是否上极端档配色，
 * 而 1.63 是**更早一次标定的 P90**；现行标定（`src/host/rescue-thresholds.ts` 的
 * `RESCUE_CALIBRATION.f1`）是 `{mid: 1.19, high: 1.57, extreme: 1.92}`，README 同步写着
 * P75/P90/P95 = 1.19/1.57/1.92x。客户端不 import 宿主模块（架构约定：client 只 import shared），
 * 因此这里用**跨文件同步断言**守住两处：改一处而不改另一处 ⇒ 本用例失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const panel = readFileSync(join(HERE, 'RescuePanel.tsx'), 'utf8')
const calib = readFileSync(join(HERE, '..', 'host', 'rescue-thresholds.ts'), 'utf8')

test('护盘面板的「同时点量能」极端档阈值 == 标定 f1.extreme（且不再是旧的 1.63）', () => {
  const m = /const RESCUE_F1_EXTREME = ([\d.]+)/.exec(panel)
  assert.notEqual(m, null, '面板必须用具名常量（不许再把魔数写进 JSX 表达式）')
  const panelValue = Number(m?.[1])
  const calibMatch = /"mid":\s*([\d.]+),\s*\n\s*"high":\s*([\d.]+),\s*\n\s*"extreme":\s*([\d.]+)/.exec(calib)
  assert.notEqual(calibMatch, null, '标定文件必须给出 f1 的 mid/high/extreme')
  const extreme = Number(calibMatch?.[3])
  assert.equal(panelValue, extreme, `面板阈值 ${panelValue} 必须等于标定的极端档 ${extreme}`)
  // 两向：旧值 1.63 是失效的 P90，不许回来
  assert.notEqual(panelValue, 1.63, '1.63 是更早一次标定的 P90（已失效），不得回退')
  assert.equal(Number(calibMatch?.[1]), 1.19, '标定 mid 值（P75）变化时本用例应提醒同步 README 的 P75/P90/P95 文案')
})

test('⑥ 跨日分位来自快照契约：显示「分位 X%（N=…）」；缺数据 ⇒ 保留原因文案；**客户端不得现算**', () => {
  const panel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'RescuePanel.tsx'), 'utf8')
  // ① 只读契约字段，不自己算分位（现算会让"同一份数据两套口径"）
  assert.equal(/scorePercentile/.test(panel), false, '客户端不许引用宿主的打分函数（那是宿主侧的实现）')
  assert.equal(/percentile\s*=|filter\(.*<=\s*value/.test(panel), false, '客户端不许自己算分位（不许出现排序/计数式分位实现）')
  for (const field of ['continuousPercentile', 'continuousPercentileN', 'continuousPercentileWhy']) {
    assert.equal(panel.includes(field), true, `面板必须读契约字段 ${field}`)
  }
  // ② 可见部分：有分位 ⇒ 「分位 X%（N=…）」；没有 ⇒ 短标记「—」+ 原因进 title
  assert.equal(/分位 \$\{/.test(panel) || panel.includes('分位 $'), true, '可见部分要显示分位')
  assert.equal(panel.includes('N=${snapshot.continuousPercentileN ?? 0}'), true, '样本数要一起显示')
  // ③ 缺数据时必须保留"原因"这句（而不是删掉事实）
  assert.equal(panel.includes('snapshot.continuousPercentileWhy ??'), true, '缺数据 ⇒ 原因文案必须来自契约')
  // ④ 反例注入：让客户端"自己算分位"⇒ 上面的扫描必须红
  const injected = panel.replace('snapshot.continuousPercentile.toFixed(0)', 'scorePercentile(snapshot.continuous ?? 0, []).pct.toFixed(0)')
  assert.notEqual(injected, panel, '⚠ 反例应能改动面板源码（若相等说明注入点已变）')
  assert.throws(() => {
    assert.equal(/scorePercentile/.test(injected), false, '客户端不许自己算分位')
  }, /客户端不许自己算分位/, '⚠ 反例（客户端自算分位）必须失败')
})
