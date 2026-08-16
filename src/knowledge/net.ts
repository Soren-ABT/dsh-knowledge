/**
 * Shared HTTP helpers. Node's built-in fetch (undici) ignores HTTP_PROXY /
 * HTTPS_PROXY / NO_PROXY — the reason a browser can reach a site while a
 * plugin request dies with a bare "fetch failed". `applyGlobalProxy` routes
 * EVERY global fetch in the process (including transformers.js model
 * downloads, which call the bare global fetch) through undici's
 * EnvHttpProxyAgent when a proxy is configured, and `httpFetch` adds a
 * timeout, one retry, and the real error cause chain.
 * @module dsh-knowledge/knowledge/net
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

let proxyApplied = false

/**
 * Make every `fetch()` in the process honor HTTP_PROXY / HTTPS_PROXY /
 * NO_PROXY. Safe when no proxy is configured (direct connections, unchanged
 * behavior); idempotent. Must be called before any download starts.
 */
export function applyGlobalProxy(): void {
  if (proxyApplied) return
  proxyApplied = true
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
  if (proxy === undefined || proxy.trim() === '') return
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent())
  } catch {
    // A malformed proxy env must never break plugin load — fetch stays direct.
  }
}

export interface HttpFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number
  /** Extra retries after the first failed attempt (default 1). */
  retries?: number
}

/** fetch through the global (proxy-aware) dispatcher with timeout + one retry. */
export async function httpFetch(url: string, options: HttpFetchOptions = {}): Promise<Response> {
  const { method, headers, body, timeoutMs = 30000, retries = 1 } = options
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`network request failed: ${describeNetworkError(lastError)}`)
}

/** A human-readable cause chain for a fetch/undici error. */
export function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError'
  const cause = (error as { cause?: unknown }).cause
  if (cause !== undefined) {
    const causeText = cause instanceof Error ? cause.message : String(cause)
    return timedOut ? `timeout (${causeText})` : `${error.message} (${causeText})`
  }
  return timedOut ? 'timeout' : error.message
}

/** Guidance appended to network failures surfaced in the panel. */
export const NETWORK_HINT = '若无法访问 huggingface.co：在「本地模型」页面设置镜像站（如 https://hf-mirror.com），或配置 HTTP(S)_PROXY 代理后重启服务。'
