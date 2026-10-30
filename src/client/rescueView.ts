/**
 * 【护盘信号】的纯视图逻辑（不 import react ⇒ 能在 node 里直接断言）。
 */

/**
 * 【护盘信号】熔断/备用源提示的**紧凑形式**（task-14 ③）。
 *
 * 用户要求：那条长句（`东财行情主机 3/3 台熔断 · 最早约 1 分钟可重试（全部恢复 14 分钟）—— 当前快照已由腾讯备用源兜底：…`）
 * 不再常驻；**但降级事实不许丢** ⇒ 常驻只留一个紧凑标记（如「备用源」），完整原因进 `title`/`aria-label`。
 *
 * 返回三段：`marker`（常驻可见，≤6 字）、`reason`（完整那句，进 title/aria）、`tone`（是否备用源降级）。
 */
export function breakerBadgeOf(input: {
  openHosts: number
  hosts: number
  allOpen: boolean
  minutesLeft: number
  allMinutesLeft: number
  closed: boolean
  flowSource: string | null | undefined
  stale: boolean
  fallback: unknown
}): { marker: string; reason: string; fromAlt: boolean } {
  const fromAlt = input.flowSource === 'tencent'
  const head = input.closed
    ? `东财行情主机 ${input.openHosts}/${input.hosts} 台熔断${input.allOpen ? '（全部）' : ''} · 下次开盘自动重试`
    : `东财行情主机 ${input.openHosts}/${input.hosts} 台熔断 · 最早约 ${input.minutesLeft} 分钟可重试${
        input.allMinutesLeft > input.minutesLeft ? `（全部恢复 ${input.allMinutesLeft} 分钟）` : ''
      }`
  const impact = fromAlt
    ? '当前快照已由腾讯备用源兜底：价格、量能、脉冲、背离可用；超大单强度与持续性无法计算（该源无分单资金流）'
    : input.stale === true || input.fallback !== undefined
      ? '当前显示上次成功采样/当日复盘数据'
      // 来源未知时（例如客户端已刷新、宿主未重启）不猜测取自哪个源，只陈述可核对的事实
      : '当前快照取自最近一次成功采样（数据时刻见上方「数据」）'
  // 常驻可见只留最短的标记：能一眼看出"现在是降级在跑"，细节全在 title/aria
  const marker = fromAlt ? '备用源' : `熔断 ${input.openHosts}/${input.hosts}`
  return { marker, reason: `${head} —— ${impact}`, fromAlt }
}

// ── v0.98.0（用户建议批 ②）：总分可视化的**语义**工具 ──────────────────────
// 红线：总分是**异常程度**，不是买卖信号 ⇒ 颜色用**中性色阶**，文案只允许"异常程度"这类刻度词，
// 不允许出现「买入 / 卖出 / 建议 / 胜率 / 概率」这类措辞（断言 `rescueVisual.test.ts` 会盯住）。

/**
 * 中性色阶：低（中性灰）→ 中（琥珀）→ 偏高（焦橙）——**不表方向，只表异常程度**。
 *
 * P1-10：改用 `styles.ts` 的语义 token（`--tw-imp-2/3`）。此前的两个硬编码色值在隐身视图里
 * 不会灰化（与护盘等级那一处同一类颜色泄漏）；token 由 `[data-view=incognito]` 统一灰化。
 */
export function abnormalColorOf(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return 'var(--tw-fg-dim)'
  if (score >= 55) return 'var(--tw-imp-3)'
  if (score >= 35) return 'var(--tw-imp-2)'
  return 'var(--tw-fg-dim)'
}

