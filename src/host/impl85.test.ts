/**
 * IMPL-85：移除护盘「跨日信号收件箱」的**宿主侧**判据。
 *
 * 背景：v0.110.0 交付的收件箱（`PortPrefs.rescueInboxRead` + `normalizeRescueInboxRead` +
 * `applyPrefsPatch` 分支 + 装载归一）被用户判定无用，IMPL-85 整块移除。本文件只钉两件事：
 *
 *   ④ **宽容忽略**：老 `prefs.json` 里遗留的旧键、以及**老客户端**发来的旧键写请求，
 *      都不得让装载或写回失败（它们是明文文件里的死数据，不是运行时契约）。
 *   ② 今日信号时间线（**保留**的功能）仍能取到数据：`snapshot().today` 由当日日志喂出。
 *      这是"删收件箱顺手把时间线一起删了"的守门判据。
 *
 * 每条判据都配反例注入（喂给同一条判据必须失败），避免退化成恒真。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * ⚠ 必须在 import store.ts / rescue.ts 的**动态导入之前**钉住 DSH_HOME：
 * 否则共享行情链会去读**真机**的 `~/.dsh/dsh-tradewatcher`（红线：不得读写用户的真实数据目录）。
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tw-impl85-home-'))

const STORE_SRC = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')
const MODEL_SRC = readFileSync(new URL('../shared/model.ts', import.meta.url), 'utf8')

/**
 * 旧键名的唯一出现处（只在本测试里拼出来）：审计扫描要求**运行时源码**里不再出现这个标识符，
 * 而这条判据恰恰要模拟"删不掉的老数据/老客户端" ⇒ 用一个局部常量承载它。
 */
const LEGACY_KEY = 'rescueInboxRead'

test('④ prefs 装载与写回：遗留旧键被宽容忽略（不抛错、不污染已知偏好）；注入：写坏已登记键必须报错', async () => {
  const { DataStore } = await import('./store.ts')

  // ── 情形 A：旧键里是一张「已读时间戳表」（v0.110.0–v0.112.0 的真实落盘形状）
  const dirA = mkdtempSync(join(tmpdir(), 'tw-impl85-legacy-a-'))
  try {
    writeFileSync(join(dirA, 'prefs.json'), JSON.stringify({
      theme: 'dark',
      rescue: { enabled: true, intervalSec: 30, tailIntervalSec: 15, tailFrom: '14:30', universe: [], rescueCoverageEnabled: true },
      [LEGACY_KEY]: { '2026-10-16#2#1760000000000': 1760000000000, '2026-10-18#2#1760000100000': 1760000100000 },
    }), 'utf8')
    const store = new DataStore(dirA)
    // 装载：不得抛错（旧键不在 PortPrefs 契约里，也没有任何归一函数为它兜底）
    await store.init()
    const loaded = store.getPrefs()
    assert.equal(loaded.theme, 'dark', '同文件里的已登记偏好必须照常装载')
    assert.equal(loaded.rescue.rescueCoverageEnabled, true, '护盘配置必须照常装载（旧键不得把同族字段带坏）')
    assert.deepEqual(loaded.stripCfg, { hidden: [] }, '未登记的已知偏好仍走默认（不是被旧键串味）')
    // 写回：同一个实例再写另一项必须成功，且真的落盘
    const written = await store.setPrefs({ theme: 'light' })
    assert.equal(written.theme, 'light', '写回必须成功')
    const reread = new DataStore(dirA)
    await reread.init()
    assert.equal(reread.getPrefs().theme, 'light', '写回必须真的落盘（新实例读到新值）')
  } finally {
    rmSync(dirA, { recursive: true, force: true })
  }

  // ── 情形 B：旧键里是坏形状（字符串）⇒ 同样不得抛错
  const dirB = mkdtempSync(join(tmpdir(), 'tw-impl85-legacy-b-'))
  try {
    writeFileSync(join(dirB, 'prefs.json'), JSON.stringify({ theme: 'light', [LEGACY_KEY]: 'broken' }), 'utf8')
    const store = new DataStore(dirB)
    await store.init()
    const loaded = store.getPrefs()
    assert.equal(loaded.theme, 'light')
    assert.equal(typeof loaded.rescue, 'object', '坏形状的旧键不得让 prefs 结构崩掉')
    // 老客户端（浏览器里还开着 v0.112 的页签）仍会把旧键塞进 patch：不得 500 / 不得 reject
    const afterOldClient = await store.setPrefs({ theme: 'dark', [LEGACY_KEY]: { '2026-10-19#2#1': 1 } } as never)
    assert.equal(afterOldClient.theme, 'dark', '旧客户端的 patch 里**同时带的已知偏好必须生效**（旧键被忽略即可，不能连坐拒绝整包）')
  } finally {
    rmSync(dirB, { recursive: true, force: true })
  }

  // ── 反例注入：这套"不抛错"的判据不是恒真 —— 写坏一个**已登记**偏好必须 reject
  const dirC = mkdtempSync(join(tmpdir(), 'tw-impl85-legacy-c-'))
  try {
    const store = new DataStore(dirC)
    await store.init()
    await assert.rejects(
      store.setPrefs({ theme: 'bogus' } as never),
      /theme 必须是/,
      '⚠ 注入：已登记偏好的非法值仍必须报错（证明上两条的"不抛错"是有来源的，不是判据失效）',
    )
  } finally {
    rmSync(dirC, { recursive: true, force: true })
  }

  // ── 源码级：宿主侧不再有收件箱的归一函数/上界常量/写入分支（防止"只删界面不删管道"）
  for (const gone of ['normalizeRescueInboxRead', 'RESCUE_INBOX_READ_MAX', LEGACY_KEY]) {
    assert.equal(STORE_SRC.includes(gone), false, `store.ts 不许再出现 ${gone}`)
    assert.equal(MODEL_SRC.includes(gone), false, `model.ts 不许再出现 ${gone}`)
  }
})

