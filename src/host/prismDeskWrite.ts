/**
 * v0.203.0：棱镜 AGENT DESK 写接口（B5）——持仓手工调整 + 约束六字段。
 * 只写 `prism-account.json` 的 positions 与 `prism-ledger.jsonl`；**不下单**（R12）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PrismAccount, PrismPosition, PrismSettings } from '../shared/prism.ts'

export interface PositionInput { op?: unknown; secid?: unknown; shares?: unknown; cost?: unknown; confirm?: unknown }

export interface PositionOpResult {
  ok: boolean
  error?: string
  account?: PrismAccount
  note?: string
  entry?: PrismLedgerEntry
}

export interface PrismLedgerEntry {
  id: string
  ts: number
  kind: 'manual-adjust'
  op: 'add' | 'update' | 'remove'
  secid: string
  before: { qty: number; cost: number } | null
  after: { qty: number; cost: number } | null
  note: string
}

/** 仅沪深 A 股 / ETF：`1.6xxxxx`、`0.0xxxxx`、`0.3xxxxx`、`1.5xxxxx`、`0.1xxxxx` */
export function isValidSecid(secid: unknown): secid is string {
  return typeof secid === 'string' && /^(1\.[56]\d{5}|0\.[013]\d{5})$/.test(secid)
}

/** 入参校验：正整数手（100 的整数倍）与有限正成本 */
export function validatePositionInput(input: PositionInput): string | null {
  const op = input.op
  if (op !== 'add' && op !== 'update' && op !== 'remove') return 'op 必须是 add / update / remove'
  if (!isValidSecid(input.secid)) return 'secid 必须是沪深 A 股或 ETF（如 1.600519 / 1.510300）'
  if (op === 'remove') return null
  const shares = input.shares
  if (typeof shares !== 'number' || !Number.isInteger(shares) || shares <= 0 || shares % 100 !== 0) return 'shares 必须是正整数且为 100 的整数倍'
  const cost = input.cost
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) return 'cost 必须是有限正数'
  return null
}

const round2 = (v: number): number => Math.round(v * 100) / 100

/** 纯函数：把一次手工调整应用到账户（不落盘） */
export function applyPositionOp(account: PrismAccount, input: PositionInput, now: number): PositionOpResult {
  const bad = validatePositionInput(input)
  if (bad !== null) return { ok: false, error: bad }
  const op = input.op as 'add' | 'update' | 'remove'
  const secid = input.secid as string
  const idx = account.positions.findIndex((p) => p.secid === secid)
  const before = idx >= 0 ? { qty: account.positions[idx]!.qty, cost: account.positions[idx]!.cost } : null
  const positions = account.positions.slice()
  let note = ''
  if (op === 'add') {
    if (idx >= 0) return { ok: false, error: '该标的已在持仓，请用 update' }
    const shares = input.shares as number
    const cost = round2(input.cost as number)
    positions.push({ secid, name: secid, qty: shares, available: shares, cost } as PrismPosition)
    note = `新增持仓 ${secid} ${shares} 股 @ ${cost}`
  } else if (op === 'update') {
    if (idx < 0) return { ok: false, error: '该标的不在持仓，请用 add' }
    const shares = input.shares as number
    const cost = round2(input.cost as number)
    positions[idx] = { ...positions[idx]!, qty: shares, available: Math.min(positions[idx]!.available, shares), cost }
    note = `调整持仓 ${secid} → ${shares} 股 @ ${cost}`
  } else {
    if (idx < 0) return { ok: false, error: '该标的不在持仓' }
    const p = positions[idx]!
    if (p.qty !== 0 && input.confirm !== true) return { ok: false, error: `持仓 ${secid} 仍有 ${p.qty} 股，需 confirm:true 才能删除` }
    positions.splice(idx, 1)
    note = `删除持仓 ${secid}`
  }
  const entry: PrismLedgerEntry = {
    id: `M${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ts: now, kind: 'manual-adjust', op, secid,
    before, after: op === 'remove' ? null : { qty: positions.find((p) => p.secid === secid)!.qty, cost: positions.find((p) => p.secid === secid)!.cost },
    note,
  }
  return { ok: true, account: { ...account, positions }, note, entry }
}

export function prismLedgerPath(dir: string): string { return join(dir, 'prism-ledger.jsonl') }

export function appendPrismLedger(dir: string, entry: PrismLedgerEntry): void {
  mkdirSync(dir, { recursive: true })
  appendFileSync(prismLedgerPath(dir), `${JSON.stringify(entry)}\n`)
}

export function readPrismLedger(dir: string): PrismLedgerEntry[] {
  const p = prismLedgerPath(dir)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as PrismLedgerEntry)
}

/** 约束六字段：名 → 值（0–100；perOrderYuan ≥ 0） */
export const PRISM_CONSTRAINT_KEYS = ['perStockPct', 'stopLossPct', 'perOrderYuan', 'maxPosPct', 'maxDDPct', 'minCashPct'] as const
export type PrismConstraintKey = typeof PRISM_CONSTRAINT_KEYS[number]
export type PrismConstraints = Record<PrismConstraintKey, number | null>

export function validateConstraints(input: Record<string, unknown>): { ok: true; value: PrismConstraints } | { ok: false; error: string } {
  const out = {} as PrismConstraints
  for (const k of PRISM_CONSTRAINT_KEYS) {
    const v = input[k]
    if (v === undefined || v === null) { out[k] = null; continue }
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `${k} 必须是数字` }
    if (k === 'perOrderYuan') {
      if (v < 0) return { ok: false, error: 'perOrderYuan 必须 ≥ 0' }
      out[k] = round2(v)
      continue
    }
    if (v < 0 || v > 100) return { ok: false, error: `${k} 必须在 0–100 之间` }
    out[k] = round2(v)
  }
  return { ok: true, value: out }
}

export function constraintsOf(settings: PrismSettings): PrismConstraints {
  const out = {} as PrismConstraints
  for (const k of PRISM_CONSTRAINT_KEYS) out[k] = typeof settings[k] === 'number' ? settings[k] as number : null
  return out
}
