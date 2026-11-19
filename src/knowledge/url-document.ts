import { isIP } from 'node:net'
import { httpFetch } from './net.js'
import { extractHtmlDocument } from './parse.js'
import { readResponseBytes } from './response-body.js'

const MAX_URL_BYTES = 8 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000

/** The URL policy checks names and literal addresses at every redirect.
 * Resolution of allowed names uses the host's resolver. */
const BLOCKED_URL_HOSTS = new Set([
  'localhost',
  '0.0.0.0',
  'metadata.google.internal',
])

/** Private, loopback, link-local, CGNAT, benchmarking, multicast and reserved
 *  IPv4 space: none of it is a legitimate target for a document-supplied URL. */
function isBlockedIpv4(host: string): boolean {
  const parts = host.split('.').map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const a = parts[0]!
  const b = parts[1]!
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 192 && b === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

/** Loopback, unspecified, unique-local, link-local and multicast IPv6, plus the
 *  forms that reach the IPv4 stack (IPv4-mapped, in both notations). */
function isBlockedIpv6(host: string): boolean {
  if (host === '::' || host === '::1') return true
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  if (mappedDotted !== null) return isBlockedIpv4(mappedDotted[1]!)
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (mappedHex !== null) {
    const high = Number.parseInt(mappedHex[1]!, 16)
    const low = Number.parseInt(mappedHex[2]!, 16)
    return isBlockedIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
  }
  const firstGroup = host.split(':').find(part => part.length > 0)
  const first = firstGroup === undefined ? 0 : Number.parseInt(firstGroup, 16)
  if (Number.isNaN(first)) return true
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

function isBlockedUrlHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (BLOCKED_URL_HOSTS.has(host) || host.endsWith('.localhost')) return true
  const family = isIP(host)
  if (family === 4) return isBlockedIpv4(host)
  if (family === 6) return isBlockedIpv6(host)
  // Named hosts keep the documented posture: the resolver is trusted, so only
  // the explicit deny-list above applies.
  return false
}

function documentFormat(url: URL, type: string): 'html' | 'markdown' {
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type === 'text/markdown' || type === 'text/x-markdown') return 'markdown'
  if (/\.(?:md|markdown)$/i.test(url.pathname) && ['', 'text/plain', 'application/octet-stream'].includes(type)) return 'markdown'
  if (type === '') return 'html' // Legacy servers that omit the header.
  throw new Error(`Expected an HTML page or Markdown document (content-type: ${type})`)
}

/** Fetch and extract one snapshot for both import and refresh. The time
 * budget covers every redirect, retry and body read. */
export async function fetchUrlDocument(url: string, external: AbortSignal): Promise<{ title: string; text: string }> {
  const signal = AbortSignal.any([external, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
  let current: URL
  try { current = new URL(url) } catch { throw new Error('invalid URL') }
  for (let hop = 0; hop <= 5; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error(`URL protocol not allowed: ${current.protocol}`)
    if (isBlockedUrlHost(current.hostname)) throw new Error(`URL host not allowed: ${current.hostname}`)
    const response = await httpFetch(current.toString(), {
      method: 'GET', headers: { 'user-agent': 'dsh-knowledge/0.1 (+knowledge-base-import)' },
      signal, redirect: 'manual',
    })
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location) throw new Error(`URL redirect without Location (HTTP ${response.status})`)
        current = new URL(location, current)
        continue
      }
      if (!response.ok) throw new Error(`URL fetch failed: HTTP ${response.status}`)
      const type = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
      const format = documentFormat(current, type)
      const bytes = await readResponseBytes(response, MAX_URL_BYTES, signal, () => new Error('URL document exceeds the 8 MiB limit'))
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: format === 'markdown' }).decode(bytes) }
      catch { throw new Error('Markdown URL must contain UTF-8 text') }
      if (format === 'markdown' && text.includes('\0')) throw new Error('Markdown URL contains binary data')
      const extracted = format === 'markdown' ? { title: '', text } : await extractHtmlDocument(text)
      signal.throwIfAborted()
      if (!extracted.text.trim()) throw new Error('URL returned no extractable text')
      return extracted
    } finally {
      // Redirects and rejected MIME/status responses may still own a connection.
      if (!response.bodyUsed) await response.body?.cancel().catch(() => {})
    }
  }
  throw new Error('URL redirect limit exceeded')
}
