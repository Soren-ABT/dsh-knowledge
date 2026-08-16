# dsh-knowledge 与 Cherry Studio 知识库逐功能实现对比

对比对象：
- **Cherry Studio**（AGPL-3.0，Electron 桌面应用）`src/main/features/knowledge/` v2 实现（2026 基线），共 111 个文件，含 4 份规范文档（`knowledge-product-spec.md`、`knowledge-service.md`、`knowledge-technical-design.md`、`workflow-architecture.md`、`operation-guards.md`）。
- **dsh-knowledge**（MIT，DSH 静态开源插件）`src/knowledge/` + `src/tool-knowledge/` + `src/ui/client/`，约 15 个源文件。

对比维度：**实现形式**（怎么做的）与**能力程度**（做到什么水平）。结论符号：`=` 同水平、`<` 插件弱于 Cherry、`>` 插件强于 Cherry、`±` 各有取舍。

---

## 1. 整体架构

| 方面 | Cherry Studio | dsh-knowledge | 对比 |
| --- | --- | --- | --- |
| 形态 | 内置功能模块，4 个职责区：数据服务（DataApi/SQLite）、`KnowledgeService` 门面、`ingestion/` 编排、`query/` 查询 + JobManager 持久任务 | 独立 Cordis 插件：`KnowledgeService` 单一 Service + 同步方法，无任务系统 | `±`：Cherry 为多窗口桌面应用设计，插件为单进程宿主设计 |
| 状态模型 | 业务状态持久化：`knowledge_item.status`（idle/preparing/processing/reading/embedding/completed/failed/deleting），JobManager 进度只作诊断 | 文档状态：`indexingStatus`（indexing→parsing→embedding→completed）、chunk 计数、embedding 模型计数；无删除状态机 | `<`：Cherry 的状态机是"可恢复工作流"的基础；插件状态只是展示用 |
| 一致性 | 跨库事务（主 SQLite + 每 base `index.sqlite`）无法原子，靠持久任务 + 幂等清理保证 | 单库（domain JSON + chunk SQLite），单进程顺序执行，天然串行 | `±`：插件更简单，但无并发也就无并发故障面；Cherry 的复杂度换来多窗口/多任务并发安全 |
| 锁 | `KeyedMutex` 每 base 互斥锁，串行化同 base 变更与清理 | 无锁（单线程宿主顺序调用） | `=` 在插件场景下等价，但插件未来若支持并发 ingest 需要补锁 |

## 2. 数据模型与存储

