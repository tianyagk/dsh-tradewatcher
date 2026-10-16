/**
 * v0.98.0（用户建议批 ②）：护盘总分可视化 —— **语义必须是"异常程度"**。
 *
 * 用户提议里被**否决**的两条（红线，断言会盯住）：
 *   · 不得写「强烈买入」这类结论；
 *   · 不得做成「≥80 红 / ≤30 绿」的买卖映射 ⇒ 用**中性色阶**，刻度文案只许是「异常程度 …」。
 * 另：既有「触发后对照」保留，但**不得**呈现为胜率/概率（本轮把展示标签一并改了）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { abnormalColorOf, abnormalLabelOf, ringDashOf } from './rescueView.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(here, p), 'utf8')
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('② 环形进度：dash 随分数线性、null ⇒ 全空；反例（比例算错）必败', () => {
  const C = 2 * Math.PI * 26
  assert.equal(ringDashOf(null).dash, 0, '没有分数 ⇒ 实线段为 0（不假装有个环）')
  assert.ok(Math.abs(ringDashOf(null).gap - C) < 0.01, '没分数 ⇒ 整圈都是空隙')
  assert.ok(Math.abs(ringDashOf(100).dash - C) < 0.01, '100 分 ⇒ 整圈填满')
  assert.ok(Math.abs(ringDashOf(50).dash - C / 2) < 0.01, '50 分 ⇒ 半圈')
  assert.ok(ringDashOf(80).dash > ringDashOf(30).dash, '单调递增')
  assert.equal(ringDashOf(150).dash, ringDashOf(100).dash, '超过 100 夹到 100（不画出圈的环）')
  // 反例注入：把比例算成"分数本身"（漏除 100）⇒ 判据必须失败
  const broken = (score: number): number => C * (score / 1)
  assert.throws(
    () => assert.ok(Math.abs(broken(50) - C / 2) < 0.01, '反例上"50 分必须半圈"必须失败'),
    /反例上/,
    '⚠ 反例注入（环形比例算错）必须让断言失败',
  )
})

test('② 刻度文案只描述「异常程度」，且中性色阶与买卖方向无关', () => {
  for (const s of [null, 0, 30, 40, 60, 100]) {
    const label = abnormalLabelOf(s)
    assert.ok(label.startsWith('异常程度'), `刻度文案必须以「异常程度」开头（实际 ${label}）`)
    for (const forbidden of ['买入', '卖出', '建议', '胜率', '概率', '红', '绿']) {
      assert.equal(label.includes(forbidden), false, `刻度文案不许出现「${forbidden}」（实际 ${label}）`)
    }
  }
  // 颜色是**中性阶梯**：低分值不是"绿=该买"，高分值也不是"红=该卖"（用具体色值断言，不依赖语义）
  const low = abnormalColorOf(10)
  const mid = abnormalColorOf(40)
  const high = abnormalColorOf(60)
  assert.notEqual(low, mid, '不同档位颜色不同（否则环看不出程度）')
  assert.notEqual(mid, high, '同上')
  assert.equal(low.includes('up') || low.includes('down'), false, '低档不许用涨跌色（那是方向语义）')
  assert.equal(high.includes('up') || high.includes('down'), false, '高档不许用涨跌色')
  // 反例注入：给刻度文案塞一个买卖结论 ⇒ 判据必须失败
  const bad = (s: number): string => (s >= 80 ? '强烈买入（异常程度 偏高）' : abnormalLabelOf(s))
  assert.throws(
    () => assert.equal(bad(85).includes('强烈买入'), false, '反例上"不许出现买卖结论"必须失败'),
    /反例上/,
    '⚠ 反例注入（给总分贴买卖标签）必须让断言失败',
  )
})

test('② 接线：分数旁有环形、量能条带标定阈值线；且界面**不出现**买卖/胜率字样', () => {
  const ui = strip(read('RescuePanel.tsx'))
  assert.ok(ui.includes("'data-role': 'score-ring'"), '总分旁必须有环形进度条')
  assert.ok(ui.includes('ringDashOf(snapshot.score)'), '环的参数必须来自纯函数（不现算）')
  assert.ok(ui.includes("'data-role': 'threshold-line'"), '进度条必须带阈值线标记')
  assert.ok(ui.includes('RESCUE_F1_EXTREME'), '阈值线必须用宿主标定值（不许自己拍一个）')
  assert.ok(ui.includes('abnormalLabelOf(snapshot.score)'), '环形要有"异常程度"可读名（读屏也能拿到）')
  // 红线反向断言（**只掐肯定式**）：买卖结论一个都不许有；
  // 「胜率/概率」只掐**带数字的肯定式声明**——"不是胜率、概率或预测""概率性信号而非身份确认"
  // 这类**否定/解释**句是我们要的诚实边界，必须留着。
  for (const forbidden of ['强烈买入', '建议买入', '建议卖出', '买入信号', '卖出信号', '建议仓位']) {
    assert.equal(ui.includes(forbidden), false, `界面不许出现「${forbidden}」`)
  }
  const quantified = /(胜率|上涨概率|下跌概率|买入概率)\s*[:：]?\s*\d/
  assert.equal(quantified.test(ui), false, '不许把历史频率写成带数字的胜率/概率声明')
  // 而"否定式"的诚实说明应当存在（既有的触发后对照必须保留、但不得呈现为概率）
  // 诚实边界：必须**明说**这不是胜率/概率（措辞可有多种，判据认语义）
  assert.ok(/不是\*\*胜率|不是\*胜率|不是.*胜率.*概率|非胜率\/概率/.test(ui), '必须明说这不是胜率/概率（诚实边界）')
  assert.ok(ui.includes('触发后对照'), '既有「触发后对照」保留（只改措辞，不删功能）')
  assert.equal(ui.includes('概率 +'), false, '⚠ 旧的「概率 +x%/N日」展示标签必须已改掉')
  // 反例注入：把一条肯定式买卖文案塞回界面 ⇒ 判据必须失败
  const injected = `${ui}\nconst bad = '强烈买入'\n`
  assert.throws(
    () => assert.equal(injected.includes('强烈买入'), false, '反例上"不许出现买卖结论"必须失败'),
    /反例上/,
    '⚠ 反例注入（塞回买卖文案）必须让断言失败',
  )
  // 再注入一条"带数字的胜率声明"（用户提议里被否决的那类）⇒ 判据必须失败
  const injectedRate = `${ui}\nconst bad2 = '触发后 30 分钟胜率 65%'\n`
  assert.equal(quantified.test(injectedRate), true, '⚠ 反例（胜率 65%）必须能被判据抓住')
  assert.throws(
    () => assert.equal(quantified.test(injectedRate), false, '反例上"不许出现胜率数字"必须失败'),
    /反例上/,
    '⚠ 反例注入（胜率/概率数字）必须让断言失败',
  )
})
