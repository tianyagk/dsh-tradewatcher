/**
 * 有界并发（**唯一实现**）：把「N 个互不依赖的异步任务」压到 `limit` 路同时跑。
 *
 * 为什么要有这个文件：仓库里已有两处手写的同款循环（竞价一拍写 40 个文件、五市场
 * 逐个取数），各自实现就会出现「有的限 3、有的限 8、有的忘了限」——`docs/AUDIT-HOST-PERF.md`
 * 的 P2-4 / P2-8 就是这两处。这里只抽**调度**，业务语义（失败怎么记、顺序怎么排）留给调用方。
 *
 * 契约：
 *   · **结果顺序 = 输入顺序**（按下标落位，不按完成先后），调用方可以放心 `deepEqual` 串行结果；
 *   · `limit` 至少 1；`items` 为空 ⇒ 立即返回 `[]`；
 *   · **单个任务抛错 ⇒ 整个 Promise 拒绝**（与 `Promise.all` 同语义）。要"一个失败不影响其它"，
 *     请在 `worker` 内部自己 catch —— 本函数不替调用方吞错。
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const width = Math.max(1, Math.floor(limit))
  const out = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      out[i] = await worker(items[i] as T, i)
    }
  })
  await Promise.all(runners)
  return out
}
