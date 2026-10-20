/**
 * AUDIT-IMPL84（UI 侧）：**非当日序列的图头不许装作是今天**。
 *
 * 真机现象：当日分时落进 LKG 时，图头那一行仍是
 *   `昨收 4.24 · 09:30 ~ 15:00`
 * ——日期一个字都没有，读者把它读成"今天的分时"；五日档那一行更直白地写「（末行为今日）」，
 * 而末行其实是 10-19。这类"看着正常的错数"属红线。
 *
 * 本文件钉住两处**可见文案**（脚注那一句在 `chartNote.test.ts` 里钉）：
 *  ① 单日档：非当日时必须把数据自己的日期写进时段（`10-19 09:30 ~ 15:00`）；
 *  ② 多日档：「末行为今日」必须按宿主给的 `nonSession` 改口成「末行为 2026-10-19」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { nonSessionNote, visibleProvenanceOf } from './chartNote.ts'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')
/** 去掉注释再断言：说明性注释里会**提到**旧写法（「末行为今日」正是注释里的反例描述） */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 判据：返回违规清单。真源码必须是空数组；把"装作是今天"的写法加回去 ⇒ 必须非空 */
export function nonSessionUiProblems(src: string): string[] {
  const bad: string[] = []
  if (!src.includes('const ns = nonSessionOf(payload)')) bad.push('图头没有读宿主给的 nonSession（无从判断"是不是今天的"）')
  if (!src.includes('ns === null ? first.label.slice(11) : first.label.slice(5)')) {
    bad.push('单日图头在"非当日"时仍然只显示 HH:mm（日期被吃掉 ⇒ 会被读成今天）')
  }
  if (/末行为今日/.test(src)) bad.push('多日图头无条件写「末行为今日」（末行不一定是今天）')
  if (!src.includes("ns === null ? '今日' : ` ${ns.day}`")) bad.push('多日图头没有按 nonSession 改口')
  return bad
}

test('AUDIT-IMPL84 ②：非当日时图头必须写出数据自己的日期（单日 + 多日）', () => {
  const drawer = strip(read('./QuoteDrawer.tsx'))
  assert.deepEqual(nonSessionUiProblems(drawer), [], `图头仍可能把昨天的图写成今天：${JSON.stringify(nonSessionUiProblems(drawer))}`)
  // "非当日"这一句必须仍然**可见**（不许被 TTL 缓存那类提示折叠掉）
  assert.notEqual(visibleProvenanceOf(nonSessionNote('2026-10-19')), '', '非当日数据必须常驻可见')
})

test('AUDIT-IMPL84 ② 反例注入：图头恢复成"恒 slice(11) + 末行为今日" ⇒ 判据必败', () => {
  const drawer = strip(read('./QuoteDrawer.tsx'))
  const injected = drawer
    .replace('ns === null ? first.label.slice(11) : first.label.slice(5)', 'first.label.slice(11)')
    .replace("ns === null ? '今日' : ` ${ns.day}`", '今日')
  assert.notDeepEqual(nonSessionUiProblems(injected), [], '⚠ 反例（旧的图头写法）必须被抓住')
  assert.throws(
    () => assert.deepEqual(nonSessionUiProblems(injected), [], '图头仍可能把昨天的图写成今天'),
    /图头仍可能把昨天的图写成今天/,
    '⚠ 反例注入（图头装作是今天）必须让断言失败',
  )
})
