/**
 * 财经日历页：月历网格 + 重要性配色 + 当天事件详情卡 + 手动事件增删改。
 * 自动事件（新股/财报/分红）来自主机侧东财数据中心同步，只读但可隐藏。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CAL_CATEGORY_LABEL,
  type CalCategory,
  type CalEvent,
  type CalImportance,
  type PortPrefs,
} from '../shared/model.ts'
import { api } from './api.ts'
import { Btn, ErrorNote, Field, Modal, Skeleton } from './ui.tsx'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

const IMP_COLOR: Record<CalImportance, string> = {
  3: 'var(--tw-up)',
  2: '#e8a33d',
  1: 'var(--tw-accent)',
}
const IMP_LABEL: Record<CalImportance, string> = { 3: '高', 2: '中', 1: '低' }

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function iso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
/** 网格起点：所在周的周一 */
function gridStart(year: number, month0: number): Date {
  const first = new Date(year, month0, 1)
  const shift = (first.getDay() + 6) % 7 // 周一=0
  return new Date(year, month0, 1 - shift)
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

export function CalendarPage(_props: { prefs: PortPrefs }): React.ReactElement {
  const today = iso(new Date())
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month0, setMonth0] = useState(now.getMonth())
  const [events, setEvents] = useState<CalEvent[]>([])
  const [syncedAt, setSyncedAt] = useState<number | null>(null)
  /**
   * 最后一次同步的状态（P0-2）。
   *
   * 界面必须能回答"这些事件是什么时候同步到的、这次同步成功了吗" ——
   * 只显示一个"同步于 X"会在上游全挂时骗人（事件是旧的、时间戳却是新的）。
   */
  const [syncInfo, setSyncInfo] = useState<{
    stale: boolean
    attemptAt: number | null
    missing: Array<{ what: string; why: string; note: string }>
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<CalCategory | 'all'>('all')
  const [dayOpen, setDayOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState<CalEvent | 'new' | null>(null)
  const [busy, setBusy] = useState(false)

  const start = useMemo(() => gridStart(year, month0), [year, month0])
  const cells = useMemo(() => {
    const out: Array<{ date: string; inMonth: boolean }> = []
    for (let i = 0; i < 42; i += 1) {
      const d = addDays(start, i)
      out.push({ date: iso(d), inMonth: d.getMonth() === month0 })
    }
    // 6 行多余时裁掉整行
    while (out.length > 35 && out.slice(35).every((c) => !c.inMonth)) out.splice(35)
    return out
  }, [start, month0])

  const load = useCallback((force = false) => {
    const from = iso(start)
    const to = iso(addDays(start, cells.length - 1))
    setBusy(true)
    api
      .calendar(from, to, force)
      .then((r) => {
        setEvents(r.events)
        setSyncedAt(r.syncedAt)
        setSyncInfo({ stale: r.stale, attemptAt: r.syncAttemptAt, missing: r.missing ?? [] })
        setErr(null)
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => {
        setBusy(false)
        setLoading(false)
      })
  }, [start, cells.length])

  useEffect(() => {
    setLoading(true)
    load(false)
  }, [load])

  const visible = useMemo(
    () => (filter === 'all' ? events : events.filter((e) => e.category === filter)),
    [events, filter],
  )
  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>()
    for (const e of visible) {
      const list = m.get(e.date) ?? []
      list.push(e)
      m.set(e.date, list)
    }
    for (const list of m.values()) {
      list.sort((a, b) => (b.importance - a.importance) || (a.time ?? '99:99').localeCompare(b.time ?? '99:99'))
    }
    return m
  }, [visible])

  const upcoming = useMemo(
    () => visible.filter((e) => e.date >= today).slice(0, 12),
    [visible, today],
  )

  const mutate = (body: Record<string, unknown>): void => {
    setBusy(true)
    api
      .mutateCalendar(body)
      .then((r) => {
        setEvents(r.events)
        setSyncedAt(r.syncedAt)
        setSyncInfo({ stale: r.stale, attemptAt: r.syncAttemptAt, missing: r.missing ?? [] })
        setErr(null)
        setEditing(null)
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false))
  }

  const monthLabel = `${year}年${month0 + 1}月`
  const shiftMonth = (delta: number): void => {
    const d = new Date(year, month0 + delta, 1)
    setYear(d.getFullYear())
    setMonth0(d.getMonth())
  }

  /**
   * 事件胶囊（P1-10）。
   * 勾稽标记：**实心 ●=有持仓 / 空心 ○=仅自选 / 无标记=与我的持仓自选无关**。
   * 用字形而不是颜色：重要性已经占了颜色，再拿颜色区分勾稽会造成"红点到底是高重要度还是有持仓"。
   */
  const pill = (e: CalEvent, compact = true): React.ReactElement => {
    const mark = e.link?.held === true ? '●' : e.link?.watched === true ? '○' : ''
    const linkText = e.link?.held === true ? '持仓标的' : e.link?.watched === true ? '自选标的' : ''
    const changeText = e.changes !== undefined && e.changes.length > 0 ? `（改期 ${e.changes.length} 次）` : ''
    return React.createElement('span', {
      key: e.id,
      className: 'tw-cal-pill',
      title:
        `${e.time !== undefined ? `${e.time} ` : ''}${e.title}${e.note !== undefined ? ` — ${e.note}` : ''}` +
        `${linkText === '' ? '' : ` · ${linkText}`}${changeText}`,
      style: { color: IMP_COLOR[e.importance], borderColor: IMP_COLOR[e.importance] },
      onClick: (ev: React.MouseEvent) => {
        ev.stopPropagation()
        setDayOpen(e.date)
      },
    },
      mark === '' ? null : React.createElement('span', { style: { marginRight: 3, opacity: 0.85 } }, mark),
      compact ? e.title : `${e.title} · ${CAL_CATEGORY_LABEL[e.category]}`,
    )
  }

  return React.createElement(
    'div',
    { className: 'tw-body' },
    React.createElement(ErrorNote, { error: err }),
    React.createElement('div', { className: 'tw-panel' },
      React.createElement('div', { className: 'tw-panel-h' },
        React.createElement('button', { className: 'tw-iconbtn', onClick: () => shiftMonth(-1), 'aria-label': '上个月' }, '‹'),
        React.createElement('span', { className: 't', style: { flex: 'none', minWidth: 96, textAlign: 'center' } }, monthLabel),
        React.createElement('button', { className: 'tw-iconbtn', onClick: () => shiftMonth(1), 'aria-label': '下个月' }, '›'),
        React.createElement(Btn, {
          onClick: () => {
            const d = new Date()
            setYear(d.getFullYear())
            setMonth0(d.getMonth())
          },
        }, '今天'),
        React.createElement('span', { style: { flex: 1 } }),
        syncedAt !== null
          ? React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5 } },
              `同步于 ${new Date(syncedAt).toLocaleString('zh-CN', { hour12: false })}${syncInfo?.stale === true ? '（本次未全部成功）' : ''}`)
          : React.createElement('span', {
              className: 'tw-muted',
              style: { fontSize: 10.5 },
              tabIndex: 0,
              role: 'note',
              'aria-label': '日历尚未成功同步过，当前只显示本地手动事件',
            }, '尚未成功同步'),
        React.createElement(Btn, { onClick: () => load(true), disabled: busy }, busy ? '同步中…' : '同步'),
        React.createElement(Btn, { primary: true, onClick: () => setEditing('new') }, '+ 事件'),
      ),
      // 同步降级必须写在界面上（P0-2）：不要只说"同步失败"，要说清哪几类事件是旧的、数据时刻是几点。
      // tabIndex + aria-label：原因不能只挂在 title 上（键盘/触屏拿不到）
      syncInfo?.stale === true
        ? React.createElement('div', {
            className: 'tw-hint',
            style: { color: 'var(--tw-up)', padding: '2px 10px 0' },
            tabIndex: 0,
            role: 'note',
            'aria-label': `日历同步未全部成功：${syncInfo.missing.map((m) => `${m.what}（${m.why === 'no-source' ? '上游无此数据' : '本次失败'}）`).join('；') || '原因未给出'}`,
          },
            `日历同步未全部成功：${syncInfo.missing.map((m) => `${m.what}（${m.why === 'no-source' ? '上游无此数据' : '本次失败'}）`).join('；') || '原因未给出'}。` +
            (syncedAt === null
              ? '本地还没有成功同步过的事件，稍后自动重试；手动事件不受影响。'
              : `下方自动事件仍是上次成功同步（${new Date(syncedAt).toLocaleString('zh-CN', { hour12: false })}）的结果，手动事件不受影响，稍后自动重试。`))
        : null,
      // 过滤与图例
      React.createElement('div', { className: 'tw-cal-bar' },
        React.createElement('div', { className: 'tw-seg' },
          ...[['all', '全部'], ...Object.entries(CAL_CATEGORY_LABEL)] .map(([key, label]) =>
            React.createElement('button', {
              key: String(key),
              'data-on': filter === key,
              onClick: () => setFilter(key as CalCategory | 'all'),
            }, String(label)),
          ),
        ),
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement('span', { className: 'tw-muted', style: { fontSize: 10.5 } }, '重要度：'),
        ...([3, 2, 1] as CalImportance[]).map((i) =>
          React.createElement('span', { key: i, style: { fontSize: 10.5, color: IMP_COLOR[i] } }, `● ${IMP_LABEL[i]}`),
        ),
      ),
      loading
        ? React.createElement(Skeleton, { lines: 4, height: 22 })
        : React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'tw-cal-grid tw-cal-dow' },
              ...WEEKDAYS.map((w) => React.createElement('div', { key: w, className: 'tw-cal-dowcell' }, w)),
            ),
            React.createElement('div', { className: 'tw-cal-grid' },
              ...cells.map((c) => {
                const list = byDay.get(c.date) ?? []
                const isToday = c.date === today
                return React.createElement('div', {
                  key: c.date,
                  className: `tw-cal-cell${c.inMonth ? '' : ' is-out'}${isToday ? ' is-today' : ''}`,
                  onClick: () => setDayOpen(c.date),
                  role: 'button',
                  tabIndex: 0,
                  onKeyDown: (ev: React.KeyboardEvent) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault()
                      setDayOpen(c.date)
                    }
                  },
                },
                  React.createElement('div', { className: 'tw-cal-day' }, String(Number(c.date.slice(8))),
                    list.length > 0 ? React.createElement('span', { className: 'tw-cal-count' }, String(list.length)) : null,
                  ),
                  ...list.slice(0, 3).map((e) => pill(e)),
                  list.length > 3
                    ? React.createElement('span', { className: 'tw-cal-more', onClick: (ev: React.MouseEvent) => { ev.stopPropagation(); setDayOpen(c.date) } }, `+${list.length - 3}`)
                    : null,
                )
              }),
            ),
          ),
    ),
    React.createElement('div', { className: 'tw-panel' },
      React.createElement('div', { className: 'tw-panel-h' }, React.createElement('span', { className: 't' }, '即将到来')),
      upcoming.length === 0
        ? React.createElement('div', { className: 'tw-muted', style: { padding: 10 } }, '本区间暂无未来事件（可切换月份或点「同步」拉取新股/财报/分红）')
        : upcoming.map((e) =>
            React.createElement('div', { key: e.id, className: 'tw-wrow', style: { cursor: 'pointer' }, onClick: () => setDayOpen(e.date) },
              React.createElement('span', { className: 'tw-muted', style: { fontFamily: 'var(--tw-mono)', fontSize: 11 } }, e.date),
              React.createElement('div', { className: 'nm' },
                React.createElement('b', { style: { color: IMP_COLOR[e.importance] } },
                  `${e.time !== undefined ? `${e.time} ` : ''}${e.title}`),
                React.createElement('small', null, `${CAL_CATEGORY_LABEL[e.category]}${e.symbol !== undefined ? ` · ${e.symbol}` : ''}${e.note !== undefined ? ` · ${e.note}` : ''}${e.source === 'auto' ? ' · 自动' : ''}`),
              ),
              React.createElement('span', { className: 'tw-badge', style: { color: IMP_COLOR[e.importance], borderColor: IMP_COLOR[e.importance] } }, IMP_LABEL[e.importance]),
            ),
          ),
    ),
    dayOpen !== null
      ? React.createElement(DayModal, {
          date: dayOpen,
          events: byDay.get(dayOpen) ?? [],
          busy,
          onClose: () => setDayOpen(null),
          onEdit: (e) => { setDayOpen(null); setEditing(e) },
          onAdd: () => { setEditing('new') },
          mutate,
        })
      : null,
    editing !== null
      ? React.createElement(EventModal, {
          event: editing === 'new' ? null : editing,
          defaultDate: dayOpen ?? today,
          busy,
          onClose: () => setEditing(null),
          mutate,
        })
      : null,
  )
}

