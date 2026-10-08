/** Runtime that must validate cached embedding/rerank weights before use.
 * Keep this aligned with the pinned Transformers dependency and its own ONNX
 * runtime (the OCR runtime is a separate dependency/process). */
export const LOCAL_MODEL_RUNTIME = Object.freeze({
  transformers: '4.3.1',
  onnxruntime: '1.30.0',
} as const)
