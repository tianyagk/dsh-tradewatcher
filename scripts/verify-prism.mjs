#!/usr/bin/env node
/**
 * 棱镜端到端验收脚本（重启后运行）：
 *   node scripts/verify-prism.mjs [--write]
 *
 * 只读检查默认不做写操作；加 --write 会依次执行 backfillAvgCost / normalizeCostBasis。
 * 检查项：版本、成本口径、可卖数量、恒等式、闸门状态、回包大小、决策流买卖。
 */
import { readFileSync } from 'node:fs'

const BASE = process.env.TW_BASE ?? 'http://192.168.2.12:3080'
const DATA = process.env.TW_DATA ?? '/home/hu/.dsh/dsh-tradewatcher'
const write = process.argv.includes('--write')

const call = async (action) => {
  const r = await fetch(`${BASE}/tradewatcher/prism`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
  return { status: r.status, body: await r.json().catch(() => null) }
}

const main = async () => {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/tradewatcher/prism`)
  const text = await res.text()
  const payload = JSON.parse(text)
  const bytes = Buffer.byteLength(text)
  const state = payload.state ?? {}
  const account = state.account ?? {}
  const runs = state.runs ?? []
  const version = runs.at(-1)?.codeVersion ?? null
  const settings = state.settings ?? {}
  const positions = account.positions ?? []

  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })

  add('回包体积 < 1.0MB', bytes < 1_000_000, `${(bytes / 1024).toFixed(0)} KiB`)
  add('宿主版本 ≥ 0.238.0', typeof version === 'string' && version >= '0.238.0', String(version))
  add('每个持仓 available ≤ qty', positions.every((p) => (p.available ?? 0) <= p.qty), positions.filter((p) => (p.available ?? 0) > p.qty).map((p) => p.secid).join(',') || 'ok')
  const avgMissing = positions.filter((p) => typeof p.avgCost !== 'number')
  add('全部持仓有买入均价 avgCost', avgMissing.length === 0, avgMissing.map((p) => p.name).join('、') || 'ok')
  const costOff = positions.filter((p) => typeof p.avgCost === 'number' && Math.abs(p.cost - p.avgCost) > Math.max(0.02, p.avgCost * 0.001))
  add('cost 已对齐 avgCost（normalizeCostBasis 后）', costOff.length === 0, costOff.map((p) => `${p.name} ${p.cost}≠${p.avgCost}`).join('；') || 'ok')
  const lastRun = runs.at(-1)
  const gateStatus = lastRun?.drawdown?.status ?? null
  add('最近一轮闸门状态可读', gateStatus !== null, String(gateStatus))
  const eq = state.equity ?? []
  const lastEq = eq.at(-1)
  const identity = lastEq ? Math.abs(lastEq.equity - (lastEq.capital + (account.realized ?? 0) + (lastEq.unrealized ?? 0))) : null
  add('净值恒等式误差 < 1 元', identity !== null && identity < 1, identity === null ? '无净值点' : `差 ${identity.toFixed(2)}`)

  if (write) {
    const bf = await call('backfillAvgCost'); add('执行 backfillAvgCost', bf.status === 200 && bf.body?.ok === true, String(bf.status))
    const nc = await call('normalizeCostBasis'); add('执行 normalizeCostBasis', nc.status === 200 && nc.body?.ok === true, String(nc.status))
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`棱镜验收 @ ${BASE}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('验收失败：', e.message); process.exit(2) })
