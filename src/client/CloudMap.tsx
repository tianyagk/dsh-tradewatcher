/**
 * 大盘云图：**只保留第三方站点**（用户要求下线内建热力视图，v0.62.0）。
 *
 * 为什么不再有两视图段控：段控只剩一个选项就是纯噪音 —— 内建那一套已整块删除
 * （其渲染组件、取数、派生与口径段落一并下线），本组件只剩第三方 iframe 与其三态
 * （loading / loaded / timeout）。
 *
 * 口径边界（保留）：第三方站点的涨跌色义由它自己决定、本插件不抓取它的内容 ⇒ 色义与本插件**相反**时
 * 出一个徽标说明（`redUp` 仍是它的输入）；色义一致时不出（零信息）。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Btn } from './ui.tsx'
import { fmtStamp } from './format.ts'

/** 第三方源站（展示用；实现里只引用这一处，域名不散落） */
const CLOUD_MAP_URL = 'https://52etf.site/'
const CLOUD_MAP_HOST = ((): string => {
  try {
    return new URL(CLOUD_MAP_URL).host
  } catch {
    return CLOUD_MAP_URL
  }
})()

/** 超时阈值：8s（本地网络或站点慢时的经验值；再长就该告诉用户"可能挂了"） */
const TIMEOUT_MS = 8000
/** 最近一次成功加载时刻的持久化键 */
const LAST_OK_KEY = 'tw.cloudmap.lastOk'

type LoadState = 'loading' | 'loaded' | 'timeout'

function readLastOk(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_OK_KEY)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function CloudMap(props: {
  /**
   * 涨跌配色（`prefs.redUp`）。
   *
   * 仅用于**色义相反时的徽标**：第三方站点是第三套色义（红=跌、绿=涨），不由本插件决定；
   * 与本插件的 `redUp` 相反时必须写出来，一致时是零信息、不出徽标。
   */
  redUp: boolean
}): React.ReactElement {
  const redUp = props.redUp
  const [state, setState] = useState<LoadState>('loading')
  const [reloadKey, setReloadKey] = useState(0)
  const [lastOk, setLastOk] = useState<number | null>(() => readLastOk())
  const timer = useRef<number | null>(null)

  // 计时随 reloadKey 重置：重试是一次新的加载，不能沿用上一次的剩余时间
  useEffect(() => {
    setState('loading')
    const t = window.setTimeout(() => {
      setState((prev) => (prev === 'loaded' ? prev : 'timeout'))
    }, TIMEOUT_MS)
    timer.current = t
    return () => {
      window.clearTimeout(t)
      timer.current = null
    }
  }, [reloadKey])

  const onLoaded = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    setState('loaded')
    const now = Date.now()
    setLastOk(now)
    try {
      window.localStorage.setItem(LAST_OK_KEY, String(now))
    } catch {
      /* 隐私模式等：只影响"上次成功时间"的跨会话记忆，不影响本次展示 */
    }
  }

  const open = (): void => {
    window.open(CLOUD_MAP_URL, '_blank', 'noopener')
  }
  const retry = (): void => setReloadKey((k) => k + 1)

  const lastOkText = lastOk === null
    ? '尚无成功记录'
    : fmtStamp(lastOk)

  return React.createElement(
    'div',
    { className: 'tw-body', style: { padding: 0, gap: 0 } },
    React.createElement('div', { className: 'tw-panel-h', style: { padding: '8px 10px' } },
      React.createElement('span', { className: 't' }, `大盘云图 · A股热力图（${CLOUD_MAP_HOST}）`),
      React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, '面积=流通市值 · 双击看K线'),
  // 该站点的色义与本插件**相反**且改不了 —— 只有相反时才出徽标（一致时是零信息，R4）；
      // 文案压成 12 字，完整口径进 title（K7：同屏两套色义，相反时必须写出来）
      redUp
        ? React.createElement('span', {
            className: 'tw-badge',
            style: { color: 'var(--tw-warn)', borderColor: 'var(--tw-warn)' },
            title: '第三方站点的涨跌配色由它自己决定，本插件无法修改，也不抓取它的内容。它的口径是「红=跌、绿=涨」',
          }, '该站红跌绿涨，与本面板相反')
        : null,
      // 加载状态常驻可见：超时不是"静默等待"，要能一眼看出现在处于哪一态
      React.createElement('span', { className: 'tw-badge', 'data-state': state, title: `最后成功加载：${lastOkText}` },
        state === 'loading' ? '加载中…' : state === 'loaded' ? '已完成' : '加载超时'),
      React.createElement(Btn, { onClick: retry }, state === 'timeout' ? '重试' : '重新加载'),
      React.createElement(Btn, { onClick: open }, '新窗口打开'),
    ),
    // 超时占位：给出域名与最后成功时间，而不是一块空白 iframe
    state === 'timeout'
      ? React.createElement('div', { className: 'tw-placeholder' },
          React.createElement('div', {}, `无法在 ${TIMEOUT_MS / 1000} 秒内加载 ${CLOUD_MAP_HOST}`),
          React.createElement('div', { className: 'tw-hint', style: { margin: '4px 0 0' } },
            `可能是本机网络不通，或该第三方站点暂时不可用（本插件无法区分二者，也不会去抓取它的内容）。最后成功加载：${lastOkText}`,
          ),
        )
      : null,
    React.createElement('iframe', {
      key: reloadKey,
      src: CLOUD_MAP_URL,
      title: `大盘云图 - ${CLOUD_MAP_HOST}`,
      // 超时后把 iframe 移出布局（不再占着 480px 的空白）
      style: {
        flex: 1,
        minHeight: 480,
        width: '100%',
        border: 'none',
        background: '#fff',
        display: state === 'timeout' ? 'none' : 'block',
      },
      sandbox: 'allow-scripts allow-same-origin allow-popups allow-forms',
      allow: 'clipboard-write',
      onLoad: onLoaded,
    }),
  )
}
