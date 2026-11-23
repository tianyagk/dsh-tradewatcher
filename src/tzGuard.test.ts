/**
 * 时区守卫：凡是要在多个 TZ 下验证的测试文件，必须登记在 `scripts/tz-files.json`。
 *
 * 为什么需要它：门禁第二遍从「全量再跑一次」收窄成「时区敏感子集 × 多时区」（省 ~30s）。
 * 收窄的风险是「新写的时区敏感用例没被登记 ⇒ 只在宿主时区跑过」。这条守卫把风险堵住：
 * 只要测试文件出现时区敏感特征（Asia/Shanghai 字面量 / 从 time.ts 导入 / 调 dayOf|hhmmOf|shClockText|shanghaiParts），
 * 就必须登记，否则红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const LIST: string[] = JSON.parse(readFileSync(join(ROOT, 'scripts/tz-files.json'), 'utf8'))

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.test.ts')) out.push(p.slice(ROOT.length).replace(/^\//, ''))
  }
  return out
}

const SENSITIVE = /Asia\/Shanghai|America\/New_York|from\s+'[^']*\/time\.ts'|\b(dayOf|hhmmOf|shClockText|shanghaiParts|calToday)\s*\(/

test('① 时区敏感测试文件必须登记在 scripts/tz-files.json', () => {
  const missing: string[] = []
  for (const rel of walk(join(ROOT, 'src'))) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    if (SENSITIVE.test(text) && !LIST.includes(rel)) missing.push(rel)
  }
  assert.deepEqual(missing, [], `以下测试文件时区敏感但未登记（会被收窄后漏跑）：\n${missing.join('\n')}`)
})

test('② 登记表里的文件必须真实存在', () => {
  const all = new Set(walk(join(ROOT, 'src')))
  for (const rel of LIST) assert.ok(all.has(rel), `tz-files.json 里的 ${rel} 不存在`)
})

test('③ 反例注入：未登记的时区敏感内容必须被判据抓住', () => {
  const fake = { rel: 'src/host/__fake.test.ts', text: "import { dayOf } from './time.ts'\ntest('x',()=>dayOf(0))" }
  assert.ok(SENSITIVE.test(fake.text), '判据必须能识别 time.ts 导入')
  assert.ok(!LIST.includes(fake.rel))
})