| 方面 | Cherry Studio | dsh-knowledge | 对比 |
| --- | --- | --- | --- |
| 主数据 | 主 SQLite（better-sqlite3 + Drizzle）：`knowledge_base`（embeddingModelId、dimensions、status、error、fileProcessorId、chunkSize/chunkOverlap/chunkSeparator/chunkStrategy、threshold、documentCount、rerankModelId、groupId）+ `knowledge_item`（type: file/url/note/directory，data 按类型） | `ctx.storageDomain` JSON（bases/documents/global，web profile 为 json 后端）；**chunk 数据在插件自有 SQLite**（`chunk` 表 + FTS5 + 索引） | `±`：JSON 单元 ≤1MB 可承受（chunk 已移出），但文档元数据无 SQL 查询能力；Cherry 全 SQLite |
| 每 base 索引 | 每 base 一个 `.cherry/index.sqlite`：material（relative_path UNIQUE）/ content（content_hash 去重）/ search_unit（unit_id 稳定哈希）/ search_text（外链 FTS5 三元组）/ embedding（embedding_text_hash → vector_blob），`meta` 记录 base_id + schema_version | 每部署一个 `knowledge-chunks.sqlite`：`chunk`（chunk_id/doc_id/base_id/idx/text/search_text/heading/context/embedding BLOB/embedding_model）+ `chunk_fts`（外链 FTS5）+ doc/base 索引 | `=` 概念同构（BLOB float32 LE 向量 + FTS5 外链），但 Cherry 每 base 隔离（base_id 防串库校验），插件所有 base 共用一库靠 base_id 列过滤 |
| 原始文件 | `raw/` 目录：文件复制进库、URL/note 快照（OKF frontmatter），**导入即复制**（product-spec 原则 2），路径安全守卫（`assertSafeKnowledgeRelativePath` + `assertResolvesBelow` 防 Windows 转义） | **不保存原始文件**：文本提取后直接入库；addFileDocument 用调用方上传的 buffer | `<`：Cherry 有可浏览、可重读、可恢复的原始材料库（reindex 从源重读）；插件 reindex 只能重嵌入已有文本（`reindexDocument` 不预删 chunk），源文件丢失即无法重读。但插件作为宿主内插件，DSH 自身有文件工具可替代部分能力 |
| 层级 | 目录树模型：directory item 是容器，children 通过 groupId 挂父（可嵌套、可展开、删除级联子树） | 扁平 base→documents；目录导入只是扫描后拍平成一堆文档 | `<`：Cherry 有真正的目录语义（树、子树删除/重建、reindex 整棵子树）；插件无嵌套、无子树概念 |
| 元数据 | item.data 按类型存 source/relativePath/indexedRelativePath/url/content；有 title（显示名）+ groupId | document: id/baseId/title/createdAt/updatedAt/chunkCount 等 | `=` 基本覆盖 |

## 3. 导入与来源（sources）

| 方面 | Cherry Studio | dsh-knowledge | 对比 |
| --- | --- | --- | --- |
| 入口模型 | 载荷式 `addItems(baseId, inputs[])` 一次 IPC：创建行→冲突处理→调度任务；返回"已受理"而非完成 | `addFileDocument` / `ingestDocument` / `importUrl` / 目录扫描，同步完成（或返回 placeholder + 异步 indexing） | `=` 语义一致（都是"先受理、后索引"），但插件没有批量原子受理 |
| 冲突策略 | 三策略：`rename`（默认，自动 `_1` 后缀）、`detect`（报告冲突让 UI 问）、`replace`（先取消旧子树任务再删旧建新）；批内 last-wins 去重；路径预留集防同批同名冲突 | 无冲突概念：文档 id 由调用方生成，重名自动去重/覆盖 | `<`：Cherry 是完整的产品级冲突管理（含 replace 的取消-删除-重命名闭环）；插件未实现 |
| 文件复制 | 复制进 `raw/`，保留名字 + 层级，`_N` 后缀防撞，processed artifact 一并预留槽位 | 无复制；直接解析 buffer | `±`：Cherry 保留材料可审计、可重读；插件省磁盘但失去原始材料 |
| 目录 | `prepare-root` 任务递归扫描（隐藏文件跳过、支持扩展名过滤、层级保留）、复制进度上报、崩溃后可恢复（pathPrefix 先 pin 再复制、retry 回收孤儿 shell） | `scanDirectory`：递归、深度 ≤8、文件数 ≤500、14 种扩展名过滤 | `<`：功能等价（限制更小），但无"先 pin 再复制"的可恢复性、无进度、无子任务 |
| URL | 快照制：`WebSearchService`（jina provider）抓取→markdown→OKF frontmatter 快照文件→索引读快照；**refresh = 重新抓取覆盖**（需确认）；p-queue 限流（3 并发 / 10 每 60s） | `fetchHtml` 直接抓 HTML→剥离成文本→入库；无快照、无 refresh、无 OKF | `<`：Cherry 有"快照 + 手动刷新"的完整闭环（快照文件本身就是可读材料）；插件抓一次定终身 |
| note | 一等的 item 类型：content 存库、首索引时写快照、可 refresh | 无 note 类型；文档文本直接 ingest | `<`：Cherry 把笔记当作知识库一等公民 |

## 4. 文件解析（readers）

