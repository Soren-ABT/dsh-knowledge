/**
 * The pure, state-free half of the context protocol: the deterministic token
 * estimate and the canonical evidence serializer. Both host bundles need these
 * values — the knowledge engine (`context.ts` composes windows) and the
 * model-facing tools (`tool-knowledge`) — so they live in their own module.
 *
 * ONE RULE: nothing stateful may be added here. Each host entry is bundled
 * separately (see build.mjs), so a stateful helper placed here would be
 * silently duplicated into both bundles as two independent module instances.
 * Anything that keeps state belongs in the engine module (`context.ts`).
 * @module dsh-knowledge/knowledge/context-protocol
 */

import type { ContextChunkExcerpt, ContextWindow } from './types.js'
import { sourceSpanLabel } from './source-spans.js'

/** CJK-heavy text costs about 1.5 chars/token and other text about 4.
 * This intentionally mirrors the service/chunker estimate and is deterministic
 * across platforms; it does not download or initialise a model tokenizer. */
export function estimateContextTokens(text: string): number {
  if (text.length === 0) return 0
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length
  const latin = text.length - cjk
  return Math.max(1, Math.ceil(cjk / 1.5 + latin / 4))
}

/** Serialize the exact evidence seen by rerank, tools, auto-preview and evals.
 * The output is always in document order; `>>>` marks (but never moves) the
 * canonical hit. */
export function serializeContextWindow(window: ContextWindow): string {
  const parts: string[] = []
  for (const excerpt of window.before) parts.push(serializeExcerpt(excerpt, false))
  parts.push(serializeExcerpt(window.anchor, true))
  for (const excerpt of window.after) parts.push(serializeExcerpt(excerpt, false))
  return parts.join('\n\n')
}

/** Serialize one excerpt exactly as it appears in the canonical window; the
 *  composer uses the same form for its budget arithmetic, so the two must not
 *  drift apart. */
export function serializeExcerpt(excerpt: ContextChunkExcerpt, anchor: boolean): string {
  const heading = excerpt.heading?.trim()
  const prefix = `${anchor ? '>>> ' : ''}${heading !== undefined && heading.length > 0 ? `[${heading}] ` : ''}`
  return `${prefix}${sourceSpanLabel(excerpt.sourceSpans)}${excerpt.text}`
}
