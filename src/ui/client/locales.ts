/**
 * Dictionary for the knowledge panel (zh / en). Keys are used as
 * `t('nav')` through the locale service's bound translate.
 * @module dsh-knowledge/client/locales
 */

export type KnowledgeKey =
  | 'mineruLocalOption' | 'mineruLocalDesc' | 'mineruLocalUrl' | 'mineruLocalKey'
  | 'mineruTier' | 'mineruFlash' | 'mineruBasic' | 'mineruStandard' | 'mineruAdvanced'
  | 'processorCheck' | 'processorChecking' | 'processorCheckSaved' | 'processorCheckSuccess'
  | 'processingTimeout' | 'structuredChunking' | 'structuredChunkingHint'
  | 'processingInfo' | 'processingComplete' | 'processingPartial' | 'processingUnknown' | 'processingReused'
  | 'reparseDocument' | 'rechunkDocument' | 'evidence' | 'evidenceEmpty' | 'evidenceNext'
  | 'pythonDetect' | 'pythonPath' | 'pythonVerify' | 'pythonChoose' | 'pythonEligible' | 'pythonMissing' | 'pythonLimited' | 'pythonHint' | 'pythonStages' | 'pythonRemembered' | 'pythonRefreshHint' | 'pythonManualHint' | 'pythonOtherDetected' | 'pythonDetectedDetails' | 'pythonSource' | 'pythonVersion' | 'pythonArchitecture' | 'pythonStepInterpreter' | 'pythonStepEnvironment' | 'pythonStepDependencies' | 'pythonStepInference' | 'pythonReasonProbe' | 'pythonReasonVersion' | 'pythonReasonImplementation' | 'pythonReasonArchitecture' | 'pythonReasonPrerelease' | 'pythonReasonThreaded' | 'pythonReasonVenv' | 'pythonReasonPip'
  | 'evidenceBack' | 'evidenceRetry' | 'mineruDeployTitle' | 'mineruDeployDescription' | 'mineruDeployRoot' | 'mineruDeployExisting' | 'mineruDeployBrowse' | 'mineruDeployCheck' | 'mineruDeployChecking' | 'mineruDeployTotal' | 'mineruDeployReuse' | 'mineruDeployRemaining' | 'mineruDeployUnknownRuntime' | 'mineruDeployIncomplete' | 'mineruDeploySpace' | 'mineruDeployPreflightOnly' | 'mineruDownloadSource' | 'mineruPythonSource' | 'mineruPythonSourceHint' | 'mineruSaveSource' | 'mineruCurrentInstall'
  | 'mineruPhaseAbsent' | 'mineruPhaseEnvironment' | 'mineruPhaseProbe' | 'mineruPhaseReady' | 'mineruPhaseInterrupted' | 'mineruServiceRunning' | 'mineruServiceStarting' | 'mineruServiceStopping' | 'mineruServiceError' | 'mineruServiceStopped' | 'mineruCancelTask' | 'mineruStart' | 'mineruStop' | 'mineruUse' | 'mineruApplied' | 'mineruExternalCopy' | 'mineruPrepare' | 'mineruManagedPreview' | 'mineruConfirmPreparation' | 'mineruNotNow' | 'mineruConfirm'
  | 'sourcePage' | 'sourceBlock' | 'sourceRegion' | 'sourceAsset' | 'sourceUnavailable'
  | 'stageQueued' | 'stageChecking' | 'stageUploading' | 'stageParsing' | 'stageDownloading'
  | 'stageNormalizing' | 'stageIndexing' | 'stageCompleted' | 'stageFailed' | 'stageCanceled'
  | 'nav'
  | 'newBase'
  | 'baseName'
  | 'baseDescription'
  | 'create'
  | 'cancel'
  | 'save'
  | 'delete'
  | 'rename'
  | 'renameDoc'
  | 'confirmDeleteBase'
  | 'documents'
  | 'addText'
  | 'textTitlePlaceholder'
  | 'textContentPlaceholder'
  | 'textContentLabel'
  | 'addTextButton'
  | 'addDocument'
  | 'tabText'
  | 'tabFile'
  | 'tabUrl'
  | 'uploadAll'
  | 'queuedFiles'
  | 'processing'
  | 'searchBases'
  | 'noDocsHint'
  | 'baseSettings'
  | 'editBase'
  | 'confirmDeleteDoc'
  | 'uploaded'
  | 'importFailed'
  | 'tooManyFiles'
  | 'listEndReached'
  | 'unsupportedFilesSkipped'
  | 'resolvingConflict'
  | 'statusPending'
  | 'errorInterrupted'
  | 'errorDimensionMismatch'
  | 'errorParseFailed'
  | 'errorEmbeddingProvider'
  | 'fileTooLarge'
  | 'noSupportedFiles'
  | 'skippedFiles'
  | 'bulkReindexSkipped'
  | 'bulkReindexNone'
  | 'dragToUpload'
  | 'pdfTooLarge'
  | 'pdfPreviewFailed'
  | 'ocrTitle'
  | 'ocrDesc'
  | 'ocrDownload'
  | 'ocrRemove'
  | 'processorBuiltinDesc'
  | 'processorMineruDesc'
  | 'perBaseHint'
  | 'uploadFile'
  | 'uploadButton'
  | 'dragHint'
  | 'importUrl'
  | 'urlPlaceholder'
  | 'urlDesc'
  | 'urlHelp'
  | 'importUrlButton'
  | 'reindex'
  | 'reindexButton'
  | 'reindexDone'
  | 'refreshUrl'
  | 'urlRefreshed'
  | 'urlUnchanged'
  | 'chunks'
  | 'chunkExpand'
  | 'chunkCollapse'
  | 'chunksExpandAll'
  | 'chunksCollapseAll'
  | 'preview'
  | 'rawText'
  | 'close'
  | 'search'
  | 'searchPlaceholder'
  | 'searchButton'
  | 'searchMode'
  | 'modeAuto'
  | 'modeHybrid'
  | 'modeVector'
  | 'modeLexical'
  | 'threshold'
  | 'settings'
  | 'advancedSettings'
  | 'embeddingProvider'
  | 'providerOpenAI'
  | 'providerOllama'
  | 'providerNone'
  | 'embeddingBaseUrl'
  | 'embeddingModel'
  | 'embeddingApiKey'
  | 'chunkSize'
  | 'chunkOverlap'
  | 'topK'
  | 'mmrDiversity'
  | 'rrfVectorWeight'
  | 'rrfVectorWeightHint'
  | 'siblingChunks'
  | 'siblingChunksHint'
  | 'batchSize'
  | 'stats'
  | 'statsDocs'
  | 'statsSourceDocs'
  | 'statsStoredDocs'
  | 'statsSourceDocsTitle'
  | 'statsStoredDocsTitle'
  | 'statsChunks'
  | 'statsChars'
  | 'statsTokens'
  | 'statsDims'
  | 'dimensionProbeFailed'
  | 'dimensionProbing'
  | 'embedded'
  | 'notEmbedded'
  | 'noBases'
  | 'selectBase'
  | 'noDocuments'
  | 'docCount'
  | 'chunkCount'
  | 'tabDir'
  | 'tabPath'
  | 'pathDesc'
  | 'sourcePathEdit'
  | 'sourcePathPrompt'
  | 'pathImportPartial'
  | 'dirPlaceholder'
  | 'importDirButton'
  | 'conflictTitle'
  | 'conflictMessage'
  | 'keepAll'
  | 'replace'
  | 'rerankModel'
  | 'rerankBaseUrl'
  | 'rerankApiKey'
  | 'rerankHint'
  | 'modelLabel'
  | 'elapsed'
  | 'reranked'
  | 'recallTest'
  | 'addSource'
  | 'docProcessing'
  | 'docProcessingHint'
  | 'processorBuiltin'
  | 'smartChunk'
  | 'smartChunkHint'
  | 'semanticChunk'
  | 'semanticChunkHint'
  | 'semanticChunkThreshold'
  | 'semanticChunkThresholdHint'
  | 'chunkTokenLimit'
  | 'chunkTokenLimitHint'
  | 'conflictStrategy'
  | 'conflictStrategyHint'
  | 'conflictRename'
  | 'conflictReplace'
  | 'conflictKeep'
  | 'urlRefreshHours'
  | 'urlRefreshHoursHint'
  | 'resumeInterrupted'
  | 'autoRetrieve'
  | 'autoRetrieveHint'
  | 'autoRetrieveWeight'
  | 'autoRetrieveWeightHint'
  | 'localWorkerIdleTimeoutMs'
  | 'localWorkerIdleTimeoutMsHint'
  | 'resumeInterruptedHint'
  | 'imageCaptionHint'
  | 'imageCaptionOff'
  | 'imageCaptionOpenAI'
  | 'imageCaptionOllama'
  | 'cacheDirTitle'
  | 'cacheDirHint'
  | 'cacheDirBrowse'
  | 'cacheDirMigrate'
  | 'cacheDirOpen'
  | 'cacheDirSaved'
  | 'cacheDirMigrateNone'
  | 'ollamaTitle'
  | 'ollamaDesc'
  | 'ollamaInstalledTitle'
  | 'ollamaNeedInstall'
  | 'ollamaRefresh'
  | 'ollamaPull'
  | 'ollamaRecommended'
  | 'ollamaEmbeddingHint'
  | 'ollamaVisionHint'
  | 'ollamaDelete'
  | 'ollamaConfirmDelete'
  | 'chunkSeparator'
  | 'chunkSeparatorHint'
  | 'retrievalTuning'
  | 'reset'
  | 'viewSource'
  | 'viewChunks'
  | 'more'
  | 'chunkChangeWarning'
  | 'topKHint'
  | 'thresholdHint'
  | 'providerLocal'
  | 'noLocalModelsReady'
  | 'noOllamaModels'
  | 'selectModelPlaceholder'
  | 'ollamaUnreachable'
  | 'embeddingSwitchWarning'
  | 'staleModelSuffix'
  | 'embeddingModelMissingHint'
  | 'localModelStatusLabel'
  | 'goToSettings'
  | 'localModelDownloadingTitle'
  | 'localModelNotReadyTitle'
  | 'localModelNotReadyHint'
  | 'localModelErrorTitle'
  | 'openFolder'
  | 'conflictDialogTitle'
  | 'conflictDialogMessage'
  | 'conflictKeepAll'
  | 'conflictReplaceAll'
  | 'conflictSkipped'
  | 'localModelHint'
  | 'localModelReady'
  | 'localModelDownloading'
  | 'localModelError'
  | 'localModelsNav'
  | 'localModelsTitle'
  | 'localModelsDesc'
  | 'localModelDownload'
  | 'localModelRetry'
  | 'localModelRemove'
  | 'localModelCancel'
  | 'customRerankTitle'
  | 'customRerankHint'
  | 'customRerankAccept'
  | 'customRerankAdd'
  | 'officialSupport'
  | 'experimentalSupport'
  | 'rerankRevalidate'
  | 'rerankValidating'
  | 'localRerankTimeoutMs'
  | 'localRerankTimeoutHint'
  | 'hfMirror'
  | 'hfMirrorHint'
  | 'hfMirrorSave'
  | 'newGroup'
  | 'groupName'
  | 'renameGroup'
  | 'ungrouped'
  | 'recallHistory'
  | 'recallEmptyTitle'
  | 'recallEmptyDesc'
  | 'recallSearching'
  | 'recallResultsSuffix'
  | 'recallTopScore'
  | 'recallRelevance'
  | 'recallCopy'
  | 'recallExpand'
  | 'recallCollapse'
  | 'recallHistoryClear'
  | 'recallHistoryRemove'
  | 'backToParent'
  | 'back'
  | 'ready'
  | 'updatedAtText'
  | 'updatedAtColumn'
  | 'moveToGroup'
  | 'confirmDeleteGroup'
  | 'selected'
  | 'bulkReindex'
  | 'bulkDelete'
  | 'type'
  | 'status'
  | 'selectAll'
  | 'noResults'
  | 'embeddingFailed'
  | 'confirmBulkDelete'
  | 'noLocalModels'
  | 'lexicalOnly'
  | 'lexicalOnlyHint'
  | 'embeddingNotConfigured'
  | 'rebuildBase'
  | 'rebuildHint'
  | 'previewTruncated'
  | 'chunksTruncated'
  | 'firstUploadTitle'
  | 'emptyFolder'
  | 'statusProcessing'
  | 'statusParsing'
  | 'statusImporting'
  | 'restoreHint'
  | 'restoreKeepModel'
  | 'modelId'
  | 'baseUrlLabel'
  | 'apiKeyLabel'
  | 'loadMore'
  | 'kbInvocation'
  | 'kbOn'
  | 'kbOff'
  | 'kbAll'
  | 'kbScopeHint'
  | 'dragResize'
  | 'loadMoreChunks'
  | 'timeJustNow'
  | 'timeMinutes'
  | 'timeHours'
  | 'timeDays'
  | 'cacheDirPickUnavailable'
  | 'cacheDirMigrated'
  | 'mineruOption'
  | 'mineruHostPlaceholder'
  | 'visionModelPlaceholder'
  | 'captionBaseUrlOllamaPlaceholder'
  | 'captionBaseUrlPlaceholder'
  | 'citationSource'
  | 'confirmCascadeDeleteTitle'
  | 'confirmCascadeDelete'
  | 'confirmCascadeBulkDeleteTitle'
  | 'confirmCascadeBulkDelete'
  | 'cascadeImpactDirectories'
  | 'cascadeImpactFiles'
  | 'cascadeImpactChunks'
  | 'cascadeImpactSnapshots'
  | 'cascadeDeleteConfirm'
  | 'syncCreated'
  | 'syncUpdated'
  | 'syncDeleted'
  | 'syncUnchanged'
  | 'syncFailed'
  | 'syncNoChanges'
  | 'statusPollFailed'
  | 'rerankLastValidated'
  | 'error'

