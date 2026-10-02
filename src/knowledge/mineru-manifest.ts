import type { MineruModelFile } from './mineru-deployment-types.js'

/** Fixed adapter + upstream registry, not a moving model list.
 * Metadata: official HF API, 2026-09-27. YAML uses Git blob IDs; LFS uses SHA-256.
 * Only required registry paths, excluding README/metadata. Sizes are bytes. */
export const MINERU_RUNTIME_VERSION = '4.0.6'
export const MINERU_MODEL_REPO = 'opendatalab/MinerU-4_models_onnx'
export const MINERU_MODEL_REVISION = '358310b4f64b95f9fefc372ad899356e4111f376'
export const MINERU_MODEL_DIRECTORY = 'MinerU-4_models_onnx'
export const MINERU_MODEL_METADATA_DATE = '2026-09-27'
export const MINERU_BASIC_FILES: readonly MineruModelFile[] = [
  { path: 'Layout/PP-DocLayoutV2/inference.onnx', bytes: 213963712, algorithm: 'sha256', digest: 'cd540dc296ff3115fe78efa65b68501e6a8dc74b198acc9834a725ffaa095aac' },
  { path: 'Layout/PP-DocLayoutV2/inference.yml', bytes: 1482, algorithm: 'git-sha1', digest: '5cc9ec8970c00fc1b0ca7a37824d9e09acbb451e' },
  { path: 'MFR/pp_formulanet_plus_m/PP-FormulaNet_plus-M.onnx', bytes: 591263297, algorithm: 'sha256', digest: '20a32595c2b30282dcd069e6295e9fad96115697beb66acb9b681b814006d193' },
  { path: 'MFR/pp_formulanet_plus_m/PP-FormulaNet_plus-M_inference.yml', bytes: 2244564, algorithm: 'git-sha1', digest: '88ab97b97b97567d5b71d418115f49e449c7c07c' },
  { path: 'OCR/paddleocr/ch_PP-OCRv6_small_rec_infer.onnx', bytes: 21159378, algorithm: 'sha256', digest: '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634' },
  { path: 'OCR/paddleocr/ch_PP-OCRv6_small_rec_inference.yml', bytes: 150752, algorithm: 'git-sha1', digest: '6eece2c57a185b5a1bfef8b53d2d4d6cb4c526fa' },
  { path: 'OCR/paddleocr/ch_PP-OCRv6_tiny_det_infer.onnx', bytes: 1780590, algorithm: 'sha256', digest: '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8' },
  { path: 'OCR/paddleocr/ch_PP-OCRv6_tiny_det_inference.yml', bytes: 1068, algorithm: 'git-sha1', digest: '0bd33a4c87de36ba27c7de81ab7c2928647010b4' },
  { path: 'OCR/paddleocr/seal_PP-OCRv4_det_infer.onnx', bytes: 4769171, algorithm: 'sha256', digest: '3e190df84542c2756975febe8f73603b587a23c7f7badfdd3fc8a986540d5bc0' },
  { path: 'OCR/paddleocr/seal_PP-OCRv4_det_inference.yml', bytes: 711, algorithm: 'git-sha1', digest: 'ad9d0da9027cbf818c67e7f8535cf2abcd6cbc85' },
  { path: 'Table/PP-LCNet_x1_0_table_cls.onnx', bytes: 6776877, algorithm: 'sha256', digest: 'c84bf1d79c1c74d534b5b12adb14dd12151c42f7ae3e4be4f1042b830f80b949' },
  { path: 'Table/slanet-plus.onnx', bytes: 7758305, algorithm: 'sha256', digest: 'd57a942af6a2f57d6a4a0372573c696a2379bf5857c45e2ac69993f3b334514b' },
  { path: 'Table/unet.onnx', bytes: 8335007, algorithm: 'sha256', digest: '0ea48d3a17e35ef5c2e498a5e799566073234d39b1079ca21d9f4fafe73c6d20' },
]