| 方面 | Cherry Studio | dsh-knowledge | 对比 |
| --- | --- | --- | --- |
| 格式覆盖 | pdf（PDFReader）、csv、docx（mammoth）、doc（word-extractor）、epub（epub/anydoc 回退）、ppt/pptx/xls/xlsx（anydoc）、html、json、md/mdx、text、DraftsExport 特殊格式 | txt/md/markdown/csv/html/htm/json/log、pdf（pdf-parse 可选）、docx（mammoth 可选）、doc（word-extractor 可选）、pptx/xlsx（jszip XML 提取）、epub（jszip）、ppt/xls（anydoc 可选） | `=` 覆盖几乎一致，插件还多 `.log`；Cherry 多了 DraftsExport 和 anydoc 全格式回退链 |
| 文档处理器（OCR/远程） | `fileProcessorId` → FileProcessingService：远程 document_to_markdown 处理器（含 OCR 能力），输出 markdown 存 `indexedRelativePath`，5s 轮询、30min 超时、取消传播 | 无远程处理器；扫描型 PDF 报"无可提取文本"错误 | `<`：**这是最大的能力缺口之一** —— Cherry 可通过远程处理器处理扫描 PDF/复杂版面；插件只能靠宿主其它工具补 |
| 解析器健壮性 | anydoc 有 win32-arm64 缺失回退链、逐章失败隔离（epub）、空结果记录 | 每个解析器 lazy 加载、失败转清晰错误 | `=` |

## 5. 分块（chunking）

| 方面 | Cherry Studio | dsh-knowledge | 对比 |
| --- | --- | --- | --- |
| 算法 | `splitter.ts` 结构感知：markdown 标题（h1-h6 分级打分 100-50）/代码围栏（不切割）/分隔线/段落/列表/换行 12 级断点 + 距离衰减窗口（22% 预算）+ token 预算换算字符（tokenx 估算 charsPerToken）+ overlap；`structured`/`delimiter` 两策略 + 用户分隔符（转义 `\n\n`）；**code fence 保护区** | `chunkText`：段落/标题块（heading 路径记录）+ 句边界窗口（末 40% 内找 `。！？.`）+ 字符窗口 + overlap；`smartChunk`/分隔符两模式 | `<`：Cherry 的断点评分制（标题 > 段落 > 列表 > 换行，距离衰减）和代码围栏保护、token 化预算明显更精细；插件按字符预算且无代码围栏保护 |
| 额外细化 | 本地嵌入模型走 `refineChunksByTokenLimit`：二分查找 + 首选边界（`\n\n`→`。`→`，`→空格）+ overlap token 回退——保证 chunk 不超模型输入上限 | 无 token 上限细化（本地模型输入上限由模型自己处理） | `<`：Cherry 对本地模型有输入长度防护，插件没有 |
| 上下文 | chunk 无 heading 元数据（search_unit.title 列存在但 units 都是 'chunk' 类型） | **每个 chunk 记录 markdown heading 路径**，检索可注入上下文 | `>`：这是插件对 Cherry 的实质增强（检索结果自带章节上下文） |
| 内容规范化 | `content.text` 单份规范化存储 + 偏移切片（`slice(charStart,charEnd)===body` 不变式），content_hash 去重，单元 id 稳定哈希（material+contentHash+index+offsets） | 每 chunk 独立存 text（重复存储内容），chunk_id 自增；无内容去重 | `<`：Cherry 的内容去重 + 原子 material 重建是"reindex 不重嵌入"的关键；插件靠 embedding_model 计数 + 全量重嵌 |

## 6. 嵌入（embedding）

