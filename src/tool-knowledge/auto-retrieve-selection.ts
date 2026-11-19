import { clampInt } from '../knowledge/bounds.js'
import type { SearchHit } from '../knowledge/types.js'

export interface AutoRetrieveCandidate {
  readonly hit: SearchHit
  readonly score: number
  readonly evidence: string
}

const LEXICAL_MIN_SCORE = 0.12
const RERANK_MIN_SCORE = 0.3
const STRONG_SCORE_MULTIPLIER = 2
const LEAD_RATIO = 1.2
const GROUP_RATIO = 0.6
const DEFAULT_BASE_WEIGHT = 3

/** Apply relevance thresholds and per-base limits to freshly ranked evidence. */
export function selectAutoRetrieveEvidence(
  ranked: readonly AutoRetrieveCandidate[],
  scoreKind: 'lexical' | 'rerank',
  limit: number,
  weightFor: (baseId: string) => number,
): AutoRetrieveCandidate[] {
  const first = ranked[0]
  const minimum = scoreKind === 'lexical' ? LEXICAL_MIN_SCORE : RERANK_MIN_SCORE
  if (first === undefined || first.score < minimum) return []

  let groupFloor = minimum
  if (scoreKind === 'lexical') {
    // Weak lexical matches need a clear leader. Several strong chunks can
    // legitimately describe the same topic and score almost equally.
    const runnerUp = ranked[1]
    const strong = first.score >= LEXICAL_MIN_SCORE * STRONG_SCORE_MULTIPLIER
    if (runnerUp !== undefined && !strong && first.score < runnerUp.score * LEAD_RATIO) return []
    groupFloor = first.score * GROUP_RATIO
  }

  const taken = new Map<string, number>()
  const chosen: AutoRetrieveCandidate[] = []
  for (const candidate of ranked) {
    if (candidate.score < groupFloor) continue
    const id = candidate.hit.baseId
    const seats = clampInt(weightFor(id), 0, 5, DEFAULT_BASE_WEIGHT)
    const used = taken.get(id) ?? 0
    if (used >= seats) continue
    taken.set(id, used + 1)
    chosen.push(candidate)
    if (chosen.length >= limit) break
  }
  return chosen
}
