/**
 * 客户端 YTD 展示断言（纯函数，可被 node --test 直接跑）。
 *
 * 重点锁两条容易被忽略、又只能靠文案保证的约定：
 *  - 取不到显示 `—` 且说明原因（不许出现 0）；
 *  - tooltip 必须带上口径原文（`YTD_CALIBER`）与实际生效的复权口径 ——
 *    「这个 YTD 是前复权还是不复权」是这个数字可不可信的前提。
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
  assert.ok(text.includes('上市首日至今'), '年内上市必须写成"上市首日至今"，否则会被读成"年初至今"')
  assert.ok(text.includes('会高估'))
})

test('ytdTooltip：算不出时给原因，且区分"还没结果"与"路由没返回它"', () => {
  const why = ytdTooltip('贵州茅台', row({ ytd: null, why: '日线本次取不到（上游限流或超时），稍后自动重试' }), true)
  assert.ok(why.includes('日线本次取不到'))
  assert.ok(why.includes(YTD_CALIBER))
  const pending = ytdTooltip('贵州茅台', undefined, false)
  assert.ok(pending.includes('尚未取到'))
  const notReturned = ytdTooltip('贵州茅台', undefined, true)
  assert.ok(notReturned.includes('未返回'))
})

test('ytdMissingSummary：全都能算时为 null；有缺失时报数量与第一条原因', () => {
  assert.equal(ytdMissingSummary([row(), row({ secid: '1.a' })]), null)
  const s = ytdMissingSummary([row(), row({ secid: '1.b', ytd: null, why: '日线本次取不到（上游限流或超时），稍后自动重试' })])
  assert.ok(s !== null)
  assert.match(s, /1 项/)
  assert.match(s, /不用 0 顶替/)
  assert.ok(s.includes('日线本次取不到'))
})