| 方面 | Cherry Studio | dsh-knowledge | 对比 |
| --- | --- | --- | --- |
| 模型接入 | `AiService.embedMany`（统一模型注册表：远程 API + 本地 ONNX 模型，worker 进程隔离 onnxruntime native）；BM25-only base 支持（无嵌入模型也可建库，后续 `enableEmbeddingModel` 原地回填） | 三 provider：`openai` 兼容 `/embeddings`、`ollama`、`local`（transformers.js 进程内 ONNX，Qwen3-Embedding-0.6B q8 1024 维，自动下载/进度/删除）；`none` = 纯 lexical | `=` 能力同构，插件独有**完全本地零依赖**本地嵌入（无需 worker，纯 JS 推理） |
| 去重复用 | **hash 去重**：`embedding_text_hash` 作 embedding 表主键，reindex 只嵌缺失 hash（决策 A4，省付费 API）；`listExistingEmbeddingHashes` + `assertEmbeddingCoverage` 防竞态 | 无 hash 去重：每次 ingest 全量重嵌（`reuse` 参数在 buildChunks 传递，但无跨次持久去重）；`embeddingModelCounts` 检测模型切换后失效 | `<`：付费 API 场景下 Cherry 的 hash 复用是省钱关键；插件对本地模型无所谓，但配远程 API 时每次 reindex 都重花钱 |
| 批处理 | 10 chunks/批 + 进度缓存（CacheService shared，linger TTL）；维度校验（返回数与维度必须匹配） | `embeddingBatchSize`（默认 32）+ 进度阶段（embedding）；维度校验 | `=` |
| 失败语义 | 嵌入失败 → job 重试（3 次指数退避），最终 failed 状态 | 本地模型失败 **抛错**（不静默降级 lexical）；远程失败降级 lexical + warn | `>` 插件对"本地模型坏了还假装混合检索开着"的问题处理更果断（这是吸取了之前静默降级的教训）；Cherry 靠 job 重试 |

## 7. 检索（retrieval）

| 方面 | Cherry Studio | dsh-knowledge | 对比 |
| --- | --- | --- | --- |
| lexical 车道 | FTS5 三元组 MATCH + 短词 LIKE 过滤（可放宽）+ `needsLikeFallback`（纯 LIKE 扫描按长度排序）；bm25() 排序取负 | FTS5 三元组 MATCH（CJK 三元组窗口）+ 短词 LIKE 过滤 + 纯 LIKE 回退（按长度）；bm25 排序 | `=` 几乎逐行同构（插件本来就是照 Cherry ftsQuery 思路实现的，含放宽逻辑） |
| vector 车道 | 暴力余弦（sqlite-vec `vec_distance_cosine`，BLOB 直接绑定），零范数行剔除（dist IS NOT NULL） | 暴力余弦（JS 读 BLOB 解码 float32 LE 计算），无 ANN | `=` 都是"明确不建 ANN、线性扫描"（Cherry 文档明说 100k+ 行才考虑索引；插件 LANE_CANDIDATE_CAP=200） |
| 混合 | RRF：`alpha/(RRF_K+rank)` 向量 + `(1-alpha)` BM25，prefetch = topK×5，RRF_K=60；**alpha 由 base 配置？** —— 实际是 `KnowledgeIndexSearchInput.alpha ?? 0.5` 固定默认 | RRF：`rrfVectorWeight` 可配置（0.1–5，默认 1），RRF_K=60，maxFused 归一化，prefetch = max(topK×4, 20) | `>` 插件的混合权重可调（并做了实验验证默认 1.0 最优）；Cherry alpha 硬编码 0.5 |
| 候选池 | overfetch 后可见性过滤（同 base + completed）+ documentCount（默认 10）截断 | poolSize 上限 + topK 截断（默认 6） | `=` 思路一致，Cherry 多一层"item 可见性"过滤（插件靠 base 存在性检查 + 文档过滤） |
| rerank | `rerankModelId` 经 AiService（统一模型路由）；**401/403/404 持久错误记 error，瞬时降级 warn**；score 变 relevance（`scoreKind`）；threshold 只对 relevance 生效 | `rerankModel`/`rerankBaseUrl`/`rerankApiKey` → Jina/SiliconFlow/Cohere 风格 `POST /rerank`（OpenAI 兼容协议）；失败降级保留检索序 + warn；threshold 只对 reranked relevance 生效（与 Cherry 语义一致） | `=` 语义同构；插件协议上更"BYO 端点"，Cherry 走模型注册表（可配本地 rerank 模型） |
| MMR 多样性 | 无 | `mmrDiversity` 配置 + `maximalMarginalRelevance` | `>` 插件独有 |
| 模式选择 | base 推导：无嵌入模型 → BM25 only；有 → hybrid（引擎层还支持纯 vector，产品层不用） | `searchMode` auto/hybrid/vector/lexical + 每请求可覆盖（mode 参数），baseIds/baseId 多库搜索 | `>` 插件的模式/范围控制更灵活（多库一次搜、显式 vector 模式） |

