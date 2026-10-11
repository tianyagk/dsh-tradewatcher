/**
 * 批量粘贴录入（P2-9）：解析 → 预览 → 确认写入 三步模态。
 *
 * 纪律：**写入只走既有账本写入路径**（`api.mutatePortfolio`，不自己写文件）；
 * 解析失败的行逐行报错并保留原文；预览标明"每条会被记成什么"（建仓/买入/卖出）；
 * 写入后给**一次撤销**（按返回的流水 id 反删，宿主侧留痕）；
 * 键盘全流程：Esc 关闭、Tab 在模态内循环（真焦点陷阱）、关闭后焦点还给触发按钮。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.ts'
import { Btn, ErrorNote } from './ui.tsx'
import { bulkOpText, parseBulk, type BulkParseResult } from './bulkPaste.ts'

export interface BulkPasteProps {
  /** 只要这两个字段（调用方从 portfolio view 直接映射，不搬运整型） */
  groups: ReadonlyArray<{ id: string; name: string; archived?: boolean }>
  items: ReadonlyArray<{ id: string; secid: string; name: string }>
  /** 默认落到哪个分组（持仓页当前分组） */
  defaultGroupId: string
  onDone: () => void
  onClose: () => void
}

type Stage = 'input' | 'preview' | 'done'

