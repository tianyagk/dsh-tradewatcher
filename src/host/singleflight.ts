/**
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
