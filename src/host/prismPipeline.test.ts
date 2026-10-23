import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPrismAnalysis } from './prismPipeline.ts'
import { PrismStore } from './prismStore.ts'

const inputs = { positions: '茅台 100 股', quotes: '600519 1330', account: '总资产：1000.00 元', news: [], skeleton: '骨架' }

test('⑦ 4 路并行 + 1 次汇总；失败只留痕、不自动重试（调用数固定 5）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-pipe-'))
  try {
    const store = new PrismStore(dir)
    await store.init()
    let calls = 0
    let active = 0
    let maxActive = 0
    const llm = {
      stream: (opts: { messages: Array<{ content: unknown }> }) => {
        calls += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        const raw = opts.messages[0]?.content
        const text = Array.isArray(raw) ? raw.map((b) => (b as { text?: string }).text ?? '').join('') : String(raw)
        const fail = text.includes('信息面')
        return (async function* () {
          await new Promise((r) => setTimeout(r, 5))
          active -= 1
          if (fail) throw new Error('boom')
          yield { type: 'text-delta', text: `结论 ${calls}` }
        })()
      },
    }
    const get = (name: string): unknown => {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    }
    const run = await runPrismAnalysis(store, '09:35', inputs, { get, now: () => 1 })
    assert.equal(calls, 5, '4 路 + 1 汇总 = 5 次（失败不重试）')
    assert.equal(run.analyses.length, 4)
    assert.equal(run.analyses.filter((a) => a.text !== null).length, 3)
    assert.match(String(run.analyses.find((a) => a.key === 'info')?.error), /boom/)
    assert.notEqual(run.summary, null, '3 路可用 ⇒ 汇总仍跑')
    assert.equal(maxActive >= 2, true, '4 路必须并行发起（不是串行）')
    assert.equal(store.runs().length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('⑦ 模型不可用：一次调用都不发，整轮留痕', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-pipe2-'))
  try {
    const store = new PrismStore(dir)
    await store.init()
    let calls = 0
    const run = await runPrismAnalysis(store, 'manual', inputs, {
      get: (name) => (name === 'llm' ? { stream: () => { calls += 1; return (async function* () {})() } } : undefined),
      now: () => 1,
    })
    assert.equal(calls, 0)
    assert.match(String(run.error), /默认模型|模型/)
    assert.equal(run.analyses.every((a) => a.error !== null), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('②/③ run.day/at 非空、四份 reports 落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-pipe3-'))
  try {
    const store = new PrismStore(dir)
    await store.init()
    let n = 0
    const llm = { stream: () => { n += 1; const text = n <= 4 ? `分报告${n}` : '汇总' ; return (async function* () { yield { type: 'text-delta', text } })() } }
    const run = await runPrismAnalysis(store, '14:40', inputs, {
      get: (name) => (name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
      now: () => Date.parse('2026-10-22T14:40:05+08:00'),
    })
    assert.equal(run.day, '2026-10-22')
    assert.match(run.at, /^2026-10-22T14:40:0[0-9]\+08:00$/)
    assert.equal(run.reports.length, 4)
    assert.equal(run.reports.every((r) => r.text !== null && r.error === null), true)
    assert.equal(store.runs()[0]?.reports.length, 4, '必须逐份落盘')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('④ 汇总不是严格 JSON ⇒ decision.parseError 带原文（不是 0 笔）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-pipe4-'))
  try {
    const store = new PrismStore(dir)
    await store.init()
    let n = 0
    const llm = {
      stream: () => {
        n += 1
        const text = n <= 4 ? `分报告${n}` : '这是一段没有 JSON 的汇总，不能静默成 0 笔'
        return (async function* () { yield { type: 'text-delta', text } })()
      },
    }
    const run = await runPrismAnalysis(store, 'manual', inputs, {
      get: (name) => (name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
      now: () => 1,
    })
    assert.equal(run.decision?.orders.length, 0)
    assert.match(String(run.decision?.parseError), /没有 JSON/)
    assert.notEqual(run.decision, null, '解析失败也必须留 decision 记录')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
