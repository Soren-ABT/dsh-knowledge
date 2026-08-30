# Issue #8: commercial-grade local reranking

## Goal

Make `local:` cross-encoder reranking reliable, diagnosable, recoverable, and
safe to use in normal searches. A rerank failure must never destroy retrieval
results or block local embedding work.

## Architecture

Local embedding remains in the existing long-lived worker thread. Local
reranking moves to a dedicated Node child process so a hung ONNX inference can
be terminated without reloading the native binding in another worker thread.
The process is lazy, serial, keeps at most one model loaded, exits on the local
model idle timeout, and is recreated after a crash or hard timeout.

IPC uses a versioned discriminated protocol. Requests and responses carry an
id and an operation (`load`, `rerank`, `self_test`, `dispose`, or `shutdown`).
The parent rejects mismatched operations, missing operation-specific fields,
late responses, non-finite values, and score-count mismatches.

The cross-encoder adapter tokenizes batched pairs with parallel inputs:

```ts
tokenizer(batch.map(() => query), {
  text_pair: batch,
  padding: true,
  truncation: true,
})
```

It accepts only one finite logit per candidate, applies a numerically stable
sigmoid, and preserves input order for equal scores. It starts at batch size 16
and reduces only for recognizable out-of-memory failures.

## Reliability policy

`localRerankTimeoutMs` defaults to 60 seconds and is clamped to 10–300 seconds.
Queue wait counts toward the deadline. The queue holds at most 16 operations;
overflow degrades immediately. An active timeout kills the rerank process.

Each model has an in-memory circuit breaker. Three consecutive runtime,
protocol, crash, or timeout failures open it for five minutes. One half-open
probe is allowed; success resets the breaker. Deterministic failures such as a
missing, unhealthy, or unsupported model do not consume the failure counter.

Search never downloads a model. Any rerank failure retains the original
retrieval order and does not apply the rerank relevance threshold. Logs include
only model id, error code, candidate count, and duration; query and document
text are never logged.

## Model lifecycle

`Xenova/bge-reranker-base` is the supported single-logit, sigmoid, 512-token
model. Custom Hugging Face rerankers may be registered through an advanced
settings action, but are marked experimental, must use a safe repository id,
must not require remote code, and must pass capability validation.

Download state and inference health are separate. A model becomes ready only
after required files exist, it loads locally, and a positive/negative self-test
returns finite, non-constant scores with the relevant text ranked first.
Successful validation writes an atomic, versioned readiness marker recording
the runtime versions and model file fingerprint. Existing caches are reused
and validated rather than downloaded again.

The model manager exposes official/experimental support, validation state,
last validation time, and latency. Downloads auto-validate, and model cards
offer a manual recheck. Cancellation stops the rerank process before partial
files are removed.

## Public contract and UI

The legacy `reranked` boolean remains. Configured searches additionally return
an optional structured `rerank` object describing provider, model, candidate
count, attempt/application state, duration, and a stable actionable error.
Statuses are `applied`, `not_needed`, or `degraded`. Errors distinguish model
installation/health, unsupported architecture, timeout, invalid response,
runtime/process failure, open circuit, queue pressure, and remote provider
failure.

The HTTP API, client types, and `knowledge_search` schema expose this object.
Recall testing shows applied latency or a yellow degradation notice. Local
model cards show support and health and provide custom registration and
self-test controls. Proactive auto-retrieval continues to skip local reranking.

## Verification

Automated tests cover tokenizer pairing, batching, output validation, IPC
dispatch, lifecycle, hard timeout/restart, queueing, circuit breaking, model id
validation, readiness records, search fallback, single/multi-query status, UI
presentation helpers, build output, and tarball contents.

An opt-in `smoke:local-rerank` command runs the real BGE model and checks score
quality and process recovery. A manual GitHub Actions job runs it on Ubuntu
with Node 22.19 and Node 24; normal push CI remains network-free.

This change does not upgrade transformers.js or onnxruntime, change the package
version, tag a release, publish npm, or address Issues #6/#7. Issue #8 remains
open until a published version passes Linux verification.
