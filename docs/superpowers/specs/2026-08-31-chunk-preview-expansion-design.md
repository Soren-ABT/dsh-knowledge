# Issue #7 Chunk Preview Expansion Design

## Problem

The document chunk preview receives complete chunk text from the existing
`listChunks` API, but `DocumentDetailPanel` always applies a two-line CSS clamp
and `overflow: hidden`. The UI provides no way to remove that clamp, so users
cannot inspect the complete content of a chunk. This is a presentation defect;
the stored chunk, retrieval index, and API response are not truncated.

## Goals

- Keep the chunk list compact by default.
- Let users reveal and read the complete text of any loaded chunk.
- Provide bulk expand and collapse controls for document-wide inspection.
- Preserve original whitespace and line breaks when a chunk is expanded.
- Keep expansion state predictable while loading more chunks and switching
  documents.
- Preserve the current API, 500-chunk incremental loading limit, chunking
  behavior, retrieval behavior, and storage schema.

## Non-goals

- Changing chunk sizes, chunk boundaries, embeddings, or retrieval ranking.
- Addressing Issue #6 or altering smart chunking.
- Fetching every chunk eagerly.
- Persisting preview expansion state across documents, sessions, or reloads.

## Interaction Design

Each chunk card remains clamped to two lines initially. Its header gains a
button that toggles the card between collapsed and expanded states. The button
uses an explicit expand/collapse label, exposes `aria-expanded`, and references
the chunk body through `aria-controls`. Expanded text removes the line clamp
and overflow restriction while retaining `white-space: pre-wrap` and the
existing word-breaking behavior.

The chunk view also gains `Expand all` and `Collapse all` controls above the
cards. The controls are hidden when there are no chunks. Existing chunk number,
heading, token count, truncation warning, scroll container, and `Load more`
behavior remain unchanged.

Chinese and English locale entries cover the per-card and bulk actions.

## State Model

Expansion state belongs to `DocumentDetailPanel` and consists of:

- `allExpanded`: whether all current and subsequently loaded chunks are
  expanded;
- `expandedChunkIds`: the individually expanded chunks when `allExpanded` is
  false.

A chunk is displayed as expanded when `allExpanded` is true or its ID appears
in `expandedChunkIds`.

State transitions are deterministic:

- Expanding one collapsed card adds its ID.
- Collapsing one individually expanded card removes its ID.
- `Expand all` sets `allExpanded` and clears individual IDs.
- `Collapse all` clears both states.
- Collapsing one card while `allExpanded` is true switches to individual mode
  and records every other currently loaded chunk as expanded.
- Chunks loaded later are automatically expanded only while `allExpanded` is
  true.
- Switching between the source preview and chunk tabs preserves state for the
  current document.
- Changing `doc.id` resets all expansion state so it cannot leak between
  documents.

The state transitions will be isolated in small pure helpers so they can be
tested without coupling tests to the full DSH panel runtime.

## Components and Data Flow

`DocumentDetailPanel` continues to receive `chunks` from the existing parent
request. No additional request is made when a card expands because every
`ChunkView` already contains its full text.

The panel owns the expansion state and passes the computed state into the card
rendering loop. The current inline card markup may remain local to the panel;
only the state-transition logic needs an isolated boundary. A stable DOM ID
derived from the chunk ID connects each toggle button to its body.

`Load more` continues to replace the loaded prefix with a larger prefix. The
expansion calculation uses chunk IDs, so existing cards keep their state even
when the array instance changes.

## Edge Cases

- Empty or lexical-only documents show the existing empty state and no bulk
  controls.
- Very long chunks expand inside the existing panel scroll container rather
  than creating a nested scrollbar.
- Original line breaks and long unbroken strings remain readable through
  `pre-wrap` and `break-word`.
- A chunk ID is treated as opaque when forming DOM IDs; it must be encoded or
  normalized rather than inserted into a CSS selector.
- If loaded chunks change while individual mode is active, unknown IDs remain
  collapsed and stale IDs have no visible effect.
- The existing server-side preview limits and chunk pagination continue to
  protect the panel from unbounded initial payloads.

## Accessibility

- Per-card toggles are real buttons and remain keyboard operable.
- Each toggle exposes the current state through `aria-expanded`.
- Each toggle has a localized accessible name and uses `aria-controls` to
  identify the corresponding chunk body.
- Bulk controls use localized visible labels and do not rely on icons alone.
- Focus styling continues to use the panel's existing button conventions.

## Testing and Verification

Automated tests cover the pure expansion transitions:

- expand and collapse one chunk;
- expand all and collapse all;
- collapse one chunk from the all-expanded state while preserving the others;
- new chunks inherit expansion only in all-expanded mode;
- resetting for a different document removes prior state.

Locale coverage verifies that all new Chinese and English keys are present.
The full repository test suite, TypeScript typecheck, and production build must
pass.

Manual UI verification uses a document containing multiple long chunks and
checks:

- collapsed cards remain two lines;
- one card can show its complete text and original line breaks;
- all loaded cards expand and collapse together;
- loading more during all-expanded mode expands the new cards;
- tab switching preserves state and document switching resets it;
- the outer panel scroll remains usable with many expanded chunks.

## Delivery

The implementation changes only client UI state, rendering, locale strings,
and focused tests. It does not change the public API or require a migration.
Issue #7 can be closed after the fix is included in a published npm version and
the packaged DSH UI has been manually verified.
