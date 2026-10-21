/**
 * 载荷闸门（`src/shared/payloadGate.ts`）的断言 —— **双向**：既证明"注入坏样本必报"，也证明"真实载荷必放"。
 *
 * 双向是有先例的：`src/assertStrength.test.ts` 对"恒真断言"用的就是同一套做法（坏样本必命中 / 好样本不误报）。
 * 只测"抓得住"的门禁很容易写成恒真：判据永远命中，或者永远不命中，测试都绿。
 *
 * 真实载荷来自本机只读测量（2026-10-21，从未写过 `~/.dsh`）：
 *  · `fixtures/cake-full.json`      —— `globalFlowPayload({source:'snapshot'})` 的真实回包（4 个序列日 / 5 个市场）；
 *  · `fixtures/cake-empty.json`     —— 同一个调用在**空 DSH_HOME**下的回包（无快照 ⇒ 整块缺失）；
 *  · `fixtures/leverage-full.json`  —— `buildLeveragePayload(真实 4019 行, '250')`；
 *  · `fixtures/leverage-empty.json` —— `emptyLeveragePayload('250')`（契约里的"没有可用数据"）。
 * 生成脚本与命令写在 `docs/AUDIT-IMPL89.md` §数据；夹具里没有任何个人数据（全是市场数据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { gateLines, gatePasses, gateProblems, type GateInput } from './payloadGate.ts'
import { gateInputOfCake, globalFlowToolData } from '../client/tools/globalFlowView.ts'
import { gateInputOfLeverage, leverageCards } from '../client/tools/leverageView.ts'
import type { GlobalFlowPayloadDto, LeveragePayloadDto } from '../client/api.ts'
import { DASH } from '../client/tools/leverageView.ts'
import type { ToolData } from '../client/toolRegistry.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(here, '..', 'client', 'tools', 'fixtures', name), 'utf8')) as T

const cakeFull = fixture<GlobalFlowPayloadDto>('cake-full.json')
const cakeEmpty = fixture<GlobalFlowPayloadDto>('cake-empty.json')
const leverageFull = fixture<LeveragePayloadDto>('leverage-full.json')
const leverageEmpty = fixture<LeveragePayloadDto>('leverage-empty.json')

/** 深拷贝（注入用：绝不改坏夹具本身，后面的用例还要用同一份） */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/**
 * **豁免清单（条数锁定）**：唯一允许"整屏一条出处"的载荷，必须写清理由。
 * 新增一条就要改这里的数字 —— 这正是"不许悄悄跳过检查"的闸门。
 */
const EXEMPT_PAYLOAD_SCOPE: ReadonlyArray<{ name: string; why: string }> = [
  { name: '杠杆温度计', why: '用户明确要求本页不写口径/来源，也不显示日期小字（leverageHeader.test.ts ①：加回「截至」必败）' },
]

/* ────────────────────────── 一、三类判据的单元断言 ────────────────────────── */

const baseInput = (over: Partial<GateInput> = {}): GateInput => ({
  name: '示例载荷',
  asOfText: '数据时刻 2026-10-20 15:05（北京时间）',
  why: null,
  sourceScope: 'cell',
  cells: [{ where: '格 1', value: '1.23%', source: '来源：某接口', missingReason: null }],
  invariants: [],
  ...over,
})

test('① source：有值但没有出处 ⇒ 必报（这正是"看起来正常但说不清来源"的形态）', () => {
  const problems = gateProblems(baseInput({ cells: [{ where: '格 1', value: '1.23%', source: null, missingReason: null }] }))
  assert.equal(problems.length, 1)
  assert.equal(problems[0].cls, 'source')
  assert.match(problems[0].where, /格 1/)
})

test('① source：没有值但没有原因 ⇒ 必报（「—」本身不是信息）', () => {
  const problems = gateProblems(baseInput({ cells: [{ where: '格 2', value: null, source: null, missingReason: null }] }))
  assert.equal(problems.length, 1)
  assert.equal(problems[0].cls, 'source')
})