## 8. 深度阅读与工具面（Concept / Tools）

| 方面 | Cherry Studio | dsh-knowledge | 对比 |
| --- | --- | --- | --- |
| 寻址 | **Concept ID** = material relative_path（OKF §2），`getMaterialByRelativePath` 解析 + 重校验可见 item（同 base + completed）——工具只接受搜索返回的 locator，绝不接受任意文件路径 | 文档 id（uuid）寻址，`knowledge_get_document` 按 id 读 | `=` 概念等价（都是"透明标识符，非文件路径"）；Cherry 的 relative_path 人类可读（如 `raw/docs/排队论.pdf`） |
| 深度读 | `readConcept`：20k 字符切片 + totalChars/truncated 分页 | `knowledge_read_document`：分页读 + truncated→charEnd 续读 | `=` 同构（插件实现即此思路） |
| grep | `grepConcept`：正则逐行匹配（每行 ≤2000 字符防灾难回溯）、60 字符 padding 片段、50 默认/200 上限、ignoreCase 默认开、行号+偏移 | `knowledge_read_document` 带 pattern 参数（grep 模式） | `=` 插件实现了同样防护（逐行上限） |
| 组织树 | `getOrganizationTree`：groupId 层级 DFS、maxDepth、1000 节点上限、conceptId 标注、truncated 标志 | 无树；`knowledge_list_documents` 拍平列表 | `<`：Cherry 的树是目录语义的自然产物；插件无目录所以无树（列表足够） |
| 概念级写操作 | `deleteConcepts` / `refreshConcepts`：批量解析、notFound 报告、走 ingestion 正规流程 | `knowledge_delete_document` / `knowledge_reindex_base`（整库重嵌） | `<`：Cherry 支持按概念（单文档）重索引；插件 reindex 是库级 |
| 工具数量 | 完整 MCP/工具面：list/search/read/grep/tree/manage（add/delete/refresh），破坏性操作需确认 | 12 个工具：search/list_bases/create_base/delete_base/add_document/list_documents/delete_document/import_url/stats/get_document/reindex_base/read_document | `=` 覆盖更全的清单（stats、import_url、create_base 是插件独有），但缺 tree 和单文档 reindex |

## 9. 任务系统与恢复（最核心的架构差距）