test('②（保留项）今日信号时间线仍能取到数据：snapshot().today 由当日日志喂出（注入：抹掉当日日志 ⇒ 必败）', async () => {
  const { RescueMonitor } = await import('./rescue.ts')
  const dir = mkdtempSync(join(tmpdir(), 'tw-impl85-today-'))
  const realNow = Date.now
  // ⚠ 时钟钉在**交易日**：非交易日门禁会把 level 置 null（与 selftest 的 LKG 用例同一理由）
  const TRADING_DAY = Date.parse('2026-10-19T10:00:00+08:00')
  Date.now = () => TRADING_DAY
  try {
    writeFileSync(join(dir, 'rescue-log.json'), JSON.stringify({
      v: 1,
      days: {
        '2026-10-19': {
          events: [
            { ts: TRADING_DAY - 900_000, hhmm: '09:45', level: 2, score: 58, reason: '（fixture）宽基放量 + 超大单净流入', engine: 'v2' },
            { ts: TRADING_DAY - 300_000, hhmm: '09:55', level: 2, score: 66, reason: '（fixture）量价背离收敛', engine: 'v2' },
          ],
          intraday: [{ ts: TRADING_DAY - 300_000, hhmm: '09:55', score: 66, level: 2, timeAdjMult: 1.1, superVsAvg: 1.4 }],
          samples: 6,
          gap: false,
        },
      },
      baselines: {},
      selfSamples: {},
    }), 'utf8')
    const mon = new RescueMonitor(dir, { enabled: true, intervalSec: 60, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
    await mon.init()
    const snap = mon.snapshot()
    assert.equal(snap.today.length, 2, `当日时间线必须取到 2 条事件（实得 ${snap.today.length}）`)
    assert.deepEqual(snap.today.map((e) => e.hhmm), ['09:55', '09:45'], '今日时间线按时间倒序（新事件在前，界面第一眼看到最新一条）')
    assert.equal(snap.today[0].level, 2, '等级字段必须原样带出（时间线按等级上色）')
    assert.equal(snap.intraday.length, 1, '当日 5 分钟抽样同链路保留')
    // 反例注入：另一份**空日志** ⇒ 同一条断言必须失败（证明"取到 2 条"不是恒真）
    const emptyDir = mkdtempSync(join(tmpdir(), 'tw-impl85-today-empty-'))
    try {
      const empty = new RescueMonitor(emptyDir, { enabled: true, intervalSec: 60, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
      await empty.init()
      assert.equal(empty.snapshot().today.length, 0, '空日志时今日时间线为空（这是真的 0，不是缺数据）')
      assert.throws(
        () => assert.equal(empty.snapshot().today.length, 2, '反例上"取到 2 条"必须失败'),
        /反例上/,
        '⚠ 注入：抹掉当日日志必须让判据失败',
      )
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  } finally {
    Date.now = realNow
    rmSync(dir, { recursive: true, force: true })
  }
})
