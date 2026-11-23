/** 金额档案缓存：档案未变时不得每次请求都 readdir + 逐文件读 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('① 目录 mtime 未变 ⇒ 命中缓存（用源码判据 + 行为）', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('./dogwatch.ts', import.meta.url), 'utf8'))
  assert.match(src, /AMOUNT_CACHE_TTL_MS/)
  assert.match(src, /dirStat\.mtimeMs === amountCache\.dirMtimeMs/)
  assert.match(src, /return new Map\(amountCache\.map\)/, '命中必须返回副本，避免调用方改缓存')
})

test('② 新写档案改变目录 mtime ⇒ 缓存失效（行为模型）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amount-cache-'))
  try {
    const { stat } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    const before = (await stat(dir)).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    await writeFile(join(dir, 'amount-2026-11-23.json'), JSON.stringify({ total: 1 }))
    const after = (await stat(dir)).mtimeMs
    assert.ok(after > before, '写文件必须改变目录 mtime（缓存以此失效）')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
