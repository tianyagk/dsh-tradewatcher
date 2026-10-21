/**
 * **载荷闸门**：对"用户能看到的读数"做三类检查 —— `source`（出处）/ `date`（数据时刻）/ `caliber`（口径自洽）。
 *
 * 来历：`docs/DESIGN-ADOPT-WORKBENCHES.md` §1.7-Q5 把第三方审计员的只读清单 A–G 收成一件可执行的东西
 * （`docs/RECON-WORKBENCHES.md` §5②）。不是新方法论：判据本身早就在各处零散存在
 * （`model.ts` 的 `DataProvenance`、`lagAlertOf`、`p0.test.ts` 的"贡献度 == 总分"、`rescueSnapshotContract.test.ts`
 * 的逐点一致），这里只是**收成一件、并给出双向判据**（必拦 + 必放）。
 *
 * ## 这个模块**不管**什么（避免下一个人把它当成万能的）
 *  - **不阻塞运行时**：判据失败只让测试红 / 让开发期告警，**不让路由 5xx**。我们的失败方向一直是
 *    "少给 + 写清原因"（`partialOutcomeOf`），不是"整块不可用"。
 *  - **不新造口径**：它只核对"载荷自己声明的口径与载荷自己的数字是否自洽"，不引入任何新的计算方法。
 *  - **不碰渲染**：不 import React、不碰 IO、不发请求 ⇒ `node --test` 可直接跑。
 *
 * ## 三条检查的判据（每条都能给出 `where` 与原因）
 *  1. `source`：**有值 ⇒ 必须有出处声明**；**没值 ⇒ 必须有原因**。两者只能占一个。
 *  2. `date`：载荷必须能回答"这是几点的数据"；答不出（`asOfText` 为空）时**必须给整块缺失的原因**（`why`）。
 *  3. `caliber`：载荷声明的不变量必须成立（合计 == 100、贡献度之和 == 总分、序列长度 == 日期数…）；
 *     不变量**算不出来**（输入是 null）时同样必须给原因 —— "判不了"不等于"没问题"。
 *
 * ## 出处覆盖面必须显式声明（`sourceScope`）
 * 本仓库有一条用户口径：**工具详情页不写口径行**（`docs/AUDIT-LEVERAGE-HOST.md` §7.1；杠杆温度计页面上
 * 唯一的说明文字只有「截至 YYYY-MM-DD」）。因此"每个数值格都带出处"不能是硬规矩 —— 只能由**载荷自己**
 * 声明它受哪一档契约约束，且 `payload` 档**必须写理由**（理由会进断言，改它要动测试）。
 */

/** 三类检查 */
export type GateClass = 'source' | 'date' | 'caliber'

/**
 * 出处覆盖面：
 *  - `cell`：**每个数值格各自带出处**（缺一个就报）—— 有多格读数的载荷走这档；
 *  - `payload`：整个载荷只有**一条**出处（`asOfText`）—— 只有"用户明确要求页面不写口径"的工具可以用，
 *    且必须给 `sourceScopeWhy`（断言会核对它非空）。
 */
export type GateSourceScope = 'cell' | 'payload'

/** 一个"用户能看到的数值格" */
export interface GateCell {
  /** 人话路径（用户能指到的那一格，如 `KPI 蛋糕温度`、`市场表 美股 份额`） */
  where: string
  /** 显示文本；`null` = 这一格**没有值**（页面应显示 `—` / `未取到`） */
  value: string | null
  /** 该格的出处/口径声明（悬停 `title`、区的口径行或磁贴的 `source`）；没有声明 ⇒ `null` */
  source: string | null
  /** 没有值时的原因（`missing[]` 的那一句）；有值 ⇒ `null` */
  missingReason: string | null
}

/**
 * 一条口径不变量（**数值等式 + 容差**）。
 *
 * 为什么用数据而不是回调：回调会把判据藏进闭包，测试只能"整体通过/失败"，说不清是哪一条、
 * 也说不出"实际 97 期望 100"。数据形状让每条不变量都能被单独注入、单独报出。
 */
export interface GateInvariant {
  /** 人话名（如 `份额合计`、`温度序列点数`） */
  label: string
  /** 实际值；`null` = 算不出来 */
  actual: number | null
  /** 期望值；`null` = 无从比对（例如"这一屏本来就不该有这条曲线"） */
  expected: number | null
  /** 允许误差（默认 0；四舍五入类口径给 0.5 / 0.01） */
  tolerance?: number
  /** `actual`/`expected` 为 `null` 时**必须**给原因；判得了时可以不给 */
  why?: string | null
}

