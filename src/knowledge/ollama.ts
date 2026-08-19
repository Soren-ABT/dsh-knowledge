/**
 * Ollama model management — pull models through the Ollama API with live
 * progress (NDJSON stream over POST /api/pull), list installed models
 * (GET /api/tags). Pulled models are selectable as the embedding provider
 * (provider `ollama`) and as local captioning VLMs, fully offline.
 * @module dsh-knowledge/knowledge/ollama
 */

import { httpFetch } from './net.js'

export interface OllamaPullStatus {
  status: 'idle' | 'pulling' | 'ready' | 'error'
  /** 0–100 download progress while `pulling`. */
  progress: number
  message: string
}

/** Live pull state per model name (settings poller drives the UI). */
const ollamaPullStatus = new Map<string, OllamaPullStatus>()
/** One in-flight pull per model (concurrent callers share it). */
const ollamaPullInFlight = new Map<string, Promise<void>>()
/** Abort handles for in-flight pulls (cancel support). */
const ollamaPullAborts = new Map<string, AbortController>()

/** 6h ceiling for a slow full-model pull (no per-attempt timeout in practice). */
const PULL_TIMEOUT_MS = 6 * 60 * 60_000

export function getOllamaPullStatus(model: string): OllamaPullStatus {
  return ollamaPullStatus.get(model) ?? { status: 'idle', progress: 0, message: '' }
}

function ollamaBase(baseUrl: string): string {
  return (baseUrl.trim() === '' ? 'http://127.0.0.1:11434' : baseUrl.trim()).replace(/\/+$/, '')
}

/** List models already installed in the Ollama server. */
export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const response = await httpFetch(`${ollamaBase(baseUrl)}/api/tags`, { timeoutMs: 30000 })
  if (!response.ok) throw new Error(`ollama tags failed: HTTP ${response.status}`)
  const json = (await response.json()) as { models?: Array<{ name?: string }> }
  return (json.models ?? []).map(model => model.name ?? '').filter(name => name !== '')
}

/** Delete an installed model (Ollama refuses models that are currently running). */
export async function deleteOllamaModel(model: string, baseUrl: string): Promise<void> {
  const response = await httpFetch(`${ollamaBase(baseUrl)}/api/delete`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    timeoutMs: 120000,
  })
  if (!response.ok) {
    throw new Error(`ollama delete failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
  }
}

/**
 * Pull a model from Ollama's registry with streamed progress. Idempotent per
 * model while a pull is in flight; progress is observed through
 * {@link getOllamaPullStatus}. Failures land in the status map (never
 * swallowed) and rethrow. {@link cancelOllamaPull} aborts the stream; the
 * partial download stays in Ollama's store (it resumes on the next pull).
 */
export async function pullOllamaModel(model: string, baseUrl: string): Promise<void> {
  const existing = ollamaPullInFlight.get(model)
  if (existing !== undefined) return existing
  const run = (async (): Promise<void> => {
    ollamaPullStatus.set(model, { status: 'pulling', progress: 0, message: '' })
    const controller = new AbortController()
    ollamaPullAborts.set(model, controller)
    const watchdog = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS)
    try {
      const response = await fetch(`${ollamaBase(baseUrl)}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`ollama pull failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
      }
      // NDJSON stream: { status: 'pulling'|'success'|..., total, completed }.
      // TextDecoder streaming avoids re-encoding each chunk; cancellation
      // surfaces as an AbortError from the stream iterator.
      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line === '') {
            newline = buffer.indexOf('\n')
            continue
          }
          try {
            const event = JSON.parse(line) as { status?: string; total?: number; completed?: number }
            if (event.status === 'success' || event.status === 'ready') {
              ollamaPullStatus.set(model, { status: 'ready', progress: 100, message: '' })
            } else if (typeof event.total === 'number' && event.total > 0) {
              const progress = Math.min(100, Math.round(((event.completed ?? 0) / event.total) * 100))
              ollamaPullStatus.set(model, { status: 'pulling', progress, message: event.status ?? '' })
            } else if (event.status !== undefined) {
              ollamaPullStatus.set(model, { status: 'pulling', progress: 0, message: event.status })
            }
          } catch {
            // malformed line — skip
          }
          newline = buffer.indexOf('\n')
        }
      }
      // Stream ended without a success event (some servers omit it on cached pulls).
      const current = ollamaPullStatus.get(model)
      if (current?.status !== 'ready') {
        ollamaPullStatus.set(model, { status: 'ready', progress: 100, message: '' })
      }
    } catch (error) {
      const aborted = controller.signal.aborted
      ollamaPullStatus.set(model, {
        status: aborted ? 'idle' : 'error',
        progress: 0,
        message: aborted ? '' : error instanceof Error ? error.message : String(error),
      })
      if (aborted) return
      throw error
    } finally {
      clearTimeout(watchdog)
      ollamaPullAborts.delete(model)
    }
  })()
  ollamaPullInFlight.set(model, run)
  // The finally chain must not leak a rejection: `run.finally(...)` yields a
  // NEW promise that rejects when `run` rejects (e.g. the Ollama server went
  // away mid-pull) — leaving it `void` would trigger Node's
  // unhandledRejection and kill the whole DSH process.
  void run.finally(() => { ollamaPullInFlight.delete(model) }).catch(() => {})
  return run
}

/** Abort an in-flight pull: the stream closes, the status resets to idle. */
export function cancelOllamaPull(model: string): void {
  const controller = ollamaPullAborts.get(model)
  ollamaPullStatus.set(model, { status: 'idle', progress: 0, message: '' })
  controller?.abort()
}
