/**
 * 工具箱页（主面板里的一个页）：**目录页 + 工具详情页容器 + 左上角返回按钮**。
 *
 * 布局（照用户给的参考图结构）：
 *   目录页 = 页标题 `工具目录` + 副标题 + 分类标签行（本轮只有「全部」）+ 搜索框（本地过滤）
 *            + 三列卡片网格；卡片 = 左上角标识 chip / 标题 / 一句话说明 / 页脚 `打开工具 →`。
 *   详情页 = 该工具的**真实结构骨架**（KPI 行 / 曲线区 / 饼图区 / 市场表 / 边界声明）。
 *
 * 数据：本批**不接数据源**。所有"数"一律走 `toolRegistry.detailModel()` 的 `未取到` 占位
 * （唯一来源，页面里不许再写第二份占位/默认值），**不得出现 0 或任何编造的数值**。
 * 主题：一切都用 `var(--tw-*)`（跟随 DSH 主题）与既有 class（`.tw-panel` / `.tw-tab` / `.tw-hint` / `.tw-empty`），
 * **不硬编码深色**。
 */
import React, { useMemo, useState } from 'react'
import {
  CATEGORY_TABS,
  PAGE_BACK_ACTION,
  TOOL_ENTRIES,
  catalogModel,
  detailModel,
  toolById,
} from './toolRegistry.ts'
import { Btn, EmptyHint } from './ui.tsx'

/** 无数据区的占位框（虚线，跟随主题 token） */
const PLACEHOLDER_BOX: React.CSSProperties = {
  minHeight: 120,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px dashed var(--tw-border-strong)',
  borderRadius: 10,
  background: 'var(--tw-bg2)',
  color: 'var(--tw-muted)',
  fontSize: 11.5,
  padding: '10px 12px',
  textAlign: 'center',
}

const GRID3: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }

export function ToolsPage(props: {
  /** 返回上一个非 tools 页签；`null` ⇒ 没有可返回的页（按钮不渲染） */
  onBack: (() => void) | null
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  /** 打开的工具 id；null = 目录页 */
  const [openId, setOpenId] = useState<string | null>(null)

  const model = useMemo(() => catalogModel(TOOL_ENTRIES, query, category, CATEGORY_TABS), [query, category])
  const entry = openId === null ? null : toolById(openId)

  return React.createElement(
    'div',
    { className: 'tw-tools', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' } },
    // 页头：左上角返回按钮（回上一个非 tools 页签）+ 页标题 + 副标题
    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px 0', flexWrap: 'wrap' } },
      props.onBack === null
        ? null
        : React.createElement(Btn, { onClick: props.onBack, title: '返回上一个页签', 'aria-label': '返回上一个页签' }, PAGE_BACK_ACTION),
      React.createElement('div', { style: { fontWeight: 600, fontSize: 13 } }, entry === null ? model.title : `${entry.chip} · ${entry.name}`),
      React.createElement('div', { className: 'tw-hint', style: { margin: 0 } }, entry === null ? model.subtitle : entry.blurb),
    ),
    entry === null ? catalogView(model, { query, category, setQuery, setCategory, onOpen: setOpenId }) : detailView(detailModel(entry), () => setOpenId(null)),
  )
}

/** 目录页：分类标签行 + 搜索框 + 三列卡片网格 */
function catalogView(
  model: ReturnType<typeof catalogModel>,
  io: { query: string; category: string; setQuery: (v: string) => void; setCategory: (v: string) => void; onOpen: (id: string) => void },
): React.ReactElement {
  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px 12px', minHeight: 0 } },
    // 分类标签行（本轮只有「全部」；工具条目自己的分类字段已落库，标签行下一批再加）
    React.createElement(
      'div',
      { className: 'tw-tabs', style: { border: 'none', background: 'transparent', padding: 0 }, role: 'tablist', 'aria-label': '工具分类' },
      model.categories.map((c) =>
        React.createElement(
          'button',
          { key: c.key, className: 'tw-tab', type: 'button', 'data-on': io.category === c.key, onClick: () => io.setCategory(c.key) },
          c.label,
        ),
      ),
    ),
    React.createElement('input', {
      type: 'search',
      value: io.query,
      placeholder: model.searchPlaceholder,
      'aria-label': model.searchPlaceholder,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => io.setQuery(e.target.value),
      style: { maxWidth: 320 },
    }),
    model.empty === null
      ? React.createElement(
          'div',
          { style: GRID3 },
          model.cards.map((card) =>
            React.createElement(
              'button',
              {
                key: card.id,
                type: 'button',
                className: 'tw-panel',
                title: card.blurb,
                'aria-label': `打开工具：${card.title}`,
                onClick: () => io.onOpen(card.id),
                style: { textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer', minHeight: 104 },
              },
              React.createElement(
                'span',
                {
                  style: {
                    alignSelf: 'flex-start',
                    fontSize: 10.5,
                    lineHeight: '16px',
                    padding: '0 6px',
                    borderRadius: 6,
                    border: '1px solid var(--tw-border)',
                    background: 'var(--tw-accent-soft)',
                    color: 'var(--tw-accent)',
                  },
                },
                card.chip,
              ),
              React.createElement('div', { style: { fontWeight: 600, fontSize: 12.5 } }, card.title),
              React.createElement('div', { className: 'tw-hint', style: { margin: 0, flex: 1 } }, card.blurb),
              React.createElement('div', { style: { color: 'var(--tw-accent)', fontSize: 11.5 } }, card.action),
            ),
          ),
        )
      : React.createElement(EmptyHint, null, model.empty),
  )
}

/** 详情页容器：结构骨架（KPI 行 / 曲线区 / 饼图区 / 市场表 / 边界声明），数据一律「未取到」 */
function detailView(model: ReturnType<typeof detailModel>, backToCatalog: () => void): React.ReactElement {
  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px 12px' } },
    React.createElement(Btn, { onClick: backToCatalog, title: '回到工具目录' }, model.backAction),
    React.createElement(
      'div',
      { className: 'tw-panel' },
      React.createElement(
        'div',
        { className: 'tw-panel-h' },
        React.createElement('span', { className: 't' }, model.kpi.title),
        React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, model.kpi.note),
      ),
      React.createElement(
        'div',
        { style: { display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, model.kpi.cells.length)}, minmax(0, 1fr))`, gap: 8 } },
        model.kpi.cells.map((cell) =>
          React.createElement(
            'div',
            { key: cell.label, style: { border: '1px solid var(--tw-border)', borderRadius: 9, padding: '6px 9px', background: 'var(--tw-card2)' } },
            React.createElement('div', { className: 'tw-hint', style: { margin: 0 } }, cell.label),
            React.createElement('div', { style: { fontSize: 12.5, color: 'var(--tw-muted)' } }, cell.text),
          ),
        ),
      ),
    ),
    React.createElement(
      'div',
      { className: 'tw-panel' },
      sectionHead(model.curve.title, model.curve.note),
      model.curve.points.length === 0
        ? React.createElement('div', { style: PLACEHOLDER_BOX }, model.curve.empty)
        : null,
    ),
    React.createElement(
      'div',
      { className: 'tw-panel' },
      sectionHead(model.pie.title, model.pie.note),
      model.pie.slices.length === 0
        ? React.createElement('div', { style: PLACEHOLDER_BOX }, model.pie.empty)
        : null,
    ),
    React.createElement(
      'div',
      { className: 'tw-panel' },
      sectionHead(model.market.title, model.market.note),
      React.createElement(
        'table',
        { style: { width: '100%', borderCollapse: 'collapse', fontSize: 11.5 } },
        React.createElement(
          'thead',
          null,
          React.createElement(
            'tr',
            null,
            model.market.columns.map((col) => React.createElement('th', { key: col, style: { textAlign: 'left', padding: '4px 6px', color: 'var(--tw-muted)', fontWeight: 500 } }, col)),
          ),
        ),
        React.createElement(
          'tbody',
          null,
          React.createElement(
            'tr',
            null,
            React.createElement(
              'td',
              { colSpan: Math.max(1, model.market.columns.length), style: { padding: '8px 6px', color: 'var(--tw-muted)' } },
              model.market.empty,
            ),
          ),
        ),
      ),
    ),
    React.createElement(
      'div',
      { className: 'tw-panel' },
      sectionHead(model.boundary.title, model.boundary.note),
      React.createElement(
        'ul',
        { style: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 } },
        model.boundary.lines.map((line) => React.createElement('li', { key: line, className: 'tw-hint', style: { margin: 0 } }, line)),
      ),
    ),
  )
}

/** 区块标题行（标题 + 口径/原因；口径行是 `未取到` 的原因，缺数据必须给原因） */
function sectionHead(title: string, note: string): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'tw-panel-h' },
    React.createElement('span', { className: 't' }, title),
    React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, note),
  )
}