/**
 * 「口径与边界」常驻入口（IMPL-79，用户 2026-10-19 要求）。
 *
 * 用户的诉求是**面板太吵**：护盘面板「底部位置 / 形态 / 触发后对照」表下方有三段常驻文字
 * （宿主算的 `model` 口径句 + 两段红线披露）。处置不是删掉，而是**搬进悬停/读屏**：
 * 常驻区只留一行入口，三段原文原样进 `title` + `aria-label`。
 *
 * ⚠ 红线（为什么不能直接删）：这三段是**我们自己的诚实性披露** ——
 *   · 「历史同类情形的出现频率」（口径，`build.mjs` 锁定片段，防被当成预测）；
 *   · 「95% 区间是 Wilson 区间」+「**不是**胜率、概率或预测」（统计含义，`build.mjs` 锁定片段）；
 *   · 「日内形态不参与概率校准」+「位置低 ≠ 见底」（能力边界与误读防线）。
 * 事实必须仍然可读到，只是默认不占版面。
 */
export const RESCUE_CALIBER_ENTRY = '口径与边界（悬停查看）'

/** 第二/三段（客户端静态披露，原样保留；`build.mjs` 的两条锁定片段都在这里） */
export const RESCUE_CALIBER_DISCLOSURE =
  '口径说明：这里是「历史同类情形的出现频率」的对照片段，不是胜率、概率或预测；给出的 95% 区间是 Wilson 区间，样本越小区间越宽 —— 区间跨过基线时，这个差异不具备可辨识性。' +
  '日内形态（回升/下影线/收回前低）没有可回算的历史分钟数据，因此「不参与概率校准」，只作实时修正参考。' +
  '位置低 ≠ 见底：护盘也可能发生在下跌半程，请结合资金流与量价背离一起判断。'

/**
 * 悬停/读屏里的完整披露：宿主口径句（`model`，第一段）+ 客户端两段，**拼起来原样可读**。
 * `model` 为空（老宿主/降级）时只给客户端两段 —— 不补编一句假口径。
 */
export function caliberHoverTextOf(model: string | null | undefined): string {
  const head = typeof model === 'string' ? model.trim() : ''
  return head === '' ? RESCUE_CALIBER_DISCLOSURE : `${head}\n\n${RESCUE_CALIBER_DISCLOSURE}`
}

/**
 * 常驻入口的渲染参数（唯一实现，便于断言）：
 *   · `label`：常驻区**唯一**可见文本（不含任何披露句）；
 *   · `title` / `ariaLabel`：完整披露（鼠标悬停 / 键盘聚焦读屏各取一个）。
 */
export function caliberEntryOf(model: string | null | undefined): { label: string; title: string; ariaLabel: string } {
  const title = caliberHoverTextOf(model)
  return { label: RESCUE_CALIBER_ENTRY, title, ariaLabel: title }
}

/**
 * 表头「触发后对照 +X%/N日」的唯一实现（P3-3）。
 *
 * 旧写法是 `(targets.at(-1)?.targetPct ?? 0.02) * 100` —— `targets` 为空时**编造**一个
 * "+2%/日"的阈值印在表头上（读者会以为这是宿主标定值）。没有目标就如实说"未取到"。
 */
export function calibrationHeaderOf(input: { targetPct: number | null; horizon: number | null }): string {
  const pct = input.targetPct === null || !Number.isFinite(input.targetPct) ? null : input.targetPct
  const horizon = input.horizon === null || !Number.isFinite(input.horizon) ? null : input.horizon
  if (pct === null || horizon === null) return '触发后对照（目标涨幅/持有期未取到）'
  return `触发后对照 +${(pct * 100).toFixed(0)}%/${horizon}日（历史频率，非胜率/概率）`
}

/**
 * 历史回看弹窗的状态（P1-9）：**失败不许伪装成"当日无信号/无抽样点"**。
 *
 * - `error`：有失败原因 ⇒ 只显示原因 + 重试（那两句"无信号/无抽样"都不会出现）；
 * - `loading`：没有失败、也还没有结果 ⇒ 骨架；
 * - `ready`：拿到结果 ⇒ 正常渲染（此时 events/intraday 为空才是**真的**"当日没有"）。
 */
export function dayHistoryStateOf(input: { err: string | null; detail: unknown | null }): 'error' | 'loading' | 'ready' {
  if (input.err !== null) return 'error'
  return input.detail === null ? 'loading' : 'ready'
}

