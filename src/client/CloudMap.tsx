/** 大盘云图: embeds https://52etf.site/ (the free A-share heat-map page,
 *  verified embeddable — no X-Frame-Options / CSP frame-ancestors). */
import React, { useState } from 'react'
import { Btn } from './ui.tsx'

export function CloudMap(): React.ReactElement {
  const [loaded, setLoaded] = useState(false)
  const [key, setKey] = useState(0)
  const open = (): void => {
    window.open('https://52etf.site/', '_blank', 'noopener')
  }
  return React.createElement(
    'div',
    { className: 'tw-body', style: { padding: 0, gap: 0 } },
    React.createElement('div', { className: 'tw-panel-h', style: { padding: '8px 10px' } },
      React.createElement('span', { className: 't' }, '大盘云图 · A股热力图（52etf.site）'),
      React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, '面积=流通市值，颜色=涨跌幅，约 8 秒自动刷新，滚轮缩放、双击看K线、方向键复盘'),
      React.createElement(Btn, { onClick: () => setKey((k) => k + 1) }, '重新加载'),
      React.createElement(Btn, { onClick: open }, '新窗口打开'),
    ),
    !loaded
      ? React.createElement('div', { className: 'tw-loading', style: { padding: 30 } }, '加载大盘云图中…（由 52etf.site 提供）')
      : null,
    React.createElement('iframe', {
      key,
      src: 'https://52etf.site/',
      title: '大盘云图 - 52etf',
      style: {
        flex: 1,
        minHeight: 480,
        width: '100%',
        border: 'none',
        background: '#fff',
        display: loaded ? 'block' : 'none',
      },
      sandbox: 'allow-scripts allow-same-origin allow-popups allow-forms',
      allow: 'clipboard-write',
      onLoad: () => setLoaded(true),
    }),
  )
}