/** Bound translate over the knowledge dictionary. */
export type Translate = (key: KnowledgeKey) => string

export const zh: Record<KnowledgeKey, string> = {
  mineruLocalOption: 'MinerU（本地 / 自部署 V1）',
  mineruLocalDesc: '文件只发送到此自部署地址。服务需独立安装；此插件不下载模型，也不会自动转到云端。由 MinerU 提供解析。',
  mineruLocalUrl: '服务地址', mineruLocalKey: '服务密钥（可选）', mineruTier: '解析档位',
  mineruFlash: '极速 flash · 原生文档 / 预览', mineruBasic: '基础 basic · CPU OCR、表格、公式',
  mineruStandard: '标准 standard · 小模型 + VLM', mineruAdvanced: '高级 advanced · 更多推理计算',
  processorCheck: '测试已保存配置', processorChecking: '正在连接…',
  processorCheckSaved: '先保存处理器配置，再测试连接。测试只检查服务能力，不上传文件。',
  processorCheckSuccess: '连接成功', processingTimeout: '文档处理总超时（毫秒）',
  structuredChunking: '按文档结构切块', structuredChunkingHint: '仅对含结构信息的文档保留表格、公式和图注单元；普通文本沿用原切块方式。',
  processingInfo: '解析来源', processingComplete: '完整', processingPartial: '部分解析', processingUnknown: '完整性未知',
  processingReused: '复用了已有证据', reparseDocument: '重新解析源文件', rechunkDocument: '复用解析结果重新切块',
  evidence: '结构证据', evidenceEmpty: '此文档没有可用的结构证据。', evidenceNext: '继续读取',
  evidenceBack: '上一段', evidenceRetry: '重新加载',
  mineruDeployTitle: 'MinerU 本地解析 · 部署预检',
  mineruDownloadSource: '模型下载源',
  mineruPythonSource: 'Python 包下载源', mineruPythonSourceHint: '用于独立 MinerU 环境，默认使用官方 PyPI。只接受 HTTPS 地址；修改后请保存并重新预检。', mineruSaveSource: '保存下载源',
  mineruCurrentInstall: '当前已验证安装目录',
  mineruPhaseAbsent: '尚未部署', mineruPhaseEnvironment: '准备隔离环境', mineruPhaseProbe: '测试 PDF 解析中', mineruPhaseReady: '已通过解析自检', mineruPhaseInterrupted: '上次任务中断，需重新预检',
  mineruServiceRunning: '服务运行中', mineruServiceStarting: '服务启动中', mineruServiceStopping: '服务停止中', mineruServiceError: '服务异常', mineruServiceStopped: '服务未运行',
  mineruCancelTask: '取消当前任务', mineruStart: '启动服务', mineruStop: '停止服务', mineruUse: '设为全局默认解析器', mineruApplied: '已设为全局默认；知识库已有的单独配置仍优先生效。',
  mineruExternalCopy: '外部模型将复制到独立安装目录，原目录保持只读；免下载不代表免磁盘占用。',
  mineruPrepare: '准备本地 MinerU', mineruNotNow: '暂不安装', mineruConfirm: '确认安装与下载',
  pythonDetect: '重新检测环境', pythonPath: 'Python 可执行文件路径', pythonVerify: '验证并记住', pythonChoose: '选择已检测到的解释器', pythonEligible: '可用于尝试部署', pythonMissing: '没有发现可用环境。可填写 Python 可执行文件路径后验证。', pythonLimited: '检测到的环境较多；未显示的环境可手动指定。', pythonHint: '检测不会安装软件。需稳定版 64 位 CPython 3.10–3.14，并包含 venv 和 ensurepip。通过检测不代表 MinerU 依赖或解析已验证。', pythonStages: '部署验证进度', pythonRemembered: '已记住的路径', pythonRefreshHint: '路径已从浏览器设置恢复。部署前请重新检测，确认解释器仍可用。', pythonManualHint: '例如 Windows：C:\\Python313\\python.exe；macOS/Linux：/usr/bin/python3。', pythonOtherDetected: '其他检测到的环境', pythonDetectedDetails: '已检测到的 Python 详情', pythonSource: '发现来源', pythonVersion: '版本', pythonArchitecture: '架构', pythonStepInterpreter: '解释器', pythonStepEnvironment: '隔离环境', pythonStepDependencies: '依赖', pythonStepInference: '真实解析', pythonReasonProbe: '无法启动或读取解释器信息', pythonReasonVersion: '需使用 Python 3.10–3.14', pythonReasonImplementation: '仅支持 CPython', pythonReasonArchitecture: '需 64 位 Python', pythonReasonPrerelease: '需使用正式稳定版', pythonReasonThreaded: '暂不支持自由线程构建', pythonReasonVenv: '缺少 venv 模块', pythonReasonPip: '缺少 ensurepip 模块',
  mineruManagedPreview: '实验性托管部署：目前仅 Basic / ONNX，使用选定 Python 创建独立环境，不修改原有环境。尚未通过真实模型和跨平台实机验收。Standard/Advanced 暂请使用外部服务。',
  mineruConfirmPreparation: '将在所选目录创建独立 Python 环境，从 PyPI 安装 MinerU 4.0.6 及依赖，从 Hugging Face 下载固定版本模型，并用公开测试 PDF 自检。运行环境总占用尚不确定，请预留额外空间。请确认接受上游软件与模型各自的许可证；不会自动切换现有解析配置。',
  mineruDeployDescription: '可选独立部署，不复用向量或重排模型，也不改变现有云 API 配置。Basic 使用 ONNX 解析模型。',
  mineruDeployRoot: '独立安装目录', mineruDeployExisting: '已有 MinerU 模型目录（可选，只读核验）', mineruDeployBrowse: '选择目录',
  mineruDeployCheck: '检查路径与容量', mineruDeployChecking: '正在核验文件，请稍候…',
  mineruDeployTotal: '模型总大小', mineruDeployReuse: '已核验可复用', mineruDeployRemaining: '需下载模型',
  mineruDeployUnknownRuntime: '以上仅为模型容量。Python、运行环境与依赖占用尚未确定，不包含在此数值中。',
  mineruDeployIncomplete: '已有模型缺失或摘要不匹配。不会修改该目录，请选择完整模型目录或清空此选项。',
  mineruDeploySpace: '可用空间不足以完成模型下载与暂存。',
  mineruDeployPreflightOnly: '部署准备会在独立目录创建 Python 环境、安装 MinerU 并下载模型。知识库当前使用的解析器不会自动切换。',
  sourcePage: '原文第 {page} 页', sourceBlock: '块', sourceRegion: '块区域（归一化坐标）', sourceAsset: '查看附件', sourceUnavailable: '原文位置未知',
  stageQueued: '排队中', stageChecking: '检查服务', stageUploading: '上传至配置服务', stageParsing: '解析中',
  stageDownloading: '下载解析结果', stageNormalizing: '整理结构证据', stageIndexing: '建立索引', stageCompleted: '处理完成', stageFailed: '处理失败', stageCanceled: '已取消',
  nav: '知识库',
  newBase: '新建知识库',
  baseName: '名称',
  baseDescription: '描述',
  create: '创建',
  cancel: '取消',
  save: '保存',
  delete: '删除',
  rename: '重命名',
  renameDoc: '重命名文档',
  confirmDeleteBase: '删除后将无法恢复该知识库。',
  documents: '文档',
  addText: '添加文本',
  textTitlePlaceholder: '为这篇笔记取个名字',
  textContentPlaceholder: '在此输入笔记内容…',
  textContentLabel: '内容',
  addTextButton: '添加',
  addDocument: '添加数据源',
  tabText: '笔记',
  tabFile: '文件',
  tabUrl: '链接',
  uploadAll: '上传全部',
  queuedFiles: '个文件待上传',
  processing: '处理中…',
  searchBases: '搜索知识库…',
  noDocsHint: '粘贴文本、上传文件或导入网页，开始积累知识',
  baseSettings: '知识库设置',
  editBase: '编辑知识库',
  confirmDeleteDoc: '删除该文档及其全部分块？',
  uploaded: '已导入',
  importFailed: '导入失败',
  tooManyFiles: '单次最多选择 {count} 个文件，请分批导入',
  listEndReached: '已到底',
  unsupportedFilesSkipped: '已跳过 {count} 个不支持的文件',
  resolvingConflict: '处理中…',
  fileTooLarge: '「{name}」超过 22MB，无法上传（上传接口上限约 24MB），已跳过',
  noSupportedFiles: '所选内容中没有支持的文件（隐藏文件与不支持的格式已跳过）',
  skippedFiles: '已跳过 {count} 个不支持的文件',
  bulkReindexSkipped: '跳过处理中 {count}',
  bulkReindexNone: '所选文档都还在处理中，稍后再试',
  dragToUpload: '松开上传文件',
  pdfTooLarge: '文件超过 100MB，无法内嵌预览，请右键下载查看',
  pdfPreviewFailed: 'PDF 预览加载失败',
  ocrTitle: '本地 OCR（扫描件识别）',
  ocrDesc: '下载 PaddleOCR 模型（约 25MB，完整中文识别）后，扫描版 PDF（无文本层）自动识别出文字并进索引',
  ocrDownload: '下载 OCR 模型',
  ocrRemove: '删除 OCR 模型',
  processorBuiltinDesc: '内置处理器：本地解析全部支持格式；扫描件 PDF 在下载 OCR 模型后自动识别（设置 → 本地模型）',
  processorMineruDesc: 'PDF 会上传到配置的 MinerU 云服务，失败可回退本地解析并记录警告。在 mineru.net 获取 API Key。',
  perBaseHint: '留空则使用全局设置',
  uploadFile: '上传文件',
  uploadButton: '点击选择文件或拖拽到此处',
  dragHint: '支持 PDF, DOCX, MD, XLSX, TXT, CSV',
  importUrl: '导入单个网页',
  urlPlaceholder: 'https://example.com',
  urlDesc: '输入网页链接：',
  urlHelp: '将自动抓取页面文本并分块索引',
  importUrlButton: '导入',
  reindex: '重建索引',
  reindexButton: '重新索引',
  reindexDone: '已重建',
  refreshUrl: '刷新快照',
  urlRefreshed: '已刷新',
  urlUnchanged: '页面无变化',
  chunks: '分块',
  preview: '预览',
  rawText: '原文',
  close: '关闭',
  search: '检索测试',
  searchPlaceholder: '输入测试 Query...',
  searchButton: '检索',
  searchMode: '检索方式',
  modeAuto: '自动',
  modeHybrid: '混合（BM25 + 向量）',
  modeVector: '向量',
  modeLexical: '关键词',
  threshold: '相似度阈值',
  settings: '设置',
  advancedSettings: '高级设置',
  embeddingProvider: '嵌入模型',
  providerOpenAI: 'OpenAI 兼容接口',
  providerOllama: 'Ollama（本地）',
  providerNone: '不使用',
  embeddingBaseUrl: '接口地址',
  embeddingModel: '模型',
  embeddingApiKey: 'API Key（可选）',
  chunkSize: '分段大小',
  chunkOverlap: '重叠大小',
  topK: 'Top K',
  retrievalTuning: '召回与上下文',
  mmrDiversity: '结果多样性（MMR，0=关）',
  rrfVectorWeight: '向量融合权重',
  rrfVectorWeightHint: '混合检索中向量 lane 的相对权重（0.1–5，1=均衡；语义问题可调大）',
  siblingChunks: '上下文拼接',
  siblingChunksHint: '每个命中结果附带相邻分块的数量（0–3，0=关；让回答获得完整段落上下文）',
  batchSize: 'embedding 批大小',
  stats: '统计',
  statsDocs: '文档',
  statsSourceDocs: '来源项',
  statsStoredDocs: '已解析文档',
  statsSourceDocsTitle: '来源中跟踪的项目（文件夹 + 文件）',
  statsStoredDocsTitle: '实际解析并作为原始副本存储在缓存中的文档',
  statsChunks: '分块',
  statsChars: '字符',
  statsTokens: '≈ Token',
  statsDims: '向量维度',
  dimensionProbeFailed: '嵌入模型探测失败',
  dimensionProbing: '探测中…',
  embedded: '已向量化',
  notEmbedded: '未向量化',
  noBases: '暂无知识库',
  selectBase: '选择一个知识库',
  noDocuments: '暂无数据源',
  docCount: '个文档',
  chunkCount: '个分块',
  tabDir: '目录',
  tabPath: '路径',
  pathDesc: '输入目录或文件的绝对路径',
  sourcePathEdit: '修改来源路径',
  sourcePathPrompt: '来源路径',
  pathImportPartial: '导入完成：成功 {count}，失败 {errors}',
  dirPlaceholder: '输入本机目录路径，如 D:\\docs\\policy',
  importDirButton: '导入',
  conflictTitle: '存在同名数据源',
  conflictMessage: '有同名数据源与知识库中已存在的项目同名，请选择处理方式。',
  keepAll: '全部保留',
  replace: '替换',
  rerankModel: '重排模型',
  rerankBaseUrl: '重排接口地址',
  rerankApiKey: '重排 API Key（可选）',
  rerankHint: '对初步召回结果重新排序的模型，可提升最终片段相关性。',
  modelLabel: '模型',
  elapsed: '耗时',
  reranked: '已重排',
  recallTest: '召回测试',
  addSource: '添加数据源',
  docProcessing: '文档处理',
  docProcessingHint: '文档预处理将在文档导入时自动执行，选择合适的处理服务商可提升文档解析质量',
  processorBuiltin: '内置解析器（PDF / DOCX / PPTX / XLSX / EPUB / HTML / 文本）',
  smartChunk: '智能分段',
  smartChunkHint: '自动沿 Markdown 结构（标题、代码块、段落）分段，且不从代码块内部切开。关闭后仅按分隔符切分。',
  semanticChunk: '语义分块',
  semanticChunkHint: '对段落做嵌入并合并语义相近的相邻段（需要已配置嵌入模型；关闭则按标题/段落分块）',
  semanticChunkThreshold: '合并阈值',
  semanticChunkThresholdHint: '相邻段落余弦相似度低于该值（默认 0.75）时另起一块；调高 → 块更碎、更聚焦',
  chunkTokenLimit: '分块 Token 上限',
  chunkTokenLimitHint: '超过该 token 数的块会在句号/逗号/空格等边界处继续切分（0 = 不限制）；本地模型建议设为模型上下文窗口以内',
  conflictStrategy: '同名文件策略',
  conflictStrategyHint: '导入文件与库内同名时：重命名（自动加 _1 后缀）/ 替换 / 保留两者',
  conflictRename: '重命名（自动 _1 后缀）',
  conflictReplace: '替换旧文件',
  conflictKeep: '保留两者',
  urlRefreshHours: 'URL 自动刷新（小时）',
  urlRefreshHoursHint: '超过该时长的 URL 文档每小时自动重新抓取并更新索引（0 = 关闭）',
  resumeInterrupted: '重启后自动恢复中断的导入',
  resumeInterruptedHint: '关闭后，重启时中断的导入标记为失败（需手动重建），不再自动重跑嵌入（Cherry Studio 行为）',
  autoRetrieve: '自动检索（用户消息进来时预检索并注入相关背景）',
  autoRetrieveHint: '开启后，模型回答事实性问题时自动使用知识库内容，无需显式提到“知识库”；关闭后仅按需调用（knowledge_search 工具 + 显式请求）',
  autoRetrieveWeight: '自动检索权重（每库可注入的分块数，0 = 不参与）',
  autoRetrieveWeightHint: '每个库在一次自动检索注入中最多贡献该数量的分块（0–5，默认 3）；权重高可让该库内容占更多上下文，0 则完全排除该库',
  localWorkerIdleTimeoutMs: '本地模型 worker 空闲超时（毫秒，0 = 模型常驻）',
  localWorkerIdleTimeoutMsHint: '本地嵌入模型空闲该时长后会被卸载以释放内存（约 600MB），但 worker 进程保留——onnxruntime 绑定只在进程内加载一次，不会出现 Linux 上的重载失败（Module did not self-register）；下次请求从磁盘重载模型（约 1 秒）。0 = 模型常驻（最快，占用内存）',
  imageCaptionHint: '图表描述（可选）：用视觉模型描述 PDF 中的图片/图表，描述文本可被检索',
  imageCaptionOff: '关闭',
  imageCaptionOpenAI: 'OpenAI 兼容视觉模型',
  imageCaptionOllama: 'Ollama 本地视觉模型',
  cacheDirTitle: '本地模型缓存目录',
  cacheDirHint: '嵌入 / 重排 / OCR 模型文件下载到这里（支持 ~ 与 DSH_HOME 变量）。注意：「保存」只切换配置指向、不移动文件；要搬动已有模型请点「迁移模型到此处」。',
  cacheDirBrowse: '选择文件夹',
  cacheDirMigrate: '迁移模型到此处',
  cacheDirOpen: '打开目录',
  cacheDirSaved: '已保存缓存目录（仅切换配置，文件未移动；如需移动已有模型请点「迁移模型到此处」）',
  cacheDirMigrateNone: '没有可迁移的模型目录（源与目标相同，或目标目录已存在同名条目）',
  ollamaTitle: 'Ollama 模型',
  ollamaDesc: '通过 Ollama API 下载模型（嵌入、视觉等），下载后可在知识库设置中选用（嵌入提供方选 Ollama）。需先安装并启动 Ollama：https://ollama.com/download',
  ollamaInstalledTitle: '已安装模型（点击名称填入输入框）',
  ollamaNeedInstall: '（提示：若持续连接失败，请确认已安装并启动 Ollama，或检查上方地址）',
  ollamaRefresh: '刷新已装模型',
  ollamaPull: '下载模型',
  ollamaRecommended: '推荐模型（点击填入，再点下载）',
  ollamaEmbeddingHint: '嵌入模型 — 知识库设置「嵌入提供方」选 Ollama 后填入',
  ollamaVisionHint: '视觉模型 — 知识库设置「图表描述」选 Ollama 后填入',
  ollamaDelete: '移除该模型（Ollama 正在运行该模型时会失败）',
  ollamaConfirmDelete: '确认移除？',
  chunkSeparator: '分隔符',
  chunkSeparatorHint: '切分文本所用的分隔符（转义形式）。开启智能分段时作为额外切分点；关闭后仅按此分隔符切分。',
  reset: '恢复默认',
  viewSource: '预览原文',
  viewChunks: '查看 Chunks',
  more: '更多',
  chunkChangeWarning: '分块设置的修改只针对新添加的内容有效',
  topKHint: '每次召回返回的最大文档片段数，越大覆盖越多但消耗更多上下文。',
  thresholdHint: '用于过滤低相关性重排片段的相似度阈值，数值越高召回越严格。',
  providerLocal: '本地模型',
  localModelHint: '进程内推理（transformers.js），无需联网服务；首次使用需下载模型权重。模型为 Hugging Face 仓库 id，默认 onnx-community/Qwen3-Embedding-0.6B-ONNX',
  noLocalModelsReady: '暂无已下载的本地模型，请到「设置 → 本地模型」下载',
  noOllamaModels: '暂无已安装的 Ollama 模型，请在「设置 → 本地模型」拉取',
  selectModelPlaceholder: '请选择模型',
  ollamaUnreachable: '无法连接 Ollama（检查地址或是否已启动）',
  embeddingSwitchWarning: '⚠ 切换嵌入模型会使本库已有向量全部失效，保存会被拒绝——请改用「重建知识库」以新模型重建（或先清空本库文档）',
  staleModelSuffix: '（未安装）',
  embeddingModelMissingHint: '嵌入模型使用本地模型，但尚未下载——导入的内容将无法向量化检索。请先到「设置 → 本地模型」下载嵌入模型（约 585MB）。',
  localModelStatusLabel: '本地嵌入模型',
  goToSettings: '去设置',
  localModelDownloadingTitle: '本地嵌入模型下载中',
  localModelNotReadyTitle: '本地嵌入模型未就绪',
  localModelNotReadyHint: '未就绪前导入的内容只能关键词检索，无法向量化。请下载或检查本地模型。',
  localModelErrorTitle: '本地嵌入模型加载失败',
  openFolder: '打开',
  conflictDialogTitle: '同名文件',
  conflictDialogMessage: '有 {count} 个文件与知识库中已有文件同名，如何处理？',
  conflictKeepAll: '全部重命名（保留两者）',
  conflictReplaceAll: '替换现有',
  conflictSkipped: '个同名文件已跳过（保留现有）',
  localModelReady: '本地模型就绪',
  localModelDownloading: '模型下载中',
  localModelError: '模型加载失败',
  localModelsNav: '本地模型',
  localModelsTitle: '本地模型',
  localModelsDesc: '下载、验证并管理本地嵌入和重排模型；只有通过健康检查的重排模型才会出现在知识库设置中。',
  localModelDownload: '下载',
  localModelRetry: '重试',
  localModelRemove: '删除',
  localModelCancel: '取消',
  customRerankTitle: '高级：添加自定义本地 reranker',
  customRerankHint: '实验性功能：仅支持无需远程自定义代码、并能返回单 logit 的 Hugging Face ONNX sequence-classification 模型。',
  customRerankAccept: '我了解自定义模型属于实验性支持，并同意下载后执行本地兼容性自检',
  customRerankAdd: '添加并验证',
  officialSupport: '官方支持',
  experimentalSupport: '实验性',
  rerankRevalidate: '重新验证',
  rerankValidating: '正在验证兼容性',
  localRerankTimeoutMs: '本地重排超时（毫秒）',
  localRerankTimeoutHint: '包含排队等待；超时后保留原始检索顺序，并自动隔离卡住的重排进程。',
  hfMirror: 'Hugging Face 镜像站',
  hfMirrorHint: '无法直连 huggingface.co 时填镜像地址（如 https://hf-mirror.com），立即生效；留空使用官方源或 HF_ENDPOINT 环境变量。',
  hfMirrorSave: '保存',
  newGroup: '新建分组',
  groupName: '分组名称',
  renameGroup: '重命名分组',
  ungrouped: '默认',
  recallHistory: '搜索历史',
  recallEmptyTitle: '输入查询语句开始检索测试',
  recallEmptyDesc: '结果将展示匹配的文档片段和分数',
  recallSearching: '正在检索...',
  recallResultsSuffix: '个结果',
  recallTopScore: '最高',
  recallRelevance: '相关度',
  recallCopy: '复制引用',
  recallExpand: '展开片段',
  recallCollapse: '收起片段',
  recallHistoryClear: '清空',
  recallHistoryRemove: '删除历史',
  backToParent: '返回上级',
  back: '返回',
  ready: '就绪',
  updatedAtText: '更新于',
  updatedAtColumn: '更新时间',
  moveToGroup: '移动到',
  confirmDeleteGroup: '删除后，该分组下的知识库将移至默认分组。',
  selected: '已选',
  bulkReindex: '重新索引',
  bulkDelete: '删除',
  type: '类型',
  status: '状态',
  selectAll: '全选',
  noResults: '无结果',
  embeddingFailed: '嵌入失败',
  confirmBulkDelete: '删除选中的 {count} 份文档及其全部分块？此操作不可撤销。',
  confirmCascadeDeleteTitle: '确认级联删除',
  confirmCascadeDelete: '该目录包含子项，删除会连同整棵子树一并移除。以下内容将被永久删除：',
  confirmCascadeBulkDeleteTitle: '确认级联删除',
  confirmCascadeBulkDelete: '选中项中包含非空目录，删除会连同它们的整棵子树一并移除。以下内容将被永久删除：',
  cascadeImpactDirectories: '目录',
  cascadeImpactFiles: '文件',
  cascadeImpactChunks: '分块',
  cascadeImpactSnapshots: '原始快照',
  cascadeDeleteConfirm: '级联删除',
  syncCreated: '新建',
  syncUpdated: '更新',
  syncDeleted: '删除',
  syncUnchanged: '未变化',
  syncFailed: '失败',
  syncNoChanges: '未检测到变化',
  statusPollFailed: '状态刷新失败',
  rerankLastValidated: '最近验证：',
  noLocalModels: '暂无本地模型',
  lexicalOnly: '仅关键词',
  lexicalOnlyHint: '未配置向量化模型，当前仅关键词检索。点右上角「设置」配置嵌入模型可启用语义检索',
  embeddingNotConfigured: '本知识库未配置向量化，目前仅关键词检索。点「去设置」选择嵌入模型（OpenAI / Ollama / 本地模型），保存后重新索引即可启用语义召回。',
  rebuildBase: '重建知识库',
  rebuildHint: '嵌入模型已更改，现有向量与新模型不匹配，请重建知识库以重新生成向量。',
  previewTruncated: '内容过大，仅显示前 {count} 字符。',
  chunksTruncated: '仅加载前 {loaded} 个分块（共 {total} 个）。',
  chunkExpand: '展开此分块',
  chunkCollapse: '收起此分块',
  chunksExpandAll: '全部展开',
  chunksCollapseAll: '全部收起',
  firstUploadTitle: '上传第一个数据源',
  emptyFolder: '该文件夹为空',
  statusProcessing: '嵌入中',
  statusParsing: '解析中',
  statusPending: '等待中',
  errorInterrupted: '导入因程序关闭而中断——请重建以继续',
  errorDimensionMismatch: '嵌入向量维度不匹配（已切换模型？）——请使用「重建知识库」以新模型重建',
  errorParseFailed: '文档解析失败',
  errorEmbeddingProvider: '嵌入服务/模型调用失败',
  statusImporting: '导入中',
  restoreHint: '将使用当前嵌入模型新建一个知识库，并重新索引所有文档。可选更换嵌入模型（换模型重建）。',
  restoreKeepModel: '沿用原库配置',
  modelId: '模型 ID',
  baseUrlLabel: 'API 地址',
  apiKeyLabel: 'API Key',
  loadMore: '加载更多',
  kbInvocation: '知识库调用',
  kbOn: '开',
  kbOff: '关',
  kbAll: '全部',
  kbScopeHint: '留空 = 全部库可用',
  dragResize: '拖动调整宽度',
  loadMoreChunks: '加载更多分块',
  timeJustNow: '刚刚',
  timeMinutes: '{n} 分钟前',
  timeHours: '{n} 小时前',
  timeDays: '{n} 天前',
  cacheDirPickUnavailable: '文件夹选择不可用（当前环境无目录选择能力）',
  cacheDirMigrated: '模型缓存已迁移到 {to}（移动条目：{count}）',
  mineruOption: 'MinerU（云 API，文件将上传）',
  mineruHostPlaceholder: 'API Host（默认 https://mineru.net）',
  visionModelPlaceholder: '视觉模型（如 qwen-vl-plus、gpt-4o-mini）',
  captionBaseUrlOllamaPlaceholder: 'Ollama 地址（默认 http://127.0.0.1:11434）',
  captionBaseUrlPlaceholder: 'API 地址（留空用嵌入模型地址）',
  citationSource: '（知识库 {id}）',
  error: '出错了',
}

