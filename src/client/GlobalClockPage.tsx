/**
 * 工具 · 全球期货交易时钟（专用详情页）。
 *
 * 版式与设计稿 `docs/mockups/global-clock.html` 对齐：
 *  头部（名称 + 说明 + 大号时钟 + 时区日期行）→ 控件行（分组 / 时区 / 立即校时 / 刷新时间戳）
 *  → 左：24 小时轮盘（整盘逆时针旋转、金线固定 12 点）；右：今日时段表
 *  → 底部：主要指数 6 张卡 + 期货自选 5 张卡（缺数据 = `—` + 原因，绝不用 0/旧值）。
 *
 * 红线：时钟 1 秒一跳（卸载清理）；行情间隔来自 settings（默认 120s）；所有缺数据都要写原因。
 */
import * as React from 'react'
import { api } from './api.ts'
import {
  CLOCK_GROUPS, CLOCK_SESSIONS, DIAL, clockRefreshMs, displayMinuteOfWheel, needleGeometry,
  nextStartSeconds, sessionStatus, sessionWindows, wallClock, wheelAngle, wheelSegments,
  type ClockGroup, type ClockSession,
} from '../shared/clockSessions.ts'
import {
  FUTURE_SPECS, INDEX_SPECS, ZONE_OPTIONS, formatClock, quoteCard, zoneOffsetOf,
  type ClockCard, type ZoneOption,
} from './clockView.ts'
import type { QuoteRow } from '../shared/model.ts'

const DAY = 86_400_000
const SERIES = ['var(--tw-prism-series-1)', 'var(--tw-prism-series-2)', 'var(--tw-prism-series-3)', 'var(--tw-prism-series-4)', 'var(--tw-prism-series-5)']
const ALL_IDS = [...INDEX_SPECS, ...FUTURE_SPECS].map((s) => s.secid)

function two(n: number): string { return n < 10 ? `0${n}` : String(n) }

