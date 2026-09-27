# MinerU self-hosted document processing

This integration is optional. The npm plugin does not install Python, CUDA,
MinerU, or model weights. Existing built-in parsing and explicitly configured
MinerU cloud API settings continue to work.

### Keep the existing cloud API / 继续使用现有云 API

You do not need to deploy a local service to keep using MinerU. Select the
existing cloud provider (`mineru`) and save its API host and API key in settings.
Do not paste cloud credentials into the local-service token field. Cloud parsing
uploads the selected document; local/self-hosted parsing is a separate opt-in.

The legacy cloud adapter currently returns text. Artifact reuse and revision-bound
reading apply to it, but page geometry and structured table/image provenance are
only available when a provider actually returns those fields. The new local V1
adapter's structural capabilities must not be advertised as verified cloud API
capabilities. No real inference endpoint was available during local validation.

## Configure / 配置

Deploy a MinerU **4.x V1 HTTP service**, then select **local/self-hosted MinerU**
in the knowledge-base processing settings. This adapter targets the 4.0.6 V1
contract and `docvortex.middle` 2.0 output; incompatible versions fail validation.

| Setting | Purpose |
| --- | --- |
| `mineruLocalUrl` | Saved HTTP(S) service endpoint; default `http://127.0.0.1:8000` |
| `mineruLocalApiKey` | Optional service bearer token, independent of the cloud key |
| `mineruTier` | `basic` by default; the service must advertise the selected tier |
| `documentProcessingTimeoutMs` | Whole processing budget, including queue wait; default 30 minutes |
| `structuredChunking` | Preserve structural table/header/formula boundaries for structured results |

Save settings before using **Check connection**. The check reads health and
capabilities; it does not upload a document or prove inference/model readiness.
Use the official deployment instructions for your hardware; an 8 GB laptop GPU
does not guarantee every tier will fit. Do not expose an unauthenticated server
to the public internet.

## Data flow / 数据与隐私

PDF bytes go to the service you selected and its advertised upload destination.
Self-hosting on another machine is still a network transfer, not on-device
processing. Service credentials are not forwarded to a different storage origin.
There is **no automatic fallback from local MinerU to the cloud API**. A local
processing failure can fall back to built-in local parsing, with a visible warning.
Explicit image-caption settings may independently contact their selected provider.

Archives and text are bounded. Paths, schema, resource identities and response
envelopes are validated. Untrusted HTML is not rendered as active content; remote
image references are not fetched. PNG/JPEG/WebP/GIF evidence is served through a
document/revision-scoped route. Logs do not include document text or credentials.

## Evidence and rebuild / 证据与重建

- Synchronization compares live files and updates changed sources.
- Reparse uses the selected processor again and can submit a new MinerU job.
- Rechunk reuses the saved parsing artifact; it does not submit to MinerU again.
- Every published generation links chunks to its own immutable evidence revision.
- Page indices are zero-based in APIs and displayed as page 1, 2, … in the UI.
- Bounding boxes describe source blocks, not glyph-level highlight selections.
- `textStart` / `textEnd` are UTF-16 positions in canonical parsed text, not PDF bytes.
- Built-in/legacy-cloud extraction can report completeness as `unknown`; missing
  geometry is not fabricated. Old documents need not be automatically reprocessed.

Canceling stops queued/local work and makes a bounded best-effort request to
cancel a known server job. It does not guarantee an inference already executing
on that server has stopped. Unknown POST outcomes are not blindly retried.
MinerU may lose job IDs on restart; explicitly reparse after a `job_lost` error.

Artifacts live beside the chunk database in `knowledge-artifacts`. Live, staged,
and recoverable job revisions are protected. Startup removes unreferenced
revisions older than seven days for existing documents; deleting a document
removes its artifacts. SQLite publication and DomainKV metadata updates use a
recovery journal, not a claimed cross-database atomic transaction.

## Verification / 验证

`npm run benchmark:structured` runs deterministic offline protocol, storage,
chunk/source mapping and evidence-continuation tests. These tests do **not** measure
real OCR accuracy. `npm run benchmark` retains the existing 40-question benchmark.

For opt-in real inference in PowerShell:

```powershell
$env:MINERU_SMOKE_URL = 'http://127.0.0.1:8000'
$env:MINERU_SMOKE_TIER = 'basic'
npm run smoke:mineru-local
```

This sends only a generated synthetic one-page PDF, never a personal file. It
checks exact quantity/unit, a negative formula term and page/block provenance.
Repeat with a supported tier to verify that deployment. Real multi-column,
scanned, merged-cell and long-document quality still requires representative
gold documents; a smoke pass is not a universal quality claim.

## Upstream and licensing

Document understanding is provided by [MinerU](https://github.com/opendatalab/MinerU),
not a reimplementation of its models. See the official
[HTTP API](https://opendatalab.github.io/MinerU/usage/http_api/),
[output format](https://opendatalab.github.io/MinerU/reference/output_files/) and
[tier guidance](https://opendatalab.github.io/MinerU/usage/tiers/).
Review the pinned [MinerU 4.0.6 license](https://github.com/opendatalab/MinerU/blob/mineru-4.0.6-released/LICENSE.md)
and separate model/runtime terms before deployment. MinerU's Apache-based terms
contain additional conditions; do not describe them as unqualified Apache-2.0.
This plugin does not redistribute the Python engine or model weights.
