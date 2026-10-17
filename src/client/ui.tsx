/** Small reusable UI atoms (modal, fields, suggest combobox, notes). */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { SUGGEST_FULL_COUNT, type SuggestItem } from '../shared/model.ts'
import { api } from './api.ts'
import {
  SUGGEST_HEAD_PX, SUGGEST_PAGE, SUGGEST_ROW_PX, SUGGEST_COUNT_PX,
  batchOf, countTextOf, edgeActiveOf, nextActiveOf, suggestDropdownBoxOf, suggestListViewOf, type SuggestDropdownBox,
} from './suggestView.ts'

export function Modal(props: {
  title: React.ReactNode
  onClose: () => void
  children?: React.ReactNode
  width?: number
}): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return React.createElement(
    'div',
    { className: 'tw-mask', onMouseDown: (e: React.MouseEvent) => { if (e.target === e.currentTarget) props.onClose() } },
    React.createElement(
      'div',
      { className: 'tw-modal', style: props.width !== undefined ? { width: props.width } : undefined },
      React.createElement('h3', null, props.title),
      props.children,
    ),
  )
}

export function Field(props: { label: string; children?: React.ReactNode }): React.ReactElement {
  return React.createElement('div', { className: 'tw-field' },
    React.createElement('label', null, props.label),
    props.children,
  )
}

export function ErrorNote(props: { error: string | null }): React.ReactElement | null {
  if (props.error === null) return null
  return React.createElement('div', { className: 'tw-err' }, props.error)
}

/**
 * Debounced suggest combobox; `onPick` receives the candidate. Enter in the
 * input picks the first candidate when there is one.
 */
