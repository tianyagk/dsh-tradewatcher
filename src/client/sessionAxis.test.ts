/**
 * 交易时段网格的断言（券商 App 口径）。
 *
 * 锁三件事：① 横轴**固定为完整时段**（不是数据范围）—— 部分数据必须留白、不许拉伸；
 * ② 午休**零宽度**（11:30 与 13:00 的点 x 相同）；③ 没有时段表的标的一律返回 null（回落旧行为）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_CN, SESSION_HK, sessionAxis, sessionMinutes, sessionOf } from './sessionAxis.ts'

const mk = (day: string, from: string, to: string, stepMin: number): Array<{ label: string }> => {
  const [fh, fm] = from.split(':').map(Number)
  const [th, tm] = to.split(':').map(Number)
  const out: Array<{ label: string }> = []
  for (let m = fh * 60 + fm; m <= th * 60 + tm; m += stepMin) {
    out.push({ label: `${day} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` })
  }
  return out
}

test('① A股完整一天（240 点）⇒ 3 条竖线，且四格等宽、首末是开盘/收盘', () => {
  const day = mk('2026-10-09', '09:30', '15:00', 1).filter((p) => {
    const hhmm = p.label.slice(11)
    return hhmm <= '11:30' || hhmm >= '13:00'
  })
  assert.ok(day.length >= 240, `A股一天 240 分钟 ⇒ 至少 240 个点（本夹具含两端点，实际 ${day.length}）`)
  const ax = sessionAxis(day, SESSION_CN)
  assert.ok(ax !== null)
  assert.equal(ax.totalMinutes, 240)
  assert.equal(ax.gridLines.length, 3, `应有 3 条内部分隔线：${ax.gridLines.map((g) => g.label).join(' / ')}`)
  assert.deepEqual(ax.gridLines.map((g) => g.label), ['10:30', '11:30/13:00', '14:00'])
  assert.deepEqual(ax.gridLines.map((g) => Number(g.at.toFixed(4))), [0.25, 0.5, 0.75], '四格等宽')
  assert.equal(ax.xs[0], 0, '首点落在左边界')
  assert.equal(ax.xs[ax.xs.length - 1], 1, '末点落在右边界')
  assert.equal(ax.daySlots, 1)
})

test('② 只有上午数据 ⇒ 曲线止于 11:30 位置，右侧留白（x 不触及右边界）', () => {
  const morning = mk('2026-10-09', '09:30', '11:30', 1)
  const ax = sessionAxis(morning, SESSION_CN)
  assert.ok(ax !== null)
  const last = ax.xs[ax.xs.length - 1]
  assert.equal(last, 0.5, '上午收盘 = 一整段的 50%')
  assert.ok(last < 1, '不许拉伸铺满（右侧必须留白）')
  assert.equal(ax.xs[0], 0)
})

test('③ 午休零宽度：11:30 与 13:00 的点 x 相同', () => {
  const pts = [
    { label: '2026-10-09 11:29' },
    { label: '2026-10-09 11:30' },
    { label: '2026-10-09 12:15' },   // 午休里的点（数据里不该有，但要能兜住）
    { label: '2026-10-09 13:00' },
    { label: '2026-10-09 13:01' },
  ]
  const ax = sessionAxis(pts, SESSION_CN)
  assert.ok(ax !== null)
  assert.equal(ax.xs[1], ax.xs[2], '11:30 与午休中的点落在折线上')
  assert.equal(ax.xs[2], ax.xs[3], '午休中的点与 13:00 同一条竖线')
  assert.equal(Number(ax.xs[1].toFixed(4)), 0.5)
  assert.ok(ax.xs[4] > ax.xs[3], '13:01 必须在 13:00 右边')
})

test('④ 无时段表的标的 ⇒ sessionOf 返回 null，sessionAxis 也返回 null（回落旧行为）', () => {
  assert.equal(sessionOf('100.SPX'), null, '美股不写时段表（夏令时漂移）')
  assert.equal(sessionOf('114.LHM'), null)
  assert.equal(sessionOf('122.XAU'), null)
  assert.equal(sessionOf('105.AAPL'), null)
  const ax = sessionAxis([{ label: '2026-09-23 21:30' }, { label: '2026-09-24 04:00' }], null)
  assert.equal(ax, null)
  // 标签里没有时间的（日/周/月 K）也不适用
  assert.equal(sessionAxis([{ label: '2026-10-09' }, { label: '2026-10-10' }], SESSION_CN), null)
})

test('⑤ 时段外的点（09:25 集合竞价）夹到边界，坐标必须有限且落在 [0,1]', () => {
  const pts = [
    { label: '2026-10-09 09:25' },
    { label: '2026-10-09 09:30' },
    { label: '2026-10-09 15:00' },
    { label: '2026-10-09 15:03' },
  ]
  const ax = sessionAxis(pts, SESSION_CN)
  assert.ok(ax !== null)
  assert.equal(ax.xs[0], 0, '盘前夹到左边界')
  assert.equal(ax.clampedBefore, 1)
  assert.equal(ax.xs[3], 1, '收盘后夹到右边界')
  assert.equal(ax.clampedAfter, 1)
  for (const x of ax.xs) assert.ok(Number.isFinite(x) && x >= 0 && x <= 1, `坐标必须有限且在 [0,1]：${x}`)
})

test('⑥ 港股（192 点那组：09:30–12:00 + 13:00–13:40）⇒ 网格与总时长相符', () => {
  const pts = [...mk('2026-10-09', '09:30', '12:00', 1), ...mk('2026-10-09', '13:00', '13:40', 1)]
  assert.equal(pts.length, 192, '151 + 41 = 192（与 LKG 实测一致）')
  const ax = sessionAxis(pts, SESSION_HK)
  assert.ok(ax !== null)
  assert.equal(ax.totalMinutes, 330, '港股市段 150 + 180 = 330 分钟')
  assert.deepEqual(ax.gridLines.map((g) => g.label), ['10:45', '12:00/13:00', '14:30'])
  assert.equal(Number(ax.xs[ax.xs.length - 1].toFixed(4)), Number(((150 + 40) / 330).toFixed(4)), '13:40 = 190/330')
  assert.equal(sessionOf('116.02513')?.id, 'hk')
  assert.equal(sessionOf('1.600519')?.id, 'cn')
  assert.equal(sessionOf('0.399001')?.id, 'cn')
  assert.equal(sessionMinutes(SESSION_HK), 330)
})

test('多日档：每天各自占一个天槽，最后一天没走完就留白', () => {
  const d1 = mk('2026-10-08', '09:30', '15:00', 60).filter((p) => !p.label.endsWith('12:00'))
  const d2 = mk('2026-10-09', '09:30', '10:30', 60)
  const ax = sessionAxis([...d1, ...d2], SESSION_CN)
  assert.ok(ax !== null)
  assert.equal(ax.daySlots, 2)
  assert.equal(ax.xs[0], 0, '第一天从头开始')
  const last = ax.xs[ax.xs.length - 1]
  assert.ok(Math.abs(last - (0.5 + 0.25 / 2)) < 0.01, `第二天只到 10:30 ⇒ 大约 0.625，实际 ${last}`)
  assert.ok(last < 1, '最后一天没走完 ⇒ 不许拉伸')
})
