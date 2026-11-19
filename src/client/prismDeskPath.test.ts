/** v0.203.1：desk 必须从回包顶层读取（曾在 state 内读，导致四区块恒「未取到」） */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PAGE = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')

test('① desk 从顶层读取，不得再读 state.state.desk', () => {
  assert.ok(!/state\?\.state[^\n]*\.desk/.test(PAGE), '不得出现 state?.state … desk（旧错误路径）')
  assert.match(PAGE, /\{\s*desk\?:\s*Desk\s*\}/, '应存在顶层 desk 类型引用')
})

test('② 已用/上限按万元显示（除以 1e4），不得除以 1e8', () => {
  assert.match(PAGE, /used \/ 1e4/)
  assert.ok(!/used \/ 1e8/.test(PAGE), '不得再用 1e8（会显示 0.01/0.02 这类错值）')
})

test('③ 字段名与宿主 desk 对齐（曾经用 total/target/source/alpha/maxDD/decisions/winRate 全部错位）', () => {
  for (const k of ['totalAssets', 'targetPrice', 'origin', 'excessPct', 'maxDrawdown', 'runsCount', 'hitRate']) {
    assert.ok(PAGE.includes(k), `缺少宿主字段 ${k}`)
  }
  for (const bad of ['ov.total ', 'ov.total/', 'f.target ', 'pf.alpha', 'pf.maxDD', 'pf.decisions', 'pf.winRate']) {
    assert.ok(!PAGE.includes(bad), `不得再引用错位字段 ${bad}`)
  }
})

test('④ 比例字段必须 ×100（positionPct 0.7838 ⇒ 78.38%）', () => {
  assert.match(PAGE, /ratioPctOf/)
  assert.match(PAGE, /v \* 100/)
  assert.match(PAGE, /ratioPctOf\(ov\.positionPct\)/)
})

test('⑤ 状态与来源中文化', () => {
  assert.match(PAGE, /filled: '已成交'/)
  assert.match(PAGE, /auto: '自动'/)
  assert.ok(!/f\.status \?\? '—'/.test(PAGE), '不得直接显示英文 status')
})
