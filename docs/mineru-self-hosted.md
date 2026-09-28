# MinerU self-hosted document processing

This integration is optional. Installing the npm plugin does not install Python,
CUDA, MinerU, or model weights. Existing built-in parsing and explicitly configured
MinerU cloud API settings continue to work.

## Managed Basic preview / 托管 Basic 实验性入口

Settings → Local models now includes an explicit preparation flow. Choose a
dedicated installation directory, optionally verify an existing MinerU ONNX model
directory, inspect the capacity plan, then confirm installation. Nothing installs
on page load. The workflow prepares a separate Python environment, downloads a
pinned model revision, verifies every file and parses a synthetic public PDF before
granting readiness. Start the service separately; **Use as global default parser**
is also a separate action. Per-base overrides continue to take precedence.

当前边界：仅 Basic/ONNX，检测稳定版 64 位 CPython 3.10–3.14（非自由线程版，需 venv/ensurepip）。支持 PATH、Python launcher、Conda 注册表及有限常见目录发现，也可手动指定解释器绝对路径。不会下载 Python、安装 CUDA
或修改全局 Python 包。真实模型安装/推理与三平台验收仍未完成，因此标为实验性。

模型文件固定为 13 项，合计 **858,204,914 bytes（约 818.4 MiB）**；这不包含 Python 环境及其依赖。设置中的 `hfEndpoint` 镜像会用于模型下载，托管 Python 包源单独配置，默认 `https://pypi.org/simple`。预检会冻结并显示实际来源，来源发生变化后需要重新预检。无论是否使用镜像，模型 revision、文件大小和摘要校验都不会改变。

检测不会安装依赖；通过检测仅表示可尝试创建隔离环境，不等于 MinerU 可用。
安装预检绑定解释器指纹，安装前再次检查；解释器变化则拒绝继续，不自动切换到其他环境。
解释器、隔离环境、依赖安装、真实解析分别记录验证结果。
Standard/Advanced 继续通过已有外部服务使用，本入口不宣称已支持其托管部署。

- Model metadata: `opendatalab/MinerU-4_models_onnx`, revision
  `358310b4f64b95f9fefc372ad899356e4111f376`, required files pinned with hashes.
- Runtime: `mineru==4.0.6` from the configured Python package index (official
  PyPI by default). Transitive Python dependencies are resolved at installation
  time, not a fully locked reproducible environment. Runtime
  download/installed sizes remain unknown, separately from exact model bytes.
- Existing external model files are verified and copied; their source directory
  stays read-only. Copies require additional space even when network transfer is zero.
- Network failures and explicit cancellation retain verified files and resumable
  parts. Retry requires a fresh plan. Each candidate uses its own environment and
  config. The active-install pointer changes only after the candidate passes the
  real parse probe; a failed retry leaves the previous verified install usable.
- Preparation is a service-owned background task; closing the panel does not cancel
  it. State is stored in the chosen directory, and a private pointer permits panel
  reopening/restart discovery. Restart never silently installs or starts a service.
- Managed API listens only on `127.0.0.1:18879`. MinerU's documented local V1
  server startup does not expose CLI API-key authentication, so the managed
  service has no bearer key and is intentionally loopback-only. Do not expose it
  through a public bind or reverse proxy without adding a separately secured gateway.
  Port conflicts fail without killing the process occupying the port. Stop before
  switching installations; stop interrupts any running parsing jobs on this service.
- Management endpoints require a loopback-bound DSH web host, local peer, loopback
  Host and same-origin management header. Network-bound hosts and Electron IPC
  without a real local socket deliberately cannot invoke installation.
- Hard crashes retain the installation lock: native descendant ownership cannot
  safely be inferred from a stale PID. Reconciliation is currently manual; do not
  remove `.operation.lock` until the owning host and its descendants are confirmed
  stopped. No automatic lock stealing or PID-by-port killing is performed.

This preview does not yet include managed Python bootstrap, Standard model cards,
download-only mode, automatic hard-crash reconciliation, uninstall/rollback UI,
or measured runtime/staging footprint. These remain follow-up work rather than
claims of completed functionality. Runtime dependency size is still unknown until
measured on each supported platform. Managed real-install acceptance has not yet
been run; Python detection and offline tests do not certify a platform.

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

Maintainers can run the opt-in `Managed MinerU smoke` workflow from GitHub Actions
with the `mineru_managed_smoke` input. It performs a clean runtime install, checks
the pinned model files, runs the synthetic PDF parse during preparation, then
repeats parsing after a service stop/start. It records the tested OS, Node/Python,
MinerU/model revisions and packed tarball SHA-256. This small fixture validates
installation and lifecycle; it does not certify scanned-PDF or table OCR quality.

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
