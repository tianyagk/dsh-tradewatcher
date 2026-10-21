/**
 * 行归属必须按**实际调用方**推导（FIX-3 中-②，docs/REVIEW-2-CORRECTNESS.md 的 M3）。
 *
 * 旧测试（`src/index.test.ts` 的"归属按实测调用方所在行"）对比的是
 * 「硬编码的 `OWNER_BY_CALLERS`」与「`ROW_ROUTES` 的测试副本」—— 两张都是写死的表，
 * **从不看谁在真正调用**：复核的反向注入 INJ-3 往 core 行的 `TopBar.tsx` 里加了一个
 * `api.board(...)` 消费者（于是 market 关掉后 core 会打 404），532 条断言**依旧全绿**。
 *
 * 这里的判据是可执行的推导：
 *   ① `api.ts` 的函数 → 路由路径（按真实实现文本解析）；
 *   ② 客户端文件的**调用点**（`api.<fn>(`）＋**本地 import 图**；
 *   ③ 每个页面组件是它那一行的**根**，反向可达性算出"这条路由被哪些行消费"；
 *   ④ 与实现表（`src/index.ts` 的 `ROW_ROUTES`）对齐：**该路由的消费行必须恰好等于它声明的行**。
 * 于是"往 core 加一个 market 路由的消费者"会被立刻抓住（消费行 = core ≠ market）。
 *
 * 判据本身用 `deriveRouteOwners` 暴露，便于双向对照：好样本必须 0 冲突、坏样本必须报冲突。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(SRC, 'client')

/** 页面组件文件 → 它所属的行（唯一一处"声明"，其余全部由调用点推导） */
export const ROW_OF_FILE: Record<string, string> = {
  'WatchlistPage.tsx': 'watchlist',
  'PortfolioPage.tsx': 'portfolio',
  'MarketPage.tsx': 'market',
  'CalendarPage.tsx': 'calendar',
  'CloudMap.tsx': 'cloudmap',
  'ToolsPage.tsx': 'tools',
  // 第 8 行（v0.111.0）：复盘页。它是 fupan 两条路由的**唯一**消费者（`api.fupanMonth`/`api.fupanNote`）
  'FupanPage.tsx': 'fupan',
  'index.tsx': 'core',
  'TopBar.tsx': 'core',
}
/** 实现里真正有路由的行（core 不持有 ROW_ROUTES 条目） */
const ROW_KEYS = ['calendar', 'watchlist', 'portfolio', 'market', 'cloudmap', 'tools', 'fupan'] as const

export interface DeriveInput {
  /** 客户端文件（相对路径 → 源码） */
  files: Record<string, string>
  /** `src/index.ts` 源码（解析实现表 ROW_ROUTES） */
  indexSrc: string
}

export interface DeriveResult {
  /** 路由 → 消费它的行集合（由真实调用点推导） */
  routeRows: Map<string, Set<string>>
  /** 声明与实测不一致的路由 */
  mismatches: string[]
}