export function SuggestInput(props: {
  placeholder?: string
  onPick: (item: SuggestItem) => void
  autoFocus?: boolean
}): React.ReactElement {
  const [text, setText] = useState('')
  const [hits, setHits] = useState<SuggestItem[]>([])
  const [meta, setMeta] = useState<{ requested?: number; truncated?: boolean } | null>(null)
  /** 上游/关键字问题时的原因（红线：失败必须给原因，**不许**用空列表冒充"无匹配"） */
  const [reason, setReason] = useState<string | null>(null)
  /** 已渲染多少行（分批渲染：长列表不会把 DOM 撑爆） */
  const [shown, setShown] = useState(SUGGEST_PAGE)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  /**
   * 键盘高亮的候选下标（P1-4）。
   *
   * 旧实现候选行只有 `onMouseDown`：键盘 Enter/Space 激活 `<button>` 触发的是 **click**，
   * 于是"看起来能用其实不能用"，键盘用户只能靠输入框里的"回车取第一个"选中排序第一的那条。
   * 现在 ↑/↓/Home/End 移动这个下标，Enter 选中它；同时补 combobox/listbox/option 语义
   * + `aria-activedescendant`，读屏能读到"这是搜索建议、当前第几条"。
   */
  const [active, setActive] = useState(-1)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const seq = useRef(0)
  /** 唯一 id 前缀：同一弹窗里若挂两个搜索框，`aria-controls` 也不会指错 */
  const uId = React.useId()
  const listId = `${uId}-listbox`
  const optionId = (i: number): string => `${uId}-opt-${i}`

  const query = useCallback((q: string) => {
    const s = ++seq.current
    setBusy(true)
    api
      // count=50：一次尽量拿全（服务端夹 1..100；上游给不了更多时回包会标 truncated）
      .suggest(q, SUGGEST_FULL_COUNT)
      .then((r) => {
        if (s !== seq.current) return
        setHits(r.hits)
        setMeta({ requested: r.requested, truncated: r.truncated })
        setReason(r.reason ?? null)
        setShown(SUGGEST_PAGE)
        setActive(-1)
        setOpen(true)
      })
      .catch((e: Error) => {
        if (s !== seq.current) return
        setHits([])
        setMeta(null)
        // 失败**照样打开**并把原因写出来（空列表 + 关掉弹层会被读成"就是没有匹配"）
        setReason(`搜索未取到 —— ${e.message}（上游不可用时按缓存与限流自动重试）`)
        setActive(-1)
        setOpen(true)
      })
      .finally(() => {
        if (s === seq.current) setBusy(false)
      })
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      const q = text.trim()
      if (q === '') {
        setHits([])
        setOpen(false)
        setBusy(false)
        setActive(-1)
      } else {
        query(q)
      }
    }, 220)
    return () => clearTimeout(t)
  }, [text, query])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current !== null && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  /** 排序 + 去重 + 分组 + 计数（纯函数，见 suggestView.ts）；界面只负责渲染 */
  const view = suggestListViewOf(hits, text.trim(), meta ?? {})
  const batched = batchOf(view.groups, shown)

  /**
   * 浮层落点与高度：**视口坐标**（`position:fixed`）⇒ 不受祖先 `overflow` 裁剪
   * （弹窗 `.tw-modal` 是 `max-height:82vh; overflow:auto` 的滚动容器，原先绝对定位的下拉会被它裁掉）。
   * 贴底空间不足 ⇒ `suggestDropdownBoxOf` 会向上翻转或整体上移。
   */
  const [box, setBox] = useState<SuggestDropdownBox | null>(null)
  const measure = useCallback((): void => {
    const el = boxRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const rows = batched.groups.reduce((a, g) => a + g.rows.length, 0)
    const heads = batched.groups.length
    const content = SUGGEST_COUNT_PX + heads * SUGGEST_HEAD_PX + rows * SUGGEST_ROW_PX + (batched.hidden > 0 ? SUGGEST_ROW_PX : 0)
    setBox(suggestDropdownBoxOf({
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
      viewportH: window.innerHeight,
      contentHeight: content,
    }))
  }, [batched])

  useEffect(() => {
    if (!open) {
      setBox(null)
      return
    }
    measure()
    const onMove = (): void => measure()
    window.addEventListener('resize', onMove)
    // 捕获阶段：弹窗自身滚动也能跟着走（scroll 不冒泡）
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open, measure])

  const pick = (item: SuggestItem): void => {
    setOpen(false)
    setText('')
    setReason(null)
    setActive(-1)
    props.onPick(item)
  }

  /** 键盘移动用**扁平**候选列表（与渲染顺序一致：分组顺序 + 组内顺序 = 界面上的第 1/2/3… 条） */
  const flatRows: SuggestItem[] = batched.groups.flatMap((g) => g.rows)
  /** 每组的扁平起始下标（渲染时据此算 `optionId`/`aria-selected`） */
  const groupOffsets: number[] = []
  {
    let off = 0
    for (const g of batched.groups) {
      groupOffsets.push(off)
      off += g.rows.length
    }
  }
  const activeId = active >= 0 && active < flatRows.length ? optionId(active) : undefined

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const total = flatRows.length
    const apply = (next: number, e: React.KeyboardEvent): void => {
      e.preventDefault()
      if (!open) setOpen(true)
      setActive(next)
    }
    // 下标算法在 suggestView（纯函数，单测覆盖环绕/边界）
    if (e.key === 'ArrowDown') {
      if (total === 0) return
      apply(nextActiveOf(open ? active : -1, total, 1), e)
      return
    }
    if (e.key === 'ArrowUp') {
      if (total === 0) return
      apply(nextActiveOf(open ? active : -1, total, -1), e)
      return
    }
    if (e.key === 'Home' || e.key === 'End') {
      if (!open || total === 0) return
      apply(edgeActiveOf(total, e.key === 'Home' ? 'home' : 'end'), e)
      return
    }
    if (e.key === 'Enter') {
      // 有键盘高亮就选它；**没有高亮时保持原行为**：回车取排序后第一条（既有默认不变）
      const highlighted = open && active >= 0 ? flatRows[active] : undefined
      if (text.trim() === '') return
      if (highlighted !== undefined) {
        e.preventDefault()
        pick(highlighted)
        return
      }
      if (flatRows.length > 0) {
        e.preventDefault()
        const first = flatRows[0] as SuggestItem
        pick(first)
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      setActive(-1)
    }
  }

  return React.createElement(
    'div',
    { ref: boxRef, style: { position: 'relative' } },
    React.createElement('input', {
      className: 'tw-input',
      value: text,
      placeholder: props.placeholder ?? '搜索代码/名称，回车取第一个',
      autoFocus: props.autoFocus === true,
      // combobox 语义（P1-4）：读屏能读到"这是搜索建议、展开没展开、当前高亮第几条"
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': open,
      'aria-haspopup': 'listbox',
      'aria-controls': open ? listId : undefined,
      'aria-activedescendant': open ? activeId : undefined,
      onChange: (e) => setText(e.target.value),
      onKeyDown: onKeyDown,
      onFocus: () => { if (hits.length > 0) setOpen(true) },
    }),
    busy ? React.createElement('div', { className: 'tw-hint' }, '搜索中…') : null,
    open
      ? React.createElement(
          'div',
          {
            className: 'tw-suggest',
            // 视口坐标（fixed）+ 实测高度：祖先再有 overflow 也裁不到它
            style: box === null
              ? { top: 'calc(100% + 2px)', left: 0, right: 0, visibility: 'hidden' }
              : { position: 'fixed', top: box.top, left: box.left, width: box.width, maxHeight: box.maxHeight, right: 'auto' },
            'data-role': 'suggest-list',
            // listbox 语义（P1-4）：容器是 listbox、行是 option、输入框用 aria-activedescendant 指当前项
            role: 'listbox',
            id: listId,
            'aria-label': '搜索候选',
            // 供断言读：是否向上翻转、当前可用高度
            'data-flip': box?.up === true ? 'up' : 'down',
            'data-max-h': box === null ? '' : String(box.maxHeight),
          },
          // ① 原因优先：上游失败 / 关键字问题 ⇒ 只说原因（**不显示空列表冒充"无匹配"**）
          reason !== null
            ? React.createElement('div', {
                className: 'tw-hint', style: { padding: '8px 11px', color: 'var(--tw-up)' },
                tabIndex: 0, role: 'note', 'aria-label': reason, title: reason,
              }, reason)
            : view.total === 0
              // ② 请求成功但真的没有匹配（与上面那条是两件事）
              ? React.createElement('div', { className: 'tw-hint', style: { padding: '8px 11px' } },
                  `没有匹配「${text.trim()}」的标的（已按代码/名称/拼音向东财与腾讯各查一次）。`)
              : React.createElement(React.Fragment, null,
                  // ③ 计数（唯一实现在 countTextOf；截断时必须出现"上游本次上限"）
                  React.createElement('div', {
                    className: 'tw-hint', style: { padding: '6px 11px', borderBottom: '1px solid var(--tw-border)' },
                    'data-role': 'suggest-count', tabIndex: 0, role: 'note', 'aria-label': countTextOf(view),
                  }, countTextOf(view)),
                  // ④ 分组渲染（组头 + 既有行样式）
                  ...batched.groups.flatMap((g, gi) => [
                    React.createElement('div', {
                      key: `h-${g.market}`, className: 'tw-muted',
                      style: { padding: '4px 11px', fontSize: 12, background: 'var(--tw-bg2)' },
                      'data-role': `suggest-group-${g.market}`,
                      // 组头不是 option（读屏仍读得到文字）
                      role: 'presentation',
                    }, `${g.label} · ${g.rows.length} 条`),
                    ...g.rows.map((h, ri) => {
                      const idx = (groupOffsets[gi] ?? 0) + ri
                      const isActive = active === idx
                      return React.createElement(
                        'button',
                        {
                          key: h.secid,
                          type: 'button',
                          role: 'option',
                          id: optionId(idx),
                          'aria-selected': isActive,
                          'data-active': isActive ? 'true' : undefined,
                          // 键盘：Enter/Space 激活 button 触发的是 click ⇒ 选中必须接在 onClick 上
                          // （旧实现只挂 onMouseDown，键盘按下去什么都不发生 —— P1-4）
                          onClick: () => pick(h),
                          // 鼠标：按下时不让输入框失焦（否则列表会在 click 之前关掉）
                          onMouseDown: (e: React.MouseEvent) => {
                            e.preventDefault()
                          },
                          onMouseEnter: () => setActive(idx),
                        },
                        React.createElement('span', null, h.name, React.createElement('small', { className: 'tw-muted' }, ` ${h.code}`)),
                        // 只有东财一条链路的标的：东财被限流期间必然空行，提前说清（不拦着添加）
                        h.hasFallback === false
                          ? React.createElement('span', {
                              className: 'tw-badge',
                              title: '腾讯/新浪都没有该标的的映射：东财行情主机不可用时，它不会有价格（加入后会在自选里显示「无行情源」）',
                              style: { fontSize: 12, color: '#e0a94a' },
                            }, '仅东财源')
                          : null,
                        React.createElement('span', { className: 'k' }, h.kind),
                      )
                    }),
                  ]),
                  // ⑤ 分批渲染：一次只挂 SUGGEST_PAGE 行（长列表不卡），剩下的按需展开
                  batched.hidden > 0
                    ? React.createElement('button', {
                        type: 'button', 'data-role': 'suggest-more',
                        onClick: () => setShown((n) => n + SUGGEST_PAGE),
                        // 键盘 Enter 触发 click；mousedown 只负责"别让输入框失焦"
                        onMouseDown: (e: React.MouseEvent) => {
                          e.preventDefault()
                        },
                      }, `显示更多（还有 ${batched.hidden} 条）`)
                    : null,
                ),
        )
      : null,
  )
}

