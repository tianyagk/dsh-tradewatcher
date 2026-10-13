/**
 * 断言强度防线（FIX-3 中-①）：把"恒真断言"的三种形状钉成**可执行的扫描**，
 * 并且**自证非恒真** —— §R5-② 用同一份判据对"坏样本必须命中 / 好样本不误报"做双向对照。
 *
 * 为什么要有它：复核对 3096 条 `assert.*` 做过全量分类，抓出 6 条恒真/自比较
 * （`|| true` ×2、循环不变量 OR ×2、自比较 ×2）。单条修完就完了 —— 但只要同类形状
 * 再次出现（很容易，因为"先写成断言、再补个 `|| true` 让它过"是最省事的写法），
 * 就没有任何东西会拦住它。这个文件就是那道拦截。
 *
 * 判据（都基于"剥注释后的源码文本"，纯函数，便于双向对照）：
 *   ① 断言实参里出现 `|| true` / `|| 1` / `|| 'x'` 这类**恒真兜底**；
 *   ② `assert.ok(true)` / `assert.equal(true, true)` 这种**字面恒真**；
 *   ③ **自比较**：`assert.equal(A, A)` / `assert.deepEqual(A, A)`（A 为含调用/取属性的表达式）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 剥掉行注释与块注释（字符串内的注释符号不动 —— 与本仓库 markdownScan 同口径的"够用即可"） */
export function stripComments(src: string): string {
  let inBlock = false
  return src
    .split('\n')
    .map((raw) => {
      let out = ''
      let rest = raw
      while (rest !== '') {
        if (inBlock) {
          const end = rest.indexOf('*/')
          if (end < 0) {
            rest = ''
            break
          }
          rest = rest.slice(end + 2)
          inBlock = false
        } else {
          const start = rest.indexOf('/*')
          if (start < 0) {
            out += rest
            rest = ''
            break
          }
          out += rest.slice(0, start)
          rest = rest.slice(start + 2)
          inBlock = true
        }
      }
      return out.replace(/(^|[^:])\/\/.*$/, '$1')
    })
    .join('\n')
}