function hms(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** 同组内按"时间重叠"贪心分道：同时段的品种不叠在同一圈 */
function lanesOf(group: ClockGroup): Map<ClockSession, number> {
  const list = CLOCK_SESSIONS.filter((s) => s.group === group)
  const lanes = new Map<ClockSession, number>()
  const spans = list.map((s) => {
    const a = Number(s.start.slice(0, 2)) * 60 + Number(s.start.slice(3))
    const b = Number(s.end.slice(0, 2)) * 60 + Number(s.end.slice(3))
    return [a, b <= a ? b + 1440 : b] as const
  })
  list.forEach((s, i) => {
    const [a, b] = spans[i]!
    let lane = 0
    while (list.some((o, j) => j < i && lanes.get(o) === lane && !(b <= spans[j]![0] || a >= spans[j]![1]))) lane += 1
    lanes.set(s, lane % DIAL.radii.length)
  })
  return lanes
}

function Dial(props: { now: number; group: ClockGroup; zoneOffset: number }): React.ReactElement {
  const { now, group, zoneOffset } = props
  const rot = wheelAngle(now)
  const dayStart = Math.floor(now / DAY) * DAY
  const lanes = lanesOf(group)
  const ticks: React.ReactElement[] = []
  for (let k = 0; k < 24; k += 1) {
    const minute = k * 60
    const a = (minute / 1440) * Math.PI * 2 - Math.PI / 2
    const outer = 200
    const inner = outer - (k % 3 === 0 ? 12 : 7)
    const cx = DIAL.cx
    const cy = DIAL.cy
    const label = displayMinuteOfWheel(minute, zoneOffset)
    const hour = Math.floor(label / 60)
    const lx = cx + Math.cos(a) * (outer - 24)
    const ly = cy + Math.sin(a) * (outer - 24)
    ticks.push(React.createElement('line', {
      key: `t${k}`, className: `tw-clock-tick${k % 3 === 0 ? ' major' : ''}`,
      x1: cx + Math.cos(a) * outer, y1: cy + Math.sin(a) * outer,
      x2: cx + Math.cos(a) * inner, y2: cy + Math.sin(a) * inner,
    }))
    ticks.push(React.createElement('text', {
      key: `l${k}`, className: 'tw-clock-lab', x: lx, y: ly + 3.5,
      transform: `rotate(${-rot} ${lx} ${ly})`,
    }, hour === 0 ? '24' : two(hour)))
  }
  const arcs: React.ReactElement[] = []
  CLOCK_SESSIONS.filter((s) => s.group === group).forEach((s, i) => {
    const wins = sessionWindows(s, dayStart - DAY, dayStart + 2 * DAY).filter((w) => w.end > dayStart && w.start < dayStart + DAY)
    const lane = lanes.get(s) ?? 0
    const r = DIAL.radii[lane] ?? DIAL.radii[0]
    wheelSegments(wins, dayStart).forEach((seg, j) => {
      const a1 = (seg.start / 1440) * Math.PI * 2 - Math.PI / 2
      const a2 = (seg.end / 1440) * Math.PI * 2 - Math.PI / 2
      const p1x = DIAL.cx + Math.cos(a1) * r
      const p1y = DIAL.cy + Math.sin(a1) * r
      const p2x = DIAL.cx + Math.cos(a2) * r
      const p2y = DIAL.cy + Math.sin(a2) * r
      const large = seg.end - seg.start > 720 ? 1 : 0
      arcs.push(React.createElement('path', {
        key: `a${i}-${j}`, className: 'tw-clock-arc', stroke: SERIES[i % SERIES.length],
        d: `M ${p1x.toFixed(2)} ${p1y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p2x.toFixed(2)} ${p2y.toFixed(2)}`,
      }))
      const mid = (seg.start + (seg.end - seg.start) / 2) % 1440
      const ma = (mid / 1440) * Math.PI * 2 - Math.PI / 2
      const mx = DIAL.cx + Math.cos(ma) * r
      const my = DIAL.cy + Math.sin(ma) * r
      arcs.push(React.createElement('text', {
        key: `t${i}-${j}`, className: 'tw-clock-arclab', x: mx, y: my + 3, textAnchor: 'middle',
        transform: `rotate(${-rot} ${mx} ${my})`,
      }, `${s.exchange}·${s.code}`))
    })
  })
  const needle = needleGeometry()
  return React.createElement('svg', {
    viewBox: `0 0 ${DIAL.cx * 2} ${DIAL.cy * 2}`, preserveAspectRatio: 'xMidYMid meet',
    role: 'img', 'aria-label': '24 小时交易时段轮盘',
  },
    React.createElement('circle', { className: 'tw-clock-ring', cx: DIAL.cx, cy: DIAL.cy, r: DIAL.ringR }),
    React.createElement('g', { transform: `rotate(${rot.toFixed(3)} ${DIAL.cx} ${DIAL.cy})` }, ...ticks, ...arcs),
    React.createElement('line', { className: 'tw-clock-needle', x1: needle.x1, y1: needle.y1, x2: needle.x2, y2: needle.y2 }),
    React.createElement('circle', { className: 'tw-clock-hub', cx: needle.x2, cy: needle.y2, r: 3.2 }),
    React.createElement('circle', { className: 'tw-clock-disc', cx: DIAL.cx, cy: DIAL.cy, r: DIAL.discR }),
  )
}

function StatCard(props: { card: ClockCard }): React.ReactElement {
  const c = props.card
  const empty = c.status === 'missing'
  return React.createElement('div', { className: 'tw-clock-stat', 'data-empty': empty ? 'true' : 'false' },
    React.createElement('div', { className: 'tw-clock-stat-top' },
      React.createElement('b', null, c.name), React.createElement('span', { className: 'code' }, c.code)),
    React.createElement('div', { className: 'tw-clock-stat-mid' },
      React.createElement('span', { className: 'tw-clock-stat-value' }, c.value),
      React.createElement('span', { className: `tw-clock-stat-pct ${c.pct.startsWith('-') ? 'down' : c.pct === '—' ? 'muted' : 'up'}` }, c.pct)),
    React.createElement('div', { className: 'tw-clock-stat-meta' },
      React.createElement('span', null, c.source), React.createElement('span', null, c.at),
      React.createElement('span', { className: `tw-clock-pill ${empty ? 'off' : 'on'}` }, empty ? '无数据' : '正常')),
    empty ? React.createElement('div', { className: 'tw-clock-stat-reason' }, c.reason ?? '') : null,
  )
}

export function GlobalClockPage(props: { back?: React.ReactNode; title: string }): React.ReactElement {
  const [group, setGroup] = React.useState<ClockGroup>('gold')
  const [zoneKey, setZoneKey] = React.useState('bj')
  const [now, setNow] = React.useState(() => Date.now())
  const offsetRef = React.useRef(0)
  const [offsetMs, setOffsetMs] = React.useState(0)
  const [refreshSec, setRefreshSec] = React.useState(120)
  const [quotes, setQuotes] = React.useState<{ items: Record<string, QuoteRow>; missing: string[]; ts: number } | null>(null)
  const [lastRefresh, setLastRefresh] = React.useState<number | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  // 时钟：1 秒一跳（卸载清理）
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + offsetRef.current), 1000)
    return () => clearInterval(timer)
  }, [])

  // 行情间隔来自 settings（默认 120s，30–600s）
  React.useEffect(() => {
    let alive = true
    api.prefs().then((r) => { if (alive) setRefreshSec(r.prefs.clockRefreshSec ?? 120) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const load = React.useCallback((syncClock: boolean) => {
    api.quotes(ALL_IDS).then((r) => {
      setQuotes({ items: r.items, missing: r.missing, ts: r.ts })
      setLastRefresh(Date.now())
      setError(null)
      if (syncClock) {
        offsetRef.current = r.ts - Date.now()
        setOffsetMs(offsetRef.current)
      }
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : '行情请求失败'))
  }, [])

  // 行情：默认 120 秒一次（可配置）
  React.useEffect(() => {
    load(false)
    const timer = setInterval(() => load(false), clockRefreshMs({ clockRefreshSec: refreshSec }))
    return () => clearInterval(timer)
  }, [load, refreshSec])

  const zone: ZoneOption = ZONE_OPTIONS.find((o) => o.key === zoneKey) ?? ZONE_OPTIONS[0]!
  const zoneOffset = zoneOffsetOf(zone, now)
  const dayStart = Math.floor(now / DAY) * DAY
  const dateParts = wallClock(zone.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone, now)
  const weekday = WEEKDAYS[new Date(Date.UTC(dateParts.y, dateParts.mo - 1, dateParts.d)).getUTCDay()] ?? ''
  const items = quotes?.items ?? {}
  const missing = quotes?.missing ?? []
  const indexCards = INDEX_SPECS.map((s) => quoteCard(s, items[s.secid], missing))
  const futureCards = FUTURE_SPECS.map((s) => quoteCard(s, items[s.secid], missing))

  const rows = CLOCK_SESSIONS.filter((s) => s.group === group).map((s, i) => {
    const trading = sessionStatus(s, now) === 'trading'
    const wins = sessionWindows(s, dayStart - DAY, dayStart + 2 * DAY)
    const win = wins.find((w) => now >= w.start && now < w.end) ?? wins.find((w) => w.start > now) ?? wins[0]
    const range = win === undefined ? '—' : `${formatClock(win.start, zoneOffset)}–${formatClock(win.end, zoneOffset)}`
    return React.createElement('tr', { key: `${s.exchange}-${s.name}` },
      React.createElement('td', { className: 'bar' }, React.createElement('i', { style: { background: SERIES[i % SERIES.length] } })),
      React.createElement('td', null, React.createElement('b', null, s.exchange), ' · ', s.name),
      React.createElement('td', { className: 'muted' }, s.code),
      React.createElement('td', { className: 'tw-clock-cd' }, hms(nextStartSeconds(s, now))),
      React.createElement('td', { className: 'tw-clock-cd' }, range),
      React.createElement('td', null, React.createElement('span', { className: `tw-clock-pill ${trading ? 'on' : 'off'}` }, trading ? '交易中' : '时段外')),
    )
  })
  const missingNote = missing.length === 0 ? null : React.createElement('div', { className: 'tw-clock-missingline' },
    `${missing.length} 个期货代码缺数据：${missing.join(' / ')}（东财熔断）`)

  return React.createElement('div', { className: 'tw-tool-detail', style: { display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 16px 24px' } },
    props.back ?? null,
    React.createElement('header', { className: 'tw-clock-head' },
      React.createElement('div', null,
        React.createElement('h2', { className: 'tw-clock-title' }, props.title),
        React.createElement('p', { className: 'tw-clock-sub' }, '24 小时交易时段 · 跨市场对照 · 以北京时间为基准（可切本地）')),
      React.createElement('div', { className: 'tw-clock-clockbox' },
        React.createElement('div', { className: 'tw-clock-big' }, formatClock(now, zoneOffset)),
        React.createElement('div', { className: 'tw-clock-meta' }, `${zone.label} · ${two(dateParts.mo)}.${two(dateParts.d)} ${weekday}`))),
    React.createElement('div', { className: 'tw-clock-controls' },
      React.createElement('div', { className: 'tw-prism-seg' }, ...CLOCK_GROUPS.map((g) => React.createElement('button', {
        key: g.key, type: 'button', className: `tw-prism-segbtn${group === g.key ? ' on' : ''}`,
        onClick: () => setGroup(g.key),
      }, g.label))),
      React.createElement('select', {
        className: 'tw-prism-input', style: { maxWidth: 160, height: 28 }, value: zoneKey,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setZoneKey(e.target.value), 'aria-label': '时区',
      }, ...ZONE_OPTIONS.map((o) => React.createElement('option', { key: o.key, value: o.key }, o.label))),
      React.createElement('button', { type: 'button', className: 'tw-prism-segbtn on', onClick: () => load(true) }, '立即校时'),
      React.createElement('span', { className: 'tw-clock-stamp' },
        `刷新 ${lastRefresh === null ? '—' : formatClock(lastRefresh, zoneOffset)} · 校时偏差 ${offsetMs >= 0 ? '+' : ''}${(offsetMs / 1000).toFixed(2)}s${error === null ? '' : ` · ${error}`}`)),
    React.createElement('div', { className: 'tw-clock-grid' },
      React.createElement('section', { className: 'tw-prism-card' },
        React.createElement('div', { className: 'tw-prism-card-title' }, '24 小时交易时段',
          React.createElement('span', { className: 'tw-prism-muted', style: { marginLeft: 'auto' } }, `${CLOCK_GROUPS.find((g) => g.key === group)?.label ?? ''} · ${zone.label}`)),
        React.createElement('div', { className: 'tw-clock-dialbox' },
          React.createElement(Dial, { now, group, zoneOffset }),
          React.createElement('div', { className: 'tw-clock-center' },
            React.createElement('div', { className: 'tw-clock-text' },
              React.createElement('div', { className: 'tw-clock-now' }, formatClock(now, zoneOffset)),
              React.createElement('div', { className: 'tw-clock-off' }, `校时偏差 ${offsetMs >= 0 ? '+' : ''}${(offsetMs / 1000).toFixed(2)}s`),
              React.createElement('div', { className: 'tw-clock-grp' }, CLOCK_GROUPS.find((g) => g.key === group)?.label ?? ''))))),
      React.createElement('section', { className: 'tw-prism-card' },
        React.createElement('div', { className: 'tw-prism-card-title' }, '今日交易时段',
          React.createElement('span', { className: 'tw-prism-muted', style: { marginLeft: 'auto' } }, `${rows.length} 段 · ${zone.label}`)),
        missingNote,
        React.createElement('table', { className: 'tw-prism-table' },
          React.createElement('thead', null, React.createElement('tr', null,
            ...['', '交易所 · 品种', '代码', '距下段开始', '时段区间', '状态'].map((h, i) => React.createElement('th', { key: `h${i}` }, h)))),
          React.createElement('tbody', null, ...rows)))),
    React.createElement('section', { className: 'tw-prism-card' },
      React.createElement('div', { className: 'tw-prism-card-title' }, '主要指数',
        React.createElement('span', { className: 'tw-prism-muted', style: { marginLeft: 'auto' } }, '6 个')),
      React.createElement('div', { className: 'tw-clock-cards' }, ...indexCards.map((c) => React.createElement(StatCard, { key: c.code, card: c })))),
    React.createElement('section', { className: 'tw-prism-card' },
      React.createElement('div', { className: 'tw-prism-card-title' }, '期货自选 · 主连',
        React.createElement('span', { className: 'tw-prism-muted', style: { marginLeft: 'auto' } }, '5 个')),
      React.createElement('div', { className: 'tw-clock-cards' }, ...futureCards.map((c) => React.createElement(StatCard, { key: c.code, card: c })))),
  )
}
