import { snapSliceEnd, snapSliceStart } from '../knowledge/text-safety.js'

/** How many prior user messages the short-follow-up query planner may consult. */
export const AUTO_RETRIEVE_CONTEXT_TURNS = 2

interface AutoRetrieveQueryPlan {
  readonly primary: string
  readonly enhanced?: string
}

export interface StrictIdentifier {
  readonly value: string
  readonly kind: 'numeric' | 'compound'
}

const FOLLOW_UP_SIGNAL = /(?:那|这个|那个|它|上述|前面|后面|接着|然后|继续|呢)|第\s*[一二三四五六七八九十百千万\d]+\s*步|\b(?:that|this|it|those|these|above|previous|next|continue|then)\b/i
const IDENTIFIER_TOKEN_CHAR = /[\p{L}\p{N}_.:/-]/u
const IDENTIFIER_WORD_CHAR = /[\p{L}\p{N}_]/u

/** Current-turn-first query planning. A second history-enhanced variant is
 * created only for short/deictic turns; KnowledgeService performs RRF over the
 * primary and enhanced lexical rankings. */
export function planAutoRetrieveQueries(
  text: string,
  contextText: string | readonly string[] | undefined,
): AutoRetrieveQueryPlan {
  const cleaned = cleanRetrieveQuery(text)
  // A pronoun-only follow-up may be entirely removed by stopword cleaning
  // (for example "it?"). Keep a bounded alphanumeric/CJK form as the current
  // primary so history can augment it without replacing the user's message.
  const primary = cleaned.length > 0
    ? cleaned
    : boundQueryChars((text.match(/[a-z0-9\u4e00-\u9fff]+/gi) ?? []).join(' '), 200)
  const topicCount = topicKeywords(retrieveKeywords(primary)).length
  // The 40-character gate applies to the actual current message, not its
  // punctuation/stopword-stripped search form. A long turn must never become
  // history-dependent merely because cleaning made it look short.
  const needsHistory = text.trim().length <= 40 && (FOLLOW_UP_SIGNAL.test(text) || topicCount < 2)
  if (!needsHistory || contextText === undefined) return { primary }

  let history: string[]
  if (typeof contextText === 'string') {
    let raw = contextText.trim()
    const current = text.trim()
    if (current.length > 0 && raw.endsWith(current)) raw = raw.slice(0, -current.length).trim()
    history = raw.length > 0 ? [raw] : []
  } else {
    history = [...contextText].slice(-AUTO_RETRIEVE_CONTEXT_TURNS)
  }

  let enhanced = primary
  for (const raw of history.reverse()) {
    const cleaned = cleanRetrieveQuery(raw)
    if (cleaned.length === 0 || cleaned === primary) continue
    const remaining = 200 - enhanced.length - 1
    if (remaining <= 0) break
    const addition = boundQueryChars(cleaned, remaining)
    if (addition.length > 0) enhanced += ` ${addition}`
  }
  return enhanced !== primary ? { primary, enhanced } : { primary }
}

/** Longest explicit base name wins. CJK names use natural substring matching;
 * latin/id-like names require token boundaries so `docs` does not capture
 * `docs-private`. */
export function findNamedBase<T extends { readonly id: string; readonly name: string }>(bases: readonly T[], text: string): T | undefined {
  return [...bases]
    .filter(base => base.name.trim().length > 0 && containsBaseName(text, base.name))
    .sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name))[0]
}

function containsBaseName(text: string, name: string): boolean {
  const haystack = text.toLowerCase()
  const needle = name.trim().toLowerCase()
  if (needle.length === 0) return false
  if (/[^\x00-\x7f]/.test(needle)) return haystack.includes(needle)
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    const before = index > 0 ? haystack[index - 1] : undefined
    const afterIndex = index + needle.length
    const after = afterIndex < haystack.length ? haystack[afterIndex] : undefined
    if ((before === undefined || !IDENTIFIER_TOKEN_CHAR.test(before))
      && (after === undefined || !IDENTIFIER_TOKEN_CHAR.test(after))) return true
    index = haystack.indexOf(needle, index + 1)
  }
  return false
}

/** Strict identifiers are the only non-language signal allowed to trigger an
 * automatic search. Pure numbers must be 6–32 digits; model/version/error-code
 * tokens must be 3–64 ASCII token characters and contain a digit. */
