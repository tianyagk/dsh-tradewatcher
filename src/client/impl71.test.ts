/**
 * IMPL-71（review-8 §P0-1 / §P0-3 / §U1 / §U2）的可检查判据。
 *
 * 四条都是"把没有/失败说成确定事实"或"失败时用户看不见"的缺陷，因此断言必须钉在
 * **真源码的行为结构**上，并且每条都配**反例注入**（把旧写法加回去 ⇒ 判据必须非空）。
 *
 * 为什么是源码级而不是渲染级：本仓库没有 react-dom 渲染测试环境（页面组件依赖宿主
 * `fetch`/`window`），既有断言（`noticeBars` / `marketRefactor` / `watchlistHints` …）
 * 走的也是"真源码 + 纯函数 + 反例注入"这条路。渲染期崩溃的证明方式是：
 * 守卫分支里**不出现**对 null 变量的解引用（旧写法正是 `[...view.groups]`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')

/** 剥注释（注释里会**提到**被删的旧写法，不能当成违规） */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 客户端全部产品源文件（排除测试：那里的反例注入是故意越界的） */
function walkClient(dir = join(root, 'client'), out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walkClient(abs, out)
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(abs)
  }
  return out
}

// ── P0-1 / U2：首屏失败必须给"原因 + 重试"，且不许解引用 null ──────────────

interface FirstLoadSpec {
  file: string
  /** 首屏状态变量（`view` / `watch`） */
  nullVar: string
  /** 守卫**之后**才允许出现的解引用表达式（旧写法在这一步崩） */
  deref: string
}

const FIRST_LOAD: FirstLoadSpec[] = [
  { file: 'PortfolioPage.tsx', nullVar: 'view', deref: 'const groups = [...view.groups]' },
  { file: 'WatchlistPage.tsx', nullVar: 'watch', deref: 'const groups = [...watch.groups]' },
]

interface GuardBlock {
  start: number
  end: number
  text: string
}

function firstLoadGuardOf(src: string, spec: FirstLoadSpec): GuardBlock | null {
  const at = src.indexOf(`if (${spec.nullVar} === null) {`)
  if (at < 0) return null
  const end = src.indexOf('\n  }\n', at)
  if (end < 0) return null
  return { start: at, end: end + 4, text: src.slice(at, end + 4) }
}

/** 判据：返回违规清单（真源码必须为空；反例必须非空） */
function firstLoadProblems(src: string, spec: FirstLoadSpec): string[] {
  const bad: string[] = []
  const guard = firstLoadGuardOf(src, spec)
  if (guard === null) {
    return [`${spec.file}：缺少 \`if (${spec.nullVar} === null) {\` 首屏守卫（旧写法把失败与加载中混在一个条件里）`]
  }
  if (!guard.text.includes('ErrorNote')) bad.push(`${spec.file}：失败分支没有渲染错误（会白屏/永久骨架）`)
  if (!guard.text.includes('重试')) bad.push(`${spec.file}：失败分支没有重试入口`)
  if (!guard.text.includes("role: 'note'")) bad.push(`${spec.file}：失败原因不可被键盘/读屏读到（缺 role=note）`)
  if (!guard.text.includes('未取到')) bad.push(`${spec.file}：失败分支没有写"未取到"（必须给原因）`)
  // 失败分支**不许**读 null 变量（旧写法 `[...view.groups]` 就在守卫之后）
  const branches = guard.text.split('error === null')
  const errorBranch = branches[1] ?? ''
  const nullRead = new RegExp(`\\b${spec.nullVar}\\b\\s*[.[]`)
  if (nullRead.test(errorBranch)) bad.push(`${spec.file}：失败分支读了 ${spec.nullVar}（渲染期 TypeError）`)
  if (branches.length !== 2) bad.push(`${spec.file}：守卫必须区分"加载中"与"失败"（缺 error === null 分支）`)
  // 解引用必须落在守卫之后
  const derefAt = src.indexOf(spec.deref)
  if (derefAt < 0) {
    bad.push(`${spec.file}：找不到守卫之后的解引用 \`${spec.deref}\`（结构已变，需同步本断言）`)
  } else if (derefAt < guard.end) {
    bad.push(`${spec.file}：解引用在守卫结束之前`)
  }
  return bad
}

