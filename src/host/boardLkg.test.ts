/**
 * P2-6（`docs/AUDIT-HOST-PERF.md`）：板块 LKG 的落盘顺序与失败可见性。
 *
 * 旧实现先 `boardLkgDirty = false` 再 `void (async () => …)` 异步写；写失败只 `console.warn`，
 * 这份 LKG 就**永久丢掉**（要等下一次有成功抓取才可能再写）；`atomic.ts` 的 `mkdir` 失败还被
 * `.catch(() => undefined)` 吞掉，报出来的错与真相不符。
 *
 * 判据：
 *   ① 写成功之后才清 dirty（成功 ⇒ false；写期间又标脏 ⇒ 仍为 true）；
 *   ② 注入写失败 ⇒ dirty 仍为 true、原因可读（errno），**下一次调用会立刻重试并成功**；
 *   ③ `mkdir` 失败不被吞：`writeFileAtomic` 抛出，`persistBoardLkgNow` 把原因记进状态。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic.ts'
import { __boardLkgStateOf, __markBoardLkgDirtyForTest, __resetBoardLkgForTest, persistBoardLkgNow } from './em.ts'

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tw-board-lkg-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('P2-6①：写成功之后才清 dirty；写期间又被标脏 ⇒ dirty 保留', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'board-lkg.json')
    __resetBoardLkgForTest()
    __markBoardLkgDirtyForTest()
    assert.equal(__boardLkgStateOf().dirty, true)

    const ok = await persistBoardLkgNow({ target })
    assert.deepEqual(ok, { written: true, reason: null })
    assert.equal(__boardLkgStateOf().dirty, false, '成功后 dirty=false')
    assert.equal(__boardLkgStateOf().writes, 1)
    const disk = JSON.parse(await readFile(target, 'utf8')) as { entries?: unknown[] }
    assert.equal(disk.entries?.length, 1, '文件里确实有一份 LKG')

    // 写期间又来了新结果 ⇒ 这一份已经过时，dirty 必须保留（下一次还会写）
    __markBoardLkgDirtyForTest('board:industry:pct:1:40')
    let markedDuringWrite = false
    const ok2 = await persistBoardLkgNow({
      target,
      write: async (t, text) => {
        if (!markedDuringWrite) {
          markedDuringWrite = true
          __markBoardLkgDirtyForTest('board:concept:pct:1:40', [])
        }
        await writeFileAtomic(t, text)
      },
    })
    assert.equal(ok2.written, true)
    assert.equal(__boardLkgStateOf().dirty, true, '写期间又标脏 ⇒ 不能清 dirty')
    assert.equal(__boardLkgStateOf().writes, 2)
  })
})

test('P2-6②：注入写失败 ⇒ dirty 仍为 true、原因可读、下次立刻重试成功', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'board-lkg.json')
    __resetBoardLkgForTest()
    __markBoardLkgDirtyForTest()

    let attempts = 0
    const flaky = async (t: string, text: string): Promise<void> => {
      attempts += 1
      if (attempts === 1) {
        const error = new Error('注入：磁盘满') as NodeJS.ErrnoException
        error.code = 'ENOSPC'
        throw error
      }
      await writeFileAtomic(t, text)
    }

    const failed = await persistBoardLkgNow({ target, write: flaky })
    assert.equal(failed.written, false)
    assert.equal(__boardLkgStateOf().dirty, true, '写失败 ⇒ dirty 必须恢复/保留（这份 LKG 不能丢）')
    const state = __boardLkgStateOf()
    assert.match(state.lastError?.reason ?? '', /ENOSPC/, '失败原因必须带 errno（可排障）')
    assert.equal(state.writes, 0, '失败不计成功写入')

    // 下一次调用（不依赖 10s 节流）立刻重试并成功
    const retried = await persistBoardLkgNow({ target, write: flaky })
    assert.equal(retried.written, true)
    assert.equal(attempts, 2, '第二次必须真的重试')
    assert.equal(__boardLkgStateOf().dirty, false, '重试成功后 dirty=false')
    assert.equal(__boardLkgStateOf().lastError, null, '成功后清掉上次失败原因')
    const disk = JSON.parse(await readFile(target, 'utf8')) as { entries?: unknown[] }
    assert.equal(disk.entries?.length, 1, '重试确实把 LKG 写进了磁盘')
  })
})

test('P2-6③：mkdir 失败不被吞（errno 可见），dirty 保留', async () => {
  await withDir(async (dir) => {
    // 用普通文件占住"父目录"位置 ⇒ mkdir 必然失败（ENOTDIR）
    const blocked = join(dir, 'blocked')
    await writeFile(blocked, 'not a directory', 'utf8')

    // 第一层：atomic 本身不再吞 mkdir 失败
    await assert.rejects(writeFileAtomic(join(blocked, 'x.json'), '{}'), (error: NodeJS.ErrnoException) => {
      assert.ok(['ENOTDIR', 'EEXIST'].includes(String(error.code)), `必须是 mkdir 的 errno，实测 ${String(error.code)}`)
      return true
    })

    // 第二层：persistBoardLkgNow 记录原因，并保留 dirty（下次还会重试）
    __resetBoardLkgForTest()
    __markBoardLkgDirtyForTest()
    const result = await persistBoardLkgNow({ target: join(blocked, 'sub', 'board-lkg.json') })
    assert.equal(result.written, false)
    assert.ok((result.reason ?? '').length > 0, '失败原因不能为空')
    assert.match(result.reason ?? '', /ENOTDIR|EEXIST/, `原因必须带 mkdir 的 errno：${String(result.reason)}`)
    assert.equal(__boardLkgStateOf().dirty, true)
    assert.equal(__boardLkgStateOf().lastError?.reason, result.reason, '原因同时留在可读状态里（健康簿/日志口径）')
  })
})
