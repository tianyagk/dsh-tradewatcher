/**
 * 大盘云图: embeds the third-party free A-share heat-map page.
 *
 * 三态降级（P0-10）：**加载中 / 已加载 / 超时**。
 * 此前只有一个 `loaded` 布尔，于是"白了就是白了"——分不清是没网、站点挂了，
 * 还是自己还在加载。现在：
 *   - 懒加载：进入本页才开始计时（面板本身只在被选中时挂载）；
 *   - 8s 超时：超时显示占位（域名 + 最后成功时间），而不是留一块空白 iframe；
 *   - 超时态给一次「重试」，重试会重建 iframe（换 key）并重新计时；
 *   - 最后成功时间记在 localStorage，跨会话可见（"上次是几点还能用的"）。
 *
 * 本仓库只做展示与降级说明，**不抓取**该站内容（见 README「明确不做」）。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Btn } from './ui.tsx'
import { IndustryHeatmap } from './IndustryHeatmap.tsx'

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

/** 用容器宽度作热力图宽度（SVG 需要数值；不引 ResizeObserver 之外的依赖） */
function useWidth(ref: React.RefObject<HTMLDivElement>, fallback = 700): number {
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const next = Math.max(320, el.clientWidth)
      setW(next)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

export function CloudMap(props: {
  /**
   * 涨跌配色（`prefs.redUp`）。
   *
   * 自绘热力图**必须**跟随它：此前这里写死 `redUp: true`，于是设成"绿涨红跌"的用户
   * 在大盘页看到绿=涨、切到云图页看到红=涨 —— 同一个面板里两套相反的色义
   * （第三方站点是第三套，且不由本插件决定，只能把它的口径写在界面上）。
   */
  redUp: boolean
}): React.ReactElement {
  const redUp = props.redUp
  /**
   * 默认「自绘」（P2-5）：只有自绘才标得了口径（面积=成交额、色深=涨跌幅、数据几点）。
   * 第三方站点仍然保留 —— 它的钻取与信息量确实更强，但口径与本插件无关，必须分清。
   */
  const [source, setSource] = useState<'self' | 'third'>('self')
  const hostRef = useRef<HTMLDivElement>(null)
  const width = useWidth(hostRef)
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
    : new Date(lastOk).toLocaleString('zh-CN', { hour12: false })

  if (source === 'self') {
    return React.createElement(
      'div',
      { className: 'tw-body', style: { padding: 0, gap: 0 } },
      React.createElement('div', { className: 'tw-panel-h', style: { padding: '8px 10px' } },
        React.createElement('span', { className: 't' }, '大盘云图'),
        React.createElement('div', { className: 'tw-seg' },
          React.createElement('button', { 'data-on': true, onClick: () => setSource('self') }, '自绘'),
          React.createElement('button', { 'data-on': false, onClick: () => setSource('third') }, '第三方站点'),
        ),
        React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, '自绘可标口径；第三方站点信息更全但口径由它决定'),
      ),
      React.createElement('div', { ref: hostRef, style: { padding: '0 10px 10px' } },
        // 配色跟随全局开关（与大盘页/列表同一套色义）
        React.createElement(IndustryHeatmap, { redUp, width: width - 20, height: Math.max(320, Math.round((width - 20) * 0.62)) }),
      ),
    )
  }

  return React.createElement(
    'div',
    { className: 'tw-body', style: { padding: 0, gap: 0 } },
    React.createElement('div', { className: 'tw-panel-h', style: { padding: '8px 10px' } },
      React.createElement('span', { className: 't' }, `大盘云图 · A股热力图（${CLOUD_MAP_HOST}）`),
      React.createElement('div', { className: 'tw-seg' },
        React.createElement('button', { 'data-on': false, onClick: () => setSource('self') }, '自绘'),
        React.createElement('button', { 'data-on': true, onClick: () => setSource('third') }, '第三方站点'),
      ),
      React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, '面积=流通市值，颜色=涨跌幅，自动刷新（频率以站点实际为准），滚轮缩放、双击看K线、方向键复盘'),
      // 该站点的色义与本插件**相反**且改不了：不写出来，用户就会以为云图跟自己的配色设置一致
      React.createElement('span', {
        className: 'tw-badge',
        style: { color: '#e0a94a', borderColor: '#e0a94a' },
        title: '第三方站点的涨跌配色由它自己决定，本插件无法修改，也不抓取它的内容。它的口径是「红=跌、绿=涨」',
      }, redUp ? '该站：红=跌 绿=涨（与本面板相反）' : '该站：红=跌 绿=涨（与本面板当前设置一致）'),
      // 加载状态常驻可见：超时不是"静默等待"，要能一眼看出现在处于哪一态
      React.createElement('span', { className: 'tw-badge', 'data-state': state, title: `最后成功加载：${lastOkText}` },
        state === 'loading' ? '加载中…' : state === 'loaded' ? '已加载' : '加载超时'),
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
          React.createElement('div', { className: 'tw-hint', style: { margin: '4px 0 0' } },
            '可以点「重试」，或点「新窗口打开」在浏览器里直接访问以确认到底是哪一边的问题。',
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