function DayModal(props: {
  date: string
  events: CalEvent[]
  busy: boolean
  onClose: () => void
  onEdit: (e: CalEvent) => void
  onAdd: () => void
  mutate: (body: Record<string, unknown>) => void
}): React.ReactElement {
  const weekday = WEEKDAYS[(new Date(`${props.date}T00:00:00`).getDay() + 6) % 7]
  // P1-10：默认按**勾稽**排（持仓 → 自选 → 其他），组内按重要度与时刻。
  // 也可切成纯重要度排序 —— 有时只想看"今天最重要的事是什么"。
  const [byLink, setByLink] = React.useState(true)
  const rank = (e: CalEvent): number => (e.link?.held === true ? 0 : e.link?.watched === true ? 1 : 2)
  const sorted = React.useMemo(() => {
    const arr = [...props.events]
    arr.sort((a, b) => {
      if (byLink) {
        const d = rank(a) - rank(b)
        if (d !== 0) return d
      }
      if (a.importance !== b.importance) return b.importance - a.importance
      return (a.time ?? '99:99').localeCompare(b.time ?? '99:99')
    })
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.events, byLink])
  const linkLabel = (e: CalEvent): string | null =>
    e.link?.held === true ? '持仓标的' : e.link?.watched === true ? '自选标的' : null
  return React.createElement(Modal, { title: `${props.date} 周${weekday} · ${props.events.length} 个事件`, onClose: props.onClose, width: 560 },
    props.events.length > 1
      ? React.createElement('div', { className: 'tw-seg', style: { marginBottom: 6 } },
          React.createElement('button', { 'data-on': byLink, onClick: () => setByLink(true), title: '持仓 → 自选 → 其他；组内按重要度' }, '按勾稽排序'),
          React.createElement('button', { 'data-on': !byLink, onClick: () => setByLink(false) }, '按重要度排序'),
        )
      : null,
    props.events.length === 0
      ? React.createElement('div', { className: 'tw-muted', style: { padding: 8 } }, '当天暂无事件记录。')
      : sorted.map((e) =>
          React.createElement('div', { key: e.id, className: 'tw-cal-card', style: { borderLeftColor: IMP_COLOR[e.importance] } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
              e.time !== undefined
                ? React.createElement('span', { style: { fontFamily: 'var(--tw-mono)', fontSize: 11.5, color: 'var(--tw-fg-dim)' } }, e.time)
                : null,
              React.createElement('b', { style: { color: IMP_COLOR[e.importance], fontSize: 13 } }, e.title),
              React.createElement('span', { className: 'tw-badge' }, `${CAL_CATEGORY_LABEL[e.category]} · ${IMP_LABEL[e.importance]}`),
              e.endDate !== undefined ? React.createElement('span', { className: 'tw-badge' }, `至 ${e.endDate}`) : null,
              React.createElement('span', { className: 'tw-badge' }, e.source === 'auto' ? '自动同步' : '手动'),
              // P1-10 勾稽：与我的持仓/自选有关的事件才值得先看
              linkLabel(e) !== null
                ? React.createElement('span', {
                    className: 'tw-badge',
                    style: { color: 'var(--tw-accent)', borderColor: 'var(--tw-accent)' },
                  }, linkLabel(e) as string)
                : null,
              // P1-10 改期：必须显式标出并给出 from → to，否则用户不知道自己按旧日期准备过
              e.changes !== undefined && e.changes.length > 0
                ? React.createElement('span', {
                    className: 'tw-badge',
                    style: { color: '#e8a33d', borderColor: '#e8a33d' },
                    title: e.changes
                      .map((c) => `${new Date(c.at).toLocaleString('zh-CN', { hour12: false })}：${c.field} ${c.from === '' ? '（无）' : c.from} → ${c.to}`)
                      .join('\n'),
                  }, `可能变更 ×${e.changes.length}`)
                : null,
              e.symbol !== undefined ? React.createElement('span', { className: 'tw-muted', style: { fontSize: 11 } }, e.symbol) : null,
            ),
            e.note !== undefined && e.note !== ''
              ? React.createElement('div', { className: 'tw-hint', style: { margin: '4px 0 0' } }, e.note)
              : null,
            React.createElement('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 6 } },
              e.source === 'manual'
                ? React.createElement(Btn, { onClick: () => props.onEdit(e) }, '编辑')
                : React.createElement(Btn, {
                    onClick: () => props.mutate({ op: 'hideAuto', autoKey: e.autoKey }),
                  }, '隐藏'),
              e.source === 'manual'
                ? React.createElement(Btn, {
                    onClick: () => {
                      if (window.confirm(`删除事件「${e.title}」？`)) props.mutate({ op: 'remove', id: e.id })
                    },
                  }, '删除')
                : null,
            ),
          ),
        ),
    React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 } },
      React.createElement(Btn, { onClick: props.onAdd, primary: true }, '+ 新增事件'),
      React.createElement(Btn, { onClick: props.onClose }, '关闭'),
    ),
  )
}

