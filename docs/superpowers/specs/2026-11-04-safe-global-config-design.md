# Safe global retrieval settings

PR #61 adds global defaults to the existing base settings panel. A global embedding change also changes bases that inherit those fields, so it must follow the same model-change rules as a per-base update. The effective-settings summary must show saved configuration while the form contains unsaved edits.

## Model changes

Before persisting a global patch, resolve each base against the current and proposed global overrides. Fully overridden model settings and empty bases do not require indexing work. A populated base with an existing model rejects a provider or model change with rebuild guidance. A lexical-only base may enable embeddings after the existing idle and source-availability checks. Validate every affected base before saving any fields or starting any backfill; one failure preserves the previous global configuration.

Share the validation with the per-base update path. Start eligible backfills only after the global patch is stored and the process-wide model settings are reapplied. Bases that explicitly disable embeddings remain lexical. Keep the existing configuration schema, HTTP routes, DSH compatibility anchor, and storage format.

## Effective settings

Render the summary from the saved global configuration merged with the selected base's saved overrides. Form changes affect the editable controls until the parent refreshes saved configuration. A rejected save displays the backend guidance and does not report success.

## Verification

Cover inherited and partially overridden model changes, unchanged per-base models, empty bases, lexical backfill, disabled embeddings, missing sources, and active imports. Verify rejected patches preserve all global fields and do not start indexing. UI regressions cover the saved summary and rejected global model saves. Run type checking, the plugin tests, production build, retrieval benchmark, and packed-artifact verification.
