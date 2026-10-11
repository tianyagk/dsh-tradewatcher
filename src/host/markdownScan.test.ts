/**
 * 用户可见字符串里的 Markdown `**` 计数必须为 0（回归防线，第三次防止它回来）。
 *
 * 为什么扫源码而不是扫运行时：工具 `description` / `methodology` / `disclaimer` 都是**常量字面量**，
 * 运行时要拿到全部 defs 就得把插件启起来；源码里"引号/反引号内的文本"就是它们的唯一来源。
 * 扫描规则：**先剥注释**（注释里出现 `**` 是给人看的，不算泄漏），再看字符串字面量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/** 剥掉 `//` 行注释与 `/* *\/` 块注释（字符串内的注释符号不动 —— 够用即可） */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

export interface Leak {
  file: string
  line: number
  text: string
}

/** 找出用户可见字符串里的 `**`（粗体标记泄漏） */
export function scanMarkdownLeaks(src: string, file = ''): Leak[] {
  const clean = stripComments(src)
  const out: Leak[] = []
  const lines = clean.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.includes('**')) continue
    // 只认"引号内的**"：随便给一行带 ** 的注释或代码不算
    if (/['"`][^'"`]*\*\*/.test(line)) out.push({ file, line: i + 1, text: line.trim().slice(0, 160) })
  }
  return out
}

test('用户可见字符串里不许出现 Markdown ** （工具描述 / methodology / disclaimer / 界面文案）', () => {
  const files = [...walk(join(root, 'host')), ...walk(join(root, 'shared')), ...walk(join(root, 'client'))]
  const leaks: Leak[] = []
  for (const f of files) {
    const rel = relative(root, f)
    leaks.push(...scanMarkdownLeaks(readFileSync(f, 'utf8'), rel))
  }
  assert.deepEqual(
    leaks.map((l) => `${l.file}:${l.line}`),
    [],
    `用户可见字符串里有 ${leaks.length} 处 Markdown ** 泄漏：\n${leaks.map((l) => `${l.file}:${l.line}  ${l.text}`).join('\n')}`,
  )
})

test('扫描非恒真：塞一个 ** 进去必须被抓到', () => {
  const dirty = "const a = '**过冷** 只是标签'"
  assert.equal(scanMarkdownLeaks(dirty).length, 1)
  assert.equal(scanMarkdownLeaks("// 注释里的 ** 不算\nconst a = '干净'").length, 0, '注释里的 ** 不该误报')
})
