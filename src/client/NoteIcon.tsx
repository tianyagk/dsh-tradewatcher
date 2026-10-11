/**
 * 右上角小圆形提示 icon（用户第 1 条：把"详情不可用 + 重试"的长条压成一个 icon）。
 *
 * 三条硬要求：
 *  ① 悬停给详情（`title`）、读屏给完整原因（`aria-label`）；
 *  ② **有重试动作时**点击 icon = 触发同一个 `setRetry` 自增；
 *  ③ **键盘可达**：用原生 `<button>`（天然可聚焦，回车/空格即点击；比自绘 div+keydown 更可靠），
 *     没有重试动作时用可聚焦的 `span` + `role="note"`（同样能 Tab 到、能读出原因）。
 *
 * 常驻可见只有一个字符（遵守开发原则 1：常驻可见只留必要信息），长解释在 title/aria 里。
 */
import React from 'react'

export interface NoteIconProps {
  /** 一行短原因（也是 icon 的语义标题） */
  reason: string
  /** 长解释（进 title 与 aria-label） */
  detail: string
  /** 有重试动作时给：点击/回车触发 */
  onRetry?: () => void
}

export function NoteIcon(props: NoteIconProps): React.ReactElement {
  const label = props.onRetry === undefined
    ? `${props.reason}。${props.detail}`
    : `${props.reason}。${props.detail}（回车或空格重试）`
  if (props.onRetry === undefined) {
    return React.createElement('span', {
      className: 'tw-noteicon',
      tabIndex: 0,
      role: 'note',
      title: `${props.reason}\n${props.detail}`,
      'aria-label': label,
    }, '!')
  }
  return React.createElement('button', {
    type: 'button',
    className: 'tw-noteicon tw-noteicon-btn',
    title: `${props.reason}\n${props.detail}`,
    'aria-label': label,
    onClick: props.onRetry,
    // button 原生支持回车/空格；显式补一份 keydown 只为让"键盘触发"这件事在测试里可核
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        props.onRetry?.()
      }
    },
  }, '!')
}
