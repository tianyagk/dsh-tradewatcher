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
