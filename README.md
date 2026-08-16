# dsh-knowledge——dsh的知识库插件
[**English**](./README.en.md) / [**中文**](./README.md)

一个深度的**知识库系统**，作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的独立、可开源 bundle 插件。提供知识库（含**分组**）与文档管理、文本分块、向量化（OpenAI 兼容 / Ollama / **本地模型** / 关键词降级）、检索，以及模型可见工具与浏览器管理面板。

## 它带来什么

- **知识库与文档**：创建/删除/重命名知识库与文档；**分组管理**（新建/重命名/删除分组，侧边栏按分组折叠导航，知识库可在菜单中「移动到分组」）；**弹窗式添加文档（文本/文件/网页/目录四页签）**、多文件拖拽上传（≤20 个）、**目录导入**（递归扫描 txt/md/csv/html/json/pdf/docx/doc/pptx/ppt/xlsx/xls/epub 等，**导入为可下钻的文件夹树**）、URL 导入；**同名冲突「全部保留/替换」**、内容哈希去重；分块与原文预览；资料行显示 **✓ 就绪状态徽标、实时导入状态（解析中 / 嵌入中 NN%）与相对更新时间**，文件夹在任一后代处理时显示「导入中」；全部操作走正式对话框与 Toast 通知（无 window.prompt/confirm）。
- **每库独立配置**：每个知识库可单独指定 embedding 提供方/模型（含**本地模型**）、**重排模型**、分块大小与 topK（Cherry Studio 式），未设置字段自动继承全局配置；改配置后一键重建索引（全库或单条资料）。
- **向量化与检索**：可插拔 embedding 提供方 —— 任意 OpenAI 兼容 `/embeddings` 端点（OpenAI、DeepSeek、SiliconFlow、本地网关…）、Ollama，或 **进程内本地模型（transformers.js，默认 onnx-community/Qwen3-Embedding-0.6B-ONNX，无需联网服务）**；**混合检索**（BM25 + 向量 + Reciprocal Rank Fusion）、**重排模型（rerank，Jina/SiliconFlow/Cohere v2 风格 API）**、**MMR 结果去重**、检索模式（auto/hybrid/vector/lexical）与相似度阈值；未配置时自动退化关键词（CJK 二元组 + 拉丁词 BM25），零配置即可用；召回测试显示命中来源、相关度、双分数、**耗时**，并保留**检索历史**可一键重放。
- **智能分块**：标题感知分块（保留 Markdown 标题路径），并将「文档标题 + 标题路径」作为上下文注入 embedding 与检索，显著提升召回。
- **索引管理**：按当前配置**重建索引**（改分块大小 / 换 embedding 后一键重切 + 重向量化）、批量 embedding、统计（文档/分块/字符/Token 数、是否已向量化）。
- **模型工具**：`knowledge_search`、`knowledge_list_bases`、`knowledge_create_base`、`knowledge_delete_base`、`knowledge_add_document`、`knowledge_list_documents`、`knowledge_delete_document`、`knowledge_import_url`、`knowledge_stats`、`knowledge_get_document`、`knowledge_reindex_base`。
- **管理面板**：**不在设置内** —— 侧边栏底部（设置旁）的「知识库」入口打开工作区整页浮层，Cherry Studio 式布局：左侧搜索框 + **分组折叠导航** + 彩色头像知识库卡片（右键菜单：重命名/移动到分组/新建分组/删除），右侧统计芯片、**「更新于」时间**、添加文档弹窗、**表格化资料列表（勾选列 + 名称/类型/状态/更新时间 + 多选批量重建/批量删除）**、分块/原文预览、重建索引、检索测试（命中高亮 + 向量/关键词双分数 + 历史）、全局与每库设置弹窗（文档处理 / 嵌入模型 / 重排模型 / TopK / 高级设置）、Toast 通知、空状态与悬停动效。
- **本地模型管理（设置内）**：设置 →「本地模型」页面（`settings.section` 插槽），Cherry Studio 式卡片：模型名称/说明、**就绪徽标**、**下载 / 重试 / 删除** 按钮、**实时下载进度条**；下载后即可在知识库设置里选用「本地模型」作为向量化方式。
- **持久化**：业务状态（知识库/文档/运行时配置）经 DSH 官方 `storageDomain` seam 落盘（`json` 后端，默认随 `web` profile 提供）；**分块数据存于独立 SQLite 文件**（`<DSH_HOME>/storages/knowledge-chunks.sqlite`，可用 `chunkStorePath` 配置）——每分块一行、每次写入/删除为单条语句，不随数据量恶化；词法检索走 FTS5 三元组全文索引、向量检索查询时扫描存储的向量（Cherry Studio 同款姿态），启动不再全量载入内存。升级后首次启动自动完成旧数据迁移（幂等、去重）；无存储后端时自动降级为内存模式。

