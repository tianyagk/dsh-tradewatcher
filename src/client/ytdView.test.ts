/**
 *  - 取不到显示 `—` 且说明原因（不许出现 0）；
 *  - tooltip 必须带上口径原文（`YTD_CALIBER`）与实际生效的复权口径 ——
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FQ_LABEL, YTD_CALIBER, type YtdRow } from '../shared/model.ts'
import { ytdMissingSummary, ytdText, ytdTooltip } from './ytdView.ts'

const row = (patch: Partial<YtdRow> = {}): YtdRow => ({
  secid: '1.600519',
  name: '贵州茅台',
  ytd: 12.34,
  baseDate: '2025-01-02',
  baseClose: 1500,
  price: 1685.1,
  baseKind: 'year',
  fq: 1,
  fqSupported: true,
  asOf: 1_760_000_000_000,
  why: null,
  ...patch,
})

test('ytdText：取不到显示 —（不用 0 顶替），方向上用字形双编码', () => {
  assert.equal(ytdText(row()), '▲12.34%')
  assert.equal(ytdText(row({ ytd: -3.5 })), '▼3.50%')
  assert.equal(ytdText(row({ ytd: 0 })), '0.00%')
  assert.equal(ytdText(row({ ytd: null })), '—')
  assert.equal(ytdText(undefined), '—')
})

test('ytdTooltip：口径原文 + 基准日 + 现价 + 实际生效的复权口径', () => {
  const text = ytdTooltip('贵州茅台', row(), true)
  assert.ok(text.includes(YTD_CALIBER), 'tooltip 必须带口径原文（写死的那一句）')
  assert.ok(text.includes('基准 2025-01-02'))
  assert.ok(text.includes('1500.000'))
  assert.ok(text.includes('1685.100'))
  assert.ok(text.includes(FQ_LABEL[1]))
})

test('ytdTooltip：指数/期货按原始价格，必须说明不适用复权', () => {
  const text = ytdTooltip('沪深300', row({ secid: '1.000300', fq: 0, fqSupported: false }), true)
  assert.ok(text.includes('不适用复权'))
  assert.ok(text.includes('按原始价格'))
})

test('ytdTooltip：本年内上市要单独说明（基准是上市首日，不是年初）', () => {
  const text = ytdTooltip('新股', row({ baseKind: 'listing', baseDate: '2025-03-03' }), true)
  assert.ok(text.includes('上市首日'), '年内上市必须写明"上市首日"，否则会被读成"年初至今"')
  assert.ok(text.includes('本年内上市'), '仍要标明基准不是"年初"')
  // "按年初读会高估"那句按文案审计压掉了（括号必须 ≤18 字）；事实本身由上面两句承载
})

test('ytdTooltip：算不出时给原因，且区分"还没结果"与"路由未取到它"', () => {
  const why = ytdTooltip('贵州茅台', row({ ytd: null, why: '日线本次取不到（上游限流或超时），稍后自动重试' }), true)
  assert.ok(why.includes('日线本次取不到'))
  assert.ok(why.includes(YTD_CALIBER))
  const pending = ytdTooltip('贵州茅台', undefined, false)
  assert.ok(pending.includes('尚未取到'))
  const notReturned = ytdTooltip('贵州茅台', undefined, true)
  assert.ok(notReturned.includes('未取到'))
})

test('ytdMissingSummary：全都能算时为 null；有缺失时报数量与第一条原因', () => {
  assert.equal(ytdMissingSummary([row(), row({ secid: '1.a' })]), null)
  const s = ytdMissingSummary([row(), row({ secid: '1.b', ytd: null, why: '日线本次取不到（上游限流或超时），稍后自动重试' })])
  assert.ok(s !== null)
  assert.match(s, /1 项缺数据/)
  assert.ok(s.includes('日线本次取不到'))
})

test('ytdMissingSummary 正文不重复渲染处已写的信息（面板每轮刷新都印，重复=把面板挤满）', () => {
  const s = ytdMissingSummary([row({ secid: '1.b', ytd: null, why: '日线本次取不到' })])
  assert.ok(s !== null)
  // 前缀「YTD：」已表明口径，正文再说一次 YTD 就是重复
  assert.ok(!s.includes('YTD'), `正文不该重复 YTD：${s}`)
  assert.ok(!s.includes('年初至今'), `正文不该重复"年初至今"：${s}`)
  // "显示 —、不用 0 顶替"是全页统一约定，属于 tooltip 而非常驻正文
  assert.ok(!s.includes('不用 0 顶替'), `正文不该重复缺失约定：${s}`)
  assert.ok(!s.includes('显示 —'), `正文不该重复缺失约定：${s}`)
})

test('P1-3：YTD 的降级必须能读出来（旧基准 + 失败冷却期间不会重取）', () => {
  const row = { secid: '1.600519', ytd: 12.3, baseDate: '2026-01-02', baseKind: 'normal', baseClose: 100, price: 112.3, why: null, fq: 1, fqSupported: true } as never
  const plain = ytdTooltip('贵州茅台', row, true)
  assert.ok(!plain.includes('本次是上次成功的结果'), '新鲜数据不加降级说明')
  const stale = ytdTooltip('贵州茅台', row, true, { stale: true, source: 'em' })
  assert.ok(stale.includes('本次是上次成功的结果'), `降级要写出来：${stale}`)
  assert.ok(stale.includes('来源：em'))
  const other = ytdTooltip('贵州茅台', row, true, { stale: false, source: 'lkg' })
  assert.ok(other.includes('来源：lkg') && !other.includes('本次是上次成功的结果'))
})
