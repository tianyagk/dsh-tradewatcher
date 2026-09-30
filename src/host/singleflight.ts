/**
 * 合并并发调用（single-flight）。
 *
 * 场景：护盘采样 tick 有**三条**触发路径 —— 定时循环、前端 `?force=1` 手动刷新、
 * 路由的 `ensureFresh()` 自动补采。此前它们各自直接 `await this.tick()`：
 * 定时器与手动刷新撞在一起时，会有两份全量采样同时在跑 —— 每份都会打一遍上游
 * （通道数 × 行情 + 分钟线），`today.samples` 重复计数，两份快照互相覆盖
 * （先完成的被后完成的盖掉，可能出现「样本数回退」）。
 *
 * 语义：**一次只跑一份**，期间的新调用合并到同一份上（等待同一个 Promise），
 * 而不是排队再跑一遍 —— 采样是幂等的轮询，重复执行没有额外信息量。
 * 失败不会把实例锁死：结算即释放下一个名额。
 */
export class SingleFlight {
  private inflight: Promise<void> | null = null

  /** 是否已有调用在跑（供 UI/自检观察） */
  get busy(): boolean {
    return this.inflight !== null
  }

  /** 当前在飞的那份（无则为 null）。**不要在自己那份工作内部 await 它**（会自锁）。 */
  get current(): Promise<void> | null {
    return this.inflight
  }

  /** 合并调用；返回的 Promise 结算于当前这一份工作完成时 */
  run(fn: () => Promise<void>): Promise<void> {
    const running = this.inflight
    if (running !== null) return running
    const started = fn().finally(() => {
      // 只清理自己那一份，避免把后来者的句柄清掉
      if (this.inflight === started) this.inflight = null
    })
    this.inflight = started
    return started
  }
}
