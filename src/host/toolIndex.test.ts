/**
 * README 工具索引表 vs `tools.ts` 的 drift 断言（P1-15）。
 *
 * 为什么用**源码级**断言：`defs` 是在注册函数里现场构造的（需要 ctx/store），
 * 想拿到名字就得跑一遍插件启动；而这张表要防的是"加了工具忘了改文档"，
 * 源码里的 `name: \`${PREFIX}xxx\`` 就是唯一真相源，直接对齐最省事也最准。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const readText = (rel: string): string => readFileSync(join(here, rel), 'utf8')

/** 从 tools.ts 抓出所有工具名（`${PREFIX}` 之后的短名，按出现顺序） */
export function toolNamesFromSource(src: string): string[] {
  const out: string[] = []
  const re = /name: `\$\{PREFIX\}([a-z_]+)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push(m[1])
  return out
}

/** 从 README 的索引表抓出 `名字`（反引号包裹） */
export function toolNamesFromReadme(src: string): string[] {
  const start = src.indexOf('## agent 工具索引')
  assert.ok(start >= 0, 'README 必须有「## agent 工具索引」一节')
  const end = src.indexOf('\n## ', start + 1)
  const body = src.slice(start, end < 0 ? undefined : end)
  const out: string[] = []
  for (const line of body.split('\n')) {
    const m = /^\|\s*(行情|分析|持仓)\s*\|\s*`([a-z_]+)`\s*\|/.exec(line)
    if (m !== null) out.push(m[2])
  }
  return out
}

test('README 工具索引与 tools.ts 的 defs 完全一致（名字与数量）', () => {
  const fromSrc = toolNamesFromSource(readText('./tools.ts'))
  const fromReadme = toolNamesFromReadme(readText('../../README.md'))
  assert.deepEqual([...fromReadme].sort(), [...fromSrc].sort(), `README 与 defs 不一致：README=${fromReadme.join(',')} defs=${fromSrc.join(',')}`)
  assert.equal(fromSrc.length, 12, `工具计数应为 12（实际 ${fromSrc.length}）`)
  assert.equal(fromReadme.length, 12)
  // README 里的计数声明也要对得上
  assert.ok(readText('../../README.md').includes('计数：**12** 个工具'), 'README 的计数声明要同步')
})

test('drift 断言真的会抓：加一个假工具就不一致', () => {
  const fake = readText('./tools.ts') + '\n// defs.push({ name: `${PREFIX}fake_tool`, description: "x" })'
  assert.equal(toolNamesFromSource(fake).includes('fake_tool'), true, '假工具能被抓出来')
  const fromReadme = toolNamesFromReadme(readText('../../README.md'))
  assert.notDeepEqual([...fromReadme].sort(), [...toolNamesFromSource(fake)].sort(), '此时两边必须不一致（否则断言没锁住任何东西）')
})
