/**
 * 出处字段的**载荷级 lint**（`docs/DESIGN-ADOPT-WORKBENCHES.md` §2-R3）。
 *
 * 为什么要它：agent 侧的出处契约（`DataProvenance`，`src/shared/model.ts`）早已统一，但**界面载荷**是
 * 各写各的 —— `src/client/api.ts` 里 `missing` 有四种写法（`string[]` / `{what,why,note}[]` / `string | null` /
 * `missingCount`），还有载荷只有 `asOf` 没有 `missing`。真正的事故不在"形状不统一"，而在**下一个新载荷
 * 忘了带出处**（`AUDIT-HY4-1 §9.1`：自校算了但没输出，界面照常显示一个看起来正常的数）。
 *
 * 判据：`api.ts` 里每个顶层载荷类型（`*Payload` / `*Dto`）必须同时含 `asOf` 与 `missing`（可带 `?`）；
 * 行内小类型（表格的一行、曲线的一个点）不在此列 —— 它们由所属载荷统一交代，逐个要求只会逼出无意义的
 * 重复字段。**例外必须逐条写理由，且条数锁定**：加一条就要改这里的数字（改测试就要评审）。
 *
 * 写法锚在源码上（与 `toolIndex.test.ts` 的 drift 断言同款）：运行时要拿到全部回包形状就得把插件启起来，
 * 而"新增一个 DTO 忘带出处"这件事在源码里就能判。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const API_SRC = readFileSync(join(here, 'api.ts'), 'utf8')

/** 剥注释（注释里会**提到**字段名，不剥就会对注释做断言 —— `markdownScan.test.ts` 的老教训） */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 取出所有 `export interface X { … }` 的体（含花括号，按深度配对；字符串里的花括号不影响这个文件） */
export function interfaceBodies(src: string): Map<string, string> {
  const clean = stripComments(src)
  const out = new Map<string, string>()
  const re = /export interface (\w+)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) {
    const start = clean.indexOf('{', m.index)
    let depth = 0
    let i = start
    for (; i < clean.length; i += 1) {
      if (clean[i] === '{') depth += 1
      else if (clean[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    out.set(m[1] as string, clean.slice(start, i + 1))
  }
  return out
}

/** 顶层载荷类型：`*Payload` / `*Dto`（行内小类型见 `ROW_TYPES`） */
export function isPayloadType(name: string): boolean {
  return /Payload$/.test(name) || /Dto$/.test(name)
}

const hasField = (body: string, field: string): boolean => new RegExp(`(^|[{\\s])${field}\\??:`, 'm').test(body)

/**
 * **白名单（条数锁定）**：不要求"自带 asOf + missing"的类型，每条必须写理由。
 *  - 行内小类型：属于某个载荷的一行/一个点，出处由所属载荷统一交代；
 *  - 契约例外：`LeveragePayloadDto` —— 缺数据一律 `null`、页面不写口径（用户明确要求），
 *    它的出处在 `payloadGate` 的 `payload` 档（`gateInputOfLeverage`）显式声明。
 */
export const EXEMPT: ReadonlyArray<{ name: string; why: string; carrier?: string }> = [
  { name: 'ChipDayDto', why: '行内小类型：筹码分布里的一天（属于 ChipsPayload，出处由它统一交代）' },
  { name: 'GlobalFlowMarketDto', why: '行内小类型：五个市场的一行（属于 GlobalFlowPayloadDto）' },
  { name: 'GlobalFlowPointDto', why: '行内小类型：曲线上的一个序列日（属于 GlobalFlowPayloadDto）' },
  { name: 'FupanDateDto', why: '行内小类型：复盘月历的一天（属于 FupanMonthPayload）' },
  { name: 'FupanNoteDto', why: '行内小类型：一条复盘笔记（属于 FupanMonthPayload）' },
  { name: 'FupanTradeDto', why: '行内小类型：当日一笔交易（属于 FupanTradesPayload）' },
  {
    name: 'FupanTradesPayload',
    why: '出处载体是**逐字段原因**（dayPnlWhy / dayPnlReason / readFailedReason），不是聚合 missing[]：当日盈亏缺时界面写「未取到」，每笔交易自带 note',
    carrier: 'dayPnlReason',
  },
  {
    name: 'LeveragePayloadDto',
    why: '契约例外：缺数据一律 null、页面不写口径（用户明确要求）；出处在 payloadGate 的 payload 档显式声明（gateInputOfLeverage）',
    carrier: 'asOf',
  },
]

const exemptNames = new Set(EXEMPT.map((e) => e.name))

function offenders(src: string): string[] {
  const bad: string[] = []
  for (const [name, body] of interfaceBodies(src)) {
    if (!isPayloadType(name) || exemptNames.has(name)) continue
    const missing: string[] = []
    if (!hasField(body, 'asOf')) missing.push('asOf')
    if (!hasField(body, 'missing')) missing.push('missing')
    if (missing.length > 0) bad.push(`${name} 缺 ${missing.join(' + ')}`)
  }
  return bad
}

test('api.ts 的每个顶层载荷类型都带 `asOf` + `missing`（例外逐条写理由、条数锁定）', () => {
  const bad = offenders(API_SRC)
  assert.deepEqual(bad, [], `以下载荷缺少出处字段（新增载荷必须带 asOf + missing，否则加进 EXEMPT 并写理由）：\n  ${bad.join('\n  ')}`)
  // 条数锁定：新增一条豁免必须改这里的数字 —— 这是"不许悄悄降低要求"的闸门
  assert.equal(EXEMPT.length, 8, `豁免清单目前锁定 8 条（实得 ${EXEMPT.length}）`)
  for (const e of EXEMPT) assert.ok(e.why.trim().length >= 8, `豁免 ${e.name} 的理由太短（要能说清为什么它不需要自带出处）`)
  const bodies = interfaceBodies(API_SRC)
  for (const e of EXEMPT) assert.equal(bodies.has(e.name), true, `豁免清单里的 ${e.name} 必须真的存在于 api.ts（否则是死条目）`)
  // 带 carrier 的豁免必须指明"出处到底在哪个字段"，且那个字段真的在（否则豁免就是一句空话）
  for (const e of EXEMPT) {
    if (e.carrier === undefined) continue
    assert.equal(hasField(bodies.get(e.name) as string, e.carrier), true, `豁免 ${e.name} 声明的出处载体 ${e.carrier} 必须真的存在`)
  }
})

test('判据真的会抓：注入一个不含出处的 DTO ⇒ 必败（反向断言证明判据非恒真）', () => {
  const injected = `${API_SRC}\nexport interface GhostDto {\n  value: number\n  note: string\n}\n`
  const bad = offenders(injected)
  assert.equal(bad.some((b) => b.startsWith('GhostDto')), true, `注入的 GhostDto 必须被抓住（实得 ${JSON.stringify(bad)}）`)
  assert.equal(bad.includes('GhostDto 缺 asOf + missing'), true)
  // 只缺一半也要抓
  const half = `${API_SRC}\nexport interface HalfPayload {\n  asOf: number | null\n  value: number\n}\n`
  assert.equal(offenders(half).includes('HalfPayload 缺 missing'), true, '只带 asOf 的载荷同样要被抓住')
})

test('豁免清单条数增加 ⇒ 必败（条数就是闸门的强度，不能悄悄变大）', () => {
  const grown = [...EXEMPT, { name: 'GlobalFlowMarketDto', why: '重复条目也照样计数' }]
  assert.notEqual(grown.length, 8, '多一条就不是 8 —— 上面那条断言会红，所以必须改测试（改测试就要评审）')
  assert.throws(() => assert.equal(grown.length, 8, '条数锁定'), /条数锁定/)
})

test('`missing` 的写法只有已知几类（新增第五类必须改这里）：按粗分桶判，不按字面量', () => {
  /**
   * 只扫**接口体内部**的 `missing`（方法返回类型里的 `missing` 会连上后面的字段，分桶会被串味）。
   * 分桶口径：数组 / 对象数组 / 可空字符串 / 计数。目的是拦住"又发明一种缺失表达"，
   * 不是拦住写法细节 —— 字面量比对会在每次改字段名时误报。
   */
  const buckets = new Set<string>()
  for (const body of interfaceBodies(API_SRC).values()) {
    for (const m of body.matchAll(/\bmissing(\??):\s*([^\n;]+)/g)) {
      const type = (m[2] as string).replace(/\s+/g, ' ')
      if (/^number$/.test(type)) buckets.add('count')
      else if (/MissingField\[\]|FupanMissing\[\]|string\[\]/.test(type)) buckets.add('array')
      else if (/Array</.test(type)) buckets.add('object-array')
      else if (/\| null/.test(type)) buckets.add('nullable-string')
      else buckets.add(`unknown:${type}`)
    }
  }
  assert.ok(buckets.size >= 3, `至少应识别出 3 类写法（实得 ${JSON.stringify([...buckets])}）`)
  const unknown = [...buckets].filter((b) => b.startsWith('unknown:'))
  assert.deepEqual(unknown, [], `出现了未登记的 missing 写法：${JSON.stringify(unknown)} —— 先登记（改这里）再实现，否则"缺失两类"的口径会分叉`)
})
