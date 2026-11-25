/**
 * `/tradewatcher/prism` 回包的**内容指纹闸**（AUDIT-CLIENT-PERF P2-4）。
 *
 * 症状：棱镜每 30s 静默刷新一次，宿主每次都会返回一个**新对象**（哪怕内容一字未变），
 * 于是 `setState` 必然触发：`flowEntriesOf` 对 300+ runs 全量展开、`flowCountsOf`/`filterOf`
 * 再各扫一遍、60 张卡片元素全部重建（约 600–1000 个节点）—— 数据没变也照做。
 *
 * 修法：落地前算一次**整包内容指纹**，与上一条相同就**不 setState**（连渲染都不进）。
 *
 * 为什么不是审计里举例的「runs.length + 首末 id/at」：那会漏掉**同长度的内容变化**
 * （例如持仓价格、额度 used、绩效数字变了但 runs 没增删）—— 界面会停在旧价格上。
 * 这里用「稳定序列化（键排序）+ 双 FNV-1a」：内容等价 ⇒ 指纹相同；任何字段变化 ⇒ 指纹不同。
 * 成本是每 30s 一次字符串化（~几百 KB，毫秒级），远低于重建 600–1000 个 React 元素。
 */

/** 稳定序列化：对象键排序，`undefined` 按 `null`（宿主 JSON 回包没有 undefined，只为健壮） */
export function stableTextOf(value: unknown): string {
  return stableTextOfInner(value, 0)
}

function stableTextOfInner(value: unknown, depth: number): string {
  if (depth > 40) return 'null'
  if (value === null || value === undefined) return 'null'
  const t = typeof value
  if (t === 'number') return Number.isFinite(value as number) ? String(value) : 'null'
  if (t === 'boolean') return value === true ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableTextOfInner(v, depth + 1)).join(',')}]`
  if (t === 'object') {
    const bag = value as Record<string, unknown>
    // asOf 是宿主每次请求的「响应时刻」，内容没变也会变 ⇒ 从指纹里排除（否则指纹闸永远不命中）
    const keys = Object.keys(bag).filter((k) => k !== 'asOf' && bag[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableTextOfInner(bag[k], depth + 1)}`).join(',')}}`
  }
  return 'null'
}

/** FNV-1a 32 位（两路不同种子 ⇒ 组合成 64 位，碰撞概率可忽略） */
export function fnv1aHex(text: string, seed: number): string {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 内容指纹：长度 + 两路哈希（长度参与，进一步排除同哈希不同长的理论情况） */
export function stateSignature(state: unknown): string {
  const text = stableTextOf(state)
  return `${text.length}:${fnv1aHex(text, 0x811c9dc5)}${fnv1aHex(text, 0x9e3779b9)}`
}

export interface StateGate<T> {
  /** 内容变了 ⇒ 落地并返回 true；内容相同 ⇒ 跳过并返回 false */
  push: (state: T) => boolean
  /** 累计跳过了几次（断言/排障用） */
  skips: () => number
}

/**
 * 只把**内容真的变了**的回包交给 `apply`。
 * 第一次 push 必落地（没有上一条可比）；之后同指纹一律跳过。
 */
export function createStateGate<T>(apply: (state: T) => void): StateGate<T> {
  let last: string | null = null
  let skips = 0
  return {
    push(state) {
      const sig = stateSignature(state)
      if (last !== null && sig === last) {
        skips += 1
        return false
      }
      last = sig
      apply(state)
      return true
    },
    skips: () => skips,
  }
}
