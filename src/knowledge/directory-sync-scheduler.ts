/** Fixed-delay directory sync: no overlapping runs or catch-up burst after restart. */
export class DirectorySyncScheduler {
  private readonly sources = new Map<string, { minutes: number; timer?: ReturnType<typeof setTimeout> }>()
  private disposed = false

  constructor(private readonly sync: (sourceId: string) => Promise<unknown>, private readonly onError: (sourceId: string, error: unknown) => void) {}

  configure(sourceId: string, minutes: number): void {
    const previous = this.sources.get(sourceId)
    if (previous?.minutes === minutes || this.disposed) return
    this.remove(sourceId)
    if (minutes === 0) return
    const source = { minutes, timer: undefined as ReturnType<typeof setTimeout> | undefined }
    this.sources.set(sourceId, source)
    const arm = (): void => {
      if (this.disposed || this.sources.get(sourceId) !== source) return
      source.timer = setTimeout(() => {
        source.timer = undefined
        void this.sync(sourceId).catch(error => this.onError(sourceId, error)).finally(arm)
      }, minutes * 60_000)
      source.timer.unref?.()
    }
    arm()
  }

  remove(sourceId: string): void {
    const source = this.sources.get(sourceId)
    if (source !== undefined) clearTimeout(source.timer)
    this.sources.delete(sourceId)
  }

  dispose(): void {
    this.disposed = true
    for (const id of this.sources.keys()) this.remove(id)
  }
}
