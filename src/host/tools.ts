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
import { TW_ROWS, type CalEvent, type DataProvenance, type MissingField, type QuoteRow } from '../shared/model.ts'
import { SECID_RE } from '../shared/model.ts'
import * as em from './em.ts'
import { assemblePortfolio, ledgerViews, verbLabel } from './portfolio.ts'
import { DataStore, dataHome } from './store.ts'
import { CalendarStore, calToday } from './calendar.ts'
import { RescueMonitor } from './rescue.ts'
import { RESCUE_LEVEL_LABEL } from '../shared/model.ts'
import { CAL_CATEGORY_LABEL } from '../shared/model.ts'
import type { PluginContext, PluginToolDefinition, PluginToolExec, PluginToolRuntime, PluginSystemPrompt } from './context.ts'
import { WriteJournal } from './writeLog.ts'

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

// ── P0-1 数据出处契约 ──────────────────────────────────────────────────────

/** 纯本地文件的出处：`source='local'`，asOf 取文件最后写入时刻（不许拿响应时刻顶替） */
function localProvenance(asOf: number | null, missing: MissingField[] = []): DataProvenance {
  return { asOf, stale: false, source: 'local', missing, cached: undefined }
}

/** 出处的单行文本摘要，附在每个工具的 render 尾部（agent 读到数就看得到口径） */
function provenanceLine(p: DataProvenance | undefined): string {
  if (p === undefined) return ''
  const parts: string[] = []
  parts.push(p.asOf === null ? '数据时刻：未取得' : `数据时刻 ${new Date(p.asOf).toLocaleString('zh-CN', { hour12: false })}`)
  parts.push(`来源 ${p.source}`)
  if (p.sources !== undefined && Object.keys(p.sources).length > 0) {
    parts.push(Object.entries(p.sources).map(([k, n]) => `${k}×${n}`).join('+'))
  }
  if (p.cached === true) parts.push('休市定稿（未回源）')
  if (p.stale) parts.push(`降级复用 ${p.staleCount ?? 0} 项`)
  if (p.missing.length > 0) {
    // 缺失必须能回答"上游没有"还是"这次失败" —— 二者的下一步动作不同
    const noSrc = p.missing.filter((m) => m.why === 'no-source').length
    const trans = p.missing.filter((m) => m.why === 'transient').length
    parts.push(`缺失 ${p.missing.length}（无此数据源 ${noSrc} / 本次失败 ${trans}）`)
  }
  return `【数据出处】${parts.join(' · ')}`
}