| 方面 | Cherry Studio | dsh-knowledge | 对比 |
| --- | --- | --- | --- |
| 持久任务 | JobManager 5 种任务：prepare-root / index-documents / check-file-processing-result / delete-subtree / reindex-subtree；每 base 队列 `base.{id}`、幂等键、并发 5、3 次指数退避重试、超时（10-30min）、父子任务、进度上报 | **无任务系统**：同步方法 + `indexingStatus` 阶段标记；宿主进程内顺序执行 | `<`：**最大的架构差距**。Cherry 的整个可靠性（崩溃恢复、重试、取消、删除状态机）都建立在 JobManager 上 |
| 崩溃恢复 | 双轨：启动时 `recoverInterruptedItems`（active → failed，用户可重试）+ `recoverDeletingItems`（重新入队删除任务）；JobManager 启动恢复（recovery: abandon 的索引类任务不自动续跑——避免重启白花嵌入 API；delete-subtree 是 retry） | `openStore` 自愈三连：`migrateLegacyChunkFile`（legacy JSON→sqlite 幂等迁移）、`recoverInterruptedImports`（启动时清掉"非目录文档但无 chunk 更新"的幽灵记录）、`reconcileChunkCounts`（回写真实 chunk 数） | `±`：插件用**启动清扫**替代任务恢复，在单进程无并发场景下足够（这正是之前修复"处理中卡死"的最终方案）；但没有任务重试/取消/进度，大文档索引中断只能整篇重来 |
| 删除 | 状态机：`deleting` 标记（同事务入队）→ 任务取消子树活动任务 → 锁内删向量/文件/行；失败保持 `deleting`（不降级 failed，避免旧 chunk 复活可搜） | `deleteBase` 同步删 base + `deleteChunksByBase` 删 chunk；`deleteDocuments` 同步删 + touchBase | `<`：插件删除是"瞬时快照"式（删了就是删了），无 `deleting` 中间态、无取消、无失败重试；Cherry 的删除是完整状态机 |
| 重索引 | reindex-subtree：仅 terminal 子树准入（completed/failed）、锁内先删向量→删旧子项→重置状态→重新调度；源丢失的根不删向量（可重建性检查 `canKnowledgeItemRebuildSource`） | `reindexDocument`/`reindexDocuments`：不预删 chunk，直接重嵌覆盖；`reindex_base` 整库 | `<`：Cherry 有准入守卫（防删了源还重建的根）+ 部分重索引；插件整库重嵌成本高 |

## 10. 配置与调参

| 方面 | Cherry Studio | dsh-knowledge | 对比 |
| --- | --- | --- | --- |
| base 配置 | embeddingModelId/dimensions（不可变，换模型=迁移新 base）/rerankModelId/fileProcessorId/chunkSize/chunkOverlap/chunkSeparator/chunkStrategy/threshold/documentCount/groupId；BM25-only base + 后期 enableEmbeddingModel 原地回填 | 全局默认 + 全局运行时覆盖 + 每 base 覆盖（三层合并）：embeddingProvider/baseUrl/model/apiKey、rerank*、smartChunk/separator/size/overlap、topK、searchMode、similarityThreshold、mmrDiversity、rrfVectorWeight、embeddingBatchSize | `=` 字段集相当（插件还多 MMR/权重/批大小），但 Cherry 模型不可变语义更严谨（防维度混乱），插件靠 embeddingModelCounts 检测变化后失效 |
| 部署配置 | 无（应用内设置） | schemastery Config（cordis.yml）+ env 覆盖（KNOWLEDGE_API_KEY 等）+ chunkStorePath/localModelCacheDir/hfEndpoint | `>` 插件作为可部署组件的配置链更完备 |

## 11. UI（实现形式差异较大）

| 方面 | Cherry Studio | dsh-knowledge | 对比 |
| --- | --- | --- | --- |
| 视图 | 文件管理器式主视图（list/grid、目录树、状态列、进度、冲突对话框、settings 内嵌 base 配置） | 侧边栏入口 + 面板：base 列表/文档列表/chunk 浏览/导入下拉/设置对话框（含本地模型卡片、RRF 权重）/状态阶段 | `=` 功能面覆盖（列表、设置、导入、本地模型），但 Cherry 有目录树视图和文件管理交互，插件无树 |
| 状态呈现 | 业务状态驱动 UI（每 item 状态徽标、进度百分比、轮询） | 阶段显示（indexing/parsing/embedding/completed）+ 计数 | `=` 插件轮询 listDocuments 呈现 |
| 快捷键/入口 | 应用内导航 | 侧边栏统一入口（对齐设置按钮几何）+ 统一添加入口下拉（URL 走正式对话框） | `=` |