test('① source：**0 顶替**必须被抓住 —— 历史事故的形态（值为 0.00%、无出处、无原因）', () => {
  // 复刻 `AUDIT-HY4-1 §9.2` 的形态：全缺时给了 `0.00%`，看起来像一个真实读数
  const problems = gateProblems(baseInput({ cells: [{ where: '市场表 美股 份额', value: '0.00%', source: null, missingReason: null }] }))
  assert.equal(problems.length, 1)
  assert.equal(problems[0].cls, 'source')
  assert.match(problems[0].detail, /没有出处声明/)
})

test('① source：有值有出处、或缺值有原因 ⇒ 放行（否则闸门只会永远报警）', () => {
  assert.deepEqual(gateProblems(baseInput()), [])
  assert.deepEqual(
    gateProblems(baseInput({ cells: [{ where: '格 3', value: null, source: null, missingReason: '本次失败，稍后重试' }] })),
    [],
  )
})

test("① source：`payload` 档（整屏一条出处）**必须写理由**，否则它就是跳过检查的后门", () => {
  const missingWhy = gateProblems(baseInput({ sourceScope: 'payload' }))
  assert.equal(missingWhy.length, 1)
  assert.equal(missingWhy[0].cls, 'source')
  assert.match(missingWhy[0].detail, /没有写理由/)
  assert.deepEqual(gateProblems(baseInput({ sourceScope: 'payload', sourceScopeWhy: '用户要求不写口径' })), [])
})

test('② date：没有数据时刻、也没有整块缺失原因 ⇒ 必报；给了原因 ⇒ 放行', () => {
  const problems = gateProblems(baseInput({ asOfText: null }))
  assert.equal(problems.length, 1)
  assert.equal(problems[0].cls, 'date')
  assert.deepEqual(gateProblems(baseInput({ asOfText: null, why: '本次没有取到任何数据（上游全失败）' })), [])
  assert.deepEqual(gateProblems(baseInput({ asOfText: '   ' })), gateProblems(baseInput({ asOfText: null })), '空白字符串等于没有')
})

test('③ caliber：不变量不成立 ⇒ 必报，且 detail 里带实际值与期望值（不是一句"不通过"）', () => {
  const problems = gateProblems(baseInput({ invariants: [{ label: '份额合计', actual: 97, expected: 100, tolerance: 0.5 }] }))
  assert.equal(problems.length, 1)
  assert.equal(problems[0].cls, 'caliber')
  assert.match(problems[0].detail, /97/)
  assert.match(problems[0].detail, /100/)
  assert.deepEqual(gateProblems(baseInput({ invariants: [{ label: '份额合计', actual: 99.7, expected: 100, tolerance: 0.5 }] })), [], '容差内必须放行')
})

test('③ caliber：算不出来（actual 为 null）却没有原因 ⇒ 必报（"判不了"不等于"没问题"）', () => {
  const problems = gateProblems(baseInput({ invariants: [{ label: '贡献度之和', actual: null, expected: 55 }] }))
  assert.equal(problems.length, 1)
  assert.equal(problems[0].cls, 'caliber')
  assert.deepEqual(gateProblems(baseInput({ invariants: [{ label: '贡献度之和', actual: null, expected: 55, why: '当天没有出分' }] })), [])
})

test('一次跑出多类问题时按 source → date → caliber 分组（报告可直接贴）', () => {
  const problems = gateProblems(baseInput({
    asOfText: null,
    cells: [{ where: '格 1', value: '1', source: null, missingReason: null }],
    invariants: [{ label: '合计', actual: 1, expected: 2 }],
  }))
  assert.deepEqual(problems.map((p) => p.cls), ['source', 'date', 'caliber'])
  assert.equal(gateLines(problems).length, 3)
  assert.equal(gatePasses(problems), false)
})

/* ────────────────────────── 二、真实夹具必须放行（必放） ────────────────────────── */

