/** A bounded FIFO shared by every file-processing entry point in one service.
 * A queued cancellation removes only itself; an active task owns its signal. */
export class ProcessingQueue {
  private running = 0
  private readonly waiting: Array<() => void> = []
  constructor(private readonly concurrency = 2, private readonly limit = 16) {}
  async run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.limit) throw Object.assign(new Error('document processor queue is full'), { code: 'busy' })
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          const index = this.waiting.indexOf(start)
          if (index >= 0) this.waiting.splice(index, 1)
          signal.removeEventListener('abort', cancel)
          reject(signal.reason)
        }
        const start = () => { signal.removeEventListener('abort', cancel); this.running++; resolve() }
        this.waiting.push(start)
        signal.addEventListener('abort', cancel, { once: true })
      })
    } else this.running++
    try { signal.throwIfAborted(); return await task() }
    finally { this.running--; this.waiting.shift()?.() }
  }
}
