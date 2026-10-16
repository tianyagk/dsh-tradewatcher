/** Small reusable UI atoms (modal, fields, suggest combobox, notes). */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { SuggestItem } from '../shared/model.ts'
import { api } from './api.ts'
import { SUGGEST_PAGE, batchOf, countTextOf, suggestListViewOf } from './suggestView.ts'

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
  const boxRef = useRef<HTMLDivElement | null>(null)
  const seq = useRef(0)

  const query = useCallback((q: string) => {
    const s = ++seq.current
    setBusy(true)
    api
      // count=50：一次尽量拿全（服务端夹 1..100；上游给不了更多时回包会标 truncated）
      .suggest(q, 50)
      .then((r) => {
        if (s !== seq.current) return
        setHits(r.hits)
        setMeta({ requested: r.requested, truncated: r.truncated })
        setReason(r.reason ?? null)
        setShown(SUGGEST_PAGE)
        setOpen(true)
      })
      .catch((e: Error) => {
        if (s !== seq.current) return
        setHits([])
        setMeta(null)
        // 失败**照样打开**并把原因写出来（空列表 + 关掉弹层会被读成"就是没有匹配"）
        setReason(`搜索未取到 —— ${e.message}（上游不可用时按缓存与限流自动重试）`)
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

  const pick = (item: SuggestItem): void => {
    setOpen(false)
    setText('')
    setReason(null)
    props.onPick(item)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const first = view.groups[0]?.rows[0]
    if (e.key === 'Enter' && first !== undefined && text.trim() !== '') {
      e.preventDefault()
      pick(first)
    } else if (e.key === 'Escape') {
      setOpen(false)
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
      onChange: (e) => setText(e.target.value),
      onKeyDown: onKeyDown,
      onFocus: () => { if (hits.length > 0) setOpen(true) },
    }),
    busy ? React.createElement('div', { className: 'tw-hint' }, '搜索中…') : null,
    open
      ? React.createElement(
          'div',
          { className: 'tw-suggest', style: { top: 'calc(100% + 2px)', left: 0, right: 0 }, 'data-role': 'suggest-list' },
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
                  ...batched.groups.flatMap((g) => [
                    React.createElement('div', {
                      key: `h-${g.market}`, className: 'tw-muted',
                      style: { padding: '4px 11px', fontSize: 12, background: 'var(--tw-bg2)' },
                      'data-role': `suggest-group-${g.market}`,
                    }, `${g.label} · ${g.rows.length} 条`),
                    ...g.rows.map((h) => React.createElement(
                      'button',
                      {
                        key: h.secid,
                        type: 'button',
                        onMouseDown: (e: React.MouseEvent) => {
                          e.preventDefault()
                          pick(h)
                        },
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
                    )),
                  ]),
                  // ⑤ 分批渲染：一次只挂 SUGGEST_PAGE 行（长列表不卡），剩下的按需展开
                  batched.hidden > 0
                    ? React.createElement('button', {
                        type: 'button', 'data-role': 'suggest-more',
                        onMouseDown: (e: React.MouseEvent) => {
                          e.preventDefault()
                          setShown((n) => n + SUGGEST_PAGE)
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
