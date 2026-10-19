/**
 * 【护盘信号】覆盖广度（阶段一）的**纯视图逻辑**：常驻短标记 + 悬停/读屏口径。不 import react。
 *
 * 契约（宿主 `RescueCoverage`，`src/shared/model.ts`）：
 *   `nEtf`         本拍**触发**的宽基通道数（该通道 `volumeZ ≥ 2`）
 *   `nEtfWithData` 本拍**取到 volumeZ**（基线可用）的通道数 ⇒ 短标记的分母（0 是合法状态）
 *   `nFamily`      命中族数 0..3（族 = 大盘 / 中小盘 / 成长）
 *   `families`     命中族名（`'大盘' | '中小盘' | '成长'`），长度恒 == nFamily
 *   `confirm1`     沪深300 与宽基 ETF 当日涨跌幅的**方向**一致性：`strong` / `same` / `mixed`
 *   `confirm1N`    与沪深300 **同向**的通道数（方向读数口径，不是 z ≥ 2 的通道数）
 *   `confirm2`     30 年国债 ETF 的**反向**读数 = −(当日涨跌幅%)，正=债跌 / 负=债涨；默认池里没有 ⇒ 常态 `null`
 * 缺失原因走**同级字段** `coverageWhy: string[]`（空数组 = 本次无缺失）；整块缺失（老宿主）⇒ `—` + 原因。
 *
 * ⚠ 红线：
 *   · 常驻只留短标记（`3 族 · 5/6`），**不塞长句** —— 口径、阈值、族归属全部进 `title` / `aria-label`；
 *   · 任何一项算不出来就是 `—` + 原因，**绝不用 0 顶替**（0 会被读成"本拍真的没有通道触发"）；
 *   · 阶段一**未计入评分**这句状态必须出现在悬停里（开关打开时才改口，见 `coverageStageNoteOf`）。
 */

import type { RescueCoverage, RescueCoverageConfirm1 } from '../shared/model.ts'

/**
 * 读侧类型：宿主契约是 `RescueCoverage`（七个键都必填），但**读侧一律按可选处理** ——
 * 老日志、裁剪过的快照、`coverage` 存在但某个键缺失，都必须显示 `—` + 原因而不是崩/补 0。
 */
export type RescueCoverageLike = Partial<RescueCoverage>

/** 触发阈值：通道 `volumeZ ≥ 2`（与宿主 `buildRescueCoverage()` 同源，不另造阈值） */
export const COVERAGE_Z_THRESHOLD = 2

/** 整块缺失（老宿主 / 未落该字段）时的唯一原因文案 */
export const COVERAGE_ABSENT_REASON = '宿主未提供覆盖广度（阶段一字段）'

/** 阶段一的状态句（开关 false / 缺省时必须常驻在悬停里） */
export const COVERAGE_STAGE_NOTE = '覆盖广度当前未计入评分（阶段一）：它只描述「这次信号有几条通道、几个族同时在动」，不进总分、不改等级。'

/** 阶段二（开关 true）的口径句 —— 那时再说"不计入评分"就是假话 */
export const COVERAGE_STAGE_NOTE_ON = '覆盖广度附加分已开启（阶段二）：它已作为附加分参与评分，因此本面板不再声称"不计入评分"。'

/** 方向一致性档位的中文（只允许这三个取值；其它 ⇒ 按未取到处理） */
export const COVERAGE_CONFIRM1_TEXT: Record<RescueCoverageConfirm1, string> = {
  strong: '强一致',
  same: '一致',
  mixed: '不一致',
}

/** 族划分的口径（宿主定义的三个族；界面只说口径，不重算族） */
export const COVERAGE_FAMILY_CALIBER =
  '族口径：大盘＝沪深300/上证50，中小盘＝中证500/中证1000，成长＝科创50/创业板指；族内任一通道 z ≥ 2 即该族命中，族数上界 3。'

/** z 的口径（与因子表「同时点量能」同刻度，别与倍数混读） */
export const COVERAGE_Z_CALIBER =
  `z 口径：同刻度 z =（当日累计额 ÷ 20日均额 − 该 5 分钟 slot 近 20 日同刻度均值）÷ 该 slot 的 σ；z ≥ ${COVERAGE_Z_THRESHOLD} 记该通道"触发"。它与「同时点量能倍数」不是同一刻度，不可直接比。`