## 架构

一个 bundle 含三个插件行：

| 插件 | 平台 | 职责 |
|---|---|---|
| `knowledge`（`ctx.knowledge`） | host | 核心引擎：存储域、分块、embedding、检索、`/knowledge/*` HTTP 服务 |
| `tool-knowledge` | host | 11 个模型工具，消费 `ctx.knowledge` |
| `ui-knowledge` | client | 侧边栏底部入口（`sidebar.footer.action`）+ 工作区整页浮层（`shell.overlay`），Cherry Studio 式布局 |

数据模型（`storageDomain` 声明领域 `knowledge`，version 0）：

- `bases` 表：知识库元数据
- `documents` 表：文档元数据
- `chunks` 表：分块（含可选 `embedding` 向量）
- global 槽：运行时配置覆盖（embedding 提供方、分块大小、topK 等）

## 安装

本包声明 `dsh.bundle.patch`，`dsh plugin add` 会自动登记并插入插件行：

```bash
# 从 npm（发布后）
dsh plugin --profile <name> add dsh-knowledge

# 或从本地路径 / tarball
dsh plugin --profile <name> add file:/path/to/dsh-knowledge
dsh plugin --profile <name> add ./dsh-knowledge-0.1.0.tgz

# 或从 GitHub
dsh plugin --profile <name> add github:you/dsh-knowledge
```

> **pnpm 10+ 构建脚本白名单**：进程内本地嵌入运行时依赖 `onnxruntime-node`、`sharp`、`protobufjs`，pnpm 默认拒绝运行它们的 postinstall，`dsh plugin add` 会因此以非零退出、并在登记 bundle 前中断。请在**安装前**于 profile 的 `pnpm-workspace.yaml` 中加入以下内容，再重新执行 add：
>
> ```yaml
> allowBuilds:
>   onnxruntime-node: true
>   sharp: true
>   protobufjs: true
> ```
>
> （Windows 嵌入路径其实不依赖这些脚本——onnxruntime 的 Windows 二进制已内置，`sharp`/`protobufjs` 也未使用——但 pnpm 会把拒绝视为错误，授权是最干净的做法。）

重启 web 服务使 host 侧生效，刷新页面加载 client 面板。

> 插件安装在 **profile 层**（`dsh plugin` 会在 profile 目录里跑 pnpm），因此无论 DSH 是 npm 安装还是全新源码 clone，上面的安装命令完全一样——不涉及插件源码、checkout 链接或 DSH 构建。

## 兼容性