test('必放 ①：资金蛋糕（真实快照载荷）⇒ 0 问题，且判据不是空的', () => {
  const data = globalFlowToolData(cakeFull, 0)
  const input = gateInputOfCake(data, cakeFull, 0)
  assert.deepEqual(gateLines(gateProblems(input)), [])
  // 判据非空：真实载荷必须真的被检查到（否则"0 问题"可能只是没检查）
  assert.ok(input.cells.length >= 5, `至少覆盖 5 个读数格（实得 ${input.cells.length}）`)
  assert.ok(input.invariants.length >= 4, `至少覆盖 4 条不变量（实得 ${input.invariants.length}）`)
  assert.match(String(input.asOfText), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '数据时刻必须是真实时刻')
})

test('必放 ②：资金蛋糕（空快照 ⇒ 整块缺失）⇒ 0 问题（缺失必须**有原因**，而不是有数字）', () => {
  const data = globalFlowToolData(cakeEmpty, 0)
  assert.notEqual(data.why, null, '这一份夹具本身就是"整块缺失"')
  const input = gateInputOfCake(data, cakeEmpty, 0)
  assert.deepEqual(gateLines(gateProblems(input)), [])
  // 缺数据的格必须各自带原因（不是只靠整块 why 兜住）
  const nullCells = input.cells.filter((c) => c.value === null)
  assert.ok(nullCells.length > 0, '空快照下应当有"没有值"的格')
  for (const cell of nullCells) assert.ok(String(cell.missingReason ?? '').trim() !== '', `缺数据的格必须给原因：${cell.where}`)
})

test('必放 ③：杠杆温度计（真实 250 日载荷）⇒ 0 问题；例外清单必须恰好 1 条且写了理由', () => {
  const input = gateInputOfLeverage(leverageFull)
  assert.deepEqual(gateLines(gateProblems(input)), [])
  assert.equal(input.sourceScope, 'payload')
  assert.ok(String(input.sourceScopeWhy ?? '').trim() !== '', '整屏一条出处必须写理由')
  // 豁免清单条数锁定：新增一条必须改这里的数字（改测试就要评审）
  assert.equal(EXEMPT_PAYLOAD_SCOPE.length, 1)
  assert.equal(input.name, EXEMPT_PAYLOAD_SCOPE[0].name)
  assert.ok(EXEMPT_PAYLOAD_SCOPE[0].why.includes('不写口径'), '理由要能对上用户口径的原文')
})

test('必放 ④：杠杆温度计（契约里的空载荷：asOf 空串 + 全 null）⇒ 0 问题', () => {
  const input = gateInputOfLeverage(leverageEmpty)
  assert.deepEqual(gateLines(gateProblems(input)), [])
  assert.equal(input.asOfText, null, '空串必须当成"没有时刻"')
  assert.notEqual(input.why, null, '没有时刻就必须给原因')
  const cards = leverageCards(leverageEmpty)
  assert.equal(cards.length, 8)
  assert.equal(cards.every((c) => c.value === DASH), true, '空载荷下每张卡都是 —')
})

/* ────────────────────────── 三、注入：真实载荷上的坏样本必须被抓住 ────────────────────────── */

test('⚠ 注入：把某个 KPI 的出处删掉 ⇒ 必报（真实载荷 + 单点注入）', () => {
  const data = clone(globalFlowToolData(cakeFull, 0))
  const labels = Object.keys(data.kpi ?? {})
  assert.ok(labels.length > 0, '夹具必须有 KPI 磁贴')
  const target = labels[0] as string
  const withValue = labels.find((k) => (data.kpi?.[k]?.value ?? null) !== null)
  assert.ok(withValue !== undefined, '至少要有一个"有值"的磁贴才能测这一支')
  const patched = { ...data, kpi: { ...data.kpi, [withValue]: { ...data.kpi?.[withValue], source: undefined } } } as ToolData
  const problems = gateProblems(gateInputOfCake(patched, cakeFull, 0))
  assert.equal(problems.length, 1, `只应报这一处（实得 ${JSON.stringify(gateLines(problems))}）`)
  assert.equal(problems[0].cls, 'source')
  assert.match(problems[0].where, new RegExp(withValue as string))
  assert.equal(target.length > 0, true)
})

