/** 棱镜持仓表单校验（纯函数，页面与测试共用）。 */
const SECID_OK = /^(60|68|00|30|51|56|58)\d{4}$/

export function positionErrorOf(code: string, shares: number): string | null {
  if (!SECID_OK.test(code)) return '仅支持沪深 A 股与 ETF'
  if (!Number.isInteger(shares) || shares <= 0) return '股数必须是正整数'
  if (shares % 100 !== 0) return '股数必须是 100 的整数倍'
  return null
}

/** 决策流动作 → 胶囊文案（未知动作给 —，不猜） */
export function actionLabelOf(action: string | undefined): string {
  const m: Record<string, string> = { buy: '买入', sell: '卖出', hold: '持有', reject: '拒绝', cancel: '撤销' }
  return action === undefined ? '—' : (m[action] ?? '—')
}

/** 决策流动作 → 胶囊样式类（buy=涨色 / sell=跌色 / reject=危险 / hold·cancel=次要） */
export function pillClassOf(action: string | undefined): string {
  if (action === 'buy') return 'is-buy'
  if (action === 'sell') return 'is-sell'
  if (action === 'reject') return 'is-reject'
  return 'is-mute'
}

/** 来源三态归一：auto / manual / 其它 ⇒ unknown */
export function sourceOf(src: string | undefined): 'auto' | 'manual' | 'unknown' {
  return src === 'auto' || src === 'manual' ? src : 'unknown'
}

/** 六条约束的合法区间（%）与金额下限；越界返回原因 */
export function constraintErrorOf(key: string, v: number): string | null {
  if (!Number.isFinite(v)) return '约束必须是数字'
  if (v < 0) return '约束不能为负'
  if (key === 'perOrderYuan') return v > 1e9 ? '单笔金额上限过大' : null
  return v > 100 ? '百分比约束不能超过 100' : null
}
