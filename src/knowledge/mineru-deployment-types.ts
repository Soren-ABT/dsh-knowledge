/** Serializable management contracts; safe for use by the browser bundle. */
export interface MineruModelFile {
  path: string
  bytes: number
  digest: string
  algorithm: 'sha256' | 'git-sha1'
}

export interface MineruPythonEnvironment {
  executable: string
  source: string
  version?: string
  implementation?: string
  architecture?: string
  bits?: number
  venv?: boolean
  ensurepip?: boolean
  eligible: boolean
  reason?: 'probe_failed' | 'version_unsupported' | 'implementation_unsupported' | 'architecture_unsupported' | 'prerelease' | 'free_threaded' | 'venv_missing' | 'ensurepip_missing'
  fingerprint?: string
}
export interface MineruPythonDiscovery { environments: MineruPythonEnvironment[]; truncated: boolean }
export interface MineruValidationSteps { interpreter: boolean; environment: boolean; dependencies: boolean; inference: boolean }

export type MineruDeploymentPhase = 'absent' | 'preparing_environment' | 'downloading' | 'probing' | 'ready' | 'failed' | 'canceled' | 'interrupted'
export interface MineruDeploymentStatus {
  root?: string
  operationId?: string
  phase: MineruDeploymentPhase
  service: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  active: boolean
  completedBytes?: number
  totalBytes?: number
  file?: string
  verifiedAt?: number
  endpoint?: string
  error?: { code: string; message: string }
  python?: MineruPythonEnvironment
  validation?: MineruValidationSteps
}
export interface MineruCapacity {
  totalBytes: number
  verifiedReusableBytes: number
  downloadBytes: number
  /** Conservative extra model space; does not pretend to include Python dependencies. */
  modelPeakAdditionalBytes: number
  runtimeDownloadBytes: number | null
  runtimeInstalledBytes: number | null
  freeBytes: number | null
}
export interface MineruDeploymentPlan {
  id: string
  expiresAt: number
  root: string
  modelRoot: string
  externalModels: boolean
  tier: 'basic'
  backend: 'onnx'
  runtimeVersion: string
  modelRepo: string
  /** Resolved and validated host setting; contains no credentials or query string. */
  modelEndpoint: string
  pythonIndexUrl: string
  modelRevision: string
  metadataDate: string
  capacity: MineruCapacity
  files: Array<MineruModelFile & { reusable: boolean }>
  warnings: string[]
  blockers: string[]
  python?: MineruPythonEnvironment
}
