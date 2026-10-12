/**
 * v0.66.0（task-15）：护盘分时量能的**客户端**接线 —— 原因可达 + 推导值可见。
 *
 * 症状（用户报）：图区只剩一句「分钟成交额未取到」。两个要求：
 *   ① 常驻仍只留短文本，但**原因必须可达**（title/aria-label，键盘/触屏也能读到）；
 *   ② 用了兜底推导的成交额必须**在界面上标出来**（不能把推导值当上游直给）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = (): string => readFileSync(join(here, 'RescuePanel.tsx'), 'utf8')

test('量能未取到：常驻短文本 + 原因进 title/aria；接口的 missing 必须被消费', () => {
  const s = src()
  // 常驻文本仍是那一句（没加长句）
  assert.ok(s.includes("}, '分钟成交额未取到')"), '常驻文本还是这一句（不给长句）')
  // 原因从 /trend 的 missing 来，并挂到 title + aria-label
  assert.ok(s.includes("r.missing?.[0]?.note"), '必须消费 /trend 的 missing[0].note')
  assert.ok(s.includes('amountReason'), 'PulseChart 要拿到原因（amountReason）')
  assert.ok(/title: reason/.test(s) && /'aria-label': `分钟成交额未取到 —— \$\{reason\}`/.test(s),
    '原因必须同时进 title 与 aria-label')
  assert.ok(s.includes("?? '原因未给出（宿主未回 missing）'"), '宿主没给原因时也不留空白（如实写"未给出"）')
  // 反例注入：把 title/aria 去掉（= 只剩一句未取到）⇒ 判据必须失败
  const injected = s.replace("      title: reason,\n", '').replace("      'aria-label': `分钟成交额未取到 —— ${reason}`,\n", '')
  assert.notEqual(injected, s, '反例注入必须真改到源码')
  assert.equal(/title: reason/.test(injected), false, '⚠ 反例（原因不可达）必须能被判据抓住')
  assert.throws(
    () => assert.equal(/title: reason/.test(injected), true, '反例上"原因必须可达"必须失败'),
    /反例上/,
    '⚠ 反例注入（去掉原因）必须让断言失败',
  )
})

test('推导值必须可见：`amountDerived` ⇒ 常驻「量能推算」标记 + 说明进 title/aria', () => {
  const s = src()
  assert.ok(s.includes("amountDerived === true"), '必须识别宿主挂的 amountDerived 标记')
  assert.ok(s.includes("}, '量能推算')"), '标记文本（4 字）必须常驻出现')
  assert.ok(s.includes('title: derivedNote') && s.includes("'aria-label': derivedNote"), '推导说明进 title/aria')
  assert.ok(s.includes('amountNote'), '优先用宿主给的 amountNote（措辞与宿主一致）')
  // 反例注入：不认这个标记（= 把推导值当上游直给）⇒ 判据必须失败
  const injected = s.replace('.amountDerived === true', '.amountDerived === false')
  assert.notEqual(injected, s, '反例注入必须真改到源码')
  assert.equal(injected.includes('amountDerived === true'), false, '⚠ 反例（不认标记）必须能被判据抓住')
})