test('⚠ 注入：把数据时刻抹掉 ⇒ date 必报（真实载荷）', () => {
  const payload = { ...clone(cakeFull), asOf: null }
  const data = globalFlowToolData(payload as GlobalFlowPayloadDto, 0)
  const problems = gateProblems(gateInputOfCake(data, payload as GlobalFlowPayloadDto, 0))
  assert.equal(problems.some((p) => p.cls === 'date'), true, `必须报 date：${JSON.stringify(gateLines(problems))}`)
})

test('⚠ 注入：把份额改成合计 97% ⇒ caliber 必报（真实载荷 + 单点注入）', () => {
  const payload = clone(cakeFull)
  const last = payload.curve.points[payload.curve.points.length - 1]
  const firstLive = last.share.findIndex((v) => v !== null)
  assert.ok(firstLive >= 0, '夹具里至少有一个有值份额')
  // 把第一个有值市场的份额砍掉 3 个百分点（其余不动）⇒ 合计 97%
  last.share[firstLive] = (last.share[firstLive] as number) - 0.03
  const data = globalFlowToolData(payload, 0)
  const problems = gateProblems(gateInputOfCake(data, payload, 0))
  const shareProblem = problems.find((p) => p.cls === 'caliber' && p.where.includes('份额合计'))
  assert.ok(shareProblem !== undefined, `必须报"份额合计"：${JSON.stringify(gateLines(problems))}`)
  assert.match(shareProblem.detail, /97/)
})

test('⚠ 注入：杠杆三条序列与日期轴不等长 ⇒ caliber 必报（真实载荷）', () => {
  const payload = clone(leverageFull)
  payload.temp = payload.temp.slice(0, -1)
  const problems = gateProblems(gateInputOfLeverage(payload))
  const hit = problems.find((p) => p.cls === 'caliber' && p.where.includes('温度序列点数'))
  assert.ok(hit !== undefined, `必须报温度序列长度：${JSON.stringify(gateLines(problems))}`)
  assert.match(hit.detail, new RegExp(`${payload.temp.length}`))
})

test('⚠ 注入：给空载荷塞进一个日期（三条序列仍为空）⇒ 三条序列各报一条 caliber', () => {
  // 这一条覆盖"空载荷"分支：真实空载荷必须放行（必放 ④），但一旦日期轴与序列不一致就必须报
  const payload = clone(leverageEmpty)
  payload.dates = ['2026-10-20']
  const problems = gateProblems(gateInputOfLeverage(payload))
  assert.equal(problems.filter((p) => p.cls === 'caliber').length, 3, `三条序列都要报（实得 ${JSON.stringify(gateLines(problems))}）`)
})

/* ────────────────────────── 四、闸门本身不许被绕过 ────────────────────────── */

test('闸门不 import React / 不碰 IO：模块里不得出现 react、fs、fetch（判据锚在源码上）', () => {
  const src = readFileSync(join(here, 'payloadGate.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const banned of ["from 'react'", "from 'node:fs'", 'fetch(', 'XMLHttpRequest']) {
    assert.equal(code.includes(banned), false, `闸门不得出现 ${banned}（它必须能在 node --test 里直接跑）`)
  }
  assert.equal(/process\.env/.test(code), false, '闸门不读环境变量（同一份输入必须给同一份结论）')
})

test('两个适配器都走同一个判据（不许各写一套：单一实现在 shared/payloadGate.ts）', () => {
  const cakeSrc = readFileSync(join(here, '..', 'client', 'tools', 'globalFlowView.ts'), 'utf8')
  const lvSrc = readFileSync(join(here, '..', 'client', 'tools', 'leverageView.ts'), 'utf8')
  for (const [name, src] of [['globalFlowView', cakeSrc], ['leverageView', lvSrc]] as const) {
    assert.ok(src.includes("from '../../shared/payloadGate.ts'"), `${name} 的闸门类型必须来自 shared/payloadGate.ts`)
    // 适配器只做"翻成 GateInput"，判据本体不许在客户端再写一份
    assert.equal(/function\s+gateProblems\s*\(/.test(src), false, `${name} 不许自带第二份 gateProblems 实现`)
  }
})