function EventModal(props: {
  event: CalEvent | null
  defaultDate: string
  busy: boolean
  onClose: () => void
  mutate: (body: Record<string, unknown>) => void
}): React.ReactElement {
  const [date, setDate] = useState(props.event?.date ?? props.defaultDate)
  const [title, setTitle] = useState(props.event?.title ?? '')
  const [category, setCategory] = useState<CalCategory>(props.event?.category ?? 'other')
  const [importance, setImportance] = useState<CalImportance>(props.event?.importance ?? 2)
  const [note, setNote] = useState(props.event?.note ?? '')
  const [symbol, setSymbol] = useState(props.event?.symbol ?? '')
  const [err, setErr] = useState<string | null>(null)

  const submit = (): void => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setErr('日期格式 YYYY-MM-DD'); return }
    if (title.trim() === '') { setErr('请填写事件名'); return }
    props.mutate({
      op: props.event === null ? 'add' : 'update',
      id: props.event?.id,
      date, title: title.trim(), category, importance,
      note: note.trim() === '' ? undefined : note.trim(),
      symbol: symbol.trim() === '' ? undefined : symbol.trim(),
    })
  }

  return React.createElement(Modal, { title: props.event === null ? '新增日历事件' : '编辑日历事件', onClose: props.onClose, width: 520 },
    React.createElement(ErrorNote, { error: err }),
    React.createElement(Field, { label: '日期' },
      React.createElement('input', { className: 'tw-input', type: 'date', value: date, onChange: (e) => setDate(e.target.value) }),
    ),
    React.createElement(Field, { label: '事件名（日历格子直接显示，建议 ≤ 14 字）' },
      React.createElement('input', { className: 'tw-input', value: title, onChange: (e) => setTitle(e.target.value), placeholder: '如：长鑫存储 IPO 上市 / FOMC 利率决议' }),
    ),
    React.createElement('div', { style: { display: 'flex', gap: 10 } },
      React.createElement(Field, { label: '类别' },
        React.createElement('select', { className: 'tw-input', value: category, onChange: (e) => setCategory(e.target.value as CalCategory) } as React.SelectHTMLAttributes<HTMLSelectElement>,
          ...Object.entries(CAL_CATEGORY_LABEL).map(([k, v]) => React.createElement('option', { key: k, value: k }, v)),
        ),
      ),
      React.createElement(Field, { label: '重要度' },
        React.createElement('select', { className: 'tw-input', value: String(importance), onChange: (e) => setImportance(Number(e.target.value) as CalImportance) } as React.SelectHTMLAttributes<HTMLSelectElement>,
          React.createElement('option', { value: '3' }, '高（红）'),
          React.createElement('option', { value: '2' }, '中（橙）'),
          React.createElement('option', { value: '1' }, '低（蓝）'),
        ),
      ),
    ),
    React.createElement(Field, { label: '关联标的（可选）' },
      React.createElement('input', { className: 'tw-input', value: symbol, onChange: (e) => setSymbol(e.target.value), placeholder: '688981 / 600938 / 1.588170' }),
    ),
    React.createElement(Field, { label: '详情备注（可选）' },
      React.createElement('textarea', { className: 'tw-input', rows: 3, value: note, onChange: (e) => setNote(e.target.value), placeholder: '要点、预期、影响标的等' } as React.TextareaHTMLAttributes<HTMLTextAreaElement>),
    ),
    React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 } },
      React.createElement(Btn, { onClick: props.onClose }, '取消'),
      React.createElement(Btn, { primary: true, onClick: submit, disabled: props.busy }, props.event === null ? '添加' : '保存'),
    ),
  )
}
