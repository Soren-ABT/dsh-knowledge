<div align="center">

#  dsh-knowledge

**DSH 的知识库插件**

[**English**](./README.en.md) · [**中文**](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-knowledge?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-knowledge)
[![npm downloads](https://img.shields.io/npm/dm/dsh-knowledge?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-knowledge)
[![Node.js >= 22](https://img.shields.io/badge/node.js-%3E%3D22-brightgreen?logo=nodedotjs)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-%23003B57?logo=sqlite)](https://www.sqlite.org/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

一个深度的**知识库系统**，作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的独立、可开源 bundle 插件。提供知识库（含**分组**）与文档管理、文本分块、向量化（OpenAI 兼容 / Ollama / **本地模型** / 关键词降级）、检索，以及模型可见工具与浏览器管理面板。

<img width="1000" height="667" alt="image" src="https://github.com/user-attachments/assets/8fab3aed-709e-4a59-87fa-c1a52c29c11e" />

</div>

---

## 为什么选择 dsh-knowledge

dsh-knowledge 把文档导入、解析、分块、检索、证据组织和模型续读整合进 DSH。它既可以零向量配置运行，也可以完全使用本地模型，不要求额外部署独立的知识库服务。

| 能力 | 说明 |
|---|---|
| 文档来源 | 文件、目录、网页和文本笔记；本地路径可持续重扫和重新索引 |
| 混合检索 | FTS5 BM25、向量召回、RRF 融合、MMR 去重以及可选重排 |
| 证据上下文 | 按文档顺序动态生成 `ContextWindow`，支持围绕命中位置继续阅读 |
| 本地运行 | 本地 embedding、本地 rerank、本地 OCR；也支持 OpenAI 兼容接口和 Ollama |
| 文档处理 | 常见办公格式、扫描 PDF、PaddleOCR、Tesseract 回退及可选 MinerU |
| 管理界面 | 知识库分组、批量导入、预览、召回测试、模型管理和索引重建 |

---

## 快速开始

### 1. 准备环境

- Node.js：`^22.19.0 || >=24.0.0`
- pnpm：`>=10`
- 已安装并初始化 DeepSeek Harness

在安装插件之前，将以下构建许可加入目标 profile 的 `pnpm-workspace.yaml`。这些依赖包含 postinstall；pnpm 10 默认拒绝执行时，`dsh plugin add` 会在登记 bundle 前退出。

```yaml
allowBuilds:
  onnxruntime-node: true
  sharp: true
  protobufjs: true
  tesseract.js: true
```

### 2. 安装插件

```bash
dsh plugin --profile <name> add dsh-knowledge
```

插件安装在 profile 层。无论 DSH 来自 npm 还是源码 checkout，都使用同一条命令。安装完成后重启 web 服务，并刷新页面加载管理面板。

### 3. 完成首次配置

1. 点击侧边栏底部、设置旁的“知识库”入口。
2. 新建知识库并导入文件、目录、网页或文本。
3. 如需本地向量检索，在“设置 > 本地模型”下载 embedding 模型；也可以配置 OpenAI 兼容服务或 Ollama。
4. 如需识别扫描件，再下载约 21 MB 的 OCR 模型。
5. 在“召回测试”中检查结果，再让模型通过 `knowledge_search` 使用知识库。

不下载模型也可以使用关键词检索。扫描件 OCR、本地 embedding 和本地 rerank 只有在对应模型已下载并通过就绪检查后才启用。

<details>
<summary>其他安装方式</summary>

```bash
# GitHub Release 或 npm pack 生成的 tarball
dsh plugin --profile <name> add ./dsh-knowledge-0.3.9.tgz

# 本地源码目录，需要先完成构建
dsh plugin --profile <name> add file:/path/to/dsh-knowledge
```

如果第一次安装因 pnpm 构建许可失败，请补全 `allowBuilds` 后重新运行 add。包通常已经进入 `node_modules`，第二次执行会继续完成 bundle 登记。

</details>

---

## 核心能力

### 文档与来源管理

- 创建、重命名、分组和删除知识库；侧边栏支持分组折叠和库间移动。
- 从文件、绝对路径、目录、URL 或纯文本导入文档。目录来源保留稳定 ID、类型和原始路径，可重新扫描磁盘变化。
- 批量上传单次最多 20 个文件、单文件最大 22 MB，并使用 5 路后台导入池。
- 同名冲突由服务端统一检测，可选择重命名、替换或取消；内容哈希用于避免重复导入。
- 文档列表展示等待、解析、embedding、完成和失败状态；支持 PDF 原文、文本和完整分块预览。
- 原始文件保存到知识库 raw 存储。不同目录根的同名相对路径互不冲突，失败的替换重建不会破坏上一份已提交内容。

<details>
<summary>支持的文档格式与目录行为</summary>

目录导入递归扫描 `txt`、`md`、`csv`、`html`、`json`、`pdf`、`docx`、`doc`、`pptx`、`ppt`、`xlsx`、`xls`、`epub` 等格式，并在界面中保留可下钻的文件夹树。

重新扫描目录时会导入新增文件、重建已修改文件并移除已不存在的文件。单个文件失败不会隐藏其他成功结果，服务端和界面都会保留逐文件错误信息。

</details>

### 检索与证据链

- 未配置 embedding 时使用 CJK 二元组和拉丁词 BM25；配置向量后可使用 hybrid、vector、lexical 或 auto 模式。
- 混合检索通过 Reciprocal Rank Fusion 合并 BM25 与向量结果，并支持相似度阈值、MMR 多样性和多查询融合。
- 可选远程或本地 cross-encoder 重排。重排失败、超时或返回无效分数时保留原始召回顺序。
- 每个命中动态生成有序的 `ContextWindow`，按 `before → anchor → after` 组织证据，不把桥接文本写入索引或 embedding。
- 自动检索默认开启；它在模型回答前注入高相关证据，同时限制延迟、重复内容和单个知识库占用的上下文份额。
- 召回测试展示来源、相关度、关键词/向量分数、耗时和重排状态，并支持复制引用与重放历史查询。

<details>
<summary>ContextWindow 与自动检索细节</summary>

`SearchHit.text` 始终保留完整 canonical anchor。`contextWindow` 默认不跨标题路径；超长锚点围绕查询命中按句子边界裁剪，相邻 chunk 的重复前后缀会被移除。旧字段 `siblingContext` 在 0.3.x 中继续兼容，但新调用方应优先使用 `contextWindow`。

`knowledge_get_document` 支持普通 `chunkOffset` / `chunkLimit` 分页，也支持通过 `anchorChunkId` 或 `anchorIndex` 进入锚点模式。锚点模式可控制 `before`、`after`、`maxTokens`、`focus` 和 `crossHeading`。

自动检索的首 Token 路径不会启动本地 reranker；远程 rerank 最多调用一次，并共享 4 秒总预算。取消、超时或 provider 故障不会污染注入记忆，也不会把检索范围扩大到无关知识库。

</details>

### 分块、解析与 OCR

- 标题感知分块保留 Markdown 标题路径和代码围栏，并把文档标题与标题路径作为检索上下文。
- `chunkSize` 与 `chunkOverlap` 使用 Token 预算；长文本按标题、代码、段落、句读、列表和换行的优先级寻找断点。
- 可选语义分块会合并相邻的相似段落；可选 Token 上限会继续在句号、逗号或空格附近细分超长块。
- 扫描 PDF、无文本层矢量 PDF、损坏文本层和逐字符排版 PDF 可自动进入整页 OCR 路径。
- PaddleOCR PP-OCRv5 为首选本地识别器，识别失败时回退 Tesseract；1-bit JBIG2/CCITT 扫描件也包含在处理路径中。
- 可选 MinerU 远程处理可将公式、表格和复杂版式恢复为 Markdown；未配置时继续使用本地解析与 OCR。

### 模型与管理界面

- 每个知识库可以覆盖 embedding、rerank、分块、topK、自动检索、冲突策略和文档处理设置；空字段继承全局值。
- embedding 支持 OpenAI 兼容 `/embeddings`、Ollama 和 transformers.js 本地模型。
- 本地模型页面管理 embedding、rerank 和 OCR 模型的下载、重试、删除、进度与健康状态。
- 模型缓存目录支持原生文件夹选择、打开目录和安全迁移，可把较大的本地权重移出系统盘。
- Ollama 页面支持查看、拉取、取消和删除模型；浏览或拉取不会隐式更改当前 embedding 配置。
- 管理面板提供知识库导航、资料表格、批量重建/删除、原文与分块预览、召回测试、全局和每库设置及 Toast 反馈。

<details>
<summary>本地模型运行方式</summary>

默认本地 embedding 模型为 `onnx-community/Qwen3-Embedding-0.6B-ONNX`，约 585 MB、1024 维。它在独立 worker thread 中运行，空闲后可以释放 ONNX session，但 worker 保持存活以避免 Linux 原生绑定重复注册问题。

`rerankModel: local:Xenova/bge-reranker-base` 在独立 child process 中运行，与 embedding worker 隔离。搜索不会隐式下载 rerank 模型；模型必须先在本地模型页面下载并通过健康检查。自定义 Hugging Face ONNX reranker 属于实验性能力，需要通过单 logit 能力验证和正负样例自检。

本地模型默认缓存在 `<DSH_HOME>/cache/dsh-knowledge/local-models`。下载端点可通过界面的 `hfEndpoint` 或环境变量 `HF_ENDPOINT` 调整；OCR 默认使用 `hf-mirror.com`，海外用户可改为 `https://huggingface.co`。

</details>

### 模型工具

插件向模型提供 14 个工具。所有读取、写入和自动检索都遵守“已启用知识库”边界；空或失效选择匹配零个知识库，不会静默扩大到全库。永久删除必须经过宿主确认。

<details>
<summary>查看全部工具</summary>

- `knowledge_search`
- `knowledge_list_bases`
- `knowledge_create_base`
- `knowledge_delete_base`
- `knowledge_add_document`
- `knowledge_list_documents`
- `knowledge_delete_document`
- `knowledge_import_url`
- `knowledge_refresh_url`
- `knowledge_stats`
- `knowledge_get_document`
- `knowledge_read_document`
- `knowledge_reindex_document`
- `knowledge_reindex_base`

`knowledge_search` 返回 citations、`chunkIndex` 和有序 `ContextWindow`。`knowledge_read_document` 支持字符区间读取和正则定位，`knowledge_get_document` 支持分页及围绕检索锚点续读。

</details>

### 存储与索引

- 知识库、文档和运行时配置通过 DSH `storageDomain` 持久化。
- 分块保存在独立 SQLite 文件 `<DSH_HOME>/storages/knowledge-chunks.sqlite`，可通过 `chunkStorePath` 调整。
- 词法检索使用 SQLite FTS5 trigram 索引；向量使用 Float32Array 常驻缓存并精确失效。
- 旧 JSON 分块数据在首次启动时执行幂等迁移；没有存储后端时自动退化为内存模式。
- 修改分块或 embedding 配置后，可以重建单条资料或整个知识库的索引。

---

## v0.3.9 更新重点

- 支持通过绝对路径导入单个文件或完整目录树，并持续追踪顶层来源。
- 来源重指严格限定到所选顶层文件或目录，跨扩展名时使用新文件对应的解析器。
- 修复不同目录根下相同相对路径的 raw 缓存冲突，并为替换重建增加失败保护。
- Ollama embedding 地址为空时回退到 `http://127.0.0.1:11434`；浏览或下载模型不再修改当前配置。
- 改进主题 token、Popover 视口定位、关闭行为、Toast 交互和中英文本地化。

本次升级不迁移数据库、不自动重建索引、不重新下载模型，也不改变 v0.3.8 的检索证据链契约。社区 PR #10–#13 的 ThinkForge-core 原作者提交和署名保留在 Git 历史中。

[查看 v0.3.9 GitHub Release](https://github.com/Soren-ABT/dsh-knowledge/releases/tag/v0.3.9) · [查看 CHANGELOG](./CHANGELOG.md)

---

## 工作流程

1. **导入**：接收文件、目录、URL 或文本，并保存来源元数据与可恢复的原始内容。
2. **解析**：按格式提取正文；扫描件或异常 PDF 按需进入本地 OCR，也可选择 MinerU。
3. **分块**：根据标题、结构和 Token 预算生成带稳定索引的 chunk。
4. **向量化**：使用远程 API、Ollama、本地模型或纯关键词模式建立检索数据。
5. **召回**：BM25 与向量检索按配置运行，hybrid 模式通过 RRF 融合。
6. **整理证据**：可选 rerank 和 MMR 处理候选，Context Composer 生成受预算约束的有序上下文。
7. **模型续读**：模型可以从 `chunkIndex` 或锚点 ID 继续读取上下文或文档正文。

---

## 技术设计：从查询到可续读证据

dsh-knowledge 的检索目标不只是返回一组 Top K 文本，而是生成一条可解释、可降级、可继续阅读的证据链。显式搜索的主路径如下：

```text
当前查询
  └─ Query Planner：主查询 + 可选查询变体
       ├─ SQLite FTS5 / BM25 词法召回
       └─ embedding / cosine 向量召回
            └─ 加权 RRF 融合
                 └─ 可选 MMR 去冗余
                      └─ 可选 remote/local cross-encoder rerank
                           └─ Context Composer
                                ├─ 有序、限额的模型可见证据
                                └─ anchorChunkId / chunkIndex 锚点续读
```

### 召回、融合与排序

| 阶段 | 实现 | 设计目的 |
|---|---|---|
| Query Planner | 主查询始终来自当前消息；多查询变体先分别召回，再统一融合 | 避免历史覆盖当前问题，同时提高换说法查询的覆盖率 |
| 词法召回 | SQLite FTS5 trigram 索引、BM25 排序；查询侧识别 CJK 二元组与拉丁词 | 无 embedding、模型未下载或远程服务不可用时仍可搜索 |
| 向量召回 | 对查询 embedding 后执行余弦相似度检索，并校验向量维度 | 补充关键词未重合的语义命中 |
| RRF 融合 | `score(d) = Σᵢ wᵢ / (60 + rankᵢ(d))`，向量路权重由 `rrfVectorWeight` 控制 | 只融合名次，不直接混合量纲不同的 BM25 与 cosine 原始分数 |
| MMR | 在相关度与已选结果的向量相似度之间取舍 | 减少 Top K 中语义重复的片段 |
| Rerank | 对有界候选执行远程 API 或本地 cross-encoder；多查询最终只重排一次 | 让成本和延迟与候选池相关，而不是随查询变体重复增长 |
| 阈值 | 只对可比较的 vector 或 rerank relevance 分数应用 | 避免用同一个阈值错误过滤 BM25/RRF 排名分数 |

同分结果保留原召回顺序。rerank 必须返回与候选一一对应、有限且位于 `[0, 1]` 的分数；缺失、越界、数量不一致或协议不匹配都被视为降级，而不是成功。

### Context Composer：查询时连接上下文

分块负责稳定索引，Context Composer 负责模型实际看到的证据。插件不会把前后块永久拼入每个 chunk，也不会为桥接文本重复生成 embedding；它会在命中发生后批量读取相邻范围，并围绕 anchor 动态组装：

- 顺序固定为 `before → anchor → after`，默认不跨越不同 heading path。
- anchor 永远优先；超预算时围绕查询命中并尽量在句子边界裁剪。
- 相邻块存在至少 24 个字符的精确 suffix/prefix 重叠时去重，避免 overlap 被模型重复阅读。
- `SearchHit.text` 保持完整 canonical anchor；`ContextWindow` 只描述本次查询实际选择的窗口。
- 搜索结果携带稳定 `anchorChunkId` 和 `chunkIndex`。模型需要更多上下文时，可以围绕同一锚点续读，而不是重新猜测文档位置。

| 使用位置 | 固定预算 |
|---|---|
| Rerank pair | query 最多 128 Tokens、evidence 最多 352 Tokens、合计最多 480 Tokens |
| 显式 `knowledge_search` | 每个 hit 目标 768 Tokens，整次模型可见输出最多 8192 Tokens |
| 自动检索背景 | 每个 hit 最多 180 Tokens，完整背景最多 640 Tokens |
| 锚点续读 | 默认 1600 Tokens，可配置 128–4096 Tokens |

<details>
<summary>自动检索为什么不是“每轮都塞一遍 Top K”</summary>

自动检索采用 current-turn-first 的查询规划：当前消息最长保留 200 字符；只有消息不超过 40 字符，并含有“这个、上述、继续、第 N 步”等指代表达或缺少足够主题词时，才使用最近最多两条用户消息生成第二个历史增强查询。两个查询分别进行词法召回，再以 RRF 融合，历史不会替换当前问题。

整个首 Token 前路径共享 4 秒 wall-clock deadline。service 内部 rerank 被明确跳过，本地 reranker 调用次数固定为零；如果配置了远程 rerank，最多调用一次且不重试。取消立即退出，超时或 provider 错误则保留词法排序并停止注入，不会重复获得新的超时预算。

已经注入的 chunk 会在相关性判断和知识库席位分配前移除。同主题五分钟内最多补充一条新证据，新主题最多注入三条；每库的 `autoRetrieveWeight` 限制它能占用的席位。纯数字 ID 和型号、版本号、错误码走严格 identifier 通道，最终模型可见文本必须包含完整且边界正确的 identifier，否则不注入。

检索内容在注入时明确标记为不可信参考资料，不能覆盖当前用户指令、权限边界或工具规则。只有背景实际折叠成功后，去重和节流状态才会提交。

</details>

---

## 工程可靠性

| 风险 | 处理方式 | 对调用方的结果 |
|---|---|---|
| 空或失效的知识库/文档过滤 | `undefined` 才表示不限制；空集合明确匹配零文档，SQLite 词法和向量路均 fail-closed | 不会因过滤错误意外搜索全部资料 |
| 远程 rerank 超时或响应异常 | 共享 deadline、严格索引和分数校验、结构化 `rerank` 状态 | 返回原始召回结果，不误用 rerank 阈值 |
| 本地 rerank 卡死或崩溃 | 独立 child process、硬超时终止、按需重建，与 embedding worker 分离 | 当前搜索降级，embedding 生命周期不被连带重启 |
| 本地模型文件不完整或不兼容 | 检查配置、tokenizer 和非空 ONNX 权重；自检通过后写入带文件指纹和运行时版本的 readiness marker | 搜索不隐式下载，也不会把“目录里有 ONNX”误判为可用 |
| 连续本地 rerank 故障 | 队列总上限 16；连续 3 次 timeout/crash/runtime/invalid-response 后熔断 5 分钟，并限制半开探测 | 避免故障模型持续占用进程和延迟预算 |
| 替换重建或目录扫描部分失败 | 新 raw source、解析结果和索引成功后才替换已提交来源；逐文件保留结果 | 单个失败不破坏旧版本，也不掩盖同批成功项 |
| 插件发布物缺文件或跨平台差异 | Node 22.19/24 质量门槛、Windows/Linux/macOS 原生测试、Windows/Linux tarball 安装启动测试、可选真实本地 rerank smoke | npm tarball 与源码构建均受到自动化发布检查 |

这些约束的共同原则是：范围错误时宁可返回空，排序增强失败时宁可保留基础召回，涉及已提交资料时宁可保留旧版本。降级原因会通过结构化状态或界面提示暴露，而不是静默伪装成成功。

---

## 架构

一个 bundle 挂载三个插件行。本地 embedding 与 OCR 分别运行在独立 worker thread，本地 rerank 运行在可终止和重建的 child process；本地推理故障不会直接进入 DSH host 的执行空间。

| 组件 | 平台 | 职责 |
|---|---|---|
| `knowledge`（`ctx.knowledge`） | host | 存储、分块、embedding/解析调度、检索、OCR 调度及 `/knowledge/*` HTTP 服务 |
| `tool-knowledge` | host | 注册并执行 14 个模型工具 |
| `ui-knowledge` | client | 侧边栏入口、工作区管理面板及同源 API 调用 |
| `embed-worker` | worker thread | transformers.js 本地 embedding 推理；大模型不进入 host 进程 |
| `ocr-worker` | worker thread | mupdf 页面渲染、PaddleOCR、OpenCV 和 Tesseract 识别 |
| `rerank-process.mjs` | child process | 本地 cross-encoder 重排、超时隔离和进程级恢复 |

业务状态中的 `bases`、`documents` 和全局配置位于 `knowledge` storage domain；chunk 与可选 embedding 位于插件自己的 SQLite 存储；文件原始字节位于 SQLite 同级的 `knowledge-raw` 目录。

---

## 在 DSH 知识库与 RAG 生态中的定位

dsh-knowledge 的定位是“一体化文档知识库”，而不是宣称所有场景都优于专项插件。下面的对照用于说明设计边界：截至 **2026-09-04**，内容依据各项目默认分支的公开 README；“未在 README 中公开说明”不等同于该项目绝对不支持，对方项目更新后本表也可能过时。

<details>
<summary>查看 DSH 知识库与 RAG 项目对照</summary>

| 项目 | 公开定位与主要设计 | 与 dsh-knowledge 的边界差异 |
|---|---|---|
| [dsh-knowledge-base](https://github.com/htcqp802/dsh-knowledge-base) | 通用文档库，提供多格式导入、文件夹 UI、FTS5 trigram 与 BM25 | dsh-knowledge 在此基础范围外还覆盖向量/RRF/MMR/rerank、自动证据注入、ContextWindow、本地 OCR 与模型管理；对方更轻量 |
| [Mindspace Local RAG](https://github.com/Spirtxiaoqi7/mindspace-dsh-local-rag) | 技术完整的本地混合 RAG：BM25+、向量、RRF、父子分块、来源续查、文档修订与 compaction summary | Mindspace 明确坚持模型按需调用、刻意不做 rerank；其修订/回滚和会话摘要治理更专注。dsh-knowledge 更强调完整管理 UI、复杂格式/OCR、本地 cross-encoder 与可选自动注入 |
| [dsh-plugin-rag](https://github.com/mervyn-teo/dsh-plugin-rag) | 监听 DSH session 事件，增量维护可检索的跨会话语义记忆，向量保存在本地 JSON | 核心对象是会话表面而非用户文档；dsh-knowledge 处理文档来源、解析、重建、引用和锚点阅读，两者可以承担不同层次的记忆 |
| [dsh-ragflow](https://github.com/staff-os/dsh-ragflow) | 将 DSH 工具连接到已有 RAGFlow dataset，提供清晰的 provider/seam/tool/config 分层 | RAGFlow 负责建库和解析，插件公开说明自身仅做 retrieval；dsh-knowledge 无需另一套知识库服务即可完成导入到证据输出的闭环 |
| [dsh-plugin-kb4rag](https://github.com/yyang8891/dsh-plugin-kb4rag) | 面向论文写作，使用 Python 离线提取/建库、Ollama embedding 和 Node Float32Array Top K | 设计简单、运行时检索依赖少；dsh-knowledge 提供运行时导入/重建、混合召回、OCR、管理界面和多级证据续读 |
| [dsh-rag-kb](https://github.com/AlowEnsoul/dsh-rag-kb) | Ollama 向量检索、多知识库、JSON 持久化和可拖拽悬浮 UI | dsh-knowledge 使用 SQLite/FTS5 与多阶段排序，并进一步覆盖来源事务、本地模型健康体系、复杂 PDF OCR 和发布验证 |

</details>

在上述已检查项目中，没有单个项目在公开 README 中同时描述以下组合：

- 文件、目录、URL、文本的完整来源生命周期，以及可恢复 raw source 和安全重建；
- 本地复杂文档解析、扫描 PDF OCR、远程 MinerU 和 per-base 处理策略；
- BM25、向量、加权 RRF、MMR、多查询和本地/远程 rerank 的完整检索链；
- 查询时动态 ContextWindow、严格 Token 预算、自动证据注入和 anchor 续读；
- embedding、OCR、rerank 的独立运行单元、模型 readiness/self-test、降级状态和跨平台 tarball 验证。

因此，dsh-knowledge 的主要差异不是“又实现了一个向量搜索”，而是把资料进入系统之后直到模型取得可引用、可续读证据之间的工程环节放在同一个 DSH 原生 bundle 中，并为失败路径定义了可观察的行为。

---

## 兼容性

- **DSH**：在 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 提交 `b150a55`（2026.8.21）上开发并验证。若更新版本出现问题，请在 Issue 中附上 DSH 提交号。
- **Node.js**：`^22.19.0 || >=24.0.0`。
- **平台**：Windows、Linux x64/arm64、macOS Apple Silicon 支持完整功能。
- **Intel Mac**：onnxruntime 没有 darwin-x64 二进制，本地 embedding 与 OCR 不可用；可改用远程 OpenAI 兼容服务或 Ollama。
- **旧 Office 格式**：`.doc`、`.ppt`、`.xls` 依赖 `@firecrawl/anydoc` 的平台原生二进制。
- **首次联网**：本地 embedding 与 OCR 首次使用需要下载模型；纯关键词和远程 provider 不要求下载本地权重。

---

## 配置

部署默认值位于 `cordis.patch.yml` 的 `knowledge` 行。管理面板可以在运行时覆盖并持久化这些值；大多数检索和文档设置还可以按知识库覆盖。

<details>
<summary>查看完整配置字段</summary>

| 字段 | 默认 | 说明 |
|---|---:|---|
| `embeddingProvider` | `none` | `openai`、`ollama`、`local` 或 `none` |
| `embeddingBaseUrl` | `''` | embedding API 基址；Ollama 空值回退到本地标准端点 |
| `embeddingModel` | `''` | 远程模型名或 Hugging Face 本地模型仓库 ID |
| `embeddingApiKey` | `''` | 也可通过 `KNOWLEDGE_API_KEY` 设置 |
| `rerankModel` / `rerankBaseUrl` / `rerankApiKey` | `''` | 远程或 `local:` 重排；空模型表示关闭 |
| `localRerankTimeoutMs` | `60000` | 本地重排总预算，范围 10,000–300,000 ms，包含排队时间 |
| `smartChunk` | `true` | 标题/段落感知分块；关闭后只使用分隔符 |
| `chunkSeparator` | `\n\n` | `smartChunk` 关闭时的分隔符 |
| `chunkSize` | `800` | 分块 Token 目标预算 |
| `chunkOverlap` | `100` | 相邻分块重叠 Token 预算 |
| `topK` | `4` | 默认检索结果数，允许 1–50 |
| `searchMode` | `auto` | `auto`、`hybrid`、`vector` 或 `lexical` |
| `similarityThreshold` | `0` | 结果最低相似度，范围 0–1 |
| `mmrDiversity` | `0` | MMR 多样性，`0` 表示关闭 |
| `rrfVectorWeight` | `1` | hybrid 模式中向量召回的 RRF 权重 |
| `embeddingBatchSize` | `32` | 每批 embedding 文本数 |
| `siblingChunks` | `1` | 每侧相邻 chunk 数，范围 0–3；`0` 仍生成 anchor-only 窗口 |
| `semanticChunk` | `false` | 合并相邻相似语义段落 |
| `semanticChunkThreshold` | `0.75` | 语义分块余弦阈值 |
| `chunkTokenLimit` | `0` | 分块 Token 硬上限；`0` 表示不限制 |
| `conflictStrategy` | `rename` | 同名导入使用 `keep`、`replace` 或 `rename` |
| `urlRefreshHours` | `0` | URL 自动刷新间隔；`0` 表示关闭 |
| `imageCaptionProvider` | `off` | `off`、`openai` 或 `ollama` |
| `imageCaptionModel` | `''` | 图表描述使用的视觉模型 ID |
| `imageCaptionBaseUrl` | `''` | 图表描述 API 基址 |
| `imageCaptionApiKey` | `''` | OpenAI 兼容视觉服务密钥 |
| `hfEndpoint` | `''` | Hugging Face 下载端点或镜像 |
| `documentProcessorProvider` | `builtin` | `builtin` 本地解析或 `mineru` 远程处理 |
| `mineruApiKey` | `''` | MinerU 模式需要的 API Key |
| `mineruApiHost` | `''` | 空值使用 `https://mineru.net` |
| `resumeInterruptedOnStartup` | `true` | 启动时恢复中断的导入 |
| `autoRetrieve` | `true` | 用户消息进入时自动检索并注入相关背景 |
| `autoRetrieveWeight` | `3` | 每库自动注入席位上限，范围 0–5；`0` 表示排除 |
| `localModelCacheDir` | `''` | 空值使用 `<DSH_HOME>/cache/dsh-knowledge/local-models` |
| `localWorkerIdleTimeoutMs` | `60000` | 本地 embedding worker 空闲释放模型的时间；`0` 表示常驻 |
| `chunkStorePath` | `''` | 空值使用 `<DSH_HOME>/storages/knowledge-chunks.sqlite` |

按库设置中的空字段继承全局配置。`localModelCacheDir`、`localWorkerIdleTimeoutMs` 和 `chunkStorePath` 是进程级设置。API Key 以明文保存在本地机器，请保护 profile 数据目录。

</details>

---

## 召回效果评测

仓库提供两个无额外依赖的脚本，可针对自己的知识库复跑检索和 RAG 上下文指标：

```bash
# Hit@k、Recall@k、MRR
node scripts/eval-retrieval.mjs --file scripts/eval-questions.example.json --base <baseId> --mode hybrid

# Hit@k、句子级 Context Recall（RAGAS 风格近似，无需 LLM）、MRR
node scripts/eval-rag.mjs --file scripts/eval-rag.example.json --base <baseId> --topK 5
```

复制示例 JSON，替换成自己的问题、预期文档标题和参考答案后运行。仓库内固定合成语料用于防止版本回归，其结果不代表所有私有文档、语言或模型配置都能获得相同准确率。

---

## 开发与验证

源码开发依赖同级目录中的公开 DeepSeek Harness monorepo，`devDependencies` 使用 `link:../dsh/...`：

```bash
pnpm install --config.auto-install-peers=false
pnpm run check
pnpm run build
```

- `pnpm test`：分块、检索、配置、存储和服务测试。
- `pnpm run typecheck`：执行 `tsc --noEmit`。
- `pnpm run build`：构建 host ESM、浏览器 client bundle 和类型声明。
- `npm run release:check -- --expected-version <version>`：执行发布前完整门槛。

---

## 已知局限

- 模型选择器是带建议的可编辑组合框，不是 provider 的实时模型列表；可以手动输入自定义 ID。
- embedding 按批次运行在导入流程内；本地模型第一次下载会阻塞对应导入，但管理页面会显示进度。
- MinerU 需要官方或自托管服务的 API Key；未配置时使用本地解析与 OCR。
- 文本入口适合轻量笔记，不提供富文本编辑器。
- Intel Mac 无法运行基于 onnxruntime 的本地 embedding 和 OCR。

---

## 安全

安全问题请按照 [SECURITY.md](./SECURITY.md) 通过 GitHub 私密漏洞报告通道提交。不要在公开 Issue 中发布利用细节、凭据、私人文档或未脱敏日志。

普通功能缺陷和使用问题可以通过 [GitHub Issues](https://github.com/Soren-ABT/dsh-knowledge/issues) 报告。

---

## 许可

[AGPL-3.0](LICENSE)。项目的 PDF 页面渲染依赖 [mupdf](https://mupdf.com/)（AGPL-3.0），因此采用 AGPL-3.0 以保持分发许可一致。项目也与设计参考 [Cherry Studio](https://github.com/CherryHQ/cherry-studio) 使用相同许可证，但代码为独立实现，不包含 Cherry Studio 源码。

感谢 [dsh-interconnect](https://github.com/deepseek-ai/deepseek-harness)、[dsh-deeptutor](https://github.com/TecFancy/dsh-deeptutor)、[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 以及为项目提交代码和问题报告的社区贡献者。
