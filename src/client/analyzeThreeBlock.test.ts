/** 决策流 ANALYZE 卡片：三行摘要块（观察/推理/结论）必须优先，且结论不得退回 summary */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { threeOf } from './prismDeskMid.ts'

const report = `## 中证1000\n- **判断**：最弱的一只。\n- **依据**：均线：5812.32 低于 MA5。\n\n观察：中证1000 收盘 5812.32，低于 MA5 1.6%，均线空头排列。\n推理：中证1000 近 5 日缩量，量比 0.89，反弹缺量。\n结论：中证1000 维持弱势，等放量站上 MA5 再谈反转。`

test('① 有三行块 ⇒ 只用块（观察/推理/结论都带主语）', () => {
  const t = threeOf(report, '必须先降低风险暴露，而且只降一条腿。')
  assert.match(t.observation!, /^中证1000 收盘/)
  assert.match(t.reasoning!, /^中证1000 近 5 日/)
  assert.match(t.conclusion!, /^中证1000 维持弱势/)
  assert.ok(!/降低风险暴露/.test(t.conclusion!), '结论不得退回 summary 的组合级句子')
})

test('② 没有块 ⇒ 用本报告自己的判断句，不跳到 summary（老数据也不再四卡同句）', () => {
  const old = '## 标题\n- **判断**：最弱的一只。\n- **依据**：均线：5812.32 低于 MA5。'
  const t = threeOf(old, '四路要点。第二句。')
  assert.equal(t.reasoning, '最弱的一只。')
  assert.equal(t.observation, '均线：5812.32 低于 MA5。')
  assert.equal(t.conclusion, '最弱的一只。', '结论应来自本报告')
  const noJudge = '## 标题\n正文。'
  assert.equal(threeOf(noJudge, '汇总第一句。第二句。').conclusion, '汇总第一句。', '确实没有自身判断才用 summary')
})

test('③ 只有部分块（缺结论）⇒ 结论仍走旧兜底，另外两行用块', () => {
  const partial = '观察：沪深300 收 3958.29。\n推理：沪深300 MACD 柱转正。'
  const t = threeOf(partial, '汇总第一句。')
  assert.match(t.observation!, /^沪深300/)
  assert.match(t.reasoning!, /^沪深300/)
  assert.equal(t.conclusion, '汇总第一句。')
})

test('④ 提示词必须带输出契约（三行 + 主语 + 不写组合级动作）', () => {
  const pipe = readFileSync(new URL('../host/prismPipeline.ts', import.meta.url), 'utf8')
  assert.match(pipe, /【输出格式·必守】/)
  assert.match(pipe, /观察：<本段对象名>/)
  assert.match(pipe, /不要写「降低风险暴露\/只降一条腿」/)
})