export interface GateInput {
  /** 载荷名（进问题描述，便于一眼看出是哪一屏） */
  name: string
  /**
   * 数据时刻的**载体**：页面渲染的那一句（如「数据时刻 2026-10-12 21:05（北京时间）」），
   * 或者——当用户明确要求页面不显示日期时——载荷里那条时刻原文。
   * `null` = 既没有可见时刻、载荷也没带 ⇒ 必须由 `why` 解释整块为什么没有数据。
   */
  asOfText: string | null
  /** 整块为什么没有数据（`ToolData.why`）；有数据 ⇒ `null` */
  why: string | null
  /** 出处覆盖面（见 `GateSourceScope`） */
  sourceScope: GateSourceScope
  /** `sourceScope === 'payload'` 时**必填**：为什么允许整屏只有一条出处 */
  sourceScopeWhy?: string
  cells: readonly GateCell[]
  invariants: readonly GateInvariant[]
}

export interface GateProblem {
  cls: GateClass
  /** 问题所在的格/不变量（用户能指到的位置） */
  where: string
  /** 一句人话（含实际值，便于直接贴进评审） */
  detail: string
}

const blank = (s: string | null | undefined): boolean => s === undefined || s === null || s.trim() === ''

/**
 * 跑三类检查。返回 `[]` = 这一屏的读数可以发出去。
 *
 * 顺序固定（`source` → `date` → `caliber`）：同一份载荷同时有多类问题时，报告按类聚在一起更好读。
 */
export function gateProblems(input: GateInput): GateProblem[] {
  const out: GateProblem[] = []
  const tag = input.name

  // ── ① 出处（有值必须有出处；没值必须有原因）─────────────────────────────────
  if (input.sourceScope === 'payload') {
    // 整屏一条出处：要求"用了这档就必须写理由"，否则这档会变成"跳过检查"的后门
    if (blank(input.sourceScopeWhy)) {
      out.push({
        cls: 'source',
        where: tag,
        detail: '出处覆盖面声明为「整屏一条」，但没有写理由 —— 这一档必须逐条说明为什么允许（否则它就是跳过检查的后门）',
      })
    }
    if (blank(input.asOfText) && blank(input.why)) {
      out.push({
        cls: 'source',
        where: tag,
        detail: '整屏只有一条出处，但这条出处本身是空的（既没有数据时刻，也没有整块缺失的原因）⇒ 这一屏的读数无从追溯',
      })
    }
  }
  for (const cell of input.cells) {
    const hasValue = !blank(cell.value)
    if (hasValue) {
      if (input.sourceScope === 'cell' && blank(cell.source)) {
        out.push({ cls: 'source', where: `${tag} · ${cell.where}`, detail: `有值「${String(cell.value).slice(0, 40)}」但没有出处声明（悬停/口径行里读不到它是谁给的）` })
      }
      continue
    }
    if (blank(cell.missingReason)) {
      out.push({ cls: 'source', where: `${tag} · ${cell.where}`, detail: '没有值、也没有原因 —— 「—」本身不是信息（是"上游没有"还是"这次失败"，读者必须能分辨）' })
    }
  }

  // ── ② 数据时刻 ─────────────────────────────────────────────────────────
  if (blank(input.asOfText) && blank(input.why)) {
    out.push({ cls: 'date', where: tag, detail: '答不出"这是几点的数据"，也没有给整块缺失的原因（`why`）' })
  }

  // ── ③ 口径自洽 ─────────────────────────────────────────────────────────
  for (const inv of input.invariants) {
    if (inv.actual === null || inv.expected === null) {
      if (blank(inv.why)) {
        out.push({ cls: 'caliber', where: `${tag} · ${inv.label}`, detail: `不变量算不出来（实际 ${fmtNum(inv.actual)} / 期望 ${fmtNum(inv.expected)}）却没有给原因 —— 判不了不等于没问题` })
      }
      continue
    }
    const tol = inv.tolerance ?? 0
    if (Math.abs(inv.actual - inv.expected) > tol) {
      out.push({
        cls: 'caliber',
        where: `${tag} · ${inv.label}`,
        detail: `实际 ${fmtNum(inv.actual)} ≠ 期望 ${fmtNum(inv.expected)}${tol === 0 ? '' : `（容差 ±${fmtNum(tol)}）`}`,
      })
    }
  }

  return out
}

function fmtNum(v: number | null): string {
  if (v === null) return 'null'
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)
}

/** 问题清单 → 一行一句话（日志/报告/告警用；空数组 ⇒ 空数组） */
export function gateLines(problems: readonly GateProblem[]): string[] {
  return problems.map((p) => `[${p.cls}] ${p.where}：${p.detail}`)
}

/** 便捷判据：这一屏能不能发出去 */
export function gatePasses(problems: readonly GateProblem[]): boolean {
  return problems.length === 0
}
