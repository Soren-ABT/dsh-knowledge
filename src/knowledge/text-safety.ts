/**
 * Surrogate-aware UTF-16 slicing and model text normalization. Code-unit
 * cuts must preserve valid pairs; isolated surrogates can be rejected by
 * providers and persist in session history. Keep this module pure because
 * both host bundles import it.
 * @module dsh-knowledge/knowledge/text-safety
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/** Move a slice start off an orphaned low surrogate. Shrink-only, so a slice
 *  that already respects a token budget keeps respecting it. */
export function snapSliceStart(text: string, index: number): number {
  return index > 0 && index < text.length
    && isHighSurrogate(text.charCodeAt(index - 1))
    && isLowSurrogate(text.charCodeAt(index))
    ? index + 1
    : index
}

/** Move a slice end off an orphaned high surrogate. Shrink-only, so a slice
 *  that already respects a token budget keeps respecting it. */
export function snapSliceEnd(text: string, index: number): number {
  return index > 0 && index < text.length
    && isHighSurrogate(text.charCodeAt(index - 1))
    && isLowSurrogate(text.charCodeAt(index))
    ? index - 1
    : index
}

/** Exit guard for model-visible text: replace any lone surrogate with U+FFFD.
 *  Length-preserving, so budget arithmetic stays valid. */
export function ensureWellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, '\uFFFD')
}
