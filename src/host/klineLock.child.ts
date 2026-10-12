/**
 * 子进程：走**真实取数路径**写 K 线磁盘缓存（`fetchKline` → `refreshKline` → `saveKlineCache`），
 * 用于 `klineLock.test.ts` 的真两进程并发断言。
 *
 * 两个模式（都先**钉住时钟**：必须是交易日盘中，否则 `fetchKline` 走"休市定稿"分支、一次不回源）：
 *   save  <DSH_HOME> <fromIndex> <count> [atEpochMs]
 *        —— 上游桩返回 [from, from+count) 这 N 根互不重复的日线；`atEpochMs` 用于让多个子进程
 *           在**同一时刻**开跑（制造真正的并发窗口）。
 *   prune <DSH_HOME> <secid> [atEpochMs]
 *        —— 落一次盘以触发 `pruneKlineCache()`（目录由测试预先塞满、超过配额），
 *           然后等目录稳定，打印自己的裁剪结果与最终文件数。
 *
 * ⚠ 硬断言 `DSH_HOME` 前缀为 `/tmp`：本项目发生过"实验写进用户真实数据目录"的事故。
 */
export {} // 让本文件是 ESM（顶层 await 需要）

const mode = String(process.argv[2] ?? '')
const dir = String(process.argv[3] ?? '')
if (mode === '' || dir === '' || !dir.startsWith('/tmp')) {
  console.error(`拒绝运行：DSH_HOME 必须在 /tmp 下（收到 ${dir}）`)
  process.exit(2)
}
const startedAt = Date.now() // 钉住之前先取真实时间（用于"同时开跑"的对齐）
process.env.DSH_HOME = dir
// 钉住"现在"：北京 2026-10-12（周一）10:30（连续竞价中）
Date.now = () => Date.UTC(2026, 9, 12, 2, 30, 0)

// 可选：等到指定时刻再开跑（多个子进程对齐成真正的并发窗口）
const startAt = Number(process.argv[mode === 'save' ? 6 : 5] ?? 0)
if (Number.isFinite(startAt) && startAt > 0) {
  const wait = startAt - startedAt
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

const { fetchKline } = await import('./em.ts')
const { join } = await import('node:path')
const { readdirSync } = await import('node:fs')

const klinesDir = join(dir, 'dsh-tradewatcher', 'klines')
const countJson = (): number => {
  try {
    return readdirSync(klinesDir).filter((n) => n.endsWith('.json')).length
  } catch {
    return 0
  }
}

if (mode === 'save') {
  const from = Number(process.argv[4] ?? 0)
  const count = Number(process.argv[5] ?? 400)
  const BASE = Date.parse('2024-01-01T00:00:00+08:00')
  const klines: string[] = []
  for (let i = 0; i < count; i += 1) {
    const day = new Date(BASE + (from + i) * 86_400_000).toISOString().slice(0, 10)
    klines.push(`${day},100,101,102,99,1000,120000,1,1,0.5,0.3`)
  }
  const text = JSON.stringify({ data: { klines, total: klines.length } })
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? '')
    const u = new URL(url)
    if (u.host.endsWith('eastmoney.com') && u.pathname === '/api/qt/stock/kline/get') {
      return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) } as unknown as Response
    }
    throw new TypeError('fetch failed')
  }) as typeof fetch
  const got = await fetchKline('1.600519', 101, 800, 1)
  console.log(`child done: mode=save from=${from} count=${count} got=${got?.days.length ?? 0}`)
} else if (mode === 'prune') {
  const secid = String(process.argv[4] ?? '1.600519')
  const text = JSON.stringify({ data: { klines: ['2024-01-02,100,101,102,99,1000,120000,1,1,0.5,0.3'], total: 1 } })
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? '')
    const u = new URL(url)
    if (u.host.endsWith('eastmoney.com') && u.pathname === '/api/qt/stock/kline/get') {
      return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) } as unknown as Response
    }
    throw new TypeError('fetch failed')
  }) as typeof fetch
  await fetchKline(secid, 101, 10, 1)
  // 等自己的裁剪跑完（`void pruneKlineCache()`）：文件数稳定 400ms 即认为结束
  let last = countJson()
  let stable = 0
  for (let i = 0; i < 200 && stable < 4; i += 1) {
    await new Promise((r) => setTimeout(r, 100))
    const now = countJson()
    stable = now === last ? stable + 1 : 0
    last = now
  }
  console.log(`child done: mode=prune secid=${secid} files=${last}`)
} else {
  console.error(`未知模式：${mode}`)
  process.exit(2)
}