## 12. 许可与分发（非功能对比）

| 方面 | Cherry Studio | dsh-knowledge |
| --- | --- | --- |
| 许可 | AGPL-3.0 | MIT |
| 分发 | 桌面应用内置 | npm 包 + 静态插件（cordis.patch.yml 三行接入），DSH `plugin add` 即装 |
| 依赖 | Electron + better-sqlite3 + sqlite-vec + onnxruntime + 全套 reader 库 | 零原生依赖（node:sqlite 内建 + transformers.js 纯 JS + 可选解析器 lazy 加载） |
| 数据落盘 | 主 SQLite + 每 base index.sqlite + raw/ 文件 | DSH storageDomain JSON + 单 SQLite chunk 库 |

## 13. 插件独有而 Cherry 没有的能力

1. **完全本地零依赖嵌入**：Qwen3-Embedding-0.6B 进程内推理（transformers.js），下载/进度/删除管理，无需 worker/onnxruntime native。
2. **混合权重可调**：`rrfVectorWeight` 配置（并经 eval 实验验证）。
3. **MMR 多样性**：检索去冗余。
4. **chunk 携带 heading 上下文**：检索注入章节路径。
5. **多库一次检索**：`baseIds` 范围 + 显式模式覆盖。
6. **每 base 嵌入 provider 配置**：同一部署内不同库可用不同模型。
7. **启动自愈**：legacy 迁移 + 幽灵文档清扫 + 计数对账（单文件内闭环）。
8. **检索评测工具链**：`scripts/eval-retrieval.mjs` + 真实数学建模题目集（Cherry 无任何 eval 工具）。

## 14. 明确差距清单（如需追赶的优先级）

| # | 差距 | 影响 | 补法成本 |
| --- | --- | --- | --- |
| 1 | 无持久任务系统/删除状态机 | 大文档中断无重试、删除无中间态 | 高（需引入任务表 + 恢复逻辑） |
| 2 | 无原始文件存储（raw/） | 无法从源重读、reindex 依赖已有文本 | 中（addFileDocument 时落盘副本） |
| 3 | 无远程文档处理器（OCR/复杂 PDF） | 扫描件无法索引 | 中（接入 DSH 网络工具或可选 OCR 依赖） |
| 4 | 无目录树语义 | 无子树删除/重索引、无树视图 | 中（引入 parentId + 递归操作） |
| 5 | 无嵌入 hash 去重 | 远程 API 场景 reindex 重复付费 | 低（embedding hash 列 + 存在性查询，可照抄 Cherry A4） |
| 6 | 无 URL 快照/刷新 | 网页内容无法更新 | 低（抓取时落盘 + refresh 接口） |
| 7 | 无冲突策略 | 批量导入同名处理粗糙 | 低 |
| 8 | 无单文档 reindex 工具 | 工具面少一个能力 | 低 |

## 15. 结论

Cherry Studio 的知识库是**为桌面多窗口、多任务并发、可恢复工作流设计的完整产品**：持久任务系统、目录树材料模型、快照制导入、hash 级嵌入去重、跨库一致性和 11 种任务的崩溃恢复构成其骨架；dsh-knowledge 是**为单进程宿主设计、以检索质量为核心的轻量实现**：在检索核心（FTS5 三元组 + 暴力向量 + RRF + rerank + 阈值语义）上与 Cherry 逐行同构甚至更强（可调权重、MMR、heading 上下文、多库范围），并独有零依赖本地嵌入、启动自愈和评测工具链。

能力总评：**检索核心 = 或 >；材料管理（导入/存储/目录/冲突）<；可靠性与可恢复性 <；本地嵌入、可配置性、评测 >**。差距集中在"材料管理生命周期"，而非检索算法本身——插件若按第 14 节的 4/5/6 项补齐，即可在能力面上追平 80% 的日常场景。