/** 纯函数：从真实源码推导"路由被哪些行消费"，并与实现表比对 */
export function deriveRouteOwners(input: DeriveInput): DeriveResult {
  const paths = Object.keys(input.files)
  const src = new Map(paths.map((p) => [p, input.files[p] as string]))
  const abs = (rel: string): string => resolve(CLIENT, rel)

  // ① api.ts：函数名 → 路由路径
  const apiRoutes = new Map<string, string>()
  const apiSrc = src.get('api.ts') ?? ''
  {
    const starts: Array<{ name: string; idx: number }> = []
    const re = /^\s{2}(?:\/\*\*[\s\S]*?\*\/\s*)?([a-zA-Z][\w]*)\s*\(/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(apiSrc)) !== null) starts.push({ name: m[1] as string, idx: m.index })
    starts.push({ name: '__end', idx: apiSrc.length })
    for (let i = 0; i < starts.length - 1; i += 1) {
      const body = apiSrc.slice(starts[i]!.idx, starts[i + 1]!.idx)
      // 宽容一点：函数体里第一个 `/tradewatcher/...` 字面量（含 `request(cond ? '…' : '…')` 这种三目写法）
      const r = /['"`](\/tradewatcher\/[^'"`?${\s]*)/.exec(body)
      if (r !== null) apiRoutes.set(starts[i]!.name, r[1] as string)
    }
  }

  // ② 调用点 + 本地 import 图
  // ⚠ 必须先剥注释：真实调用点写成方法链且中间夹注释（`api\n // dist …\n .breadth({…})`），
  // 不剥就会漏掉调用方（实测 `/tradewatcher/breadth` 因此被判成"没有调用方"）
  const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const calls = new Map<string, Set<string>>()
  const imports = new Map<string, Set<string>>()
  for (const [rel, raw] of src) {
    const text = strip(raw)
    const called = new Set<string>()
    const re = /\bapi\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) called.add(m[1] as string)
    if (called.size > 0) calls.set(rel, called)

    const imps = new Set<string>()
    const ire = /from\s+['"](\.[^'"]+)['"]/g
    while ((m = ire.exec(text)) !== null) {
      const target = resolve(dirname(abs(rel)), m[1] as string)
      for (const cand of [target, `${target}.ts`, `${target}.tsx`, join(target, 'index.ts'), join(target, 'index.tsx')]) {
        const relCand = relative(CLIENT, cand)
        if (src.has(relCand)) {
          imps.add(relCand)
          break
        }
      }
    }
    imports.set(rel, imps)
  }

  // ③ 根：页面组件；反向可达性 = "哪些行会加载这个模块"
  const roots = paths.filter((p) => {
    const row = ROW_OF_FILE[basename(p)]
    return row !== undefined && row !== 'core'
  })
  const rootsFor = (rel: string): Set<string> => {
    const out = new Set<string>()
    for (const root of roots) {
      const seen = new Set<string>([root])
      const queue: string[] = [root]
      while (queue.length > 0) {
        const cur = queue.shift() as string
        if (cur === rel) {
          out.add(ROW_OF_FILE[basename(root)] as string)
          break
        }
        for (const nxt of imports.get(cur) ?? []) {
          if (!seen.has(nxt)) {
            seen.add(nxt)
            queue.push(nxt)
          }
        }
      }
    }
    return out
  }

  const routeRows = new Map<string, Set<string>>()
  for (const [rel, called] of calls) {
    const rows = rootsFor(rel)
    // 没有任何页面根可达 ⇒ 它是外壳（core）里的调用点 —— 这正是 INJ-3 注入的形态
    if (rows.size === 0 && rel !== 'api.ts') rows.add('core')
    for (const fn of called) {
      const route = apiRoutes.get(fn)
      if (route === undefined) continue
      if (!routeRows.has(route)) routeRows.set(route, new Set())
      for (const row of rows) routeRows.get(route)?.add(row)
    }
  }

  // ④ 实现表
  const table = new Map<string, string[]>()
  {
    const re = /^\s{2}([a-z]+):\s*\[([^\]]*)\]/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(input.indexSrc)) !== null) {
      const row = m[1] as string
      if (!(ROW_KEYS as readonly string[]).includes(row) || table.has(row)) continue
      table.set(row, [...(m[2] as string).matchAll(/'([^']+)'/g)].map((x) => x[1] as string))
    }
  }

  const mismatches: string[] = []
  for (const [row, routePaths] of table) {
    for (const route of routePaths) {
      const consumers = [...(routeRows.get(route) ?? [])].sort()
      if (consumers.length !== 1 || consumers[0] !== row) {
        mismatches.push(`${route}：实现表归 ${row}，实测消费行 = [${consumers.join(',') || '未找到调用方'}]`)
      }
    }
  }
  return { routeRows, mismatches }
}

function readClientFiles(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out[relative(CLIENT, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(CLIENT)
  return out
}

test('行归属：实现表里的每条路由，其**实际消费行**必须恰好等于它声明的行（按调用点推导）', () => {
  const files = readClientFiles()
  const indexSrc = readFileSync(join(SRC, 'index.ts'), 'utf8')
  const { routeRows, mismatches } = deriveRouteOwners({ files, indexSrc })
  assert.ok(routeRows.size > 0, '推导必须真的找到调用点（否则判据本身失效）')
  const table = [...routeRows.entries()].map(([r, rows]) => `  ${r} ← [${[...rows].join(',')}]`).join('\n')
  assert.deepEqual(mismatches, [], `行归属与实测调用方不一致：\n${mismatches.join('\n')}\n实测消费表：\n${table}`)
})

test('行归属判据非恒真：core 里多一个 market 路由的消费者必须被发现（复核实测 INJ-3 的形态）', () => {
  const files = readClientFiles()
  const indexSrc = readFileSync(join(SRC, 'index.ts'), 'utf8')
  // 好样本：真实树 ⇒ 0 冲突
  assert.deepEqual(deriveRouteOwners({ files, indexSrc }).mismatches, [])
  // 坏样本：往 core 外壳里加一个 market 路由的消费者（TopBar 不在任何页面根之下 ⇒ 消费行 = core）
  const injected = { ...files, 'TopBar.tsx': `${files['TopBar.tsx'] ?? ''}\nconst _x = api.board('industry', 'pct', 1)\n` }
  const bad = deriveRouteOwners({ files: injected, indexSrc }).mismatches
  assert.ok(
    bad.some((m) => m.includes('/tradewatcher/board')),
    `往 core 加消费者必须被抓到（实际 ${JSON.stringify(bad)}）`,
  )
})