/** 短标记里允许出现的分隔符（`3 族 · 5/6`）：唯一实现，别处不许另拼 */
const MARKER_SEP = ' · '

const missingMark = '—'

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function count(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.max(0, Math.round(n))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 覆盖广度短标记（唯一实现）：`3 族 · 5/6`。算不出来的那半段显示 `—`，两半都算不出来 ⇒ 整个 `—` */
export function coverageMarkerOf(cov: RescueCoverageLike | null | undefined): string {
  if (cov === null || cov === undefined || !isRecord(cov)) return missingMark
  const fam = count(cov.nFamily)
  const hit = count(cov.confirm1N)
  const total = count(cov.nEtfWithData)
  const famText = fam === null ? missingMark : `${fam} 族`
  // 分母 0 不成立（不是"0 条同向"，而是"没有基线可用的通道"）⇒ 显示 —，原因进 title
  const confText = hit === null || total === null || total <= 0 ? missingMark : `${hit}/${total}`
  if (famText === missingMark && confText === missingMark) return missingMark
  return `${famText}${MARKER_SEP}${confText}`
}

/**
 * 缺失原因清单（宿主 `coverageWhy` + 客户端按字段自检的补集）。
 * 空数组 = 这一次没有缺失。（**不返回 null**：调用方按长度判断，边界更少。）
 */
export function coverageMissingOf(
  cov: RescueCoverageLike | null | undefined,
  why: readonly string[] | null | undefined = null,
): string[] {
  const out: string[] = []
  const push = (s: string): void => {
    const t = s.trim()
    if (t !== '' && !out.includes(t)) out.push(t)
  }
  if (cov === null || cov === undefined || !isRecord(cov)) {
    push(COVERAGE_ABSENT_REASON)
    return out
  }
  for (const w of why ?? []) if (typeof w === 'string') push(w)
  if (count(cov.nFamily) === null) push('族数（nFamily）未取到')
  if (count(cov.confirm1N) === null) push('同向通道数（confirm1N）未取到')
  if (count(cov.nEtf) === null) push('触发通道数（nEtf）未取到')
  const total = count(cov.nEtfWithData)
  if (total === null) push('有读数的通道数（nEtfWithData）未取到')
  else if (total === 0) push('本拍没有基线可用的通道（nEtfWithData = 0，分母不成立）')
  const fam = count(cov.nFamily)
  const families = Array.isArray(cov.families) ? cov.families.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : null
  if (families === null) push('命中族名（families）未取到')
  else if (fam !== null && families.length !== fam) push(`命中族名（families）与族数不一致（${families.length} ≠ ${fam}）`)
  if (cov.confirm1 !== 'strong' && cov.confirm1 !== 'same' && cov.confirm1 !== 'mixed') {
    push(`方向一致性（confirm1）未取到${cov.confirm1 === null || cov.confirm1 === undefined ? '' : `（${String(cov.confirm1)}）`}`)
  }
  // confirm2 的 null 是契约里的合法值（默认池里没有 30 年国债 ETF）⇒ 不算"客户端缺失"，
  // 宿主的 coverageWhy 会写明"未取到"，界面上照它的原因显示。
  return out
}

/** 悬停/读屏里的完整口径：三族归属 + 阈值 + 两档确认读数 + 阶段状态 + 缺失原因 */
export interface CoverageBadge {
  /** 常驻可见（≤ 12 字符）：只允许 `3 族 · 5/6` / `2 族 · —` / `—` */
  marker: string
  /** 悬停 / 键盘聚焦读屏（完整事实，一条不删） */
  title: string
  /** 缺失原因（`null` = 本次无缺失） */
  missing: string | null
  /** 方向一致性档位文字（悬停用；未识别 ⇒ `null`） */
  confirmLabel: string | null
}

/**
 * 短标记 + 悬停口径的唯一实现。
 *
 * `enabled` 是宿主 `RescueConfig.rescueCoverageEnabled` 的回显：缺省/false ⇒ 说「未计入评分（阶段一）」；
 * true ⇒ 改口成"已开启附加分（阶段二）"，不继续说假话。
 */
export function coverageBadgeOf(input: {
  coverage?: RescueCoverageLike | null
  why?: readonly string[] | null
  enabled?: boolean | null
} | null | undefined): CoverageBadge {
  const cov = input?.coverage ?? null
  const why = input?.why ?? null
  const missingList = coverageMissingOf(cov, why)
  const marker = coverageMarkerOf(cov)
  const confirmLabel = cov !== null && cov !== undefined && (cov.confirm1 === 'strong' || cov.confirm1 === 'same' || cov.confirm1 === 'mixed')
    ? COVERAGE_CONFIRM1_TEXT[cov.confirm1]
    : null
  const lines: string[] = ['覆盖广度（阶段一）']
  if (isRecord(cov)) {
    const nFamily = count(cov.nFamily)
    const families = Array.isArray(cov.families)
      ? cov.families.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
      : []
    const familyText = nFamily === null
      ? '未取到'
      : nFamily === 0
        ? '无（0/3 族）'
        : families.length === 0
          ? `族名未提供（${nFamily}/3 族）`
          : `${families.join('、')}（${nFamily}/3 族）`
    lines.push(`命中族：${familyText}`)
    const nEtf = count(cov.nEtf)
    const total = count(cov.nEtfWithData)
    lines.push(
      `触发通道（z ≥ ${COVERAGE_Z_THRESHOLD}）：${nEtf === null ? missingMark : `${nEtf} 条`}；` +
        `有读数的通道：${total === null ? missingMark : `${total} 条`}${total === 0 ? '（分母不成立，短标记那半段显示 —）' : ''}`,
    )
    const doneLabel = cov.confirm1 === 'strong' || cov.confirm1 === 'same' || cov.confirm1 === 'mixed'
      ? COVERAGE_CONFIRM1_TEXT[cov.confirm1]
      : null
    const hit = count(cov.confirm1N)
    lines.push(
      `确认档 1（与沪深300 涨跌方向的一致性）：${doneLabel ?? `未取到${cov.confirm1 === null || cov.confirm1 === undefined ? '' : `（${String(cov.confirm1)}）`}`}` +
        `；同向通道 ${hit === null ? missingMark : `${hit} 条`} ⇒ 短标记 ${marker}`,
    )
    const bond = num(cov.confirm2)
    lines.push(
      `确认档 2（30 年国债 ETF 反向读数，−涨跌幅%）：${bond === null ? '—（未取到）' : bond.toFixed(2)}` +
        `${bond === null ? '——默认通道池里没有这只 ETF，要看得把它加进「自定义通道」' : '（正=债跌/风偏回升，负=债涨/避险；仅展示，不参与评分）'}`,
    )
  } else {
    lines.push(`覆盖广度：${missingMark}（${COVERAGE_ABSENT_REASON}）`)
  }
  lines.push(COVERAGE_FAMILY_CALIBER)
  lines.push(COVERAGE_Z_CALIBER)
  lines.push(input?.enabled === true ? COVERAGE_STAGE_NOTE_ON : COVERAGE_STAGE_NOTE)
  if (missingList.length > 0) lines.push(`缺失：${missingList.join('；')}`)
  return {
    marker,
    title: lines.join('\n'),
    missing: missingList.length === 0 ? null : missingList.join('；'),
    confirmLabel,
  }
}

/** 快照级的"本拍覆盖广度"：优先 `snapshot.coverage`，老宿主退回最新一条带该字段的事件 */
export function latestCoverageOf(snapshot: {
  coverage?: RescueCoverageLike | null
  coverageWhy?: readonly string[] | null
  today?: ReadonlyArray<{ coverage?: RescueCoverageLike | null; coverageWhy?: readonly string[] | null } | null> | null
} | null | undefined): { coverage: RescueCoverageLike | null; why: readonly string[] | null } {
  if (snapshot === null || snapshot === undefined) return { coverage: null, why: null }
  const top = snapshot.coverage
  if (isRecord(top)) return { coverage: top, why: snapshot.coverageWhy ?? null }
  // today 是**时间倒序**（宿主 reverse 过）⇒ 第一个带字段的事件就是最新的一条
  for (const e of snapshot.today ?? []) {
    if (e !== null && e !== undefined && isRecord(e.coverage)) return { coverage: e.coverage, why: e.coverageWhy ?? null }
  }
  return { coverage: null, why: snapshot.coverageWhy ?? null }
}
