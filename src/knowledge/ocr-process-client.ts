import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { OCR_PROTOCOL_VERSION, ocrError, type OcrProcessResponse } from './ocr-protocol.js'

const MAX_PENDING = 16
const EXIT_TIMEOUT_MS = 10_000

/** Native OCR runs in another process: a V8/ONNX fatal cannot kill DSH. */
export class OcrProcessClient {
  private child: ChildProcess | null = null
  private readonly children = new Set<ChildProcess>()
  private sequence = 0
  private disposing: Promise<void> | undefined
  private readonly pending = new Map<number, { resolve(text: string): void; reject(error: Error): void }>()

  constructor(
    private readonly modulePath = fileURLToPath(new URL('./ocr-process.mjs', import.meta.url)),
    private readonly timeoutMs = 5 * 60_000,
  ) {}

  private failPending(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  private spawn(): ChildProcess {
    if (this.child !== null) return this.child
    const options: ForkOptions & { windowsHide: boolean } = {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
      execArgv: [],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }
    const child = fork(this.modulePath, [], options)
    this.child = child
    this.children.add(child)
    child.unref()
    child.on('message', (value: unknown) => {
      if (this.child !== child) return
      const message = value as Partial<OcrProcessResponse> | null
      if (message === null || typeof message !== 'object' || typeof message.id !== 'number') return
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.protocolVersion !== OCR_PROTOCOL_VERSION || message.operation !== 'recognize') {
        entry.reject(ocrError('ocr_failed', 'OCR process returned an invalid response'))
      } else if (message.ok === true && typeof message.text === 'string') {
        entry.resolve(message.text)
      } else {
        entry.reject(ocrError('ocr_failed', message.ok === false && typeof message.error === 'string' ? message.error : 'OCR process failed'))
      }
      if (this.pending.size === 0) child.channel?.unref()
    })
    const fail = (error: Error): void => {
      if (this.child !== child) return
      this.child = null
      this.failPending(error)
      child.kill('SIGKILL')
    }
    child.on('error', error => {
      if (child.pid === undefined) this.children.delete(child)
      fail(ocrError('ocr_process_crash', `OCR process failed: ${error.message}`))
    })
    child.on('disconnect', () => fail(ocrError('ocr_process_crash', 'OCR process disconnected')))
    child.on('exit', (code, signal) => {
      this.children.delete(child)
      fail(ocrError('ocr_process_crash', `OCR process exited (${signal ?? code ?? 'unknown'})`))
    })
    return child
  }

  recognize(png: Buffer, modelDir: string): Promise<string> {
    if (this.disposing !== undefined) return Promise.reject(ocrError('ocr_failed', 'OCR process is shutting down'))
    if (this.pending.size >= MAX_PENDING) return Promise.reject(ocrError('ocr_busy', 'OCR queue is full; retry the document later'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        const child = this.child
        this.child = null
        this.failPending(ocrError('ocr_timeout', 'OCR request timed out; the isolated process was stopped'))
        child?.kill('SIGKILL')
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: text => { clearTimeout(timer); resolve(text) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      try {
        const child = this.spawn()
        child.channel?.ref()
        child.send({ protocolVersion: OCR_PROTOCOL_VERSION, id, operation: 'recognize', png, modelDir }, error => {
          if (error === null || this.child !== child || !this.pending.has(id)) return
          this.child = null
          this.failPending(ocrError('ocr_process_crash', `OCR request could not be sent: ${error.message}`))
          child.kill('SIGKILL')
        })
      } catch (error) {
        // A synchronous send/spawn failure invalidates the same channel used by
        // every queued request. Settle them all and release any started child.
        const child = this.child
        this.child = null
        this.failPending(ocrError('ocr_process_crash', error instanceof Error ? error.message : String(error)))
        child?.kill('SIGKILL')
      }
    })
  }

  /** Observe every owned child's exit before model files may be removed. */
  dispose(): Promise<void> {
    if (this.disposing !== undefined) return this.disposing
    this.child = null
    this.failPending(ocrError('ocr_failed', 'OCR process disposed'))
    this.disposing = Promise.all([...this.children].map(child => new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) { resolve(); return }
      const timer = setTimeout(() => {
        child.off('exit', done)
        reject(new Error('OCR process did not exit; model files were not removed'))
      }, EXIT_TIMEOUT_MS)
      const done = (): void => { clearTimeout(timer); resolve() }
      child.once('exit', done)
      child.kill('SIGKILL')
    }))).then(() => {}).finally(() => { this.disposing = undefined })
    return this.disposing
  }
}
