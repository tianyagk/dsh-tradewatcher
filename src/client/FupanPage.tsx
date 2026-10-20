/**
 * 复盘页（第 7 个页签）：月历（每天显示笔记条数 / 是否钉住 / 交易日或休市）+ 当日笔记（增 / 改 / 删 / 钉到未来）。
 *
 * 分工：本文件只做**接线与渲染**。所有规则（交易日判定、钉自标注、失败与丢弃原因、键盘移动、
 * 请求体）都在 `fupanView.ts` 的纯函数里，判据在 `impl83.test.ts`（本仓库没有 DOM 测试环境，
 * 规则留在页面里就不可断言 —— 见 `toolsPage.test.ts` 文件头）。
 *
 * 三条界面红线：
 *  ① 取数失败 ⇒ **原因 + 重试**，绝不渲染"本月暂无笔记"（失败与空是两件事）；
 *  ② 写失败 ⇒ 原因就地显示（`role="alert"`），不许 `catch(() => {})`；
 *  ③ 宿主的 `dropped`（超上限丢最旧）⇒ 必须显示，不许静默当成功。
 *
 * 保活（`src/client/index.tsx` 的 `KEEP_ALIVE` 里有 `'fupan'`）：本页**零轮询** —— 只在挂载 /
 * 换月 / 写成功后取数，所以"切页不卸载"的收益（月份、选中日期、正在写的草稿都保住）
 * 明显大于风险，与「日历」同款。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MISSING_TIER_LABEL } from '../shared/model.ts'
import { api, type FupanMonthPayload, type FupanNoteDto } from './api.ts'
import {
  FUPAN_DOW, FUPAN_GRID_LABEL,
  cellAriaOf, cellInfoOf, charCountTextOf, dayListStateOf,
  emptyDayTextOf, emptyMonthTextOf, fupanGridOf, missingTextOf, monthFailHintOf, monthFailTextOf,
  monthBodyStateOf, monthLabelOf, monthNoteTotalOf, monthTotalsTextOf, monthTradingStateOf, moveCellFocus, noteBodyOf,
  notesOfDay, pinBadgeOf, quarantineTextOf, shiftYm, tradingDaysTextOf, tradingLabelOf, tradingNoteTextOf,
  unreadableReasonOf, unreadableTextOf, weekdayLabelOf,
  writeFailTextOf, writeInputProblems, writeOkTextOf, writeVerbOf, writeWarningsOf, ymOf,
  type WriteInput,
} from './fupanView.ts'
import { Btn, EmptyHint, ErrorNote, Skeleton } from './ui.tsx'
import { fmtStamp } from './format.ts'
import { shToday } from './marketTime.ts'

/** `missing[].why` → 人话（与日历页同一份标签，缺失分"上游没有"与"本次失败"两档） */
function missingTier(why: string): string {
  return MISSING_TIER_LABEL[why === 'no-source' ? 'no-source' : 'transient']
}

