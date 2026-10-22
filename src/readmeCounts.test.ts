/**
 * README 的**计数句**必须与代码一致（防复发）。
 *
 * 来由（`docs/DESIGN-ADOPT-WORKBENCHES.md` §5-7 的实测发现）：加第 8 行 `fupan` 之后，README 仍在两处写着
 * 旧数字 ——「面板由**六个**页签组成」（客户端已有 7 个 tab）与「拆成**七行**…（清单缺 `fupan`）」，
 * 且 `cordis.patch.yml` 的行号引用（`:53-75`）也随插入而漂。**现有断言一个都没抓住**：
 * `src/index.test.ts` 锁的是 `ROW_ROUTES` 八项，不锁 README 的计数句。
 *
 * 本文件锁五处**同源事实**（改一处不改另一处 ⇒ 红）：
 *   ① README 的页签计数 == README 列出的页签名个数；
 *   ② README 的页签计数 == `src/client/index.tsx` 的 tabs 条数（== `PageKey` 联合的成员数）；
 *   ③ README 的行数 == README 列出的行名个数；
 *   ④ README 的行数 == `src/index.ts` 的 `ROW_ROUTES` 键数 + 1（core）；
 *   ⑤ README 的行数 == `cordis.patch.yml` 的 `- insert:` 块里 `id: tradewatcher-*` 的行数。
 *
 * 为什么锚源码而不锚运行时：这几处都是**常量声明**，运行时拿它们就得把插件启起来；而"文档数字过期"这件事
 * 在源码文本里就能判（与 `toolIndex.test.ts` 的 README drift 断言同款）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8')

const README = read('../README.md')
const CLIENT_INDEX = read('./client/index.tsx')
const PATCH = read('../cordis.patch.yml')

/** 中文计数（够用即可：行/页签不可能超过十几个；超出就说明有人写错了） */
const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 }
export function cnCount(text: string): number | null {
  const t = text.trim()
  if (/^\d+$/.test(t)) return Number(t)
  return CN_DIGITS[t] ?? null
}

export interface CountClaim {
  /** 声明出来的数字 */
  count: number
  /** 声明的原词（七 / 八 / 7 …） */
  raw: string
  /** 同一句里列出的成员名（` / ` 分隔） */
  items: string[]
}

/**
 * 抽「面板由**七个页签**组成：**自选 / 持仓 / …**。」这一句。
 *
 * 加粗标记的位置**可能变**（`**七个页签**` / `**七**个页签`），所以每一处都用 `\*{0,2}` 放宽 ——
 * 判据要抓的是数字与清单，不是 Markdown 的星号怎么摆（写死星号位置会在改文案时误报）。
 * 返回 `null` ⇒ 这句话被改写成别的句式了（那时本文件的判据失效，必须同步改判据 —— 所以 null 也算失败）。
 */
export function parseTabClaim(text: string): CountClaim | null {
  const m = /面板由\*{0,2}([一二三四五六七八九十\d]+)个页签\*{0,2}组成：\*{0,2}([^*。]+?)\*{0,2}。/.exec(text)
  if (m === null) return null
  const count = cnCount(m[1] as string)
  if (count === null) return null
  const items = (m[2] as string).split('/').map((s) => s.trim()).filter((s) => s !== '')
  return { count, raw: m[1] as string, items }
}

/** 抽「拆成**八行**（core / calendar / …）」这一句 */
export function parseRowClaim(text: string): CountClaim | null {
  const m = /拆成\*{0,2}([一二三四五六七八九十\d]+)行\*{0,2}（([^）]+)）/.exec(text)
  if (m === null) return null
  const count = cnCount(m[1] as string)
  if (count === null) return null
  const items = (m[2] as string).split('/').map((s) => s.trim()).filter((s) => s !== '')
  return { count, raw: m[1] as string, items }
}