export const en: Record<KnowledgeKey, string> = {
  mineruLocalOption: 'MinerU (local / self-hosted V1)',
  mineruLocalDesc: 'Files are sent only to this self-hosted address. Install the service separately; this plugin does not download models or switch to cloud automatically. Parsing powered by MinerU.',
  mineruLocalUrl: 'Service URL', mineruLocalKey: 'Service key (optional)', mineruTier: 'Parsing tier',
  mineruFlash: 'Flash · native documents / preview', mineruBasic: 'Basic · CPU OCR, tables and formulas',
  mineruStandard: 'Standard · small models + VLM', mineruAdvanced: 'Advanced · more inference compute',
  processorCheck: 'Test saved configuration', processorChecking: 'Connecting…',
  processorCheckSaved: 'Save processor changes before testing. This checks capabilities without uploading a file.',
  processorCheckSuccess: 'Connected', processingTimeout: 'Document processing timeout (ms)',
  structuredChunking: 'Structure-aware chunking', structuredChunkingHint: 'Preserve tables, formulas and captions in structured documents; ordinary text keeps its existing chunking behavior.',
  processingInfo: 'Parsing provenance', processingComplete: 'Complete', processingPartial: 'Partially parsed', processingUnknown: 'Completeness unknown',
  processingReused: 'Existing evidence reused', reparseDocument: 'Reparse source', rechunkDocument: 'Rechunk saved parsing result',
  evidence: 'Structured evidence', evidenceEmpty: 'No structured evidence is available for this document.', evidenceNext: 'Continue reading',
  evidenceBack: 'Previous excerpt', evidenceRetry: 'Reload',
  mineruDeployTitle: 'MinerU local parsing · Deployment preflight',
  mineruDownloadSource: 'Model download source',
  mineruPythonSource: 'Python package index', mineruPythonSourceHint: 'Used only by the isolated MinerU environment. Defaults to official PyPI. Save and rerun preflight after changing it.', mineruSaveSource: 'Save package source',
  mineruCurrentInstall: 'Currently verified installation',
  mineruPhaseAbsent: 'Not deployed', mineruPhaseEnvironment: 'Preparing isolated environment', mineruPhaseProbe: 'Parsing test PDF', mineruPhaseReady: 'Parse self-test passed', mineruPhaseInterrupted: 'Previous task interrupted; run preflight',
  mineruServiceRunning: 'Service running', mineruServiceStarting: 'Service starting', mineruServiceStopping: 'Service stopping', mineruServiceError: 'Service error', mineruServiceStopped: 'Service stopped',
  mineruCancelTask: 'Cancel task', mineruStart: 'Start service', mineruStop: 'Stop service', mineruUse: 'Use as global default parser', mineruApplied: 'Global default updated. Existing per-base overrides still take precedence.',
  mineruExternalCopy: 'External models are copied into managed storage; the source stays read-only. Reusing downloads still requires disk space for the copy.',
  mineruPrepare: 'Prepare local MinerU', mineruNotNow: 'Not now', mineruConfirm: 'Confirm installation and download',
  pythonDetect: 'Rescan environments', pythonPath: 'Python executable path', pythonVerify: 'Verify and remember', pythonChoose: 'Choose a detected interpreter', pythonEligible: 'Eligible to attempt setup', pythonMissing: 'No eligible environment found. Enter a Python executable path and verify it.', pythonLimited: 'Discovery reached its limit. Specify other environments manually.', pythonHint: 'Detection does not install software. Requires stable 64-bit CPython 3.10–3.14 with venv and ensurepip. Eligibility does not verify MinerU dependencies or parsing.', pythonStages: 'Deployment validation', pythonRemembered: 'Remembered path', pythonRefreshHint: 'Restored from browser settings. Rescan before deployment to confirm the interpreter is still available.', pythonManualHint: 'For example: C:\\Python313\\python.exe or /usr/bin/python3.', pythonOtherDetected: 'Other detected environments', pythonDetectedDetails: 'Detected Python details', pythonSource: 'Source', pythonVersion: 'Version', pythonArchitecture: 'Architecture', pythonStepInterpreter: 'Interpreter', pythonStepEnvironment: 'Isolated environment', pythonStepDependencies: 'Dependencies', pythonStepInference: 'Real parsing', pythonReasonProbe: 'Could not start interpreter or read its details', pythonReasonVersion: 'Python 3.10–3.14 required', pythonReasonImplementation: 'CPython only', pythonReasonArchitecture: '64-bit Python required', pythonReasonPrerelease: 'Stable release required', pythonReasonThreaded: 'Free-threaded builds are not supported', pythonReasonVenv: 'venv module is missing', pythonReasonPip: 'ensurepip module is missing',
  mineruManagedPreview: 'Experimental managed deployment: Basic / ONNX only. Creates an isolated environment from the selected Python without modifying existing environments. Real-model and cross-platform acceptance are pending. Use an external service for Standard/Advanced.',
  mineruConfirmPreparation: 'Creates an isolated Python environment in the chosen directory, installs MinerU 4.0.6 and dependencies from PyPI, downloads pinned models from Hugging Face, and parses a public test PDF. Total runtime size is unknown; allow additional disk space. Confirm acceptance of upstream software and model licenses. Existing parser settings will not switch automatically.',
  mineruDeployDescription: 'Optional isolated deployment. Embedding and reranking models are separate, and existing cloud API settings stay unchanged. Basic uses ONNX parsing models.',
  mineruDeployRoot: 'Dedicated installation directory', mineruDeployExisting: 'Existing MinerU model directory (optional, read-only verification)', mineruDeployBrowse: 'Choose directory',
  mineruDeployCheck: 'Check paths and capacity', mineruDeployChecking: 'Verifying files…',
  mineruDeployTotal: 'Total model size', mineruDeployReuse: 'Verified reusable', mineruDeployRemaining: 'Model download remaining',
  mineruDeployUnknownRuntime: 'Model files only. Python, runtime and dependency sizes are not yet known and are not included above.',
  mineruDeployIncomplete: 'Existing model files are missing or do not match their fingerprints. This directory will not be modified; choose a complete model directory or clear this option.',
  mineruDeploySpace: 'Insufficient space for model downloads and staging.',
  mineruDeployPreflightOnly: 'Preparation creates a Python environment in the dedicated directory, installs MinerU, and downloads its models. The parser currently used by your knowledge base will not switch automatically.',
  sourcePage: 'Source page {page}', sourceBlock: 'Block', sourceRegion: 'Block region (normalized coordinates)', sourceAsset: 'View asset', sourceUnavailable: 'Source location unknown',
  stageQueued: 'Queued', stageChecking: 'Checking service', stageUploading: 'Uploading to configured service', stageParsing: 'Parsing',
  stageDownloading: 'Downloading results', stageNormalizing: 'Normalizing evidence', stageIndexing: 'Indexing', stageCompleted: 'Completed', stageFailed: 'Failed', stageCanceled: 'Canceled',
  nav: 'Knowledge',
  newBase: 'New base',
  baseName: 'Name',
  baseDescription: 'Description',
  create: 'Create',
  cancel: 'Cancel',
  save: 'Save',
  delete: 'Delete',
  rename: 'Rename',
  renameDoc: 'Rename document',
  confirmDeleteBase: 'After deletion the knowledge base cannot be restored.',
  documents: 'Documents',
  addText: 'Add text',
  textTitlePlaceholder: 'Name this note',
  textContentPlaceholder: 'Type note content...',
  textContentLabel: 'Content',
  addTextButton: 'Add',
  addDocument: 'Add Data Source',
  tabText: 'Note',
  tabFile: 'Files',
  tabUrl: 'Link',
  uploadAll: 'Upload all',
  queuedFiles: 'files queued',
  processing: 'Processing…',
  searchBases: 'Search bases…',
  noDocsHint: 'Paste text, upload files, or import a URL to get started',
  baseSettings: 'Base settings',
  editBase: 'Edit base',
  confirmDeleteDoc: 'Delete this document and all its chunks?',
  uploaded: 'imported',
  importFailed: 'import failed',
  tooManyFiles: 'At most {count} files per selection; split the import',
  listEndReached: 'End of list',
  unsupportedFilesSkipped: '{count} unsupported file(s) skipped',
  resolvingConflict: 'Resolving…',
  fileTooLarge: '"{name}" exceeds 22MB — cannot upload (the upload API caps at ~24MB); skipped',
  noSupportedFiles: 'No supported files in the selection (hidden files and unsupported formats are skipped)',
  skippedFiles: 'Skipped {count} unsupported files',
  bulkReindexSkipped: 'skipped {count} in progress',
  bulkReindexNone: 'All selected documents are still processing — try again later',
  dragToUpload: 'Drop to upload',
  pdfTooLarge: 'File exceeds 100MB — cannot preview inline; download it to view',
  pdfPreviewFailed: 'Failed to load PDF preview',
  ocrTitle: 'Local OCR (scanned documents)',
  ocrDesc: 'Download the PaddleOCR models (~25MB, full Chinese recognition); scanned PDFs (no text layer) are then OCRed automatically and indexed',
  ocrDownload: 'Download OCR models',
  ocrRemove: 'Remove OCR models',
  processorBuiltinDesc: 'Built-in processor: parses every supported format locally; scanned PDFs are OCRed automatically once the OCR models are downloaded (Settings → Local Models)',
  processorMineruDesc: 'PDFs are uploaded to the configured MinerU cloud service. Failures may fall back to local parsing with a recorded warning. Get an API key at mineru.net.',
  perBaseHint: 'Leave empty to use global settings',
  uploadFile: 'Upload file',
  uploadButton: 'Click to select files or drag them here',
  dragHint: 'Supports PDF, DOCX, MD, XLSX, TXT, CSV',
  importUrl: 'Import a single webpage',
  urlPlaceholder: 'https://example.com',
  urlDesc: 'Enter a webpage URL:',
  urlHelp: 'The page text will be fetched and indexed automatically',
  importUrlButton: 'Import',
  reindex: 'Reindex',
  reindexButton: 'Reindex',
  reindexDone: 'reindexed',
  refreshUrl: 'Refresh snapshot',
  urlRefreshed: 'refreshed',
  urlUnchanged: 'page unchanged',
  chunks: 'Chunks',
  preview: 'Preview',
  rawText: 'Raw text',
  close: 'Close',
  search: 'Search test',
  searchPlaceholder: 'Enter test query...',
  searchButton: 'Search',
  searchMode: 'Search mode',
  modeAuto: 'Auto',
  modeHybrid: 'Hybrid (BM25 + vector)',
  modeVector: 'Vector',
  modeLexical: 'Lexical',
  threshold: 'Similarity Threshold',
  settings: 'Settings',
  advancedSettings: 'Advanced Settings',
  embeddingProvider: 'Embedding Model',
  providerOpenAI: 'OpenAI-compatible',
  providerOllama: 'Ollama (local)',
  providerNone: 'Disabled',
  embeddingBaseUrl: 'Base URL',
  embeddingModel: 'Model',
  embeddingApiKey: 'API key (optional)',
  chunkSize: 'Chunk Size',
  chunkOverlap: 'Overlap Size',
  topK: 'Top K',
  retrievalTuning: 'Retrieval and context',
  mmrDiversity: 'Diversity (MMR, 0=off)',
  rrfVectorWeight: 'Vector fusion weight',
  rrfVectorWeightHint: 'Relative weight of the vector lane in hybrid fusion (0.1–5, 1=balanced; raise for semantic questions)',
  siblingChunks: 'Context stitching',
  siblingChunksHint: 'Neighbouring chunks (±) attached to each hit (0–3, 0=off; gives answers the full paragraph)',
  batchSize: 'Embedding batch size',
  stats: 'Stats',
  statsDocs: 'docs',
  statsSourceDocs: 'source items',
  statsStoredDocs: 'parsed docs',
  statsSourceDocsTitle: 'Items tracked from the source (folders + files)',
  statsStoredDocsTitle: 'Documents actually parsed and stored as raw copies in the cache',
  statsChunks: 'chunks',
  statsChars: 'chars',
  statsTokens: '~tokens',
  statsDims: 'vector dims',
  dimensionProbeFailed: 'Embedding probe failed',
  dimensionProbing: 'Probing…',
  embedded: 'embedded',
  notEmbedded: 'not embedded',
  noBases: 'No knowledge bases',
  selectBase: 'Select a knowledge base',
  noDocuments: 'No data sources',
  docCount: ' docs',
  chunkCount: ' chunks',
  tabDir: 'Directory',
  tabPath: 'Path',
  pathDesc: 'Absolute path to a directory or file',
  sourcePathEdit: 'Edit source path',
  sourcePathPrompt: 'Source path',
  pathImportPartial: 'Import finished: {count} succeeded, {errors} failed',
  dirPlaceholder: 'Enter a local directory path, e.g. D:\\docs\\policy',
  importDirButton: 'Import',
  conflictTitle: 'Same-name source',
  conflictMessage: 'Some sources have the same name as items already in this base. How to proceed?',
  keepAll: 'Keep both',
  replace: 'Replace',
  rerankModel: 'Rerank model',
  rerankBaseUrl: 'Rerank base URL',
  rerankApiKey: 'Rerank API key (optional)',
  rerankHint: 'Model used to rerank initial retrieval results and improve final chunk relevance.',
  modelLabel: 'Model',
  elapsed: 'latency',
  reranked: 'reranked',
  recallTest: 'Recall Test',
  addSource: 'Add Data Source',
  docProcessing: 'File Processing',
  docProcessingHint: 'Document preprocessing runs automatically during document import. Choosing the right provider can improve document parsing quality.',
  processorBuiltin: 'Built-in parser (PDF / DOCX / PPTX / XLSX / EPUB / HTML / text)',
  smartChunk: 'Smart Chunking',
  smartChunkHint: 'Automatically split along Markdown structure (headings, code blocks, paragraphs) and never split inside a code block. Turn off to split purely by the separator.',
  semanticChunk: 'Semantic chunking',
  semanticChunkHint: 'Embed paragraphs and merge adjacent similar ones (needs an embedding provider; off = heading/paragraph chunking)',
  semanticChunkThreshold: 'Merge threshold',
  semanticChunkThresholdHint: 'Start a new chunk when adjacent segments fall below this cosine (default 0.75); higher = smaller, more focused chunks',
  chunkTokenLimit: 'Chunk token limit',
  chunkTokenLimitHint: 'Chunks above this token count split further at sentence/comma/space boundaries (0 = off); set within your local model\'s context window',
  conflictStrategy: 'Same-name conflict',
  conflictStrategyHint: 'When an imported file matches an existing name: rename (auto _1 suffix) / replace / keep both',
  conflictRename: 'Rename (auto _1 suffix)',
  conflictReplace: 'Replace the old file',
  conflictKeep: 'Keep both',
  urlRefreshHours: 'URL auto-refresh (hours)',
  urlRefreshHoursHint: 'URL documents older than this are re-fetched and re-indexed hourly (0 = off)',
  resumeInterrupted: 'Resume interrupted imports on restart',
  resumeInterruptedHint: 'When off, imports interrupted by a shutdown are marked failed instead of auto re-embedding (Cherry Studio behavior)',
  autoRetrieve: 'Auto-retrieve (pre-search user messages and inject relevant background)',
  autoRetrieveHint: 'When on, the model automatically uses knowledge-base content for factual questions without an explicit "knowledge base" mention; when off, only on-demand calls (knowledge_search tool + explicit requests)',
  autoRetrieveWeight: 'Auto-retrieve weight (chunks this base may contribute, 0 = excluded)',
  autoRetrieveWeightHint: 'A base contributes at most this many chunks per auto-retrieve injection (0–5, default 3); higher lets its content take more context, 0 excludes it entirely',
  localWorkerIdleTimeoutMs: 'Local-model worker idle timeout (ms, 0 = keep models hot)',
  localWorkerIdleTimeoutMsHint: 'After this much idle time the local model is UNLOADED to free memory (~600MB) but the worker process stays alive — the onnxruntime binding is loaded once per process, so the Linux respawn failure ("Module did not self-register") cannot occur; the next request reloads from disk (~1s). 0 = keep models hot (fastest, costs resident memory)',
  imageCaptionHint: 'Image/table captioning (optional): a vision model describes embedded PDF figures so charts become searchable',
  imageCaptionOff: 'Off',
  imageCaptionOpenAI: 'OpenAI-compatible vision model',
  imageCaptionOllama: 'Ollama local vision model',
  cacheDirTitle: 'Local model cache directory',
  cacheDirHint: 'Embedding / rerank / OCR model files download here (~ and DSH_HOME are expanded). Note: "Save" only points the config here — it does NOT move files; use "Migrate models here" to move existing models.',
  cacheDirBrowse: 'Pick folder',
  cacheDirMigrate: 'Migrate models here',
  cacheDirOpen: 'Open folder',
  cacheDirSaved: 'Cache directory saved (config only, files not moved; use "Migrate models here" to move existing models)',
  cacheDirMigrateNone: 'Nothing to migrate (source equals target, or the target already has the same entries)',
  ollamaTitle: 'Ollama models',
  ollamaDesc: 'Pull models through the Ollama API (embeddings, VLMs); pulled models are selectable in the base settings (provider: Ollama). Requires Ollama to be installed and running: https://ollama.com/download',
  ollamaInstalledTitle: 'Installed models (click a name to fill the input)',
  ollamaNeedInstall: '(Tip: if connections keep failing, make sure Ollama is installed and running, or check the address above)',
  ollamaRefresh: 'Refresh installed',
  ollamaPull: 'Pull model',
  ollamaRecommended: 'Recommended models (click to fill, then pull)',
  ollamaEmbeddingHint: 'Embedding model — pick provider Ollama in the base settings and fill this name',
  ollamaVisionHint: 'Vision model — pick Ollama for image captioning in the base settings and fill this name',
  ollamaDelete: 'Delete this model (fails while Ollama is running it)',
  ollamaConfirmDelete: 'Confirm delete?',
  chunkSeparator: 'Separator',
  chunkSeparatorHint: 'Delimiter the text is split on, in escaped form. With smart chunking on it adds a break point; with it off the text is split only by this delimiter.',
  reset: 'Restore Defaults',
  viewSource: 'Preview Source',
  viewChunks: 'View Chunks',
  more: 'More',
  chunkChangeWarning: 'Chunking changes only apply to newly added content',
  topKHint: 'Maximum number of document chunks returned for each retrieval. Higher values cover more content but use more context.',
  thresholdHint: 'Similarity threshold used to filter low-relevance reranked chunks; higher is stricter.',
  providerLocal: 'Local model',
  localModelHint: 'In-process inference (transformers.js), no server needed; first use downloads the weights. Model = Hugging Face repo id, default onnx-community/Qwen3-Embedding-0.6B-ONNX',
  noLocalModelsReady: 'No downloaded local models — download one in Settings → Local Models',
  noOllamaModels: 'No installed Ollama models — pull one in Settings → Local Models',
  selectModelPlaceholder: 'Select a model',
  ollamaUnreachable: 'Cannot reach Ollama (check the address or whether it is running)',
  embeddingSwitchWarning: '⚠ Switching the embedding model invalidates this base\'s stored vectors, so the save will be refused — rebuild via \u201cRebuild base\u201d with the new model instead (or empty the base first)',
  staleModelSuffix: ' (not installed)',
  embeddingModelMissingHint: 'The embedding provider is the local model, which is not downloaded yet — imported content cannot be vectorized for retrieval. Download the embedding model (~585MB) in Settings → Local Models first.',
  localModelStatusLabel: 'Local embedding model',
  goToSettings: 'Settings',
  localModelDownloadingTitle: 'Downloading the local embedding model',
  localModelNotReadyTitle: 'Local embedding model not ready',
  localModelNotReadyHint: 'Until it is ready, imports are keyword-searchable only. Download or check the local model.',
  localModelErrorTitle: 'Local embedding model failed to load',
  openFolder: 'Open',
  conflictDialogTitle: 'Same-name files',
  conflictDialogMessage: '{count} files share a name with items already in this base. How to proceed?',
  conflictKeepAll: 'Rename all (keep both)',
  conflictReplaceAll: 'Replace existing',
  conflictSkipped: 'same-name file(s) skipped (existing kept)',
  localModelReady: 'Local model ready',
  localModelDownloading: 'Downloading model',
  localModelError: 'Model load failed',
  localModelsNav: 'Local Models',
  localModelsTitle: 'Local Models',
  localModelsDesc: 'Download, validate, and manage local embedding and rerank models. Only healthy rerankers appear in base settings.',
  localModelDownload: 'Download',
  localModelRetry: 'Retry',
  localModelRemove: 'Remove',
  localModelCancel: 'Cancel',
  customRerankTitle: 'Advanced: add a custom local reranker',
  customRerankHint: 'Experimental: only Hugging Face ONNX sequence-classification models that need no remote custom code and return one logit are supported.',
  customRerankAccept: 'I understand custom models are experimental and agree to run a local compatibility check after download',
  customRerankAdd: 'Add and validate',
  officialSupport: 'Official support',
  experimentalSupport: 'Experimental',
  rerankRevalidate: 'Revalidate',
  rerankValidating: 'Validating compatibility',
  localRerankTimeoutMs: 'Local rerank timeout (ms)',
  localRerankTimeoutHint: 'Includes queue wait. On timeout, retrieval order is preserved and the stuck rerank process is isolated.',
  hfMirror: 'Hugging Face mirror',
  hfMirrorHint: 'When huggingface.co is unreachable, set a mirror (e.g. https://hf-mirror.com); takes effect immediately. Empty = official hub or the HF_ENDPOINT env var.',
  hfMirrorSave: 'Save',
  newGroup: 'New group',
  groupName: 'Group name',
  renameGroup: 'Rename group',
  ungrouped: 'Default',
  recallHistory: 'Search History',
  recallEmptyTitle: 'Enter a query to start the recall test',
  recallEmptyDesc: 'Results will show matching document chunks and scores',
  recallSearching: 'Searching...',
  recallResultsSuffix: 'results',
  recallTopScore: 'Top',
  recallRelevance: 'Relevance',
  recallCopy: 'Copy citation',
  recallExpand: 'Expand',
  recallCollapse: 'Collapse',
  recallHistoryClear: 'Clear',
  recallHistoryRemove: 'Remove',
  backToParent: 'Back to parent',
  back: 'Back',
  ready: 'Ready',
  updatedAtText: 'Updated',
  updatedAtColumn: 'Updated at',
  moveToGroup: 'Move to',
  confirmDeleteGroup: 'After deletion, bases in this group will move to the default group.',
  selected: 'Selected',
  bulkReindex: 'Reindex',
  bulkDelete: 'Delete',
  type: 'Type',
  status: 'Status',
  selectAll: 'Select all',
  noResults: 'No results',
  embeddingFailed: 'Embedding failed',
  confirmBulkDelete: 'Delete the selected {count} documents and all their chunks? This cannot be undone.',
  confirmCascadeDeleteTitle: 'Confirm cascading delete',
  confirmCascadeDelete: 'This directory has children, so deleting it removes the whole subtree. The following will be permanently deleted:',
  confirmCascadeBulkDeleteTitle: 'Confirm cascading delete',
  confirmCascadeBulkDelete: 'The selection contains non-empty directories, so deleting it removes their whole subtrees. The following will be permanently deleted:',
  cascadeImpactDirectories: 'Directories',
  cascadeImpactFiles: 'Files',
  cascadeImpactChunks: 'Chunks',
  cascadeImpactSnapshots: 'Raw snapshots',
  cascadeDeleteConfirm: 'Delete subtree',
  syncCreated: 'Created',
  syncUpdated: 'Updated',
  syncDeleted: 'Deleted',
  syncUnchanged: 'Unchanged',
  syncFailed: 'Failed',
  syncNoChanges: 'No changes detected',
  statusPollFailed: 'Status refresh failed',
  rerankLastValidated: 'Last validated: ',
  noLocalModels: 'No local models yet',
  lexicalOnly: 'Lexical only',
  lexicalOnlyHint: 'No embedding model configured — search is lexical only. Use the Settings button (top right) to configure an embedding model and enable semantic retrieval.',
  embeddingNotConfigured: 'This base has no embedding configured, so search is lexical only. Open Settings to pick an embedding model (OpenAI / Ollama / local), save, then reindex to enable semantic recall.',
  rebuildBase: 'Rebuild base',
  rebuildHint: 'The embedding model has changed; existing vectors no longer match. Rebuild the base to regenerate vectors.',
  previewTruncated: 'Content too large; showing the first {count} characters.',
  chunksTruncated: 'Showing the first {loaded} of {total} chunks.',
  chunkExpand: 'Expand chunk',
  chunkCollapse: 'Collapse chunk',
  chunksExpandAll: 'Expand all',
  chunksCollapseAll: 'Collapse all',
  firstUploadTitle: 'Upload your first data source',
  emptyFolder: 'This folder is empty',
  statusProcessing: 'Embedding',
  statusParsing: 'Parsing',
  statusPending: 'Pending',
  errorInterrupted: 'Import was interrupted by a shutdown — reindex to resume',
  errorDimensionMismatch: 'Embedding dimension mismatch (model switched?) — rebuild the base with the new model',
  errorParseFailed: 'Document parse failed',
  errorEmbeddingProvider: 'Embedding provider/model call failed',
  statusImporting: 'Importing',
  restoreHint: 'A new base will be created and all documents re-indexed. Optionally switch the embedding model (rebuild-with-new-model).',
  restoreKeepModel: 'Keep the source base config',
  modelId: 'Model ID',
  baseUrlLabel: 'API base URL',
  apiKeyLabel: 'API key',
  loadMore: 'Load more',
  kbInvocation: 'Knowledge base',
  kbOn: 'on',
  kbOff: 'off',
  kbAll: 'All',
  kbScopeHint: 'Empty = all bases',
  dragResize: 'Drag to resize',
  loadMoreChunks: 'Load more chunks',
  timeJustNow: 'just now',
  timeMinutes: '{n} min ago',
  timeHours: '{n} h ago',
  timeDays: '{n} d ago',
  cacheDirPickUnavailable: 'Folder picking is unavailable (this environment has no directory picker)',
  cacheDirMigrated: 'Model cache migrated to {to} ({count} entries moved)',
  mineruOption: 'MinerU (cloud API, uploads files)',
  mineruHostPlaceholder: 'API Host (default https://mineru.net)',
  visionModelPlaceholder: 'Vision model (e.g. qwen-vl-plus, gpt-4o-mini)',
  captionBaseUrlOllamaPlaceholder: 'Ollama URL (default http://127.0.0.1:11434)',
  captionBaseUrlPlaceholder: 'API URL (leave empty to use the embedding model URL)',
  citationSource: ' (KB {id})',
  error: 'Error',
}