export function BulkPaste(props: BulkPasteProps): React.ReactElement {
  const [stage, setStage] = useState<Stage>('input')
  const [text, setText] = useState('')
  const [groupId, setGroupId] = useState(props.defaultGroupId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [written, setWritten] = useState<{ batch: string; count: number } | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)

  // 打开即聚焦首个控件（焦点陷阱的入口）
  useEffect(() => {
    const el = ref.current
    el?.querySelector<HTMLElement>('textarea,select,button')?.focus()
  }, [])

  const held = useMemo(() => props.items.map((i) => i.secid), [props.items])
  const parsed: BulkParseResult = useMemo(() => parseBulk(text, { heldSecids: held }), [text, held])

  /** Tab 在模态内循环（首尾相接；焦点被拖出模态也拉回） */
  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (ev.key !== 'Tab') return
    const el = ref.current
    if (el === null) return
    const nodes = [...el.querySelectorAll<HTMLElement>('textarea,select,button,input')].filter((n) => !n.hasAttribute('disabled'))
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement
    if (ev.shiftKey && (active === first || !el.contains(active))) {
      ev.preventDefault()
      last.focus()
    } else if (!ev.shiftKey && (active === last || !el.contains(active))) {
      ev.preventDefault()
      first.focus()
    }
  }

  const write = async (): Promise<void> => {
    if (parsed.rows.length === 0) return
    setBusy(true)
    setError(null)
    // 批次标记：写进每条流水的 note（撤销时按这个前缀反删 —— 客户端不需要知道流水 id）
    // 定长 8 位 base36（与 shared 的 BULK_BATCH_RE 约定一致：定长就不会出现
    // “一批次标记是另一批前缀”的歧义）
    const batch = `批量录入#${Date.now().toString(36).padStart(8, '0').slice(-8)}`
    try {
      for (const row of parsed.rows) {
        let posId = props.items.find((i) => i.secid.toUpperCase() === row.secid.toUpperCase())?.id
        if (posId === undefined) {
          // 建仓走既有 addPos（与"逐条手工录入"同一条路径）
          await api.mutatePortfolio({ op: 'addPos', groupId, secid: row.secid, symbolName: row.symbolName })
          const fresh = await api.portfolio()
          posId = fresh.view.positions.find((p) => p.secid.toUpperCase() === row.secid.toUpperCase())?.posId
          if (posId === undefined) throw new Error(`建仓失败：${row.secid}（宿主没返回该持仓）`)
        }
        await api.mutatePortfolio({
          op: row.op, posId, qty: row.qty, price: row.price, ts: row.ts,
          // 方向标记放最前（解析层依赖 `^卖`），批次标记跟在后面（撤销依赖它）
          note: `${row.note.trim() === '' ? '' : `${row.note} `}${batch}`,
        })
      }
      setWritten({ batch, count: parsed.rows.length })
      setStage('done')
      props.onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const undo = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // 撤销走宿主的 deleteLedger（按批次前缀反删 + 留痕：删掉的原件摘要写成一条 pnote）
      if (written === null) return
      await api.mutatePortfolio({ op: 'deleteLedger', noteMarker: written.batch })
      setWritten(null)
      setStage('input')
      props.onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return React.createElement('div', { className: 'tw-bulk', ref, role: 'dialog', 'aria-modal': 'true', 'aria-label': '批量录入', onKeyDown },
    React.createElement('div', { className: 'tw-bulk-h' },
      React.createElement('span', { className: 'tw-bulk-title' }, '批量录入'),
      React.createElement('span', { className: 'tw-bulk-stage' }, stage === 'input' ? '① 粘贴' : stage === 'preview' ? '② 预览' : '③ 完成'),
      React.createElement('button', { className: 'tw-iconbtn', onClick: props.onClose, 'aria-label': '关闭', title: '关闭（Esc）' }, '×'),
    ),
    error !== null ? ErrorNote({ error }) : null,
    stage === 'input'
      ? React.createElement('div', { className: 'tw-bulk-body' },
          React.createElement('div', { className: 'tw-bulk-tip' }, '每行一条：代码 ｜ 名称 ｜ 日期 ｜ 数量 ｜ 价格（可选第 6 列备注，以「卖」开头表示卖出）'),
          React.createElement('textarea', {
            className: 'tw-bulk-text', rows: 8, spellCheck: false,
            value: text, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value),
            placeholder: '1.600519|贵州茅台|2026-03-02|100|1500.5',
            'aria-label': '批量录入文本',
          }),
          React.createElement('div', { className: 'tw-bulk-tools' },
            React.createElement('select', {
              className: 'tw-select', value: groupId, 'aria-label': '落到哪个分组',
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setGroupId(e.target.value),
            }, ...props.groups.filter((g) => g.archived !== true).map((g) => React.createElement('option', { key: g.id, value: g.id }, g.name))),
            React.createElement('span', { className: 'tw-bulk-sum' }, parsed.summary),
          ),
          React.createElement('div', { className: 'tw-bulk-foot' },
            React.createElement(Btn, { onClick: () => setStage('preview'), disabled: parsed.rows.length === 0, primary: true }, `预览 ${parsed.rows.length} 条`),
          ),
        )
      : null,
    stage === 'preview'
      ? React.createElement('div', { className: 'tw-bulk-body' },
          React.createElement('div', { className: 'tw-bulk-sum' }, parsed.summary),
          React.createElement('table', { className: 'tw-bulk-table' },
            React.createElement('thead', null, React.createElement('tr', null,
              ['行', '代码', '名称', '日期', '数量', '价格', '记为'].map((h) => React.createElement('th', { key: h }, h)))),
            React.createElement('tbody', null, ...parsed.rows.map((r) => React.createElement('tr', { key: r.line },
              React.createElement('td', null, String(r.line)),
              React.createElement('td', null, r.secid),
              React.createElement('td', null, r.symbolName),
              React.createElement('td', null, r.day),
              React.createElement('td', { className: 'tw-num' }, String(r.qty)),
              React.createElement('td', { className: 'tw-num' }, String(r.price)),
              React.createElement('td', null, bulkOpText(r)),
            ))),
          ),
          parsed.errors.length > 0
            ? React.createElement('div', { className: 'tw-bulk-errors' },
                React.createElement('div', { className: 'tw-bulk-errh' }, `以下 ${parsed.errors.length} 行没有写入（原文保留，可复制回去改）：`),
                ...parsed.errors.map((e) => React.createElement('div', { key: e.line, className: 'tw-bulk-err' },
                  `第 ${e.line} 行：${e.message}`, React.createElement('code', { className: 'tw-bulk-raw' }, e.raw))),
              )
            : null,
          React.createElement('div', { className: 'tw-bulk-foot' },
            React.createElement(Btn, { onClick: () => setStage('input') }, '返回修改'),
            React.createElement(Btn, { onClick: () => { void write() }, disabled: busy || parsed.rows.length === 0, primary: true }, busy ? '写入中…' : `确认写入 ${parsed.rows.length} 条`),
          ),
        )
      : null,
    stage === 'done'
      ? React.createElement('div', { className: 'tw-bulk-body' },
          React.createElement('div', { className: 'tw-bulk-ok' }, `已写入 ${written?.count ?? 0} 条（走既有账本路径）。`),
          React.createElement('div', { className: 'tw-bulk-foot' },
            React.createElement(Btn, { onClick: () => { void undo() }, disabled: busy }, '撤销本次导入'),
            React.createElement(Btn, { onClick: props.onClose, primary: true }, '完成'),
          ),
        )
      : null,
  )
}