test('P0-1：持仓页首屏失败 ⇒ 错误 + 原因 + 重试，且不读 view（不再渲染期崩溃）', () => {
  const src = read('PortfolioPage.tsx')
  assert.deepEqual(firstLoadProblems(src, FIRST_LOAD[0] as FirstLoadSpec), [])
  // 反例注入：把守卫退回旧写法（只挡"加载中"、失败继续往下走去读 view.groups）⇒ 判据必须失败
  const spec = FIRST_LOAD[0] as FirstLoadSpec
  const guard = firstLoadGuardOf(src, spec)
  assert.ok(guard !== null, '必须能定位到守卫块')
  const oldGuard =
    "if (view === null && error === null) {\n" +
    "    return React.createElement('div', { className: 'tw-body' }, React.createElement(Skeleton, { lines: 5, height: 18 }))\n" +
    '  }'
  const injected = src.slice(0, (guard as GuardBlock).start) + oldGuard + src.slice((guard as GuardBlock).end)
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  assert.notDeepEqual(firstLoadProblems(injected, spec), [], '⚠ 反例（旧守卫）必须被抓住')
  assert.throws(
    () => assert.deepEqual(firstLoadProblems(injected, spec), [], '反例上"失败必须给原因"必须失败'),
    /反例上/,
    '⚠ 反例注入（只挡加载中）必须让断言失败',
  )

  // 反例注入 ②：**整块删掉守卫** ⇒ 判据必须失败（"删守卫必败"就是这条）
  const noGuard = src.slice(0, (guard as GuardBlock).start) + src.slice((guard as GuardBlock).end)
  assert.notEqual(noGuard, src, '反例注入必须真改到源码')
  assert.notDeepEqual(firstLoadProblems(noGuard, spec), [], '⚠ 反例（删掉守卫）必须被抓住')
  assert.match(firstLoadProblems(noGuard, spec).join(' '), /缺少/, '删守卫时必须报"缺少守卫"')
})

test('U2：自选页首屏失败 ⇒ 错误 + 原因 + 重试（不再永久骨架屏）', () => {
  const src = read('WatchlistPage.tsx')
  assert.deepEqual(firstLoadProblems(src, FIRST_LOAD[1] as FirstLoadSpec), [])
  // 反例注入：退回 `if (watch === null) return <Skeleton/>`（失败时骨架屏永不停）
  const spec = FIRST_LOAD[1] as FirstLoadSpec
  const guard = firstLoadGuardOf(src, spec)
  assert.ok(guard !== null)
  const oldGuard =
    "if (watch === null) return React.createElement('div', { className: 'tw-body' }, React.createElement(Skeleton, { lines: 4, height: 16 }))\n"
  const injected = src.slice(0, (guard as GuardBlock).start) + oldGuard + src.slice((guard as GuardBlock).end)
  assert.notEqual(injected, src, '反例注入必须真改到源码')
  assert.notDeepEqual(firstLoadProblems(injected, spec), [], '⚠ 反例（永久骨架屏）必须被抓住')
  // 失败态必须能重试：重试按钮绑的是 `reload`（同一个取数入口）
  assert.ok(/onClick: reload \}, '重试'/.test(src), '重试按钮必须调用 reload')
})

// ── P0-3：不许呈现胜率/概率/预测（带数字） ────────────────────────────────

/** 「概率类结论 + 数字」的判据：`胜率 58%` / `概率：0.7` / `预测 65%` 都算违规 */
const QUANTIFIED_RATE = /(胜率|概率|预测)\s*[:：]?\s*[0-9]/