/** 刻度文案（唯一实现）：只描述异常程度，不含任何买卖语义 */
export function abnormalLabelOf(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return '异常程度 未知'
  if (score >= 55) return '异常程度 偏高'
  if (score >= 35) return '异常程度 中等'
  return '异常程度 低'
}

/** 环形进度条的 dash 参数（占满整圈，`score/100` 决定实线段比例）；纯函数便于断言 */
export function ringDashOf(score: number | null, circumference = 2 * Math.PI * 26): { dash: number; gap: number; pct: number } {
  const pct = score === null || !Number.isFinite(score) ? 0 : Math.max(0, Math.min(100, score)) / 100
  const dash = Math.round(circumference * pct * 100) / 100
  return { dash, gap: Math.round((circumference - dash) * 100) / 100, pct }
}

/**
 * 六卡分钟序列的**读侧归一**（AUDIT-IMPL76 ④）。
 *
 * 宿主线上编码只发有信息量的字段（`hhmm` 空串不发、`price` null 不发），老宿主/落盘快照仍是 dense。
 * 这个函数把**两种编码**都还原成同一种形状：`{ hhmm, amount, price }`，缺省按语义兜底
 * （`hhmm → ''`、`price → null`、`amount → null`，**不把缺失当成 0**）。
 * 判据：对同一份数据，dense 与稀疏编码归一后必须**逐点 deepEqual**。
 */
export interface RescueCardPoint {
  hhmm: string
  amount: number | null
  price: number | null
}

export function rescueCardPointsOf(
  card: { points?: ReadonlyArray<{ hhmm?: string; amount?: number | null; price?: number | null }> | null } | null,
): RescueCardPoint[] {
  const points = card?.points ?? []
  return points.map((p) => ({
    hhmm: typeof p.hhmm === 'string' ? p.hhmm : '',
    amount: typeof p.amount === 'number' && Number.isFinite(p.amount) ? p.amount : null,
    price: typeof p.price === 'number' && Number.isFinite(p.price) ? p.price : null,
  }))
}

/**
 * 信号时间线的**一行短句**（用户 2026-10-26：压到 ≤40 字，不要 `｜` 长串）：
 * `时间 · 等级 · x族 · 分数 · 一句结论`。
 */
export function shortSignalOf(e: {
  hhmm: string
  level: 0 | 1 | 2 | 3
  score?: number | null
  families?: number | null
  reason?: string | null
  kind?: string | null
}): string {
  const label = ['平静', '资金异动', '疑似护盘', '强护盘'][e.level] ?? '—'
  const fam = typeof e.families === 'number' ? `${e.families}族` : '—'
  const score = typeof e.score === 'number' && Number.isFinite(e.score) ? `${Math.round(e.score)}分` : '—'
  const note = (e.reason ?? '').replace(/[｜|]/g, ' ').replace(/\s+/g, ' ').trim()
  const brief = note.length > 14 ? `${note.slice(0, 13)}…` : (note === '' ? '—' : note)
  return `${e.hhmm} · ${label} · ${fam} · ${score} · ${brief}`.slice(0, 40)
}

/**
 * 护盘轮询间隔（秒）：只在交易时段跟随上游 `activeIntervalSec`，**必须做有限性与范围收敛**。
 *
 * 为什么不能直接 `Math.max(10, activeIntervalSec)`：线缆里字段缺失/为 null 时
 * `Math.max(10, undefined) === NaN`，定时器拿到 `NaN*1000` 会被浏览器当成 **0ms**
 * ⇒ 变成死循环打上游。因此：非有限值一律回落 60s，合法值收敛到 [30, 600]。
 */
export function rescuePollSec(activeIntervalSec: unknown, trading: boolean): number {
  if (!trading) return 60
  if (typeof activeIntervalSec !== 'number' || !Number.isFinite(activeIntervalSec)) return 60
  return Math.min(600, Math.max(30, activeIntervalSec))
}
