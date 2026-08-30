/**
 * Dictionary for the knowledge panel (zh / en). Keys are used as
 * `t('nav')` through the locale service's bound translate.
 * @module dsh-knowledge/client/locales
 */

export type KnowledgeKey =
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
  | 'error'

/** Bound translate over the knowledge dictionary. */
export type Translate = (key: KnowledgeKey) => string

export const zh: Record<KnowledgeKey, string> = {
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
  processorMineruDesc: 'PDF 优先经 MinerU 远程 API 解析（版面/表格/扫描件质量最高），失败自动回退本地解析。在 mineru.net 获取 API Key。',
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
  mmrDiversity: '结果多样性（MMR，0=关）',
  rrfVectorWeight: '向量融合权重',
  rrfVectorWeightHint: '混合检索中向量 lane 的相对权重（0.1–5，1=均衡；语义问题可调大）',
  siblingChunks: '上下文拼接',
  siblingChunksHint: '每个命中结果附带相邻分块的数量（0–3，0=关；让回答获得完整段落上下文）',
  batchSize: 'embedding 批大小',
  stats: '统计',
  statsDocs: '文档',
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
  error: '出错了',
}

export const en: Record<KnowledgeKey, string> = {
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
  processorMineruDesc: 'PDFs go through the MinerU remote API first (best quality for scans/complex layouts); failures fall back to local parsing. Get an API key at mineru.net.',
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
  mmrDiversity: 'Diversity (MMR, 0=off)',
  rrfVectorWeight: 'Vector fusion weight',
  rrfVectorWeightHint: 'Relative weight of the vector lane in hybrid fusion (0.1–5, 1=balanced; raise for semantic questions)',
  siblingChunks: 'Context stitching',
  siblingChunksHint: 'Neighbouring chunks (±) attached to each hit (0–3, 0=off; gives answers the full paragraph)',
  batchSize: 'Embedding batch size',
  stats: 'Stats',
  statsDocs: 'docs',
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
  embeddingSwitchWarning: '⚠ Switching the embedding model invalidates this base\'s stored vectors, so the save will be refused — rebuild via 重建知识库 with the new model instead (or empty the base first)',
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
  error: 'Error',
}