export interface MenuItem {
  label: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}

/** Compact 「⋯」 overflow menu: dark-saas style popover, closes on outside
 *  click / Escape / scroll. */
export function MoreMenu(props: { items: MenuItem[]; ariaLabel?: string; title?: string }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  // 打开后按真实裁剪区（视口 ∩ 所有 overflow 祖先）自适应：
  // 右侧放不下则左移，下方放不下则整体翻到触发器上方。
  useEffect(() => {
    if (!open) return
    const wrap = wrapRef.current
    const menu = menuRef.current
    if (wrap === null || menu === null) return
    const wr = wrap.getBoundingClientRect()
    const mr = menu.getBoundingClientRect()
    let cl = 0
    let ct = 0
    let cr = window.innerWidth
    let cb = window.innerHeight
    for (let n: HTMLElement | null = wrap.parentElement; n !== null; n = n.parentElement) {
      const st = window.getComputedStyle(n)
      if (/(auto|scroll|hidden|clip)/.test(`${st.overflow}${st.overflowX}${st.overflowY}`)) {
        const r = n.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          cl = Math.max(cl, r.left)
          ct = Math.max(ct, r.top)
          cr = Math.min(cr, r.right)
          cb = Math.min(cb, r.bottom)
        }
      }
    }
    let dx = 0
    let dy = 0
    if (mr.right > cr - 6) dx = cr - 6 - mr.right
    if (mr.left + dx < cl + 6) dx = cl + 6 - mr.left
    if (mr.bottom > cb - 6) dy = -(mr.height + wr.height + 8)
    menu.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`
  }, [open])

  return React.createElement(
    'div',
    { ref: wrapRef, className: 'tw-menu-wrap' },
    React.createElement('button', {
      className: 'tw-iconbtn tw-dots',
      title: props.title ?? '更多操作',
      'aria-label': props.ariaLabel ?? '更多操作',
      'aria-expanded': open,
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation()
        setOpen((v) => !v)
      },
    }, '⋯'),
    open
      ? React.createElement('div', { ref: menuRef, className: 'tw-menu' },
          props.items.map((it) =>
            React.createElement('button', {
              key: it.label,
              type: 'button',
              disabled: it.disabled === true,
              'data-danger': it.danger === true,
              onClick: (e: React.MouseEvent) => {
                e.stopPropagation()
                setOpen(false)
                it.onClick()
              },
            }, it.label),
          ),
        )
      : null,
  )
}

/** Button with tiny label + handler. */
export function Btn(props: {
  children?: React.ReactNode
  onClick?: (e: React.MouseEvent) => void
  primary?: boolean
  disabled?: boolean
  title?: string
  'aria-label'?: string
  'data-verb'?: string
}): React.ReactElement {
  return React.createElement(
    'button',
    {
      className: 'tw-btn',
      type: 'button',
      'data-primary': props.primary === true,
      'data-verb': props['data-verb'],
      disabled: props.disabled === true,
      title: props.title,
      'aria-label': props['aria-label'],
      onClick: props.onClick,
    },
    props.children,
  )
}

/** Loading skeleton blocks (shimmer). */
export function Skeleton(props: { lines?: number; height?: number; style?: React.CSSProperties }): React.ReactElement {
  const lines = props.lines ?? 3
  const height = props.height ?? 14
  return React.createElement(
    'div',
    { className: 'tw-skel-stack', 'aria-busy': true, 'aria-label': '加载中', style: props.style },
    Array.from({ length: lines }, (_, i) =>
      React.createElement('div', {
        key: i,
        className: 'tw-skel',
        style: { height: height + (i === 0 ? 8 : 0), width: i % 3 === 1 ? '68%' : i % 3 === 2 ? '84%' : '96%' },
      }),
    ),
  )
}

/** Unified empty state. */
export function EmptyHint(props: { children?: React.ReactNode; action?: React.ReactNode }): React.ReactElement {
  return React.createElement('div', { className: 'tw-empty' },
    React.createElement('span', null, props.children),
    props.action !== undefined ? React.createElement('div', null, props.action) : null,
  )
}

/**
 * 轻量 toast（P0-6 口径切换、P0-8 视图切换等"一次性动作的说明"）。
 *
 * 为什么不是 console 或就地改文案：这些动作**改变了全页面的解释口径**
 * （成本口径切换会让总盈亏整体跳一下、视图切换会让金额变模糊），
 * 不给一句"从 X 变成 Y、影响了多少"的说明，用户只会看到数字无缘无故变了。
 *
 * 自动消失（默认 6s），可手动关；同一时刻只留最后一条（不做队列，
 * 队列会把"刚才那一下到底发生了什么"推迟到看不见的地方）。
 */
export function useToast(): { text: string | null; show: (text: string) => void; clear: () => void } {
  const [text, setText] = useState<string | null>(null)
  const timer = useRef<number | null>(null)
  const show = useCallback((next: string): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    setText(next)
    timer.current = window.setTimeout(() => {
      timer.current = null
      setText(null)
    }, 6000)
  }, [])
  const clear = useCallback((): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    setText(null)
  }, [])
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
  }, [])
  return { text, show, clear }
}

export function Toast(props: { text: string | null; onClose?: () => void }): React.ReactElement | null {
  const text = props.text
  if (text === null || text === '') return null
  return React.createElement('div', { className: 'tw-toast', role: 'status', 'aria-live': 'polite' },
    React.createElement('span', null, text),
    props.onClose !== undefined
      ? React.createElement('button', { className: 'tw-toast-x', onClick: props.onClose, 'aria-label': '关闭提示' }, '×')
      : null,
  )
}