/** 按**顶层逗号**切分实参（括号/引号感知；跨行调用暂不覆盖，见文件头说明） */
export function splitArgs(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (quote !== null) {
      cur += ch
      if (ch === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      cur += ch
      continue
    }
    if ('([{'.includes(ch)) {
      depth += 1
      cur += ch
      continue
    }
    if (')]}'.includes(ch)) {
      if (depth === 0) {
        out.push(cur)
        return out
      }
      depth -= 1
      cur += ch
      continue
    }
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

/** `assert.xxx(a, b, ...)` → 实参文本（取不到或有歧义时返回 null） */
function callArgs(line: string): string[] | null {
  const open = line.indexOf('(')
  if (open < 0) return null
  const args = splitArgs(line.slice(open + 1))
    .map((a) => a.trim())
    .filter((a) => a !== '')
  return args.length >= 2 ? args : null
}

export interface WeakHit {
  rule: 'vacuous-or' | 'literal-true' | 'self-compare'
  line: number
  text: string
}

/**
 * 扫描源码里的"弱断言"。**纯函数**：坏样本必须命中、好样本不得误报（见本文件的两条对照用例）。
 */
export function scanWeakAssertions(src: string): WeakHit[] {
  const clean = stripComments(src)
  const hits: WeakHit[] = []
  const lines = clean.split('\n')
  lines.forEach((line, i) => {
    const t = line.trim()
    if (!t.includes('assert')) return
    // ① 恒真兜底：assert.*(… || true …) / || 1 / || '任意字面量'
    if (/\|\|\s*(true|1|'[^']*'|"[^"]*"|`[^`]*`)\s*[,)]/.test(t)) {
      hits.push({ rule: 'vacuous-or', line: i + 1, text: t.slice(0, 160) })
    }
    // ② 字面恒真
    // ⚠ `(?!\w)`：否则 `assert.equal(120 > x, false)` 会被 `1` 误伤（数字开头的实参）
    if (/assert\.(ok|equal|strictEqual)\(\s*(?:true|1)(?![\w.])/.test(t)) {
      hits.push({ rule: 'literal-true', line: i + 1, text: t.slice(0, 160) })
    }
    // ③ 自比较：第 1、2 个**实参**（按顶层逗号切分、空白归一后）逐字相同，
    //    且至少含一次调用/点取（排除 `assert.equal(a, a)` 这种变量对比，那种写法另有用途）
    if (/assert\.(?:equal|deepEqual|strictEqual)\(/.test(t)) {
      const args = callArgs(t)
      if (args !== null) {
        const norm = (x: string): string => x.replace(/\s+/g, '')
        const left = norm(args[0] as string)
        const right = norm(args[1] as string)
        if (left === right && /[.(]/.test(left) && left.length > 6) {
          hits.push({ rule: 'self-compare', line: i + 1, text: t.slice(0, 160) })
        }
      }
    }
  })
  return hits
}

const HERE = dirname(fileURLToPath(import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

test('断言强度：全仓测试文件里不得有"恒真/自比较"三类弱断言（回归防线）', () => {
  // ⚠ 排除本文件自身：它把坏样本当**数据**放在字符串里，扫自己必然自伤（并有双向对照用例守着判据）
  const files = walk(HERE)
    .filter((f) => !f.endsWith('assertStrength.test.ts'))
    .sort()
  assert.ok(files.length > 40, `扫描范围应覆盖全部测试文件（实际 ${files.length} 个）`)
  const bad: string[] = []
  for (const f of files) {
    for (const hit of scanWeakAssertions(readFileSync(f, 'utf8'))) {
      bad.push(`${f.slice(HERE.length + 1)}:${hit.line} [${hit.rule}] ${hit.text}`)
    }
  }
  assert.deepEqual(bad, [], `发现弱断言（三类：|| true / 字面恒真 / 自比较）：\n${bad.join('\n')}`)
})

test('断言强度：判据必须抓得到坏值，且不误报好值（双向对照，自证非恒真）', () => {
  const bad = [
    "assert.equal(/\\[secid, retry\\]/.test(drawer) || true, true)",
    "assert.ok(drawer.includes('cursor') === false || true)",
    "assert.ok(panel.includes(k) || 'latestBarDate')",
    'assert.ok(true)',
    'assert.equal(true, true)',
    'assert.deepEqual(klineReadout({ bars, i: 1, macd: null }), klineReadout({ bars, i: 1, macd: null }))',
    "assert.equal(fmtPrice(1500.25), fmtPrice(1500.25))",
    // 带对象字面量（内部含逗号）的自比较：必须按顶层逗号切分才抓得住
    "assert.deepEqual(klineReadout({ bars, i: 1, macd: null }), klineReadout({ bars, i: 1, macd: null }))",
  ]
  for (const src of bad) {
    const hits = scanWeakAssertions(src)
    assert.ok(hits.length >= 1, `坏样本必须被抓到：${src}`)
  }
  // 误报对照：这些都是**好**断言，判据必须一个都不报
  const good = [
    "assert.equal(text, '盯盘 · 数据 09:42:52')",
    "assert.equal(/\\[secid, retry\\]/.test(drawer), true, '主图依赖数组必须含 retry')",
    "assert.ok(panel.includes('未取到'), '现价不可得 ⇒ 显示未取到')",
    "assert.deepEqual(dates.slice(0, 3), ['2026-10-01', '2026-10-02', '2026-10-03'])",
    'assert.equal(hit.score, 3)',
    'assert.ok(scanned > 0 && scanned <= total)',
  ]
  for (const src of good) {
    assert.deepEqual(scanWeakAssertions(src), [], `好样本不得误报：${src}`)
  }
  // 注释里的同类字样不算（剥注释）
  assert.deepEqual(scanWeakAssertions('// assert.ok(x || true) 是坏写法\nassert.equal(a, 1)'), [])
})