- **DSH 版本**：在 [deepseek-harness](https://github.com/deepseek-ai/DeepSeek-Harness) 提交 `47f943859b`（2026-08，npm 插件生态时代）上开发并验证。peer 依赖按 DSH 惯例声明为 `*`，更新的 DSH 源码也能无解析错误安装；若新版 DSH 出现兼容问题，请带上你运行的 DSH 提交号提 issue。
- **Node.js**：`^22.19.0 || >=24.0.0`（与 DSH 自身要求一致——分块存储使用 Node 内置 `node:sqlite`，DSH 自己的会话存储也在用）。
- **平台**：Windows / macOS / Linux x64 + arm64。旧版 `.doc` / `.ppt` / `.xls` 解析依赖 `@firecrawl/anydoc`（各平台原生二进制）；其余全为纯 JS。
- **首次运行联网**：启用 `embeddingProvider: local` 后首次使用会从 Hugging Face 下载模型权重（缓存于 `localModelCacheDir`）；需要时可设 `HF_ENDPOINT` 指向镜像。

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
| `chunkSize` | `800` | 分块字符数 |
| `chunkOverlap` | `100` | 相邻分块重叠字符数 |
| `topK` | `6` | 检索返回条数（1–50） |
| `searchMode` | `auto` | `auto` / `hybrid` / `vector` / `lexical` |
| `similarityThreshold` | `0` | 相似度阈值（0–1），低于该分数的结果被过滤 |
| `mmrDiversity` | `0` | MMR 结果多样性（0–1，0=关闭） |
| `embeddingBatchSize` | `32` | 每次 embedding 请求的文本条数 |
| `localModelCacheDir` | `''` | 本地模型缓存根目录；留空 = `<DSH_HOME>/cache/dsh-knowledge/local-models`（`DSH_HOME` 未设则为 `~/.dsh`） |
| `chunkStorePath` | `''` | 分块 SQLite 文件；留空 = `<DSH_HOME>/storages/knowledge-chunks.sqlite` |

分块数据不放在存储域 KV 里，而是独立 SQLite 文件：`web` profile 的 JSON 后端每次写记录都会重写整个单元文件，数据增长后删除/导入会变慢到秒级甚至分钟级；SQLite 让每次写入/删除都是单条语句，并提供 FTS5 三元组全文检索（BM25）与查询时向量扫描、有界读取——常驻内存不随语料增长。升级后首次启动会自动把旧 JSON 单元里的分块迁入 SQLite（幂等，中断产生的重复行自动去重）。

> 以上所有字段均可在**每个知识库的设置面板**中单独覆盖（Cherry Studio 式：留空继承全局）；API Key 以明文保存在本地存储（与 Cherry Studio 一致）。

### 本地模型（进程内 embedding）

选择 `embeddingProvider: local` 时，插件在 host 进程内用 `@huggingface/transformers`（+ onnxruntime）跑 embedding，**无需任何外部服务**。默认模型 `onnx-community/Qwen3-Embedding-0.6B-ONNX`（1024 维，Cherry Studio 同款），`embeddingModel` 可换成任意 Hugging Face 上的 ONNX embedding 仓库 id。首次使用会从 Hugging Face Hub 下载模型权重（默认缓存到 `$DSH_HOME/cache/dsh-knowledge/local-models`）；下载完成后后续导入与检索全程本地。**在设置 →「本地模型」页面可提前下载 / 取消 / 删除 / 重试**，并实时查看下载进度；知识库设置面板也会显示模型下载进度（下载中 % / 就绪 / 失败）；可用环境变量 `HF_ENDPOINT` 指向镜像加速下载。

## 使用

1. 点击**侧边栏底部「知识库」按钮**（设置旁），打开 Cherry Studio 式整页面板 —— 不在设置内。
2. 点「新建知识库」，选中后粘贴文本、拖拽上传 txt/md/pdf/docx，或导入网页 URL。
3. 在「检索测试」里验证召回（可切换混合/向量/关键词模式与阈值）；点右上角「设置」配置向量化。
4. 对 agent 说 *"用知识库里的内容回答…"*，模型会调用 `knowledge_search` 等 11 个工具。

## 开发

依赖公开的 DeepSeek Harness monorepo 作为 sibling checkout（`package.json` 的 `devDependencies` 用 `link:../dsh/...` 指向它，peer 依赖由该 checkout 提供）：

```bash
# 建立 sibling 链接（Windows 可用 junction）
#   mklink /J ..\dsh "D:\Program Files\deepseek harness"
pnpm install --config.auto-install-peers=false
pnpm run check    # typecheck + test + build
pnpm run build    # esbuild → lib/（含 client bundle）
```

## 验证

- `pnpm test`：分块、检索、配置、存储、服务级单测。
- `pnpm run typecheck`：tsc --noEmit。
- `pnpm run build`：host ESM 条目 + 浏览器 factory-form client bundle + 类型声明。

## 已知局限

- **模型下拉为建议式组合框，而非 provider 实时列表**：DSH 的 `ctx.llm` 只暴露对话模型（`listModels` 无 embedding 维度标记，且本插件的 embedding 端点/模型是独立配置）。设置面板因此用「内置精选建议 + 可输入自定义 id」的原生 datalist 组合框（嵌入 / 本地 / 重排三组建议）。
- **导入为后台异步执行，但嵌入在宿主进程内联完成**：解析与分块有实时逐文件状态（解析中 / 嵌入中 NN%），向量化以批次内联运行而非独立 worker 队列；本地模型首次下载会阻塞到缓存完成（设置面板实时显示进度）。
- **无 OCR / 无内置笔记编辑器**：图片与扫描版 PDF 无法提取文本（Cherry 依赖外部进程做 OCR，DSH 插件平台做不到）；笔记编辑请使用 DSH 自身。

## 许可

[MIT](LICENSE)。特别感谢 [Cherry Studio](https://github.com/CherryHQ/cherry-studio)：本项目界面与功能设计以其为灵感（AGPL-3.0），代码为独立实现，未包含其源码。另参考并致谢社区项目：[dsh-interconnect](https://github.com/deepseek-ai/deepseek-harness)、[dsh-deeptutor](https://github.com/TecFancy/dsh-deeptutor)、[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
