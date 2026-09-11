/**
 * Agent-facing read-only tools + system-prompt guidance. Registered on the
 * host `tools` registry (when the service is present) with plain object
 * literals (structural face — no runtime dependency on @deepseek-ai/dsh-tools).
 *
 * Everything the sidebar panel writes lives in the same JSON files, so a
 * session can analyse holdings, reconstruct the ledger and optimise: the
 * tools read the live files + live quotes; the plain JSON is additionally
 * documented in README for file-tool based analysis.
 */
import { TW_ROWS, type CalEvent, type QuoteRow } from '../shared/model.ts'
import { SECID_RE } from '../shared/model.ts'
import * as em from './em.ts'
import { assemblePortfolio, ledgerViews, verbLabel } from './portfolio.ts'
import { DataStore, dataHome } from './store.ts'
import { CalendarStore, calToday } from './calendar.ts'
import { CAL_CATEGORY_LABEL, type CalCategory } from '../shared/model.ts'
import type { PluginContext, PluginToolDefinition, PluginToolRuntime, PluginSystemPrompt } from './context.ts'

const PREFIX = 'tradewatcher_'

function textBlock(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

const fmtNum = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(digits)

const fmtMoney = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return n.toFixed(2)
}

function pnlLine(label: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return `${label}: —`
  const sign = value > 0 ? '+' : ''
  return `${label}: ${sign}${fmtMoney(value)}`
}

// ── quote helpers shared by tools ─────────────────────────────────────────

async function resolveQuoteIds(idsRaw: unknown): Promise<string[]> {
  const raw = String(idsRaw ?? '').trim()
  if (raw === '') throw new Error('secids 是必填参数（逗号分隔，如 1.000001,114.lhm）')
  const presets: Record<string, string[]> = {
    cn: TW_ROWS[0].items.map((i) => i.secid),
    intl: TW_ROWS[1].items.map((i) => i.secid),
    commodity: TW_ROWS[2].items.map((i) => i.secid),
  }
  if (raw === 'all') return [...presets.cn, ...presets.intl, ...presets.commodity]
  if (presets[raw] !== undefined) return presets[raw]
  const ids = raw.split(',').map((s) => s.trim().toUpperCase()).filter((s) => SECID_RE.test(s))
  if (ids.length === 0) throw new Error('未解析到合法证券代码（格式如 1.000001 / 114.lhm）')
  return [...new Set(ids)].slice(0, 120)
}

function renderQuotes(items: Record<string, QuoteRow>): string {
  const lines = Object.values(items).map((q) => {
    const pct = q.pct === null ? '—' : `${q.pct > 0 ? '+' : ''}${q.pct.toFixed(2)}%`
    const chg = q.chg === null ? '—' : `${q.chg > 0 ? '+' : ''}${q.chg.toFixed(2)}`
    return `${q.name}（${q.secid}） 现价 ${fmtNum(q.price)}  涨跌 ${chg}  幅度 ${pct}  ${
      q.prev === null ? '' : `昨收 ${fmtNum(q.prev)}`
    }${q.amount === null ? '' : `  成交额 ${fmtMoney(q.amount)}`}`
  })
  return lines.length === 0 ? '未取到行情数据（接口繁忙请稍后重试）。' : lines.join('\n')
}

// ── tools ─────────────────────────────────────────────────────────────────

