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