test('P0-3：客户端源码不许出现"胜率/概率/预测 + 数字"（用户红线）', () => {
  const files = walkClient()
  assert.ok(files.length >= 20, `扫描面必须覆盖全客户端（实际 ${files.length} 个文件）`)
  const leaks: string[] = []
  for (const abs of files) {
    const rel = relative(here, abs)
    const lines = readFileSync(abs, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (QUANTIFIED_RATE.test(line)) leaks.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`)
    })
  }
  assert.deepEqual(leaks, [], `概率类结论 + 数字必须为 0 处：\n${leaks.join('\n')}`)
  // 做T 摘要已换成**中性事实**（次数 / 净额 / 平均每笔），不是删掉信息
  const port = strip(read('PortfolioPage.tsx'))
  assert.ok(port.includes('平均每笔'), '做T 摘要必须给中性事实（平均每笔），不是变成"什么都没有"')
  assert.ok(!port.includes('winRate'), '界面不再消费 winRate（回包字段留着不影响）')
  // 口径进悬停（长解释不进常驻）
  assert.ok(port.includes('这里只统计已发生的交易，不做任何对将来的推断'), '做T 的口径说明必须进悬停')
  // 反例注入：把「胜率 58%」加回渲染位置 ⇒ 判据必须失败
  const injected = `${port}\nconst reintroduced = \`胜率 58%\`\n`
  assert.equal(QUANTIFIED_RATE.test(injected), true, '⚠ 反例（胜率 58%）必须能被判据抓住')
  assert.throws(
    () => assert.equal(QUANTIFIED_RATE.test(injected), false, '反例上"不许有概率类数字"必须失败'),
    /反例上/,
    '⚠ 反例注入（把胜率加回）必须让断言失败',
  )
})

// ── U1：写失败的原因必须出现在**弹窗内** ──────────────────────────────────

/**
 * 取 `at` 处**这一条语句**（到括号配平后的第一个换行为止；下一行以 `.`/`?`/`+` 等续行记号开头时继续）。
 * 用语句而不是"固定字符窗口"：同一个弹窗里两个写调用点常常只隔几十个字符，
 * 用窗口会让"另一个调用点的 setErr"冒充本调用点的失败处理（反例就抓不到）。
 */
function statementAt(src: string, at: number, max = 1200): string {
  let depth = 0
  const end = Math.min(src.length, at + max)
  for (let i = at; i < end; i += 1) {
    const c = src[i]
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (c === '\n' && depth <= 0) {
      const rest = src.slice(i + 1, Math.min(src.length, i + 120))
      const next = /^\s*([^\s])/.exec(rest)?.[1] ?? ''
      if (next === '' || next === '.' || next === '?' || next === ':' || next === '+' || next === '&' || next === '|') continue
      return src.slice(at, i)
    }
  }
  return src.slice(at, end)
}

/** 判据：每个写调用点**所在的语句**里必须出现 `setErr(`（= 写进本弹窗的 err state） */
function writeCallsWithoutLocalError(src: string, call: RegExp): string[] {
  const bad: string[] = []
  for (const m of src.matchAll(call)) {
    const at = m.index ?? 0
    const statement = statementAt(src, at)
    if (!statement.includes('setErr(')) {
      bad.push(`写调用点没有把失败写进弹窗内 err：${statement.replace(/\s+/g, ' ').slice(0, 110)}`)
    }
  }
  return bad
}

/** 取一个组件函数体（从 `function X(` 到下一个 `function Y(`，或到文件末尾） */
function fnBodyOf(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) return ''
  const next = src.indexOf('\nfunction ', at + 1)
  return src.slice(at, next < 0 ? src.length : next)
}

test('U1：分组 / 加证券 / 移动 的写失败留在弹窗内（WatchlistPage）', () => {
  const src = read('WatchlistPage.tsx')
  // 写操作返回 Promise（拒绝 = 失败），页面级调用另有出口（不被吞掉）
  assert.ok(src.includes('const mutate = (body: Parameters<typeof api.mutateWatch>[0]): Promise<void>'), 'mutate 必须返回 Promise')
  assert.ok(src.includes('mutate(body).catch((e: Error) => setError(e.message))'), '页面级写失败仍要可见（ErrorNote）')
  const modal = fnBodyOf(src, 'WatchModal')
  assert.ok(modal.length > 0, '必须能定位到 WatchModal')
  assert.deepEqual(writeCallsWithoutLocalError(modal, /mutate\(\{/g), [], '弹窗内每个写调用点都要 setErr')
  // 反例注入：把某个调用点的失败处理换成吞错 ⇒ 判据必须失败
  const injected = modal.replace(
    "mutate({ op: 'addGroup', name }).then(onClose, (e: Error) => setErr(e.message))",
    "mutate({ op: 'addGroup', name }).then(onClose, () => undefined)",
  )
  assert.notEqual(injected, modal, '反例注入必须真改到源码')
  assert.notDeepEqual(writeCallsWithoutLocalError(injected, /mutate\(\{/g), [], '⚠ 反例（吞错）必须被抓住')
})

test('U1：分组 / 加仓 / 买入卖出 / 编辑 的写失败留在弹窗内（PortfolioPage）', () => {
  const src = read('PortfolioPage.tsx')
  assert.ok(src.includes('const mutate = (body: MutatePortBody): Promise<void>'), 'mutate 必须返回 Promise')
  assert.ok(src.includes('mutate(body).catch((e: Error) => setError(e.message))'), '页面级写失败仍要可见')
  const modals = ['GroupFormModal', 'AddPosModal', 'TradeModal', 'PosEditModal']
  for (const name of modals) {
    const body = fnBodyOf(src, name)
    assert.ok(body.length > 0, `必须能定位到 ${name}`)
    assert.deepEqual(writeCallsWithoutLocalError(body, /props\.mutate\(/g), [], `${name} 的写失败必须落在弹窗内`)
  }
  // 反例注入：一个弹窗退回"只关窗、不处理失败"⇒ 判据必须失败
  const tradeBody = fnBodyOf(src, 'TradeModal')
  const injected = tradeBody.replace(
    'props.mutate(body).then(props.onClose, (e: Error) => setErr(e.message))',
    'props.mutate(body).then(props.onClose)',
  )
  assert.notEqual(injected, tradeBody, '反例注入必须真改到源码')
  assert.notDeepEqual(writeCallsWithoutLocalError(injected, /props\.mutate\(/g), [], '⚠ 反例（吞错）必须被抓住')
})

test('U1：日历事件的写失败留在弹窗内（EventModal + DayModal 的隐藏/删除）', () => {
  const src = read('CalendarPage.tsx')
  assert.ok(src.includes('const mutate = (body: Record<string, unknown>): Promise<void>'), 'mutate 必须返回 Promise')
  const eventModal = fnBodyOf(src, 'EventModal')
  assert.ok(eventModal.length > 0, '必须能定位到 EventModal')
  assert.deepEqual(writeCallsWithoutLocalError(eventModal, /props\s*\.\s*mutate\(/g), [], 'EventModal 的写失败必须落在弹窗内')
  const dayModal = fnBodyOf(src, 'DayModal')
  assert.ok(dayModal.includes('props.mutate(body).catch((e: Error) => setErr(e.message))'), 'DayModal 的隐藏/删除失败也要落在弹窗内')
  assert.ok(dayModal.includes('ErrorNote'), 'DayModal 必须渲染自己的错误')
  // 反例注入：EventModal 退回"成功也由父级关窗、失败不管"⇒ 判据必须失败
  const injected = eventModal.replace('.then(props.onClose, (e: Error) => setErr(e.message))', '.then(props.onClose, () => undefined)')
  assert.notEqual(injected, eventModal, '反例注入必须真改到源码')
  assert.notDeepEqual(writeCallsWithoutLocalError(injected, /props\s*\.\s*mutate\(/g), [], '⚠ 反例（吞错）必须被抓住')
})

test('U1：三条写路径都不再用 `catch(() => undefined)` 吞错', () => {
  for (const file of ['WatchlistPage.tsx', 'CalendarPage.tsx', 'PortfolioPage.tsx']) {
    const code = strip(read(file))
    assert.equal(/catch\(\s*\(\s*\)\s*=>\s*(undefined|\{\s*\})/.test(code), false, `${file} 的写路径里不许再吞错`)
  }
})
