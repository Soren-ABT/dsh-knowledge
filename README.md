<div align="center">

#  dsh-knowledge

**DSH 的知识库插件**

[**English**](./README.en.md) · [**中文**](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-knowledge?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-knowledge)
[![npm downloads](https://img.shields.io/npm/dm/dsh-knowledge?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-knowledge)
![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)
[![Node.js >= 22](https://img.shields.io/badge/node.js-%3E%3D22-brightgreen?logo=nodedotjs)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-%23003B57?logo=sqlite)](https://www.sqlite.org/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

一个深度的**知识库系统**，作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的独立、可开源 bundle 插件。提供知识库（含**分组**）与文档管理、文本分块、向量化（OpenAI 兼容 / Ollama / **本地模型** / 关键词降级）、检索，以及模型可见工具与浏览器管理面板。

<img width="1000" height="667" alt="image" src="https://github.com/user-attachments/assets/8fab3aed-709e-4a59-87fa-c1a52c29c11e" />

</div>

---

## 为什么选择 dsh-knowledge

把项目手册、论文和团队 Wiki 放进 DSH，聊天时就能按问题查找原文，沿引用回到上下文。只用关键词即可开始；需要按语义查找时，再为相应知识库配置向量模型。

| 想做什么 | 可以怎样做 |
| --- | --- |
| 把资料放在一起 | 导入文件、目录、文本笔记、HTML 网页或 Markdown 原文链接。按项目给知识库分组，在面板中预览原文、分块和处理进度。 |
| 跟上资料更新 | 将目录绑定到 DSH 可访问的磁盘路径，手动或定时同步增删改。网页和 Markdown 来源可以原地刷新，保留文档 ID、所属目录和自定义标题。 |
| 读取扫描件与复杂 PDF | 对扫描 PDF 使用本地 OCR。对含表格、公式或多栏排版的文档，可选用云端或自部署 MinerU；保留了结构化来源的结果可定位到页码和区域。[MinerU 配置](./docs/mineru-self-hosted.md) |
| 搜到原话或相近表述 | 用关键词查编号和术语，用向量查同义表述，或用混合检索合并两路结果。可进一步按文档、标题、来源和更新时间筛选，启用重排调整顺序。 |
| 核对模型的引用 | 每个命中带有文档标题和分块位置。可从命中向前、向后续读；有结构化解析结果时，还可读取对应的原文块。面板的召回测试可查看得分、耗时并复制引用。 |
| 控制模型能看到什么 | 在面板启用本次对话要用的知识库。自动检索可在回答前补入相关资料，跟进提问可复用前文主题。也可以显式指定一个库或多个已启用的库。 |

## 安装并试用

使用 Node.js 24.9.0 或更高版本启动 DSH `0.2.2-rc.5`，选好一个 profile。将下面的条目合并到该 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 中。

```yaml
allowBuilds:
  esbuild: true
  onnxruntime-node: true
  protobufjs: true
  sharp: true
  tesseract.js: false
```

安装 npm 稳定版，或在 beta 发布后指定完整版本。把 `<profile>` 换成实际名称，选择一条命令即可。

```sh
dsh plugin --profile <profile> add dsh-knowledge
dsh plugin --profile <profile> add dsh-knowledge@0.6.0-beta.1
```

本地测试发布候选包时，运行 `dsh plugin --profile <profile> add ./dsh-knowledge-0.6.0-beta.1.tgz`。重启 DSH 的 Web 服务并刷新页面。

1. 打开侧边栏底部的「知识库」，新建一个库并导入一份熟悉的资料。支持 PDF、Word、PowerPoint、Excel、EPUB、Markdown、HTML、CSV、JSON 和纯文本等格式。
2. 在「召回测试」中输入资料里的一句话，查看命中段落和相邻原文。关键词检索可直接使用。
3. 启用这个库，在对话中问一个需要查证的问题，例如“手册里的退货期限是几天？请引用条款，并读一下后面的例外情况”。

## 检索与模型配置

| 使用场景 | 配置 |
| --- | --- |
| 本机离线查资料 | 使用默认关键词检索。要启用语义检索、重排或扫描件识别，可先在「本地模型」中下载对应模型，此后在本机运行。 |
| 已有推理服务 | 向量检索支持 OpenAI 兼容接口和 Ollama，重排可使用兼容的远程 rerank 接口。图像或表格描述可选配视觉模型。送往远程服务的内容取决于所启用的处理步骤。 |
| 不同项目需要不同设置 | 在全局配置中设置默认值，再按库覆盖分块、检索模式、模型或自动检索权重。更换向量模型后可重建该库索引。 |

## Agent 可以做什么

`knowledge_search` 接受 `baseId` 或 `baseIds`。例如，先用 `knowledge_list_bases` 取得库 ID，再把搜索限制在两个库，同时排除标题含“目录”的文档。

```json
{"query":"退货期限","baseIds":["<手册库 ID>","<条款库 ID>"],"titleExcludes":["目录"]}
```

省略库参数时使用面板启用的范围。显式传入 `baseIds: []` 会返回空结果。永久删除由 DSH 请求确认。

<details>
<summary>按用途查看 15 个模型工具</summary>

| 用途 | 工具 |
| --- | --- |
| 浏览知识库、文档和统计 | `knowledge_list_bases`、`knowledge_list_documents`、`knowledge_stats` |
| 检索、续读和核对证据 | `knowledge_search`、`knowledge_get_document`、`knowledge_read_document`、`knowledge_read_evidence` |
| 添加资料和刷新 URL | `knowledge_add_document`、`knowledge_import_url`、`knowledge_refresh_url` |
| 重建文档或知识库索引 | `knowledge_reindex_document`、`knowledge_reindex_base` |
| 创建知识库或删除资料 | `knowledge_create_base`、`knowledge_delete_document`、`knowledge_delete_base` |

</details>

## 运行与维护

- DSH 打包安装测试在 Windows 和 Ubuntu 上使用 `0.2.2-rc.5` 启动安装后的插件。Intel Mac 可使用关键词检索或远程模型。
- 备份时一并保存 DSH 的 storage-domain 元数据、分块 SQLite、`knowledge-raw` 原文和 `knowledge-artifacts` 解析产物。
- [版本记录](./CHANGELOG.md) · [检索评测](./benchmarks/README.md) · [贡献指南](./CONTRIBUTING.md) · [安全问题报告](./SECURITY.md) · [AGPL-3.0 许可](./LICENSE)