export function makeAgentTools(
  store: DataStore,
  calendar?: CalendarStore,
): {
  registerTools: (tools: PluginToolRuntime, prompt: PluginSystemPrompt | undefined) => () => void
} {
  const defs: PluginToolDefinition[] = []

  defs.push({
    name: `${PREFIX}portfolio`,
    description:
      '读取 tradewatcher 持仓总览：按分组输出总市值、浮动盈亏、当日盈亏与累计已实现盈亏，附每只持仓的' +
      '数量/摊薄成本/现价/市值/浮盈/当日盈亏明细与实时行情时间戳。数据由逐笔买卖流水自动核算（移动加权成本、费用计入），' +
      '纯只读。Triggers: 查看持仓/我的仓位/持仓盈亏/市值, 分析持仓, 投资组合分析.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeEmpty: { type: 'boolean', description: '是否包含数量为 0 的已清仓持仓（默认 false）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          generatedAt: { type: 'number' },
          grand: {},
          groups: { type: 'array', items: {} },
          positions: { type: 'array', items: {} },
          stale: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const v = value as {
          view?: {
            grand: { totalMv: number; floatPnl: number; dilutedPnl?: number; dayPnl: number; realized: number }
            groups: Array<{ id: string; name: string; totalMv: number; floatPnl: number; dayPnl: number; realized: number; archived?: boolean }>
            positions: Array<{
              posId: string; groupId: string; secid: string; name: string; qty: number; avgCost: number
              dilutedCost: number | null; realized: number; mv: number | null
              floatPnl: number | null; dilutedPnl: number | null; dayPnl: number | null
              price: number | null; pct: number | null
            }>
          }
          stale?: number
          error?: string
        }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        const view = v.view
        if (view === undefined) return textBlock('暂无数据。')
        const g = view.grand
        const head =
          `【持仓总览】${pnlLine('总市值', g.totalMv)} | ${pnlLine('持仓盈亏(摊薄口径)', g.dilutedPnl ?? g.floatPnl)} | ` +
          `${pnlLine('浮动盈亏(均价口径)', g.floatPnl)} | ${pnlLine('当日盈亏', g.dayPnl)} | ${pnlLine('累计已实现', g.realized)}` +
          (v.stale && v.stale > 0 ? `（${v.stale} 只持仓行情暂缺）` : '')
        const groupLines = view.groups
          .filter((x) => x.archived !== true)
          .map((x) => `  ▸ ${x.name}: ${fmtMoney(x.totalMv)}  ${pnlLine('浮盈', x.floatPnl)} ${pnlLine('当日', x.dayPnl)}`)
        const posLines: string[] = []
        for (const p of view.positions) {
          if (p.qty === 0) continue
          const price = p.price ?? null
          const pct = price !== null && p.pct !== null ? `（${p.pct > 0 ? '+' : ''}${p.pct.toFixed(2)}%）` : ''
          posLines.push(
            `  • ${p.name}（${p.secid}）数量 ${p.qty}  均价成本 ${fmtNum(p.avgCost, 4)}  摊薄成本 ${fmtNum(p.dilutedCost, 4)}  现价 ${fmtNum(price)}${pct}\n` +
            `    市值 ${fmtMoney(p.mv)}  持仓盈亏(摊薄) ${fmtMoney(p.dilutedPnl)}  浮动盈亏(均价) ${fmtMoney(p.floatPnl)}  当日 ${fmtMoney(p.dayPnl)}  已实现 ${fmtMoney(p.realized)}`,
          )
        }
        const body = [
          head,
          ...(groupLines.length > 0 ? ['分组：', ...groupLines] : ['暂无分组。']),
          ...(posLines.length > 0 ? ['持仓明细：', ...posLines] : ['暂无持仓。']),
        ]
        return textBlock(body.join('\n'))
      },
    },
    async execute(args) {
      try {
        const port = store.portData()
        const secids = [...new Set(port.items.map((p) => p.secid))]
        const quotes = secids.length > 0 ? await em.fetchQuotes(secids) : {}
        const { view, stale } = assemblePortfolio(port.groups, port.items, store.ledgerEntries(), quotes)
        if (args.includeEmpty !== true) {
          view.positions = view.positions.filter((p) => p.qty > 0)
        }
        return { view, stale }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  defs.push({
    name: `${PREFIX}ledger`,
    description:
      '读取 tradewatcher 的逐笔流水/操作记录（买入、卖出、调整、建仓、移除、分组的创建/改名/归档/还原等），' +
      '按时间倒序。可指定持仓（posId）或分组（groupId）过滤；limit 默认 100。适合追溯每只持仓的完整交易过程与成本变化。' +
      'Triggers: 查看交易流水/历史记录/买卖记录, 某只股票的买卖历史, 分组操作记录, 复盘交易.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        posId: { type: 'string', description: '持仓 id（不传则全部；用 tradewatcher_portfolio 查看 posId）' },
        groupId: { type: 'string', description: '分组 id（不传则全部）' },
        limit: { type: 'number', description: '返回条数（默认 100，最大 500）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: {}, ts: {}, verb: {}, actor: {}, groupName: {}, posName: {},
                qty: {}, price: {}, fee: {}, note: {},
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { entries?: Array<Record<string, unknown>>; error?: string }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        const rows = v.entries ?? []
        if (rows.length === 0) return textBlock('暂无流水记录。')
        const lines = rows.map((r) => {
          const ts = new Date(Number(r.ts)).toLocaleString('zh-CN', { hour12: false })
          const where = [r.groupName ?? null, r.posName ?? null].filter(Boolean).join(' / ')
          const qty = r.qty !== undefined ? ` ${r.qty}` : ''
          const price = r.price !== undefined && r.price !== null ? `@${fmtNum(r.price as number)}` : ''
          const fee = r.fee !== undefined && r.fee !== null && Number(r.fee) !== 0 ? ` 费${r.fee}` : ''
          const note = r.note !== undefined && r.note !== null && String(r.note) !== '' ? ` — ${String(r.note)}` : ''
          return `[${ts}] ${verbLabel(r.verb as never)} ${where}${qty}${price}${fee}${note}（${String(r.actor) === 'tool' ? '会话' : '界面'}）`
        })
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        const posId = typeof args.posId === 'string' && args.posId !== '' ? args.posId : undefined
        const groupId = typeof args.groupId === 'string' && args.groupId !== '' ? args.groupId : undefined
        const limit = typeof args.limit === 'number' ? Math.min(500, Math.max(1, Math.round(args.limit))) : 100
        const port = store.portData()
        const entries = ledgerViews(store.ledgerEntries(), port.groups, port.items, { posId, groupId, limit })
        return { entries }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  defs.push({
    name: `${PREFIX}watchlist`,
    description:
      '读取 tradewatcher 自选列表（分组结构）。要同时看实时行情请配合 tradewatcher_quotes（把返回的 secid 逗号拼接传入）。' +
      'Triggers: 查看自选股/自选列表/关注列表.',
    parameters: {
      type: 'object', additionalProperties: false, properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { groups: { type: 'array', items: {} }, items: { type: 'array', items: {} } },
      },
      render: (_a, value) => {
        const v = value as { groups?: Array<{ id: string; name: string; archived?: boolean }>; items?: Array<{ id: string; groupId: string; name: string; secid: string; note?: string }>; error?: string }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        const groups = (v.groups ?? []).filter((g) => g.archived !== true)
        if (groups.length === 0) return textBlock('暂无自选分组。可在侧边栏「盯盘 → 自选」中添加。')
        const lines: string[] = []
        for (const g of groups) {
          const items = (v.items ?? []).filter((i) => i.groupId === g.id)
          lines.push(`▸ ${g.name}（${items.length}）`)
          for (const it of items) lines.push(`   ${it.name}（${it.secid}）${it.note !== undefined && it.note !== '' ? ` — ${it.note}` : ''}`)
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute() {
      try {
        const w = store.watchData()
        return { groups: w.groups, items: w.items }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  defs.push({
    name: `${PREFIX}quotes`,
    description:
      '批量实时行情（免费延迟源，经 tradewatcher 主机中继）。支持预设组：cn（A股六大指数）/ intl（国际指数）/ commodity（大宗商品）/ all；' +
      '或逗号分隔的任意东财代码（如 1.600519 贵州茅台、0.300750、116.00700 港股、1.510300 ETF、100.KOSPI200）。' +
      'Triggers: 查行情/股价/指数/期货/商品价格, 今天涨了多少, 自选行情, 报价.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['secids'],
      properties: { secids: { type: 'string', description: '如 cn / all / 1.600519,114.lhm' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ts: { type: 'number' }, items: { type: 'object', additionalProperties: true } },
      },
      render: (_a, value) => {
        const v = value as { items?: Record<string, QuoteRow>; ts?: number; error?: string }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        return textBlock(renderQuotes(v.items ?? {}))
      },
    },
    async execute(args) {
      try {
        const ids = await resolveQuoteIds(args.secids)
        const items = await em.fetchQuotes(ids)
        return { ts: Date.now(), items }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  defs.push({
    name: `${PREFIX}search`,
    description:
      '在 tradewatcher 的证券池中搜索代码/名称（A股股票、ETF/基金、指数、期货主连等），返回带 secid 的候选，' +
      '供 tradewatcher_quotes 使用或与用户确认后加入自选/持仓。Triggers: 搜索股票/代码/某只证券的代码, 找基金代码.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: { query: { type: 'string', description: '名称关键字或代码，如 茅台 / 600519 / 沪深300' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { hits: { type: 'array', items: {} } },
      },
      render: (_a, value) => {
        const v = value as { hits?: Array<{ name: string; code: string; secid: string; kind: string }>; error?: string }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        const hits = v.hits ?? []
        if (hits.length === 0) return textBlock('未找到匹配证券。')
        return textBlock(hits.map((h) => `${h.name}（${h.code}）${h.kind} → ${h.secid}`).join('\n'))
      },
    },
    async execute(args) {
      try {
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (query === '') throw new Error('query 是必填参数')
        const hits = await em.searchSymbols(query)
        return { hits }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  // ── 财经日历：读取 ────────────────────────────────────────────────
  defs.push({
    name: `${PREFIX}calendar`,
    description:
      '读取 tradewatcher 财经日历（宏观事件、IPO/新股申购与上市、持仓与自选标的的财报预约披露、分红除权除息），' +
      '按日期返回（默认今天起 30 天）。自动事件来自东方财富数据中心（6 小时缓存），手动事件由用户在侧边栏维护。' +
      'Triggers: 看日历/近期财经事件/新股上市日期/财报披露时间/分红除权日.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        from: { type: 'string', description: '起始日期 YYYY-MM-DD（默认今天）' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD（默认 +30 天）' },
        category: { type: 'string', description: '可选过滤：macro-intl/macro-cn/ipo/earnings/dividend/other' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { events: { type: 'array', items: {} }, syncedAt: { type: 'number' } } },
      render: (_a, value) => {
        const v = value as { events?: CalEvent[]; syncedAt?: number; error?: string }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        const rows = v.events ?? []
        if (rows.length === 0) return textBlock('该区间暂无事件。')
        const mark = (i: number): string => (i === 3 ? '【高】' : i === 2 ? '【中】' : '')
        const lines = rows.map((e) =>
          `${e.date} ${mark(e.importance)}${e.title}（${CAL_CATEGORY_LABEL[e.category] ?? e.category}${e.source === 'auto' ? '·自动' : ''}）` +
          (e.note !== undefined && e.note !== '' ? ` — ${e.note}` : ''),
        )
        return textBlock(`共 ${rows.length} 条：\n${lines.join('\n')}`)
      },
    },
    async execute(args) {
      if (calendar === undefined) return { error: '日历模块未挂载' }
      try {
        const from = typeof args.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.from) ? args.from : calToday(0)
        const to = typeof args.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.to) ? args.to : calToday(30)
        await calendar.init()
        try {
          const port = store.portData()
          const codes = new Set<string>()
          const push = (secid: string): void => {
            const m = /^(\d{1,3})\.([A-Za-z0-9]+)$/.exec(secid)
            if (m !== null && (m[1] === '0' || m[1] === '1')) codes.add(m[2])
          }
          for (const it of store.watchData().items) push(it.secid)
          for (const it of port.items) push(it.secid)
          await calendar.sync([...codes], false)
        } catch {
          /* 同步失败不影响读取 */
        }
        const cat = typeof args.category === 'string' && args.category !== '' ? args.category : null
        let events = calendar.list(from, to)
        if (cat !== null) events = events.filter((e) => e.category === cat)
        return { events, syncedAt: calendar.syncedAt }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  // ── 财经日历：新增（手动事件） ──────────────────────────────────────
  defs.push({
    name: `${PREFIX}calendar_add`,
    description:
      '向 tradewatcher 财经日历写入一条**手动事件**（宏观会议/数据、未上市公司 IPO 与上市日期、自定义提醒等）。' +
      'importance：3=高（红）2=中（橙）1=低。自动事件（新股/财报/分红）由数据源同步，不要手工重复添加。' +
      'Triggers: 记到日历/加入日历/提醒我/记录某个日期.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['date', 'title'],
      properties: {
        date: { type: 'string', description: '日期 YYYY-MM-DD' },
        title: { type: 'string', description: '事件名（≤80 字，日历格子直接显示）' },
        category: { type: 'string', description: 'macro-intl / macro-cn / ipo / earnings / dividend / other（默认 other）' },
        importance: { type: 'number', description: '3=高 2=中 1=低（默认 2）' },
        note: { type: 'string', description: '详情备注（≤500 字，详情卡显示）' },
        symbol: { type: 'string', description: '关联标的代码（可选，如 688981 / 600938）' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, event: {} } },
      render: (_a, value) => {
        const v = value as { ok?: boolean; error?: string; event?: CalEvent }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        const e = v.event
        return textBlock(e === undefined ? '已写入' : `已加入日历：${e.date} ${e.title}（${CAL_CATEGORY_LABEL[e.category] ?? e.category}，重要度 ${e.importance}）`)
      },
    },
    async execute(args) {
      if (calendar === undefined) return { error: '日历模块未挂载' }
      try {
        const before = new Set((await calendar.init(), calendar.list(calToday(-365), calToday(365))).map((e) => e.id))
        const events = await calendar.mutate({ ...args, op: 'add' })
        const created = events.find((e) => !before.has(e.id))
        return { ok: true, event: created }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  function guidanceText(): string {
    return (
      '本机已安装 dsh-tradewatcher（盯盘）插件：' +
      '数据文件在 ' + dataHome() + '（watch.json 自选 / positions.json 持仓与分组 / ledger.json 逐笔流水与操作记录 / prefs.json 偏好），' +
      '均为明文 JSON，可直接用文件工具读取分析。' +
      '会话内优先使用只读工具：' +
      'tradewatcher_portfolio（持仓总览：分组市值/持仓盈亏(摊薄口径，等同券商App)/浮动盈亏(均价口径)/当日盈亏/已实现 + 每只持仓的数量、摊薄成本、均价成本与实时价，全部由买卖流水自动核算、费用已计入）、' +
      'tradewatcher_ledger（逐笔买卖与分组操作流水，支持按 posId/groupId 过滤）、' +
      'tradewatcher_watchlist（自选分组）、' +
      'tradewatcher_quotes（实时行情：cn/intl/commodity/all 预设或任意东财代码）、' +
      'tradewatcher_search（证券搜索）、' +
      'tradewatcher_calendar（财经日历：宏观/IPO/财报/分红，自动同步东财数据中心），' +
      'tradewatcher_calendar_add（把用户提到的重要日期写入日历）。' +
      '持仓与流水由侧边栏「盯盘」页签维护；工具为只读，如需修改（如按建议调仓后补录）请在侧边栏页面操作。' +
      '主动调用规则：当用户询问持仓/仓位/盈亏/市值/某笔交易历史/自选行情/行情报价时，应主动用 tradewatcher_* 工具查询，不要臆造数据。'
    )
  }

  return {
    registerTools(tools, prompt) {
      const disposers: Array<() => void> = []
      for (const def of defs) {
        try {
          // Lossless-JSON guard: tool outputs must round-trip exactly.
          // Optional fields that carry `undefined` (note/fee/price/…) or any
          // NaN/Infinity would fail that check, so every execute result is
          // sanitized: undefined keys dropped, undefined array slots → null,
          // non-finite numbers → null.
          const rawExecute = def.execute
          const execute = async (
            args: Record<string, unknown>,
            exec?: { signal?: AbortSignal },
          ): Promise<unknown> => losslessJson(await rawExecute(args, exec))
          disposers.push(tools.register({ ...def, execute }))
        } catch (error) {
          console.warn('[tradewatcher] register tool failed:', def.name, error)
        }
      }
      let disposeGuidance: (() => void) | undefined
      if (prompt !== undefined) {
        try {
          disposeGuidance = prompt.section({
            name: 'plugin:dsh-tradewatcher',
            order: 200,
            text: guidanceText,
          })
          if (disposeGuidance !== undefined) disposers.push(disposeGuidance)
        } catch {
          disposeGuidance = undefined
        }
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* already disposed */
          }
        }
      }
    },
  }
}

/**
 * Deep-sanitize one value into a form that round-trips losslessly through
 * JSON: drop undefined-valued object keys, map undefined array slots to
 * null, and coerce NaN/±Infinity to null. Everything else (strings, booleans,
 * finite numbers, plain containers) passes through unchanged.
 */
export function losslessJson(value: unknown): unknown {
  if (value === null) return null
  const t = typeof value
  if (t === 'number') return Number.isFinite(value) ? value : null
  if (t === 'string' || t === 'boolean') return value
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length)
    for (let i = 0; i < value.length; i += 1) {
      const cleaned = losslessJson(value[i])
      out[i] = cleaned === undefined ? null : cleaned
    }
    return out
  }
  if (t === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = losslessJson(v)
      if (cleaned !== undefined) out[k] = cleaned
    }
    return out
  }
  return undefined
}

/** Host entry side-effect helper: locate optional services via ctx.get. */
export function servicesOf(ctx: PluginContext): { tools?: PluginToolRuntime; systemPrompt?: PluginSystemPrompt } {
  const tools = ctx.get('tools') as PluginToolRuntime | undefined
  const systemPrompt = ctx.get('systemPrompt') as PluginSystemPrompt | undefined
  return { tools, systemPrompt }
}