/** `src/client/index.tsx` 里 tabs 的 label 序列（锚定 `{ key: '<page>', label: '<中文>'` 这种形状） */
export function tabLabelsOf(src: string): string[] {
  return [...src.matchAll(/\{ key: '(?:watch|portfolio|market|cloud|calendar|tools|fupan|prism)', label: '([^']+)'/g)].map((m) => m[1] as string)
}

/** `type PageKey = 'watch' | 'portfolio' | …` 的成员数 */
export function pageKeyCountOf(src: string): number {
  const m = /type PageKey =([^\n]+)/.exec(src)
  assert.ok(m !== null, 'src/client/index.tsx 必须有 `type PageKey = …`')
  return [...String(m[1]).matchAll(/'([a-z]+)'/g)].length
}

/** `cordis.patch.yml` 里 `id: tradewatcher-*` 的行数（唯一的行清单权威处） */
export function patchRowCountOf(src: string): number {
  return [...src.matchAll(/^\s*-\s*id:\s*(tradewatcher-[a-z]+)\s*$/gm)].length
}

/** 页签名在 README 里的写法（tab 栏用「工具」，README 正文用「工具箱」—— 同一处东西的两个名字，逐条登记） */
const TAB_ALIAS: Record<string, string> = { 工具: '工具箱' }

test('① README 的页签计数 == 它自己列出的页签名（六个 vs 七个这种自相矛盾必红）', () => {
  const claim = parseTabClaim(README)
  assert.notEqual(claim, null, 'README 里必须保留「面板由**N 个页签**组成：**A / B / …**。」这句（本判据锚它）')
  const c = claim as CountClaim
  assert.equal(c.count, c.items.length, `README 声明 ${c.raw} 个页签，却列了 ${c.items.length} 个：${c.items.join(' / ')}`)
})

test('② README 的页签计数 == 客户端 tabs 条数 == PageKey 成员数', () => {
  const c = parseTabClaim(README) as CountClaim
  const labels = tabLabelsOf(CLIENT_INDEX)
  assert.ok(labels.length >= 2, `必须能从 index.tsx 抓到 tabs（实得 ${labels.length}）`)
  assert.equal(c.count, labels.length, `README 说 ${c.count} 个页签，客户端 tabs 有 ${labels.length} 个：${labels.join(' / ')}`)
  assert.equal(pageKeyCountOf(CLIENT_INDEX), labels.length, 'PageKey 的成员数必须与 tabs 条数一致（少一个就说明有页签不可达）')
  // README 里必须逐个提到（允许登记的别名），否则"七个页签"就只是个数对、名字对不上
  for (const label of labels) {
    const name = TAB_ALIAS[label] ?? label
    assert.equal(README.includes(name), true, `README 必须提到页签「${name}」（tab 栏写作「${label}」）`)
    assert.equal(c.items.some((item) => item.startsWith(name)), true, `README 的页签清单里必须有「${name}」：${c.items.join(' / ')}`)
  }
})

test('③ README 的行数 == 它自己列出的行名', () => {
  const c = parseRowClaim(README) as CountClaim
  assert.notEqual(c, null, 'README 里必须保留「拆成**N 行**（core / … ）」这句（本判据锚它）')
  const claim = c as CountClaim
  assert.equal(claim.count, claim.items.length, `README 声明 ${claim.raw} 行，却列了 ${claim.items.length} 个：${claim.items.join(' / ')}`)
})

test('④ README 的行数 == ROW_ROUTES 键数 + 1（core）== cordis.patch.yml 的行数', async () => {
  const { ROW_ROUTES } = await import('./index.ts')
  const claim = parseRowClaim(README) as CountClaim
  const codeRows = Object.keys(ROW_ROUTES).length + 1 // core 不在 ROW_ROUTES 里（它是"其余全部"）
  assert.equal(claim.count, codeRows, `README 说 ${claim.count} 行，ROW_ROUTES+core 是 ${codeRows} 行（${['core', ...Object.keys(ROW_ROUTES)].join(' / ')}）`)
  assert.equal(patchRowCountOf(PATCH), codeRows, 'cordis.patch.yml 的 id 行数必须等于代码行数')
  // 名字对得上就够了：清单的**顺序**是叙述选择（README 按"内核在前"写，ROW_ROUTES 的键序不同），
  // 判据不该管顺序 —— 管顺序会让每次调整叙述都误报。
  assert.deepEqual([...claim.items].sort(), ['core', ...Object.keys(ROW_ROUTES)].sort(), `README 的行清单必须与代码的行清单是同一组：${claim.items.join(' / ')}`)
})

test('⚠ 反例注入：把 README 改回「六个页签」/「七行」⇒ 判据必红（证明它不是恒真）', () => {
  const tabsBack = README.replace('八个页签', '七个页签')
  assert.notEqual(tabsBack, README, '注入必须真的改到那句')
  const tabClaim = parseTabClaim(tabsBack) as CountClaim
  assert.equal(tabClaim.count === tabClaim.items.length, false, '「六个」+ 七个名字 ⇒ 必须自相矛盾（否则判据没锁住）')
  assert.throws(() => assert.equal(tabClaim.count, tabClaim.items.length, '反例'), /反例/, '⚠ 反例下必须失败')

  const rowsBack = README.replace('九行', '八行')
  assert.notEqual(rowsBack, README, '注入必须真的改到那句')
  const rowClaim = parseRowClaim(rowsBack) as CountClaim
  assert.equal(rowClaim.count, 8)
  assert.throws(() => assert.equal(rowClaim.count, 9, '反例'), /反例/, '⚠ 行数改回旧值必须失败')
  // 同时证明：清单里少列 fupan 也会被 ③ 抓住
  const dropped = README.replace(' / fupan', '')
  const droppedClaim = parseRowClaim(dropped) as CountClaim
  assert.notEqual(droppedClaim.count, droppedClaim.items.length, '少了 fupan ⇒ 「八行」与 7 个名字对不上（②③ 必红）')
})

test('README 不再引用 `cordis.patch.yml` 的**行号**（行号会随插入漂；改为引用章节/块）', () => {
  // 实测踩过：`:53-75` 在第 8 行插入后整体漂了 8 行，而 README 的自引用是唯一不会自动更新的地方
  const stale = /cordis\.patch\.yml:\d+(-\d+)?/.exec(README)
  assert.equal(stale, null, `README 不许再写 cordis.patch.yml 的具体行号（找到 ${stale?.[0]}）—— 改成引用「- insert:」块或章节名`)
  assert.equal(README.includes('`- insert:` 块'), true, '行清单那句话必须改成引用 `- insert:` 块')
})

/**
 * README 里的**注解类措辞**必须为零（用户裁决，2026-10-21）。
 *
 * 被否决的不是"数据事实"（缺数据原因 / 规则名 / `模拟` 口径都保留），而是这一整类面向用户的
 * 免责/提示句：`不构成投资建议`、`投资建议`、`免责`。删的时候要求句子仍然通顺
 * （不能留下悬空的逗号/破折号/空括号）。同一判据既跑真实 README（必须空）也跑注入（必须非空）。
 */
const FORBIDDEN_README = ['不构成投资建议', '投资建议', '免责'] as const

function readmeAnnotationProblems(text: string): string[] {
  const bad: string[] = []
  for (const phrase of FORBIDDEN_README) {
    if (text.includes(phrase)) bad.push(`README 出现被否决的措辞「${phrase}」`)
  }
  return bad
}

test('⑤ README 不得出现「不构成投资建议 / 投资建议 / 免责」（注入 ⇒ 必败）', () => {
  assert.deepEqual(readmeAnnotationProblems(README), [], `README 仍有注解类措辞：${JSON.stringify(readmeAnnotationProblems(README))}`)
  // 删后句子必须通顺：首段自然收尾；标题里也不再挂"免责"
  assert.ok(README.includes('仅作盯盘参考。'), '首段必须自然收尾（不是删一半留下悬空逗号）')
  assert.equal(/仅作盯盘参考[，,]\s*。/.test(README), false, '不许留下悬空的逗号')
  assert.equal(README.includes('## 已知边界与免责'), false, '章节标题不许再挂「免责」')
  assert.ok(README.includes('## 已知边界'), '章节标题必须保留（改名为「已知边界」）')
  // 反例注入：把任一种措辞加回 ⇒ 判据必须非空
  const injections: Array<{ add: string; hit: RegExp }> = [
    { add: '本插件不构成投资建议', hit: /不构成投资建议/ },
    { add: '以上内容属于投资建议', hit: /投资建议/ },
    { add: '免责声明：仅供参考', hit: /免责/ },
  ]
  for (const { add, hit } of injections) {
    const bad = readmeAnnotationProblems(`${README}\n${add}\n`)
    assert.ok(bad.length > 0, `注入「${add}」必须被抓到（一条都没报 ⇒ 判据恒真）`)
    assert.match(bad.join(' ／ '), hit, `注入「${add}」报的原因应是预期的：${JSON.stringify(bad)}`)
  }
  const injected = `${README}\n本插件不构成投资建议\n`
  assert.throws(
    () => assert.deepEqual(readmeAnnotationProblems(injected), [], '反例'),
    /反例/,
    '⚠ 反例注入（加回免责句）必须让断言失败',
  )
})