export function FupanPage(): React.ReactElement {
  // R5：复盘的"今天"是**北京自然日**（与日历页同源；UTC 浏览器在北京 00:30 会落到前一天）
  const today = shToday()
  const [ym, setYm] = useState(() => ymOf(today))
  const [selected, setSelected] = useState(() => today)
  const [month, setMonth] = useState<FupanMonthPayload | null>(null)
  const [loading, setLoading] = useState(true)
  /** 首取/换月失败的原因（有它 ⇒ 只渲染"原因 + 重试"，绝不渲染空态） */
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [writeErr, setWriteErr] = useState<string | null>(null)
  const [writeOk, setWriteOk] = useState<string | null>(null)
  /** 写成功后的附加披露（丢弃 / 写后读不到 / 隔离）：可能不止一条 */
  const [warnings, setWarnings] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [draftPin, setDraftPin] = useState('')
  const [editing, setEditing] = useState<{ note: FupanNoteDto; text: string; pin: string } | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  /** 日期输入框的 id：`htmlFor` 要用，硬编码会在同页多实例时撞 */
  const pinInputId = `${React.useId()}-pin`
  /** 键盘移动后把焦点落到新格子上（跨月移动要等重渲染，所以走 effect） */
  const [focusTick, setFocusTick] = useState(0)

  /**
   * 取月历。`silent` = 写成功后的重取：**保留**当前数据（写入已经落盘，别把可见内容清空），
   * 失败时只报"已保存但重取失败"，与首取失败的措辞分开。
   */
  const load = useCallback((target: string, silent = false): void => {
    if (!silent) setLoading(true)
    api.fupanMonth(target).then(
      (r) => {
        setMonth(r)
        setLoadErr(null)
      },
      (e: unknown) => {
        if (!silent) setMonth(null)
        setLoadErr(monthFailTextOf(e, silent))
      },
    ).finally(() => {
      if (!silent) setLoading(false)
    })
  }, [])

  useEffect(() => {
    load(ym)
  }, [ym, load])

  useEffect(() => {
    if (focusTick === 0) return
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-date="${selected}"]`)
    el?.focus()
  }, [focusTick, selected])

  const goMonth = useCallback((delta: number): void => {
    const next = shiftYm(ym, delta)
    setYm(next)
    // 换月时把选中日挪进新月份（否则"选中日不在当前网格里"，roving tabindex 会没有落点）
    setSelected((cur) => (ymOf(cur) === next ? cur : `${next}-01`))
    setEditing(null)
    setConfirmId(null)
    setWriteErr(null)
    setWriteOk(null)
    setWarnings([])
  }, [ym])

  const goToday = useCallback((): void => {
    const t = shToday()
    setYm(ymOf(t))
    setSelected(t)
    setEditing(null)
    setConfirmId(null)
    setWriteErr(null)
    setWriteOk(null)
    setWarnings([])
  }, [])

  const selectDay = useCallback((date: string): void => {
    setSelected(date)
    setEditing(null)
    setConfirmId(null)
    // 点到相邻月的补格 ⇒ 跟着切月（保持"选中日一定在当前网格里"这条不变量）
    setYm((prev) => {
      const target = ymOf(date)
      return target === prev ? prev : target
    })
  }, [])

  const cells = useMemo(() => fupanGridOf(ym), [ym])
  const cellIndexOf = useCallback((date: string): number => cells.findIndex((c) => c.date === date), [cells])

  /** 方向键/Home/End 在格子间移动（Enter/Space 由格子自己处理，见 cell 的 onKeyDown） */
  const onGridKeyDown = (ev: React.KeyboardEvent): void => {
    const next = moveCellFocus(cells, cellIndexOf(selected), ev.key)
    if (next === null) return
    ev.preventDefault()
    const cell = cells[next]
    if (cell === undefined) return
    selectDay(cell.date)
    setFocusTick((n) => n + 1)
  }

  const info = cellInfoOf(month, selected)
  const dayNotes = notesOfDay(month?.notes, selected)
  const unreadable = unreadableReasonOf(month)
  const listState = dayListStateOf({
    count: info.count,
    own: dayNotes.own.length,
    pinned: dayNotes.pinned.length,
    notesUnreadable: unreadable,
  })
  const tradingState = monthTradingStateOf(month)
  const total = monthNoteTotalOf(month)
  /** 月历主体该画什么（`failed` 永远压过 `empty`：取数失败时"有没有笔记"是未知的） */
  const bodyState = monthBodyStateOf({ loading, loadErr, hasData: month !== null, total, notesUnreadable: unreadable })

  /**
   * 写入的**唯一入口**：本地校验 → POST → 成功回执 + dropped / 失败原因。
   * 失败路径**必须**落到 `setWriteErr`（反例注入见 impl83.test.ts ③）。
   */
  const submit = useCallback((input: WriteInput): void => {
    const problem = writeInputProblems(input)
    if (problem !== null) {
      setWriteOk(null)
      setWriteErr(`${writeVerbOf(input.op)}未提交 —— ${problem}`)
      return
    }
    setBusy(true)
    setWriteErr(null)
    setWriteOk(null)
    setWarnings([])
    api.fupanNote(noteBodyOf(input)).then(
      (r) => {
        setWarnings(writeWarningsOf(r))
        setWriteOk(writeOkTextOf(input.op, typeof r.asOf === 'number' ? fmtStamp(r.asOf) : null))
        setEditing(null)
        setConfirmId(null)
        if (input.op === 'create') {
          setDraft('')
          setDraftPin('')
        }
        // 写成功 ⇒ 重取月历（`dates[].count`/`hasPinned`/`totals` 的唯一权威来源）
        load(ym, true)
      },
      (e: unknown) => {
        // ⚠ 这里不许吞错：用户点"保存"必须看到为什么没成功
        setWriteErr(writeFailTextOf(input.op, e))
      },
    ).finally(() => setBusy(false))
  }, [load, ym])

  const submitDraft = (): void => {
    submit({ op: 'create', date: selected, text: draft, pinnedTo: draftPin === '' ? null : draftPin })
  }

  const noteCard = (note: FupanNoteDto): React.ReactElement => {
    const badge = pinBadgeOf(note, selected)
    const foreign = badge?.kind === 'from'
    const isEditing = editing !== null && editing.note.id === note.id
    const asking = confirmId === note.id
    return React.createElement(
      'div',
      {
        key: note.id,
        className: 'tw-fp-note',
        'data-foreign': foreign ? 'true' : 'false',
        role: 'article',
        'aria-label': `复盘笔记 ${note.date}${badge === null ? '' : `，${badge.text}`}`,
      },
      isEditing && editing !== null
        ? React.createElement(React.Fragment, null,
            React.createElement('textarea', {
              className: 'tw-input',
              rows: 4,
              value: editing.text,
              'aria-label': `编辑 ${note.date} 的复盘笔记`,
              onChange: (ev: React.ChangeEvent<HTMLTextAreaElement>) => setEditing({ ...editing, text: ev.target.value }),
            } as React.TextareaHTMLAttributes<HTMLTextAreaElement>),
            React.createElement('div', { className: 'tw-fp-editrow' },
              // 用 span 而不是 label：这个输入框已经有 aria-label，空的 <label> 反而不成对
              React.createElement('span', { className: 'tw-fp-label' }, '钉到（可选）'),
              React.createElement('input', {
                type: 'date',
                className: 'tw-fp-date',
                value: editing.pin,
                min: note.date,
                'aria-label': '把这条笔记钉到哪一天',
                onChange: (ev: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, pin: ev.target.value }),
              }),
              React.createElement('span', { className: 'tw-fp-meta' }, charCountTextOf(editing.text)),
              React.createElement('span', { style: { flex: 1 } }),
              React.createElement(Btn, { onClick: () => setEditing(null) }, '取消'),
              React.createElement(Btn, {
                primary: true,
                disabled: busy,
                onClick: () => submit({
                  op: 'update',
                  date: note.date,
                  id: note.id,
                  text: editing.text,
                  pinnedTo: editing.pin === '' ? null : editing.pin,
                }),
              }, busy ? '保存中…' : '保存'),
            ),
          )
        : React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'tw-fp-text' }, note.text),
            React.createElement('div', { className: 'tw-fp-meta-row' },
              badge === null
                ? null
                : React.createElement('span', {
                    className: 'tw-fp-pinlabel',
                    'data-kind': badge.kind,
                    // 「钉自 YYYY-MM-DD」是**必须**的标注：不标就会被读成"那天写的复盘"
                    title: badge.kind === 'from' ? '这条是别天写的，被钉到今天' : '这条还会出现在钉到的那一天',
                  }, badge.text),
              note.source === 'import'
                ? React.createElement('span', { className: 'tw-fp-meta', title: '这条来自导入（不是在本页手写的）' }, '导入')
                : null,
              React.createElement('span', { className: 'tw-fp-meta' },
                typeof note.at === 'number' ? `写入 ${fmtStamp(note.at)}` : '写入时刻未取到'),
              React.createElement('span', { style: { flex: 1 } }),
              asking
                ? React.createElement(React.Fragment, null,
                    React.createElement(Btn, { disabled: busy, onClick: () => setConfirmId(null) }, '取消'),
                    React.createElement(Btn, {
                      disabled: busy,
                      onClick: () => submit({ op: 'delete', date: note.date, id: note.id }),
                    }, busy ? '删除中…' : '确认删除'),
                  )
                : React.createElement(React.Fragment, null,
                    React.createElement(Btn, {
                      onClick: () => {
                        setConfirmId(null)
                        setEditing({ note, text: note.text, pin: typeof note.pinnedTo === 'string' ? note.pinnedTo : '' })
                      },
                    }, '编辑'),
                    typeof note.pinnedTo === 'string' && note.pinnedTo !== ''
                      ? React.createElement(Btn, {
                          disabled: busy,
                          title: '取消钉住（这条不再出现在那一天）',
                          onClick: () => submit({ op: 'pin', date: note.date, id: note.id, text: note.text, pinnedTo: null }),
                        }, '取消钉住')
                      : null,
                    React.createElement(Btn, { onClick: () => setConfirmId(note.id) }, '删除'),
                  ),
            ),
          ),
    )
  }

  // ── 月历卡片 ───────────────────────────────────────────────────────────
  const calendarCard = React.createElement(
    'div',
    { className: 'tw-panel tw-fp-cal' },
    React.createElement('div', { className: 'tw-panel-h' },
      React.createElement('button', { className: 'tw-iconbtn', onClick: () => goMonth(-1), 'aria-label': '上个月' }, '‹'),
      React.createElement('span', { className: 't', style: { flex: 'none', minWidth: 112, textAlign: 'center' } }, monthLabelOf(ym)),
      React.createElement('button', { className: 'tw-iconbtn', onClick: () => goMonth(1), 'aria-label': '下个月' }, '›'),
      React.createElement(Btn, { onClick: goToday }, '今天'),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('span', { className: 'tw-fp-meta' },
        typeof month?.asOf === 'number' ? `数据时刻 ${fmtStamp(month.asOf)}` : '数据时刻未取到'),
      loading ? null : React.createElement(Btn, { onClick: () => load(ym) }, '重试'),
    ),
    // 图例：交易日 / 休市 / 未知三档必须能一眼分开（不能只靠 tooltip）
    React.createElement('div', { className: 'tw-fp-legend' },
      React.createElement('span', { className: 'tw-fp-legend-item', 'data-kind': 'trading' }, '● 交易日'),
      React.createElement('span', { className: 'tw-fp-legend-item', 'data-kind': 'closed' }, '○ 休市'),
      React.createElement('span', { className: 'tw-fp-legend-item', 'data-kind': 'unknown' }, '◇ 交易日未知'),
      React.createElement('span', { style: { flex: 1 } }),
      tradingDaysTextOf(month) === null
        ? null
        : React.createElement('span', { className: 'tw-fp-meta' }, tradingDaysTextOf(month) as string),
      React.createElement('span', { className: 'tw-fp-meta' }, monthTotalsTextOf(month)),
      typeof month?.source === 'string' && month.source !== ''
        ? React.createElement('span', { className: 'tw-fp-meta', title: '数据口径（由宿主给出）' }, `· ${month.source}`)
        : null,
    ),
    // 交易日信息怎么来的 / 为什么可能是未知 —— 常驻一行，不塞进 tooltip
    // （首取中先不占版面：这时"未知"的原因是"还没拿到"，没有增量信息）
    loading && month === null
      ? null
      : React.createElement('div', {
          className: 'tw-hint',
          tabIndex: 0,
          role: 'note',
          'aria-label': tradingNoteTextOf(month),
          'data-state': tradingState.kind,
        }, tradingNoteTextOf(month)),
    missingTextOf(month?.missing, missingTier) === null
      ? null
      : React.createElement('div', { className: 'tw-hint', tabIndex: 0, role: 'note' }, missingTextOf(month?.missing, missingTier) as string),
    // 笔记文件被隔离 / 有条目被跳过：宿主给了就必须说
    quarantineTextOf(month) === null
      ? null
      : React.createElement('div', { className: 'tw-hint', tabIndex: 0, role: 'note', style: { color: 'var(--tw-warn)' } },
          quarantineTextOf(month) as string),
    bodyState === 'loading'
      ? React.createElement(Skeleton, { lines: 5, height: 26 })
      : bodyState === 'failed'
        // 失败态：原因 + 重试（**不渲染空态**，因为"有没有笔记"此刻是未知的）
        ? React.createElement('div', { className: 'tw-fp-fail' },
            React.createElement(ErrorNote, { error: loadErr }),
            React.createElement('div', { className: 'tw-hint' }, monthFailHintOf()),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
              React.createElement(Btn, { primary: true, onClick: () => load(ym) }, '重试'),
            ),
          )
        : React.createElement(React.Fragment, null,
            loadErr !== null
              ? React.createElement(ErrorNote, { error: loadErr })
              : null,
            bodyState === 'empty'
              // 空态：一句"没有" ＋ 一句"怎么加"（不得只写空）
              ? React.createElement(EmptyHint, null,
                  React.createElement('span', { style: { fontWeight: 600, display: 'block' } }, emptyMonthTextOf().title),
                  React.createElement('span', { style: { display: 'block' } }, emptyMonthTextOf().hint),
                )
              : null,
            bodyState === 'blank'
              ? React.createElement('div', { className: 'tw-hint' }, '本月笔记条数：未取到（宿主回包没有 totals/notes，界面不写 0）')
              : null,
            React.createElement('div', {
              ref: gridRef,
              className: 'tw-fp-grid',
              role: 'grid',
              'aria-label': `${FUPAN_GRID_LABEL} ${monthLabelOf(ym)}`,
              onKeyDown: onGridKeyDown,
            },
              React.createElement('div', { className: 'tw-fp-row', role: 'row' },
                ...FUPAN_DOW.map((w) => React.createElement('div', { key: w, className: 'tw-fp-dow', role: 'columnheader' }, w)),
              ),
              ...chunks(cells, 7).map((week, wi) =>
                React.createElement('div', { className: 'tw-fp-row', role: 'row', key: `w${wi}` },
                  ...week.map((cell) => {
                    const ci = cellInfoOf(month, cell.date)
                    const on = cell.date === selected
                    return React.createElement('div', {
                      key: cell.date,
                      'data-date': cell.date,
                      'data-kind': ci.kind,
                      'data-out': cell.inMonth ? 'false' : 'true',
                      'data-on': on ? 'true' : 'false',
                      className: 'tw-fp-cell',
                      role: 'gridcell',
                      'aria-selected': on,
                      'aria-label': cellAriaOf(cell, ci, on),
                      // roving tabindex：整个网格只有一格在 Tab 序列里；其余靠方向键到达
                      tabIndex: on ? 0 : -1,
                      title: `${cell.date} · ${tradingLabelOf(ci.kind, ci.closedReason)}`,
                      onClick: () => selectDay(cell.date),
                      // Enter/Space 打开（方向键由容器统一处理，见 onGridKeyDown）
                      onKeyDown: (ev: React.KeyboardEvent) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault()
                          selectDay(cell.date)
                        }
                      },
                    },
                      React.createElement('div', { className: 'tw-fp-dom' },
                        String(cell.dom),
                        ci.count !== null && ci.count > 0
                          ? React.createElement('span', { className: 'tw-fp-count' }, String(ci.count))
                          : null,
                        ci.hasPinned === true
                          ? React.createElement('span', { className: 'tw-fp-pinmark', title: '有笔记被钉到这一天', 'aria-hidden': 'true' }, '钉')
                          : null,
                        ci.kind === 'unknown'
                          ? React.createElement('span', { className: 'tw-fp-unknown', title: '该日交易日信息未取到', 'aria-hidden': 'true' }, '?')
                          : null,
                      ),
                      ci.kind === 'closed'
                        ? React.createElement('div', { className: 'tw-fp-closed' }, '休市')
                        : null,
                    )
                  }),
                ),
              ),
            ),
          ),
  )

  // ── 当日笔记卡片 ────────────────────────────────────────────────────────
  const dayCard = React.createElement(
    'div',
    { className: 'tw-panel tw-fp-side' },
    React.createElement('div', { className: 'tw-panel-h' },
      React.createElement('span', { className: 't' },
        `${selected} ${weekdayLabelOf(selected)} · ${tradingLabelOf(info.kind, info.closedReason)}`),
      React.createElement('span', { className: 'tw-fp-meta' },
        info.count === null ? '条数未知' : `${info.count} 条`),
    ),
    // 写失败 ⇒ 原因（role=alert：读屏也会读到，不是只挂在 title 上）
    React.createElement('div', { role: 'alert', 'aria-live': 'assertive' },
      React.createElement(ErrorNote, { error: writeErr }),
    ),
    writeOk === null
      ? null
      : React.createElement('div', { className: 'tw-fp-ok', role: 'status', 'aria-live': 'polite' }, writeOk),
    // 宿主丢弃条目 / 写后读不到 ⇒ 必须显示（不许当成功无事）
    ...warnings.map((w, i) => React.createElement('div', { key: `w${i}`, className: 'tw-fp-warn', role: 'alert', tabIndex: 0 }, w)),
    listState === 'unreadable'
      ? React.createElement('div', { className: 'tw-hint', style: { color: 'var(--tw-up)' }, tabIndex: 0, role: 'note' },
          unreadableTextOf(unreadable ?? '原因未给出'))
      : null,
    listState === 'incomplete'
      ? React.createElement('div', { className: 'tw-hint', tabIndex: 0, role: 'note' },
          `宿主回包显示该日有 ${String(info.count)} 条，但 notes[] 里没有对应条目（回包不完整，界面不假装"没有笔记"）`)
      : null,
    listState === 'empty'
      ? React.createElement(EmptyHint, null,
          React.createElement('span', { style: { fontWeight: 600, display: 'block' } }, emptyDayTextOf().title),
          React.createElement('span', { style: { display: 'block' } }, emptyDayTextOf().hint),
        )
      : null,
    dayNotes.own.length > 0
      ? React.createElement('div', { className: 'tw-fp-notes' }, ...dayNotes.own.map(noteCard))
      : null,
    dayNotes.pinned.length > 0
      ? React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'tw-fp-split' }, '钉到这一天的笔记'),
          React.createElement('div', { className: 'tw-fp-notes' }, ...dayNotes.pinned.map(noteCard)),
        )
      : null,
    React.createElement('div', { className: 'tw-fp-editor' },
      React.createElement('div', { className: 'tw-fp-metarow' },
        React.createElement('span', { className: 'tw-fp-label' }, `在 ${selected} 新增一条`),
        React.createElement('span', { className: 'tw-fp-meta' }, charCountTextOf(draft)),
      ),
      React.createElement('textarea', {
        className: 'tw-input',
        rows: 4,
        value: draft,
        placeholder: '这一天想记什么？（保存后会出现在这天的格子里）',
        'aria-label': `在 ${selected} 新增复盘笔记`,
        onChange: (ev: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(ev.target.value),
      } as React.TextareaHTMLAttributes<HTMLTextAreaElement>),
      React.createElement('div', { className: 'tw-fp-editrow' },
        React.createElement('label', { className: 'tw-fp-label', htmlFor: pinInputId }, '钉到（可选）'),
        React.createElement('input', {
          id: pinInputId,
          type: 'date',
          className: 'tw-fp-date',
          value: draftPin,
          min: selected,
          onChange: (ev: React.ChangeEvent<HTMLInputElement>) => setDraftPin(ev.target.value),
        }),
        draftPin !== ''
          ? React.createElement(Btn, { onClick: () => setDraftPin('') }, '清除')
          : null,
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement(Btn, { primary: true, disabled: busy, onClick: submitDraft }, busy ? '保存中…' : '保存'),
      ),
      React.createElement('div', { className: 'tw-fp-meta' },
        '上限由宿主把关：单条字数超限会直接拒绝并给出原因（不会静默截断）；每月条数/体积超限时，宿主会从最旧开始丢并回报丢弃条数。'),
    ),
  )

  return React.createElement('div', { className: 'tw-body tw-fp' },
    React.createElement('div', { className: 'tw-fp-wrap' },
      calendarCard,
      dayCard,
    ),
  )
}

/** 按行切（`role="row"` 必须每行一层） */
function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}
