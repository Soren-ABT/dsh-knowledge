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

</div>

---

## 它带来什么

- **知识库与文档**：创建/删除/重命名知识库与文档；**分组管理**（新建/重命名/删除分组，侧边栏按分组折叠导航，知识库可在菜单中「移动到分组」）；**添加文档**（文件 / 网页 / 目录 / **文本（笔记）四入口**，纯文本亦可经模型工具 `knowledge_add_document`）、多文件拖拽上传（单文件 ≤22MB，文件选择器与拖拽均单次最多 20 个并过滤不支持扩展名，**5 路并发后台导入池**）、**目录导入**（递归扫描 txt/md/csv/html/json/pdf/docx/doc/pptx/ppt/xlsx/xls/epub 等，**导入为可下钻的文件夹树**，源文件复制进知识库 raw 存储，源盘变更后仍可重建）、URL 导入；**同名冲突弹窗决议**（服务端权威检测，**列出冲突文件名**，「全部重命名 / 替换 / 取消」+ 解析中锁定）、内容哈希去重；**文档预览**（PDF 内嵌查看器 + 文本/分块预览，超大文件自动截断）；资料行显示 **✓ 就绪状态徽标、实时导入状态（等待中 / 解析中 / 嵌入中 NN%）与相对更新时间**，失败行悬浮显示**本地化原因**（可聚焦、读屏可读），文件夹在任一后代处理时显示「导入中」；全部操作走正式对话框与 Toast 通知（无 window.prompt/confirm）。
- **扫描件 OCR（本地引擎）**：扫描版 PDF、**矢量绘制的无文本层 PDF** 与图片自动走**整页渲染 + PaddleOCR PP-OCRv5**（约 21MB 模型，含 1.8 万字符中文词典，设置 → 本地模型一键下载；页面用 mupdf WASM 渲染），识别失败自动回退 Tesseract；**1-bit 位图（JBIG2/CCITT 传真式扫描件）也能正确识别**；文本层损坏或逐字符排版的 PDF 会自动切换识别路径；识别文本照常分块、向量化、可检索。
- **每库独立配置**：每个知识库可单独指定 embedding 提供方/模型（含**本地模型**）、**重排模型**（远程 API 或 **本地 bge-reranker**）、分块大小与 topK、**语义分块**、冲突策略、URL 自动刷新等，未设置字段自动继承全局配置；改配置后一键重建索引（全库或单条资料）。
- **可选 MinerU 远程文档处理**：PDF 可交给 [MinerU](https://github.com/opendatalab/MinerU) 服务解析（公式、表格、版式还原成 Markdown），知识库设置里填入 MinerU API Key（全局或每库覆盖）即可；未配置时自动走本地解析链路。
- **向量化与检索**：可插拔 embedding 提供方 —— 任意 OpenAI 兼容 `/embeddings` 端点（OpenAI、DeepSeek、SiliconFlow、本地网关…）、Ollama，或 **进程内本地模型（transformers.js，默认 onnx-community/Qwen3-Embedding-0.6B-ONNX，无需联网服务）**；**混合检索**（BM25 + 向量 + Reciprocal Rank Fusion）、**重排模型（rerank，Jina/SiliconFlow/Cohere v2 风格 API 或本地跨编码器）**、**MMR 结果去重**、检索模式（auto/hybrid/vector/lexical）与相似度阈值、**多查询检索（extraQueries，换说法/翻译扩召回）**；未配置时自动退化关键词（CJK 二元组 + 拉丁词 BM25），零配置即可用；召回测试显示命中来源、相关度、双分数、**耗时**，**复制引用（Markdown 引用块 + 来源行）**，并保留**检索历史**可一键重放。
- **智能分块**：标题感知分块（保留 Markdown 标题路径，**代码围栏保护**），并将「文档标题 + 标题路径」作为上下文注入 embedding 与检索；分块大小/重叠为 **Token 预算**（按文档实测字符/Token 比换算，与 Cherry Studio 一致），长块按 **Cherry 断点评分模型**切分（标题 100 → 代码边界 80 → 分隔线 60 → 段落 20 → 句读 8 → 列表 5 → 裸换行 1，窗口内距离衰减），CJK/拉丁语混排窗口大小一致；**语义分块**（段落嵌入 + 相邻相似段合并，零额外嵌入开销）与 **Token 上限细化**（超限在句号/逗号/空格边界继续切分）可选开启。
- **索引管理**：按当前配置**重建索引**（改分块大小 / 换 embedding 后一键重切 + 重向量化）、批量 embedding、统计（文档/分块/字符/Token 数、是否已向量化）。
- **模型工具**：`knowledge_search`（含 citations 引用数组）、`knowledge_list_bases`、`knowledge_create_base`、`knowledge_delete_base`、`knowledge_add_document`、`knowledge_list_documents`、`knowledge_delete_document`、`knowledge_import_url`、`knowledge_refresh_url`、`knowledge_stats`、`knowledge_get_document`、`knowledge_read_document`（按字符区间分段阅读 / 正则定位）、`knowledge_reindex_document`、`knowledge_reindex_base`（共 14 个）。
- **管理面板**：**不在设置内** —— 侧边栏底部（设置旁）的「知识库」入口打开工作区整页浮层，布局：左侧搜索框 + **分组折叠导航** + 彩色头像知识库卡片（右键菜单：重命名/移动到分组/新建分组/删除），右侧统计芯片、**「更新于」时间**、添加文档弹窗、**表格化资料列表（勾选列 + 名称/类型/状态/更新时间 + 多选批量重建/批量删除）**、分块/原文预览、重建索引、检索测试（命中高亮 + 向量/关键词双分数 + 历史 + 复制引用）、全局与每库设置弹窗（文档处理 / 图表描述 / 嵌入模型 / 重排模型 / TopK / 高级设置）、Toast 通知、空状态与悬停动效。
- **本地模型管理（设置内）**：设置 →「本地模型」页面（`settings.section` 插槽），**嵌入、重排与 OCR 模型卡片**：模型名称/说明、**就绪徽标**、**下载 / 重试 / 删除** 按钮、**实时下载进度条**；**模型缓存目录可配置**（原生文件夹选择器 + 打开目录 + **一键迁移**已下载模型到新位置，迁移自动跳过隐藏目录、不会把目标目录复制进自身，不再盲目占满 C 盘）；**Ollama 管理**（拉取/取消/删除、**已装模型卡片列表（含大小）**、下载进度卡片、嵌入与视觉模型推荐）。
- **持久化**：业务状态（知识库/文档/运行时配置）经 DSH 官方 `storageDomain` seam 落盘（`json` 后端，默认随 `web` profile 提供）；**分块数据存于独立 SQLite 文件**（`<DSH_HOME>/storages/knowledge-chunks.sqlite`，可用 `chunkStorePath` 配置）——每分块一行、每次写入/删除为单条语句，不随数据量恶化；词法检索走 FTS5 三元组全文索引、向量检索使用**常驻内存缓存**（Float32Array，精确失效），启动不再全量载入内存。升级后首次启动自动完成旧数据迁移（幂等、去重）；无存储后端时自动降级为内存模式。

---

## 架构

一个 bundle 含三个插件行，另有两个**独立 worker 线程**承载推理（与 Cherry 的 own-worker 姿势一致，原生/WASM 崩溃不会波及 host 进程）：

| 插件 / 线程 | 平台 | 职责 |
|---|---|---|
| `knowledge`（`ctx.knowledge`） | host | 核心引擎：存储域、分块、embedding、检索、OCR 调度、`/knowledge/*` HTTP 服务 |
| `tool-knowledge` | host | 14 个模型工具，消费 `ctx.knowledge` |
| `ui-knowledge` | client | 侧边栏底部入口（`sidebar.footer.action`）+ 工作区整页浮层（`shell.overlay`），Cherry Studio 式布局 |
| `embed-worker`（worker 线程） | host | transformers.js 本地嵌入推理（模型 ~600MB 不进 host 进程） |
| `ocr-worker`（worker 线程） | host | 页面渲染（mupdf WASM）+ PaddleOCR / Tesseract 识别（onnxruntime、OpenCV、tesseract worker 全隔离在线程内） |

数据模型（`storageDomain` 声明领域 `knowledge`，version 0）：

- `bases` 表：知识库元数据
- `documents` 表：文档元数据
- `chunks` 表：分块（含可选 `embedding` 向量）
- global 槽：运行时配置覆盖（embedding 提供方、分块大小、topK 等）

---

## 安装

本包已发布到 [npm](https://www.npmjs.com/package/dsh-knowledge)（声明 `dsh.bundle.patch`），`dsh plugin add` 会自动登记并插入插件行：

```bash
# 从 npm（推荐，无需构建）
dsh plugin --profile <name> add dsh-knowledge

# 从发布 tarball（GitHub Releases 或 npm pack 产物）
dsh plugin --profile <name> add ./dsh-knowledge-0.3.4.tgz

# 从本地源码目录（需先构建，见下方「开发」）
dsh plugin --profile <name> add file:/path/to/dsh-knowledge
```

> **pnpm 10+ 构建脚本白名单（必须）**：插件依赖的 `onnxruntime-node`、`sharp`、`protobufjs`、`tesseract.js` 都带 postinstall，pnpm 默认拒绝运行它们并以非零退出——`dsh plugin add` 会因此**在登记 bundle 前中断，插件不会生效**。请在**安装前**于 profile 的 `pnpm-workspace.yaml` 中加入以下内容，再执行 add：
>
> ```yaml
> allowBuilds:
>   onnxruntime-node: true
>   sharp: true
>   protobufjs: true
>   tesseract.js: true
> ```
>
> （各平台二进制均已内置在 npm 包内，跳过这些脚本不损害功能；但 pnpm 把拒绝视为错误，授权是最干净的做法。装完后再补上配置、重跑一次 add 也可以——包已在 node_modules，重跑会正常登记。）

重启 web 服务使 host 侧生效，刷新页面加载 client 面板。

> 插件安装在 **profile 层**（`dsh plugin` 会在 profile 目录里跑 pnpm），因此无论 DSH 是 npm 安装还是全新源码 clone，上面的安装命令完全一样——不涉及插件源码、checkout 链接或 DSH 构建。

### 零基础：只装了 DSH，怎么装到「和我一样」的功能

一条命令之外，全部功能（本地嵌入、OCR、扫描件识别、混合检索、管理面板）都随插件自带，**没有任何个人配置或外部服务依赖**。只需要满足四个前提：

1. **Node.js ≥ 22 与 pnpm ≥ 10 在 PATH 中**（DSH 本身即以此为前提；`dsh plugin add` 内部直接调用 pnpm，没有 pnpm 会提示你安装）。
2. **先写好 `allowBuilds` 再执行 add**（见上方黑名单块——这是唯一的「安装前必须」步骤，profile 的 `pnpm-workspace.yaml` 首次初始化时会自动生成，只需往里追加那 4 行）。
3. **模型下载的网络可达**：
   - **本地嵌入模型**（约 585MB，Qwen3-Embedding-0.6B）：国内默认走 Hugging Face 镜像；如需自定义镜像，在知识库面板「设置 → 高级设置」或设置 → 本地模型页填 `hfEndpoint`（或设环境变量 `HF_ENDPOINT`）。
   - **OCR 模型**（约 21MB，PaddleOCR）：默认从 hf-mirror.com 下载；**海外用户**请在同一个 `hfEndpoint` 填 `https://huggingface.co`，OCR 与嵌入模型都会改走该端点。
   - 不下载也可以正常使用（远程 OpenAI 兼容 / Ollama 嵌入 + 纯文本 PDF），只是本地向量化与扫描件识别不可用。
4. **平台**：Windows / macOS（Apple Silicon）/ Linux x64 + arm64 全功能；**Intel Mac（macOS x64）本地嵌入与 OCR 不可用**（onnxruntime 无 darwin-x64 二进制），请改用远程嵌入（OpenAI 兼容 / Ollama）。

装好后首次使用：设置 →「本地模型」下载嵌入模型（或直接给知识库配远程 embedding），需要扫描件识别再下载 OCR 模型——之后的功能与本仓库开发机完全一致。

---

## 兼容性

- **DSH 版本**：在 [deepseek-harness](https://github.com/deepseek-ai/DeepSeek-Harness) 提交 `b150a55`（2026.8.21）上开发并验证。插件不再声明 peer 依赖——DSH 宿主以 externals 注入 cordis/zod/存储等运行时；更新的 DSH 源码也能无解析错误安装。若新版 DSH 出现兼容问题，请带上你运行的 DSH 提交号提 issue。
- **Node.js**：`^22.19.0 || >=24.0.0`（与 DSH 自身要求一致——分块存储使用 Node 内置 `node:sqlite`，DSH 自己的会话存储也在用）。
- **平台**：Windows / macOS（Apple Silicon）/ Linux x64 + arm64 全功能。旧版 `.doc` / `.ppt` / `.xls` 解析依赖 `@firecrawl/anydoc`（各平台原生二进制）；`@napi-rs/canvas` 的 Windows 平台包声明为 optionalDependencies，非 Windows 平台自动跳过。**Intel Mac（darwin-x64）**：onnxruntime 无该平台二进制，本地嵌入与本地 OCR 不可用，请用远程嵌入（OpenAI 兼容 / Ollama）。
- **首次运行联网**：启用 `embeddingProvider: local` 后首次使用会从 Hugging Face 下载模型权重（缓存于 `localModelCacheDir`）；OCR 模型（约 21MB）在设置 → 本地模型页下载。两者都可经面板的 `hfEndpoint` 字段或环境变量 `HF_ENDPOINT` 指向镜像（OCR 默认 hf-mirror.com，海外可改为 huggingface.co）。

---

## 配置

部署默认值写在 `cordis.patch.yml` 的 `knowledge` 行（可用上层 patch 按 `id` 覆盖）；面板里的「设置」可运行时覆盖，覆盖值持久化在存储域中：

| 字段 | 默认 | 说明 |
|---|---|---|
| `embeddingProvider` | `none` | `openai` / `ollama` / `local`（进程内 transformers.js）/ `none` |
| `embeddingBaseUrl` | `''` | 端点基址，如 `https://api.openai.com/v1` 或 `http://127.0.0.1:11434`（`local` 不需要） |
| `embeddingModel` | `''` | 如 `text-embedding-3-small`；`local` 时为 Hugging Face 仓库 id（默认 `onnx-community/Qwen3-Embedding-0.6B-ONNX`） |
| `embeddingApiKey` | `''` | 可选；也可用环境变量 `KNOWLEDGE_API_KEY` |
| `rerankModel` / `rerankBaseUrl` / `rerankApiKey` | `''` | 重排模型（留空=不启用），Jina / SiliconFlow / Cohere v2 风格接口 |
| `smartChunk` | `true` | 智能分段（标题/段落感知）；关闭后仅按 `chunkSeparator` 切分 |
| `chunkSeparator` | `\n\n` | 智能分段关闭时的段落边界（可写 `\n`） |
| `chunkSize` | `800` | 分块 Token 预算（按文档实测字符/Token 比换算字符窗口；对齐 Cherry Studio） |
| `chunkOverlap` | `100` | 相邻分块重叠 Token 数（同上换算） |
| `topK` | `6` | 检索返回条数（1–50） |
| `searchMode` | `auto` | `auto` / `hybrid` / `vector` / `lexical` |
| `similarityThreshold` | `0` | 相似度阈值（0–1），低于该分数的结果被过滤 |
| `mmrDiversity` | `0` | MMR 结果多样性（0–1，0=关闭） |
| `rrfVectorWeight` | `1` | RRF 混合时向量路的相对权重（0.1–5，1=均衡） |
| `embeddingBatchSize` | `32` | 每次 embedding 请求的文本条数 |
| `siblingChunks` | `1` | 检索命中附带的上下文块数（±N，0–3，0=关闭） |
| `semanticChunk` | `false` | 语义分块：段落嵌入 + 相邻相似段合并（按库可覆盖） |
| `semanticChunkThreshold` | `0.75` | 语义分块合并阈值（0–1） |
| `chunkTokenLimit` | `0` | 分块 Token 上限（0=不限制）；超限在句号/逗号/空格边界继续切分 |
| `conflictStrategy` | `rename` | 同名文件导入策略：`rename`（自动 `_1` 后缀）/ `replace` / `keep` |
| `urlRefreshHours` | `0` | URL 文档定时自动刷新间隔（小时，0=关闭） |
| `imageCaptionProvider` | `off` | PDF 图表描述：`off` / `openai`（兼容视觉 API）/ `ollama`（本地 VLM） |
| `imageCaptionModel` | `''` | 图表描述模型 id（如 `qwen2.5vl`、`gpt-4o-mini`） |
| `imageCaptionBaseUrl` | `''` | 图表描述 API 地址；留空 = 嵌入基址（openai）或 `http://127.0.0.1:11434`（ollama） |
| `imageCaptionApiKey` | `''` | 图表描述 API Key（openai 提供方） |
| `hfEndpoint` | `''` | Hugging Face 端点（嵌入模型与 OCR 模型的下载镜像）；留空 = 嵌入走 transformers 默认、OCR 走 hf-mirror.com |
| `documentProcessorProvider` | `builtin` | PDF 文档处理：`builtin`（本地解析 + 可选 OCR）/ `mineru`（远程 MinerU 服务） |
| `mineruApiKey` | `''` | MinerU API Key（`mineru` 模式需要；全局或每库覆盖） |
| `mineruApiHost` | `''` | MinerU 服务地址；留空 = 官方 `https://mineru.net` |
| `localModelCacheDir` | `''` | 本地模型缓存根目录；留空 = `<DSH_HOME>/cache/dsh-knowledge/local-models`（`DSH_HOME` 未设则为 `~/.dsh`） |
| `chunkStorePath` | `''` | 分块 SQLite 文件；留空 = `<DSH_HOME>/storages/knowledge-chunks.sqlite` |

分块数据不放在存储域 KV 里，而是独立 SQLite 文件：`web` profile 的 JSON 后端每次写记录都会重写整个单元文件，数据增长后删除/导入会变慢到秒级甚至分钟级；SQLite 让每次写入/删除都是单条语句，并提供 FTS5 三元组全文检索（BM25）与查询时向量扫描、有界读取——常驻内存不随语料增长。升级后首次启动会自动把旧 JSON 单元里的分块迁入 SQLite（幂等，中断产生的重复行自动去重）。

> 以上所有字段均可在**每个知识库的设置面板**中单独覆盖（留空继承全局）；API Key 以明文保存在本地存储。

### 本地模型（进程内 embedding 与 OCR）

选择 `embeddingProvider: local` 时，插件在**独立 worker 线程**里用 `@huggingface/transformers`（+ onnxruntime）跑 embedding，**无需任何外部服务**。默认模型 `onnx-community/Qwen3-Embedding-0.6B-ONNX`（1024 维），`embeddingModel` 可换成任意 Hugging Face 上的 ONNX embedding 仓库 id。首次使用会从 Hugging Face Hub 下载模型权重（默认缓存到 `$DSH_HOME/cache/dsh-knowledge/local-models`）；下载完成后后续导入与检索全程本地。**在设置 →「本地模型」页面可提前下载 / 取消 / 删除 / 重试**，并实时查看下载进度；知识库设置面板也会显示模型下载进度（下载中 % / 就绪 / 失败）。

**OCR（扫描件识别）**：下载 OCR 模型后，扫描版 / 矢量无文本层 / 文本层损坏的 PDF 在导入时自动**渲染整页**（mupdf WASM）并识别（PaddleOCR PP-OCRv5 优先，失败回退 Tesseract，全部在 `ocr-worker` 线程内）。模型约 21MB，默认从 hf-mirror.com 下载；海外用户可在同一 `hfEndpoint` 字段填 `https://huggingface.co`。

---

## 召回效果评测（自带工具，可对任意库复跑）

`scripts/` 内置两套评估脚本，对**你自己的知识库**运行，无需任何外部服务：

```bash
# 检索质量：Hit@k / Recall@k / MRR（示例集见 scripts/eval-questions.example.json）
node scripts/eval-retrieval.mjs --file scripts/eval-questions.example.json --base <baseId> --mode hybrid

# RAG 上下文质量：Hit@k + 句子级 Context Recall（RAGAS 风格近似，无需 LLM）+ MRR
# （示例集见 scripts/eval-rag.example.json，需带 groundTruth 参考答案）
node scripts/eval-rag.mjs --file scripts/eval-rag.example.json --base <baseId> --topK 5
```

把 `*.example.json` 复制为 `eval-questions.json` / `eval-rag.json` 并替换成你的问题（`expect` 为期望命中的文档标题子串）即可复跑。开发期间用内部评测集（覆盖库内文档主题的数学建模问题）测得：直答型问题纯词法 Hit@5 0.929；换说法型（问题不含主题词）纯词法 0.600 → 混合/向量 0.900（MRR 0.575 → 0.628）——向量检索的价值主要体现在换说法型问题。该内部评测集已随隐私清理从仓库移除（含个人文档标题），故分数仅供参比，请用你自己的数据复测。

---

## 使用

1. 点击**侧边栏底部「知识库」按钮**（设置旁），打开整页面板 —— 不在设置内。
2. 点「新建知识库」，拖拽上传 txt/md/pdf/docx，或导入网页 URL；扫描版 PDF 也可直接拖入（设置 → 本地模型下载 OCR 模型后自动识别）。
3. 在「检索测试」里验证召回（可切换混合/向量/关键词模式与阈值）；点右上角「设置」配置向量化。
4. 对 agent 说 *"用知识库里的内容回答…"*，模型会调用 `knowledge_search` 等 14 个工具。

---

## 开发

依赖公开的 DeepSeek Harness monorepo 作为 sibling checkout（`package.json` 的 `devDependencies` 用 `link:../dsh/...` 指向它，peer 依赖由该 checkout 提供）：

```bash
# 建立 sibling 链接（Windows 可用 junction，指向你的 DSH 安装目录）
#   mklink /J ..\dsh "<你的 DSH 安装目录>"
pnpm install --config.auto-install-peers=false
pnpm run check    # typecheck + test + build
pnpm run build    # esbuild → lib/（含 client bundle）
```

## 验证

- `pnpm test`：分块、检索、配置、存储、服务级单测。
- `pnpm run typecheck`：tsc --noEmit。
- `pnpm run build`：host ESM 条目 + 浏览器 factory-form client bundle + 类型声明。

---

## 已知局限

- **模型下拉为建议式组合框，而非 provider 实时列表**：DSH 的 `ctx.llm` 只暴露对话模型（`listModels` 无 embedding 维度标记，且本插件的 embedding 端点/模型是独立配置）。设置面板因此用「内置精选建议 + 可输入自定义 id」的原生 datalist 组合框（嵌入 / 本地 / 重排三组建议）。
- **嵌入在导入流程内联执行**：解析与分块有实时逐文件状态（解析中 / 嵌入中 NN%），向量化以批次内联运行（推理在独立 worker 线程，不阻塞 UI，但同一知识库的导入按 5 路并发池排队）；本地模型首次下载会阻塞到缓存完成（设置面板实时显示进度）。
- **MinerU 需 API Key**：`documentProcessorProvider: mineru` 依赖 MinerU 官方服务（或自托管 host），需要注册获取 Key；未配置时 PDF 自动走本地解析 + OCR。
- **轻量文本（笔记）入口**：添加菜单中的「文本」可粘贴标题 + 内容直接入库（无内置富文本编辑器，笔记编辑请使用 DSH 自身）。

---

## 许可

[AGPL-3.0](LICENSE)。本项目采用 AGPL-3.0 许可——PDF 整页渲染依赖 [mupdf](https://mupdf.com/)（AGPL-3.0），AGPL 许可对包含该组件的发行物具有传染性；选择 AGPL-3.0 使整个项目在法律上自洽，也与设计灵感 [Cherry Studio](https://github.com/CherryHQ/cherry-studio)（AGPL-3.0）的许可一致。代码为独立实现，未包含 Cherry Studio 源码。另参考并致谢社区项目：[dsh-interconnect](https://github.com/deepseek-ai/deepseek-harness)、[dsh-deeptutor](https://github.com/TecFancy/dsh-deeptutor)、[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