function extractStrictIdentifiers(text: string): StrictIdentifier[] {
  const found: StrictIdentifier[] = []
  const numeric = /\d{6,32}/g
  for (const match of text.matchAll(numeric)) {
    const value = match[0]
    const index = match.index
    const before = index > 0 ? text[index - 1] : undefined
    const after = index + value.length < text.length ? text[index + value.length] : undefined
    if ((before === undefined || !IDENTIFIER_WORD_CHAR.test(before))
      && (after === undefined || !IDENTIFIER_WORD_CHAR.test(after))) {
      found.push({ value, kind: 'numeric' })
    }
  }
  // Tokenize the whole compound first, then enforce the length. A bounded
  // regex alone would incorrectly accept the first 64 characters of a longer
  // attacker-controlled token.
  for (const token of text.match(/[A-Za-z0-9][A-Za-z0-9._:/-]*[A-Za-z0-9]/g) ?? []) {
    if (token.length < 3 || token.length > 64 || !/\d/.test(token) || /^\d+$/.test(token)) continue
    if (/^(?:https?|ftp):\/\//i.test(token) || /^www\./i.test(token)) continue
    found.push({ value: token, kind: 'compound' })
  }
  const seen = new Set<string>()
  return found.filter(identifier => {
    const key = `${identifier.kind}:${identifier.value.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function containsStrictIdentifier(text: string, identifier: StrictIdentifier): boolean {
  const haystack = text.toLowerCase()
  const needle = identifier.value.toLowerCase()
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    const before = index > 0 ? haystack[index - 1] : undefined
    const afterIndex = index + needle.length
    const after = afterIndex < haystack.length ? haystack[afterIndex] : undefined
    if (identifierBoundary(haystack, index - 1, before, identifier.kind, 'before')
      && identifierBoundary(haystack, afterIndex, after, identifier.kind, 'after')) return true
    index = haystack.indexOf(needle, index + 1)
  }
  return false
}

function identifierBoundary(
  text: string,
  index: number,
  char: string | undefined,
  kind: StrictIdentifier['kind'],
  side: 'before' | 'after',
): boolean {
  if (char === undefined) return true
  if (IDENTIFIER_WORD_CHAR.test(char)) return false
  if (kind === 'numeric' || !/[.:/-]/.test(char)) return true
  const outward = side === 'before' ? text[index - 1] : text[index + 1]
  return outward === undefined || !IDENTIFIER_WORD_CHAR.test(outward)
}

/** Common conversational filler that carries no retrieval signal (English words,
 *  Chinese interjections/fronters — whole-token matches only, no segmentation). */
const RETRIEVE_STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'is', 'are', 'was', 'were',
  'be', 'been', 'it', 'this', 'that', 'with', 'from', 'by', 'as', 'about', 'what', 'how', 'why',
  'when', 'where', 'which', 'who', 'can', 'could', 'should', 'would', 'please', 'help', 'tell',
  'know', 'want', 'look', 'find', 'search', 'explain', 'describe', 'me', 'you', 'my', 'your',
  'our', 'their', 'i', 'we', 'they', 'he', 'she', 'do', 'does', 'did', 'have', 'has', 'had', 'if',
  'then', 'also', 'just', 'like', 'say', 'said', 'see', 'get', 'make',
  '请问', '帮我', '一下', '知道', '我想', '我问', '看看', '查查', '这个', '那个', '我们', '你们', '他们',
])

/** Tokenize into latin words (≥2 chars, stopword-filtered) plus CJK bigrams —
 *  Chinese has no word boundaries, so bigrams keep the query's signal without
 *  a segmenter. */
function retrieveKeywords(text: string): string[] {
  const out: string[] = []
  for (const segment of text.split(/[^a-z0-9\u4e00-\u9fff]+/i)) {
    if (segment.length === 0) continue
    if (/^[a-z0-9]+$/i.test(segment)) {
      const lower = segment.toLowerCase()
      if (lower.length >= 2 && !RETRIEVE_STOPWORDS.has(lower)) out.push(lower)
      continue
    }
    const runs = segment.match(/[\u4e00-\u9fff]+/g) ?? []
    for (const run of runs) {
      if (run.length === 1) continue
      if (run.length === 2) out.push(run)
      else for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2))
    }
  }
  return [...new Set(out)]
}

/** Generic CJK bigrams with no topic signal (question tails, filler) — the
 *  topic-aware throttle must ignore these, or '制度是什么' vs '流程是什么'
 *  would share '什么' and read as the same topic. Also covers spoken filler
 *  (好的/收到/哈哈…) so a pure-acknowledgement message carries no retrieval
 *  signal and never triggers a search. */
const RETRIEVE_GENERIC_BIGRAMS = new Set([
  '什么', '是什', '怎么', '么样', '如何', '为什', '哪个', '哪些', '哪里', '怎样',
  '这样', '那样', '这个', '那个', '一下', '请问', '帮我', '知道', '应该', '可以', '需要',
  '好的', '收到', '谢谢', '哈哈', '嗯嗯', '呵呵', '嘻嘻', '嘿嘿', '哦哦', '啊啊', '嗯呢',
  '好吧', '是的', '没错', '对啊', '对呀', '是吗', '明白', '了解', '行吧', '算了', '没事',
  '再见', '拜拜', '早安', '晚安', '加油', '辛苦', '感谢', '客气', '不错', '挺好',
])

/** Topic signal of a query: keywords minus generic bigrams. */
function topicKeywords(keywords: string[]): string[] {
  return keywords.filter(keyword => !RETRIEVE_GENERIC_BIGRAMS.has(keyword))
}

/** True when a CJK run is a single unit repeated (哈哈哈哈, 好的好的好的,
 *  哈哈哈…): pure spoken filler. Its cross-boundary bigrams (好的/的好) would
 *  otherwise form a bogus topic signal and could retrieve a chunk that merely
 *  contains the filler word. */
function isRepetitiveRun(run: string): boolean {
  if (run.length < 4) return false
  const chars = [...run]
  if (chars.every(ch => ch === chars[0])) return true
  const pair = run.slice(0, 2)
  if (run.length % 2 === 0 && run === pair.repeat(run.length / 2)) return true
  const triple = run.slice(0, 3)
  if (run.length % 3 === 0 && run === triple.repeat(run.length / 3)) return true
  return false
}

/** Build the BM25 query: drop English stopwords but keep CJK runs WHOLE — the
 *  FTS lane matches CJK via trigram windows (OR'd), so splitting Chinese into
 *  space-separated bigrams would turn them into AND'd LIKE filters and make
 *  the query implausibly strict. */
export function cleanRetrieveQuery(text: string): string {
  const parts: string[] = []
  for (const segment of text.split(/[^a-z0-9\u4e00-\u9fff]+/i)) {
    if (segment.length === 0) continue
    if (/^[a-z0-9]+$/i.test(segment)) {
      const lower = segment.toLowerCase()
      if (lower.length >= 2 && !RETRIEVE_STOPWORDS.has(lower)) parts.push(lower)
    } else {
      parts.push(segment)
    }
  }
  for (const identifier of extractStrictIdentifiers(text)) {
    if (!parts.some(part => part.toLowerCase() === identifier.value.toLowerCase())) parts.push(identifier.value)
  }
  return boundQueryChars(parts.join(' '), 200)
}

/** Preserve the intent-bearing beginning and usually-specific tail of an
 * oversized query instead of letting previous/history text erase the current
 * question. */
function boundQueryChars(text: string, maxChars: number): string {
  const normalized = text.trim()
  if (normalized.length <= maxChars) return normalized
  if (maxChars <= 2) return normalized.slice(0, snapSliceEnd(normalized, maxChars))
  const head = Math.min(120, Math.ceil((maxChars - 1) * 0.6))
  const tail = maxChars - head - 1
  const headEnd = snapSliceEnd(normalized, head)
  const tailStart = snapSliceStart(normalized, normalized.length - tail)
  return `${normalized.slice(0, headEnd)} ${normalized.slice(tailStart)}`
}

/** True when at least one query keyword appears in the hit text. */
export function sharesKeywords(query: string, hitText: string): boolean {
  const keywords = retrieveKeywords(query)
  if (keywords.length === 0) return true
  const lowerHit = hitText.toLowerCase()
  return keywords.some(keyword => lowerHit.includes(keyword))
}

export function queryFocusRange(text: string, query: string): { start: number; end: number } | undefined {
  const haystack = text.toLowerCase()
  const exact = query.trim().toLowerCase()
  if (exact.length > 0) {
    const index = haystack.indexOf(exact)
    if (index >= 0) return { start: index, end: index + exact.length }
  }
  const terms = [
    ...extractStrictIdentifiers(query).map(identifier => identifier.value),
    ...topicKeywords(retrieveKeywords(query)),
    ...(query.match(/[\p{L}\p{N}_./:-]{2,}/gu) ?? []),
  ].sort((a, b) => b.length - a.length)
  for (const term of terms) {
    const index = haystack.indexOf(term.toLowerCase())
    if (index >= 0) return { start: index, end: index + term.length }
  }
  return undefined
}

export function retrievalIntent(text: string, queryPlan: AutoRetrieveQueryPlan) {
  const currentQuery = queryPlan.primary
  // Topic signal excludes generic bigrams ('什么' shared by every question
  // tail would otherwise make unrelated topics look like follow-ups).
  const currentTopicSignal = topicKeywords(retrieveKeywords(currentQuery))
  // Signal gate: a message must carry language intent or a strict identifier.
  // Pure filler and short random digits never search; 6–32 digit ids and
  // bounded model/version/error tokens search only through the exact-match
  // evidence gate below.
  const topicSignal = queryPlan.enhanced === undefined
    ? currentTopicSignal
    : topicKeywords(retrieveKeywords(queryPlan.enhanced))
  const gateTopicSignal = queryPlan.enhanced !== undefined && FOLLOW_UP_SIGNAL.test(text)
    ? topicSignal
    : currentTopicSignal
  const hasCjkSignal = gateTopicSignal.some(keyword => /[\u4e00-\u9fff]/.test(keyword))
  const hasWordSignal = gateTopicSignal.some(keyword => /^[a-z]{3,}$/i.test(keyword))
  const identifiers = extractStrictIdentifiers(text)
  // Repetitive filler (好的好的好的, 哈哈哈哈哈) has no retrieval intent even
  // though its cross-boundary bigrams would pass the CJK-signal check above.
  const runs = currentQuery.match(/[\u4e00-\u9fff]+/g) ?? []
  const fillerOnly = runs.length > 0 && runs.every(run => isRepetitiveRun(run))
  if ((gateTopicSignal.length === 0 || (!hasCjkSignal && !hasWordSignal)) && identifiers.length === 0) return undefined
  if (fillerOnly) return undefined
  return { topicSignal, identifiers }
}