/** 缺失明细的逐条文本（只在有缺失时输出，避免正常路径变啰嗦） */
function missingLines(p: DataProvenance | undefined, limit = 8): string[] {
  if (p === undefined || p.missing.length === 0) return []
  const head = p.missing.slice(0, limit).map((m) => `  · ${m.what}（${m.why === 'no-source' ? '上游无此数据' : '本次失败'}）：${m.note}`)
  if (p.missing.length > limit) head.push(`  · …另有 ${p.missing.length - limit} 项`)
  return ['缺失明细：', ...head]
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
  // 保留原始大小写（113.rbm / 114.lhm 后缀区分大小写）；去重按大小写无关键
  const seen = new Set<string>()
  const ids: string[] = []
  let dropped = 0
  for (const piece of raw.split(',')) {
    const id = piece.trim()
    if (id === '' || !SECID_RE.test(id)) continue
    if (seen.has(id.toUpperCase())) continue
    if (ids.length >= 120) { dropped += 1; continue }
    seen.add(id.toUpperCase())
    ids.push(id)
  }
  if (ids.length === 0) throw new Error('未解析到合法证券代码（格式如 1.000001 / 114.lhm）')
  if (dropped > 0) throw new Error(`一次最多查询 120 个标的（本次多出 ${dropped} 个，请分批）`)
  return ids
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
  rescue?: RescueMonitor,
  /** 写操作日志（P0-11）；不传则用默认数据目录 */
  journal: WriteJournal = new WriteJournal(),
): {
  registerTools: (tools: PluginToolRuntime, prompt: PluginSystemPrompt | undefined) => () => void
} {
  const defs: PluginToolDefinition[] = []

  /** 从 exec 里取写入者标识（会话 id）；取不到时如实标 unknown，不编一个假 id */
  const writerOf = (exec?: PluginToolExec): string => {
    const id = exec?.agent?.id
    return typeof id === 'string' && id !== '' ? id : 'unknown'
  }

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
          provenance: { type: 'object', additionalProperties: true },
          fxMode: { type: 'string' },
          unpriced: { type: 'array', items: {} },
          unpricedMv: { type: 'number' },
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
          provenance?: DataProvenance
          fxMode?: string
          unpriced?: Array<{ secid: string; name: string; why: string; note: string }>
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
        const np = v.unpriced ?? []
        const unpricedLines = np.length > 0
          ? [
              `未计入总额 ${np.length} 项（fxMode=${v.fxMode ?? 'none'}）：`,
              ...np.map((u) => `  · ${u.name}（${u.secid}）${u.why === 'no-fx' ? '非人民币计价且未折算' : '无可用行情源'}：${u.note}`),
            ]
          : []
        const body = [
          head,
          ...(groupLines.length > 0 ? ['分组：', ...groupLines] : ['暂无分组。']),
          ...(posLines.length > 0 ? ['持仓明细：', ...posLines] : ['暂无持仓。']),
          ...unpricedLines,
          provenanceLine(v.provenance),
          ...missingLines(v.provenance),
        ]
        return textBlock(body.filter((x) => x !== '').join('\n'))
      },
    },
    async execute(args) {
      try {
        const port = store.portData()
        const secids = [...new Set(port.items.map((p) => p.secid))]
        const q = secids.length > 0 ? await em.fetchQuotesWithProvenance(secids) : null
        const { view, stale } = assemblePortfolio(port.groups, port.items, store.ledgerEntries(), q?.items ?? {})
        if (args.includeEmpty !== true) {
          view.positions = view.positions.filter((p) => p.qty > 0)
        }
        // 无持仓标的时也要给得出处的形状（source='local'，asOf 取持仓文件落盘时刻）
        const base = q?.provenance
          ?? localProvenance(await store.fileMtime('positions.json'))
        // 非人民币、无行情的持仓并进 missing[]，让"总额缺一块"有出处
        const extra: MissingField[] = (view.unpriced ?? []).map((u) => ({
          what: `${u.name}（${u.secid}）`,
          why: u.why === 'no-fx' ? ('no-source' as const) : ('transient' as const),
          note: u.note,
        }))
        const provenance: DataProvenance = { ...base, missing: [...base.missing, ...extra] }
        return {
          view, stale, provenance,
          fxMode: view.fxMode ?? 'none',
          unpriced: view.unpriced ?? [],
          unpricedMv: view.unpricedMv ?? 0,
        }
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
          provenance: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        const v = value as { entries?: Array<Record<string, unknown>>; provenance?: DataProvenance; error?: string }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        const rows = v.entries ?? []
        if (rows.length === 0) return textBlock([`暂无流水记录。`, provenanceLine(v.provenance)].filter((x) => x !== '').join('\n'))
        const lines = rows.map((r) => {
          const ts = new Date(Number(r.ts)).toLocaleString('zh-CN', { hour12: false })
          const where = [r.groupName ?? null, r.posName ?? null].filter(Boolean).join(' / ')
          const qty = r.qty !== undefined ? ` ${r.qty}` : ''
          const price = r.price !== undefined && r.price !== null ? `@${fmtNum(r.price as number)}` : ''
          const fee = r.fee !== undefined && r.fee !== null && Number(r.fee) !== 0 ? ` 费${r.fee}` : ''
          const note = r.note !== undefined && r.note !== null && String(r.note) !== '' ? ` — ${String(r.note)}` : ''
          return `[${ts}] ${verbLabel(r.verb as never)} ${where}${qty}${price}${fee}${note}（${String(r.actor) === 'tool' ? '会话' : '界面'}）`
        })
        return textBlock([...lines, provenanceLine(v.provenance)].join('\n'))
      },
    },
    async execute(args) {
      try {
        const posId = typeof args.posId === 'string' && args.posId !== '' ? args.posId : undefined
        const groupId = typeof args.groupId === 'string' && args.groupId !== '' ? args.groupId : undefined
        const limit = typeof args.limit === 'number' ? Math.min(500, Math.max(1, Math.round(args.limit))) : 100
        const port = store.portData()
        const entries = ledgerViews(store.ledgerEntries(), port.groups, port.items, { posId, groupId, limit })
        // 账本是纯本地文件：出处 = 文件落盘时刻（不是"这次读它"的时刻）
        return { entries, provenance: localProvenance(await store.fileMtime('ledger.json')) }
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
        properties: {
          groups: { type: 'array', items: {} }, items: { type: 'array', items: {} },
          provenance: { type: 'object', additionalProperties: true },
        },
      },
      render: (_a, value) => {
        const v = value as { groups?: Array<{ id: string; name: string; archived?: boolean }>; items?: Array<{ id: string; groupId: string; name: string; secid: string; note?: string }>; provenance?: DataProvenance; error?: string }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        const groups = (v.groups ?? []).filter((g) => g.archived !== true)
        if (groups.length === 0) return textBlock(['暂无自选分组。可在侧边栏「盯盘 → 自选」中添加。', provenanceLine(v.provenance)].filter((x) => x !== '').join('\n'))
        const lines: string[] = []
        for (const g of groups) {
          const items = (v.items ?? []).filter((i) => i.groupId === g.id)
          lines.push(`▸ ${g.name}（${items.length}）`)
          for (const it of items) lines.push(`   ${it.name}（${it.secid}）${it.note !== undefined && it.note !== '' ? ` — ${it.note}` : ''}`)
        }
        return textBlock([...lines, provenanceLine(v.provenance)].join('\n'))
      },
    },
    async execute() {
      try {
        const w = store.watchData()
        return { groups: w.groups, items: w.items, provenance: localProvenance(await store.fileMtime('watch.json')) }
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
        properties: {
          ts: { type: 'number' }, items: { type: 'object', additionalProperties: true },
          provenance: { type: 'object', additionalProperties: true },
        },
      },
      render: (_a, value) => {
        const v = value as { items?: Record<string, QuoteRow>; ts?: number; provenance?: DataProvenance; error?: string }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        return textBlock([
          renderQuotes(v.items ?? {}),
          provenanceLine(v.provenance),
          ...missingLines(v.provenance),
        ].filter((x) => x !== '').join('\n'))
      },
    },
    async execute(args) {
      try {
        const ids = await resolveQuoteIds(args.secids)
        // P0-1：必须走 Detailed 入口 —— fetchQuotes 会把 asOf/stale/source/missing 全丢掉，
        // agent 于是只能看到一串没有出处的数字
        const { items, provenance } = await em.fetchQuotesWithProvenance(ids)
        return { ts: Date.now(), items, provenance }
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
        properties: { hits: { type: 'array', items: {} }, provenance: { type: 'object', additionalProperties: true } },
      },
      render: (_a, value) => {
        const v = value as { hits?: Array<{ name: string; code: string; secid: string; kind: string; hasFallback?: boolean }>; provenance?: DataProvenance; error?: string }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        const hits = v.hits ?? []
        if (hits.length === 0) return textBlock(['未找到匹配证券。', provenanceLine(v.provenance)].filter((x) => x !== '').join('\n'))
        // 如实标注"仅东财源"：这类标的在东财被限流期间必然取不到价
        return textBlock([
          hits
            .map((h) => `${h.name}（${h.code}）${h.kind} → ${h.secid}${h.hasFallback === false ? '（仅东财源，无腾讯/新浪兜底）' : ''}`)
            .join('\n'),
          provenanceLine(v.provenance),
        ].filter((x) => x !== '').join('\n'))
      },
    },
    async execute(args) {
      try {
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (query === '') throw new Error('query 是必填参数')
        const hits = await em.searchSymbols(query)
        if (hits.length === 0) {
          // 空结果必须区分"上游没这个证券"与"上游这次挂了"：前者改关键词，后者重试
          return {
            hits,
            provenance: {
              asOf: Date.now(), stale: true, source: 'none', missing: [{
                what: `搜索「${query}」`, why: 'transient' as const,
                note: '东财搜索接口本次未返回任何候选（可能被限流）。请稍后重试；若持续为空，再用 tradewatcher_quotes 直接试代码',
              }],
            },
          }
        }
        return { hits, provenance: { asOf: Date.now(), stale: false, source: 'em', missing: [] } }
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
      schema: {
        type: 'object', additionalProperties: true,
        properties: { events: { type: 'array', items: {} }, syncedAt: { type: 'number' }, provenance: { type: 'object', additionalProperties: true } },
      },
      render: (_a, value) => {
        const v = value as { events?: CalEvent[]; syncedAt?: number; provenance?: DataProvenance; error?: string }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        const rows = v.events ?? []
        if (rows.length === 0) {
          return textBlock(['该区间暂无事件。', provenanceLine(v.provenance), ...missingLines(v.provenance)].filter((x) => x !== '').join('\n'))
        }
        const mark = (i: number): string => (i === 3 ? '【高】' : i === 2 ? '【中】' : '')
        const lines = rows.map((e) =>
          `${e.date} ${mark(e.importance)}${e.title}（${CAL_CATEGORY_LABEL[e.category] ?? e.category}${e.source === 'auto' ? '·自动' : ''}）` +
          (e.note !== undefined && e.note !== '' ? ` — ${e.note}` : '') +
          // P1-10：改期必须说出来（"我按 10-09 准备的怎么变成 10-16 了"）
          (e.changes !== undefined && e.changes.length > 0
            ? ` ⚠ 可能变更：${e.changes.map((c) => `${c.field} ${c.from === '' ? '（无）' : c.from}→${c.to}`).join('，')}`
            : '') +
          (e.link?.held === true ? ' ●持仓' : e.link?.watched === true ? ' ○自选' : ''),
        )
        const auto = rows.filter((e) => e.source === 'auto').length
        const tail = [
          provenanceLine(v.provenance),
          // 自动/手动事件的时间口径不同（一个来自上游同步、一个由用户本地维护），
          // 混在一个 asOf 里说不清，因此分开报数
          auto > 0 ? `事件构成：自动同步 ${auto} 条（时刻以上方数据时刻为准）· 手动 ${rows.length - auto} 条（本地维护）` : '事件构成：全部为手动事件（本地维护）',
          ...missingLines(v.provenance),
        ].filter((x) => x !== '')
        return textBlock(`共 ${rows.length} 条：\n${lines.join('\n')}\n${tail.join('\n')}`)
      },
    },
    async execute(args) {
      if (calendar === undefined) return { error: '日历模块未挂载' }
      try {
        const from = typeof args.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.from) ? args.from : calToday(0)
        const to = typeof args.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.to) ? args.to : calToday(30)
        await calendar.init()
        let syncError: string | null = null
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
        } catch (error) {
          // 静默吞掉同步失败等于让 agent 以为"日历里没有就是没有事件"——
          // 必须把这次失败如实写进 missing[]
          syncError = error instanceof Error ? error.message : String(error)
        }
        const cat = typeof args.category === 'string' && args.category !== '' ? args.category : null
        let events = calendar.list(from, to)
        if (cat !== null) events = events.filter((e) => e.category === cat)
        // P1-10 勾稽：与路由同源（持仓=held / 仅自选=watched），避免两处口径分叉
        const codes6 = (secid: string): string | null => {
          const m = /^(\d{1,3})\.(\d{6})$/.exec(secid)
          return m === null ? null : m[2]
        }
        const held = new Set<string>()
        const watched = new Set<string>()
        for (const it of store.portData().items) { const c = codes6(it.secid); if (c !== null) held.add(c) }
        for (const it of store.watchData().items) { const c = codes6(it.secid); if (c !== null) watched.add(c) }
        events = events.map((e) => {
          const m = e.symbol === undefined ? null : /(\d{6})/.exec(e.symbol)
          if (m === null) return e
          const code = m[1]
          return { ...e, link: { held: held.has(code), watched: !held.has(code) && watched.has(code) } }
        })
        const provenance: DataProvenance = {
          // 自动事件的数据时刻 = 上一次成功同步时刻；一次都没同步过时是 null
          asOf: calendar.syncedAt > 0 ? calendar.syncedAt : null,
          stale: syncError !== null,
          source: calendar.syncedAt > 0 ? 'em' : 'local',
          missing: syncError === null ? [] : [{
            what: '自动事件（新股/财报/分红）', why: 'transient',
            note: `本次同步失败（${syncError.slice(0, 80)}）；下方事件仅含本地已同步的部分 + 手动事件，稍后重试可补齐`,
          }],
        }
        return { events, syncedAt: calendar.syncedAt, provenance }
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
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          ok: { type: 'boolean' }, event: {},
          writeId: { type: 'string' }, by: { type: 'string' },
        },
      },
      render: (_a, value) => {
        const v = value as { ok?: boolean; error?: string; event?: CalEvent; writeId?: string }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        const e = v.event
        if (e === undefined) return textBlock('已写入')
        return textBlock(
          `已加入日历：${e.date} ${e.title}（${CAL_CATEGORY_LABEL[e.category] ?? e.category}，重要度 ${e.importance}）` +
          (v.writeId !== undefined ? `\n写入 id ${v.writeId} —— 写错了可用 tradewatcher_undo（id 或 last=1）撤回` : ''),
        )
      },
    },
    async execute(args, exec) {
      if (calendar === undefined) return { error: '日历模块未挂载' }
      try {
        // P0-11 ①：先过写节流 —— 同一秒超限直接报错（不静默丢一次写入）
        await journal.init()
        const throttled = journal.throttleReason()
        if (throttled !== null) return { error: throttled }
        const by = writerOf(exec)
        const before = new Set((await calendar.init(), calendar.list(calToday(-365), calToday(365))).map((e) => e.id))
        const events = await calendar.mutate({ ...args, op: 'add' })
        const created = events.find((e) => !before.has(e.id))
        // P0-11 ②：登记反向操作（自动事件不可删，这里只登记手动事件）
        const rec = await journal.record({
          by,
          tool: `${PREFIX}calendar_add`,
          summary: `新增日历事件 ${created?.date ?? String(args.date)} ${created?.title ?? String(args.title)}`,
          undo: created === undefined || created.source === 'auto'
            ? null
            : { kind: 'calendar.remove', targetId: created.id, label: `删除日历事件 ${created.date} ${created.title}` },
        })
        return { ok: true, event: created, writeId: rec.id, by }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })


  // ── 撤销（P0-11） ──────────────────────────────────────────────────
  defs.push({
    name: `${PREFIX}undo`,
    description:
      '撤销本插件做过的**写入**（目前是日历事件的新增）。可传 id（来自写入回包或 writeLog 列表），' +
      '或 last=N 撤销最近 N 次尚未撤销的写入（默认 1）。撤销只作用于本插件登记过的写入，' +
      '不删除历史（撤销本身也留痕）。Triggers: 撤销/回滚/写错了/undo/退回去.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', description: '写入 id（写入回包的 writeId）' },
        last: { type: 'number', description: '撤销最近 N 次写入（默认 1，最大 20）' },
        listOnly: { type: 'boolean', description: 'true 时只列出可撤销的写入，不执行撤销' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          undone: { type: 'array', items: {} },
          pending: { type: 'array', items: {} },
          error: { type: 'string' },
        },
      },
      render: (_a, value) => {
        const v = value as {
          error?: string
          undone?: Array<{ id: string; tool: string; summary: string; undone: boolean; reason?: string }>
          pending?: Array<{ id: string; ts: number; tool: string; summary: string; by: string }>
        }
        if (v.error !== undefined) return textBlock(`错误：${v.error}`)
        const out: string[] = []
        if (v.undone !== undefined) {
          if (v.undone.length === 0) out.push('没有可撤销的写入。')
          for (const u of v.undone) {
            out.push(u.undone
              ? `已撤销 ${u.id}：${u.summary}`
              : `未能撤销 ${u.id}：${u.summary} —— ${u.reason ?? '原因未知'}`)
          }
        }
        if (v.pending !== undefined) {
          out.push(`可撤销的写入（${v.pending.length} 条，最新在前）：`)
          for (const p of v.pending) {
            out.push(`  ${p.id} · ${new Date(p.ts).toLocaleString('zh-CN', { hour12: false })} · ${p.tool} · ${p.summary} · by ${p.by}`)
          }
        }
        return textBlock(out.join('\n'))
      },
    },
    async execute(args, exec) {
      try {
        await journal.init()
        const by = writerOf(exec)
        const pending = journal.list(200).filter((e) => e.undoneBy === undefined && e.undo !== null)
        if (args.listOnly === true) {
          return { ok: true, pending: pending.map((p) => ({ id: p.id, ts: p.ts, tool: p.tool, summary: p.summary, by: p.by })) }
        }
        const explicit = typeof args.id === 'string' && args.id !== '' ? args.id : null
        const lastRaw = typeof args.last === 'number' && Number.isFinite(args.last) ? Math.round(args.last) : 1
        const last = Math.max(1, Math.min(20, lastRaw))
        const targets = explicit !== null
          ? pending.filter((p) => p.id === explicit)
          : pending.slice(0, last)
        if (explicit !== null && targets.length === 0) {
          return { error: `写入 id ${explicit} 不存在、已撤销，或没有可撤销的反向操作（tradewatcher_undo 传 listOnly=true 可列出全部可撤销项）` }
        }
        if (calendar === undefined) return { error: '日历模块未挂载' }
        const undone: Array<{ id: string; tool: string; summary: string; undone: boolean; reason?: string }> = []
        for (const t of targets) {
          const act = t.undo
          if (act === null) {
            undone.push({ id: t.id, tool: t.tool, summary: t.summary, undone: false, reason: '该写入没有可自动反向的操作' })
            continue
          }
          try {
            if (act.kind === 'calendar.remove') {
              await calendar.mutate({ op: 'remove', id: act.targetId })
            } else {
              // 未知类型必须报错而不是静默跳过（否则调用方以为撤销成功了）
              undone.push({ id: t.id, tool: t.tool, summary: t.summary, undone: false, reason: `不支持的反向操作类型 ${String((act as { kind: string }).kind)}` })
              continue
            }
            await journal.markUndone(t.id, by)
            undone.push({ id: t.id, tool: t.tool, summary: t.summary, undone: true })
          } catch (error) {
            undone.push({
              id: t.id, tool: t.tool, summary: t.summary, undone: false,
              reason: error instanceof Error ? error.message : String(error),
            })
          }
        }
        return { ok: undone.every((u) => u.undone), undone, by }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  defs.push({
    name: `${PREFIX}rescue`,
    description:
      '读取【护盘信号】监测：国家队潜在护盘行为的概率性信号（宽基 ETF 放量 + 超大单净流入 + 量价背离）。' +
      '返回当前信号等级（平静/资金异动/疑似护盘/强护盘信号）、综合评分、六因子明细（实测值/阈值/是否命中）、' +
      '各宽基通道明细（沪深300ETF/上证50ETF/中证500ETF/中证1000ETF/科创50ETF/创业板ETF 的量能倍数、超大单净额、' +
      '脉冲倍数）、今日信号时间线与近 30 日历史。注意：汇金/国新/诚通不披露日内成交，' +
      '这是行为模式识别而非身份确认，回答时不要断言「国家队已入场」。',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'true 时立即重新采样一次（默认返回最近一次采样快照）' },
        day: { type: 'string', description: '历史回看某日（YYYY-MM-DD），返回当日信号时间线与 5 分钟抽样' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          level: { type: 'number' },
          levelLabel: { type: 'string' },
          score: { type: 'number' },
          summary: { type: 'string' },
          factors: { type: 'array', items: {} },
          etfs: { type: 'array', items: {} },
          history: { type: 'array', items: {} },
          provenance: { type: 'object', additionalProperties: true },
          activeWindow: { type: 'object', additionalProperties: true },
          calibratedAt: { type: 'string' },
          factorContrib: { type: 'array', items: {} },
          scoreLog: { type: 'array', items: {} },
        },
      },
      render: (_args, value) => {
        const v = value as {
          error?: string
          levelLabel?: string
          score?: number
          trading?: boolean
          summary?: string
          thresholdSource?: string
          selfSampleDays?: number
          indexPct?: number | null
          gap?: boolean
          provenance?: DataProvenance
          activeWindow?: { sampling: boolean; reason?: string; nextLabel: string | null; intervalSec: number; samples: number }
          calibratedAt?: string
          timeCoef?: number
          factorContrib?: Array<{ label: string; weight: number; score: number; contribution: number }>
          scoreLog?: Array<{ hhmm: string; score: number; rawScore: number; timeCoef: number; factors: Array<{ id: string; score: number }> }>
          factors?: Array<{ 因子: string; 实测: string; 得分: number; 命中: boolean }>
          etfs?: Array<Record<string, unknown>>
          history?: Array<{ day: string; maxLevel: number; maxScore: number; events: number; peakHhmm: string | null }>
        }
        if (v.error !== undefined) return textBlock(`护盘信号读取失败：${v.error}`)
        const pct = (n: unknown): string => (typeof n === 'number' ? `${n.toFixed(2)}x` : '—')
        const yi = (n: unknown): string => (typeof n === 'number' ? `${(n / 1e8).toFixed(2)}亿` : '—')
        // P0-4：非采样时段必须说清"暂停"而不是让人以为坏了；暂停时不得出现「采样缺口」
        const w = v.activeWindow
        const winText = w === undefined
          ? ''
          : w.sampling
            ? `采样中 · 每 ${w.intervalSec}s · 今日已采 ${w.samples} 次`
            : w.reason === 'disabled'
              ? '采样暂停（监测已关闭）'
              : `采样暂停 · 下次 ${w.nextLabel ?? '—'}（${w.reason === 'weekend' ? '周末' : w.reason === 'noon-break' ? '午休' : '已收盘'}）`
        const gapText = v.gap === true
          ? w !== undefined && !w.sampling ? '（当日曾出现采样缺口；当前为暂停时段，不是正在失败）' : ' ⚠ 采样有缺口'
          : ''
        const contrib = v.factorContrib ?? []
        const contribSum = contrib.reduce((a, c) => a + c.contribution, 0)
        const lines = [
          `护盘信号：${v.levelLabel ?? '—'}（评分 ${v.score ?? 0}/100，${v.trading === true ? '采样中' : '非交易时段'}）`,
          `归因：${v.summary ?? '—'}`,
          winText === '' ? '' : `采样窗口：${winText}`,
          `阈值来源：${v.thresholdSource ?? '—'}（自建样本 ${v.selfSampleDays ?? 0} 天，标定日 ${v.calibratedAt ?? '—'}）  沪深300 ${typeof v.indexPct === 'number' ? `${v.indexPct.toFixed(2)}%` : '—'}${gapText}`,
          '因子：',
          ...(v.factors ?? []).map((f) => `  ${f.命中 ? '●' : '○'} ${f.因子} 实测 ${f.实测} 得分 ${f.得分}`),
          // P0-7：贡献度列，且给出可复算的等式（权重×得分×时点系数）
          contrib.length > 0
            ? `贡献度（权×得分×时点系数，合计 ${contribSum.toFixed(1)} ≈ 总分 ${v.score ?? 0}）：`
            : '',
          ...contrib.map((c) => `  ${c.label} ${c.weight.toFixed(2)}×${c.score}×${v.timeCoef ?? 1} = ${c.contribution.toFixed(1)}`),
          '通道：',
          ...(v.etfs ?? []).map((e) =>
            `  ${String(e.通道 ?? '')} 量能 ${pct(e['同时点量能倍数'])}  超大单 ${yi(e['超大单净额'])}（比20日均额 ${pct(e['超大单比20日均额'])}）  脉冲 ${pct(e['脉冲倍数'])}${e['自身触发'] === true ? '  ← 触发' : ''}`,
          ),
          `近 ${(v.history ?? []).length} 日最高等级：`,
          ...(v.history ?? []).slice(0, 7).map((h) => `  ${h.day} 等级 ${h.maxLevel} 峰值 ${h.maxScore}${h.peakHhmm !== null ? ` @${h.peakHhmm}` : ''} 触发 ${h.events} 次`),
          provenanceLine(v.provenance),
          ...missingLines(v.provenance),
        ]
        return textBlock(lines.filter((x) => x !== '').join('\n'))
      },
    },
    execute: async (args: Record<string, unknown>) => {
      if (rescue === undefined) return { error: '护盘监测未启用' }
      try {
        const day = typeof args.day === 'string' ? args.day : null
        const snapshot = args.force === true ? await rescue.sampleNow() : rescue.snapshot()
        const brief = {
          ts: snapshot.ts,
          trading: snapshot.trading,
          level: snapshot.level,
          levelLabel: RESCUE_LEVEL_LABEL[snapshot.level],
          score: snapshot.score,
          summary: snapshot.summary,
          indexPct: snapshot.indexPct,
          thresholdSource: snapshot.thresholdSource,
          selfSampleDays: snapshot.selfSampleDays,
          activeIntervalSec: snapshot.activeIntervalSec,
          sampleCount: snapshot.sampleCount,
          gap: snapshot.gap,
          factors: snapshot.factors.map((f) => ({ 因子: f.label, 实测: f.actual, 得分: f.score, 权重: f.weight, 命中: f.hit, 阈值: f.threshold })),
          etfs: snapshot.etfs.map((e) => ({
            通道: `${e.name}(${e.secid})`, 涨跌: e.pct, 成交额: e.amount, 量比: e.volRatio,
            同时点量能倍数: e.timeAdjMult, 超大单净额: e.superNet, 超大单占成交额: e.superShare,
            超大单比20日均额: e.superVsAvg, 脉冲倍数: e.pulseMult, 活跃度: e.activity, 自身触发: e.triggered,
          })),
          todayEvents: snapshot.today,
          history: rescue.history(30),
          // P0-1：护盘也有出处。asOf = 最近一次成功采样（不是 ts —— 那是快照生成时刻）；
          // 采样失败与降级复用都进 stale + missing[]
          provenance: {
            asOf: snapshot.lastSampleTs ?? null,
            stale: snapshot.stale === true || snapshot.gap === true,
            staleCount: snapshot.stale === true || snapshot.gap === true ? 1 : 0,
            source: snapshot.flowSource ?? 'none',
            cached: false,
            missing: [
              ...(snapshot.completeness?.missing ?? []).map((m): MissingField => ({
                what: `护盘因子「${m}」`,
                // 腾讯源没有分单资金流 → 这是上游结构性缺口；东财源下才是本次失败
                why: snapshot.flowSource === 'tencent' ? 'no-source' : 'transient',
                note: snapshot.flowSource === 'tencent'
                  ? '本次数据来自腾讯备用源，该源不提供分单资金流（超大单/主力净额），重试不会补齐'
                  : '东财源下冷启动回填或盘中采样满 5 分钟后自动补齐',
              })),
              ...(snapshot.lastFailTs !== null && snapshot.lastFailTs !== undefined
                ? [{
                    what: '最近一次采样',
                    why: 'transient' as const,
                    note: `采样失败于 ${new Date(snapshot.lastFailTs).toLocaleString('zh-CN', { hour12: false })}；上方数据为上一次成功采样结果`,
                  }]
                : []),
            ],
          },
          activeWindow: snapshot.activeWindow,
          calibratedAt: snapshot.calibratedAt,
          timeCoef: snapshot.timeCoef,
          factorContrib: snapshot.factorContrib,
          // P0-7：出分日志（5 分钟刻度 + 等级变化），阈值漂移回溯用
          scoreLog: rescue.scoreLogOf(day ?? undefined).slice(-24),
        }
        if (day !== null && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
          return { ...brief, day, dayEvents: rescue.eventsOf(day), dayIntraday: rescue.intradayOf(day) }
        }
        return brief
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  function guidanceText(): string {
    return (
      '本机已安装 dsh-tradewatcher（盯盘）插件：数据文件在 ' + dataHome() + '（watch.json 自选 / positions.json 持仓 / ledger.json 流水 / prefs.json 偏好），均为明文 JSON，可直接用文件工具读取分析。' +
      '会话内优先用只读工具：tradewatcher_portfolio（持仓总览与盈亏，由流水核算、费用已计入）、' +
      'tradewatcher_ledger（买卖与分组流水，可按 posId/groupId 过滤）、tradewatcher_watchlist（自选分组）、' +
      'tradewatcher_quotes（行情：cn/intl/commodity/all 预设或任意代码）、tradewatcher_search（证券搜索）、' +
      'tradewatcher_calendar（财经日历：宏观/IPO/财报/分红，自动同步）、tradewatcher_calendar_add（写入重要日期）、' +
      'tradewatcher_undo（撤销本插件做过的写入）、' +
      'tradewatcher_rescue（护盘信号：宽基 ETF 放量+超大单净流入的概率性识别，含六因子与历史回看）。' +
      '持仓与流水由侧边栏「盯盘」页签维护；除日历与撤销外工具只读。' +
      '每个读数都会带【数据出处】（数据时刻/来源/是否降级/缺失原因）；' +
      '缺失分「上游无此数据」与「本次失败」两类，前者重试无用、应改口径，后者稍后重试即可。' +
      '当用户问及持仓/仓位/盈亏/市值/交易历史/自选行情/护盘或国家队动向时，主动调用 tradewatcher_* 查询，不要臆造数据；' +
      '护盘是行为模式识别（汇金/国新/诚通不披露日内成交），回答时不要断言「国家队已入场」。'
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
            exec?: PluginToolExec,
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
