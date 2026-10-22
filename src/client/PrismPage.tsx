/**
 * 【棱镜】第 9 行 / 第 8 个页签（批次 1+2）。
 *
 * 只读展示 + 两个编辑面（时点、骨架）+ 手动补跑；不新增轮询（打开/保存/补跑时才取数）。
 * Material Design 只在本页：elevation token、state layer、固定尺寸 ripple（transform/opacity）。
 * 不写声明性文案；缺数据一律 `—` + 一句原因。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import type { PrismRun, PrismState } from '../shared/prism.ts'
import { PRISM_DEFAULT_TIMES } from '../shared/prism.ts'
import { shClockText } from './marketTime.ts'
import {
  PRISM_FONT,
  analysisText,
  newsStatusText,
  runSummaryText,
  timesProblems,
  timesText,
} from './prismView.ts'

function RippleButton(props: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  title?: string
}): React.ReactElement {
  const ref = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    // 切后台（`data-idle=true`）时直接移除节点：CSS 的 animation-play-state:paused 会冻住半透明水波
    const obs = new MutationObserver(() => {
      if (document.querySelector('.tw-root')?.getAttribute('data-idle') === 'true') {
        ref.current?.querySelectorAll('.tw-prism-ripple').forEach((n) => n.remove())
      }
    })
    obs.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-idle'] })
    return () => obs.disconnect()
  }, [])
  const onPointerDown = (ev: React.PointerEvent<HTMLButtonElement>): void => {
    const el = ref.current
    if (el === null) return
    if (document.querySelector('.tw-root')?.getAttribute('data-idle') === 'true') return
    const rect = el.getBoundingClientRect()
    const span = document.createElement('span')
    span.className = 'tw-prism-ripple'
    span.style.left = `${ev.clientX - rect.left - 50}px`
    span.style.top = `${ev.clientY - rect.top - 50}px`
    el.appendChild(span)
    span.addEventListener('animationend', () => span.remove(), { once: true })
    setTimeout(() => span.remove(), 800)
  }
  return (
    <button
      ref={ref}
      type="button"
      className="tw-prism-btn"
      onPointerDown={onPointerDown}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  )
}

const card = (title: string, children: React.ReactNode): React.ReactElement => (
  <section className="tw-prism-card">
    <div className="tw-prism-card-title" style={{ fontSize: PRISM_FONT.title }}>{title}</div>
    {children}
  </section>
)

export function PrismPage(props: { active: boolean }): React.ReactElement {
  const [state, setState] = useState<PrismState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [times, setTimes] = useState<string[]>([...PRISM_DEFAULT_TIMES])
  const [skeleton, setSkeleton] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback((): void => {
    setError(null)
    api.prismState()
      .then((r) => {
        setState(r.state)
        setTimes(r.state.settings.times)
        setSkeleton(r.state.skeleton)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    if (!props.active) return
    load()
  }, [props.active, load])

  const saveTimes = (): void => {
    const bad = timesProblems(times)
    if (bad.length > 0) {
      setError(bad[0] as string)
      return
    }
    setBusy(true)
    api.prismSetTimes(times)
      .then((r) => { setState((s) => (s === null ? s : { ...s, settings: r.settings })); setNotice('时点已保存') })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  const saveSkeleton = (): void => {
    setBusy(true)
    api.prismSetSkeleton(skeleton)
      .then(() => setNotice('骨架已保存'))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  const syncNews = (): void => {
    setBusy(true)
    api.prismNews()
      .then((r) => setState((s) => (s === null ? s : { ...s, news: r.status })))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  const run = (slot: string): void => {
    setBusy(true)
    setNotice(null)
    api.prismRun(slot)
      .then((r) => setState((s) => (s === null ? s : { ...s, runs: [...s.runs, r.run] })))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  const latest: PrismRun | null = state === null || state.runs.length === 0 ? null : (state.runs[state.runs.length - 1] as PrismRun)
  const modelText = state === null
    ? '—'
    : state.model.error !== null
      ? `—（${state.model.error}）`
      : `${state.model.provider ?? '—'} / ${state.model.model ?? '—'}`

  return (
    <div className="tw-prism">
      <div className="tw-prism-head">
        <span style={{ fontSize: PRISM_FONT.title }}>棱镜</span>
        <span className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>模型 {modelText}</span>
        <RippleButton onClick={load} disabled={busy} title="重新取状态">刷新</RippleButton>
      </div>
      {error !== null ? <div className="tw-prism-error" style={{ fontSize: PRISM_FONT.body }}>—（{error}）</div> : null}
      {notice !== null ? <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>{notice}</div> : null}

      {card('研判时点（Asia/Shanghai，可增删）', (
        <div className="tw-prism-times">
          {times.map((t, i) => (
            <span key={`${t}-${i}`} className="tw-prism-chip" style={{ fontSize: PRISM_FONT.body }}>
              <input
                className="tw-prism-time"
                type="time"
                value={t}
                aria-label={`时点 ${i + 1}`}
                onChange={(e) => setTimes((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <RippleButton onClick={() => setTimes((prev) => prev.filter((_, j) => j !== i))} title="删除该时点">✕</RippleButton>
            </span>
          ))}
          <RippleButton onClick={() => setTimes((prev) => [...prev, '10:00'])} title="新增时点">＋ 时点</RippleButton>
          <RippleButton onClick={saveTimes} disabled={busy} title="保存时点">保存</RippleButton>
          <span className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>{timesText(state?.settings ?? null)}</span>
        </div>
      ))}

      {card('金十快讯（24h）', (
        <div className="tw-prism-row" style={{ fontSize: PRISM_FONT.body }}>
          <span>{newsStatusText(state?.news ?? null)}</span>
          <RippleButton onClick={syncNews} disabled={busy} title="同步新闻">同步</RippleButton>
        </div>
      ))}

      {card('研判骨架（页面可编辑）', (
        <div>
          <textarea
            className="tw-prism-skeleton"
            value={skeleton}
            onChange={(e) => setSkeleton(e.target.value)}
            rows={8}
            aria-label="研判骨架"
            style={{ fontSize: PRISM_FONT.body }}
          />
          <div className="tw-prism-row">
            <RippleButton onClick={saveSkeleton} disabled={busy} title="保存骨架">保存骨架</RippleButton>
            <span className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>{skeleton.length} 字</span>
          </div>
        </div>
      ))}

      {card('补跑（只跑指定时点）', (
        <div className="tw-prism-row">
          {(state?.settings.times ?? [...PRISM_DEFAULT_TIMES]).map((t) => (
            <RippleButton key={t} onClick={() => run(t)} disabled={busy} title={`补跑 ${t}`}>{t}</RippleButton>
          ))}
          <RippleButton onClick={() => run('manual')} disabled={busy} title="补跑（manual）">manual</RippleButton>
        </div>
      ))}

      {card('最近一次研判', (
        latest === null
          ? <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>—（还没有运行记录）</div>
          : (
            <div className="tw-prism-run">
              <div className="tw-muted" style={{ fontSize: PRISM_FONT.body }}>
                {latest.slot} · {shClockText(latest.startedAt)}
              </div>
              <div className="tw-prism-grid">
                {latest.analyses.map((a) => (
                  <div key={a.key} className="tw-prism-analysis">
                    <div className="tw-prism-analysis-title" style={{ fontSize: PRISM_FONT.body }}>{a.label}</div>
                    <div className="tw-prism-analysis-body" style={{ fontSize: PRISM_FONT.body }}>{analysisText(a)}</div>
                  </div>
                ))}
              </div>
              <div className="tw-prism-summary" style={{ fontSize: PRISM_FONT.body }}>{runSummaryText(latest)}</div>
            </div>
          )
      ))}
    </div>
  )
}
