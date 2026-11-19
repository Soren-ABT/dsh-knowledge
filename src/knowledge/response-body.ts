/** Bound the actual decoded response bytes even when the declared length is absent or incorrect. */
export async function readResponseBytes(
  response: Response, maximum: number, signal: AbortSignal, tooLarge: () => Error,
): Promise<Uint8Array> {
  signal.throwIfAborted()
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  let bytes = new Uint8Array(0)
  let size = 0
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      const end = size + value.byteLength
      if (end > maximum) throw tooLarge()
      if (end > bytes.byteLength) {
        const larger = new Uint8Array(Math.min(maximum, Math.max(end, bytes.byteLength * 2)))
        larger.set(bytes)
        bytes = larger
      }
      bytes.set(value, size)
      size = end
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return bytes.subarray(0, size)
}
