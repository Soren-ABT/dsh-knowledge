# 发布收尾计划：稳定插件 + 实验性托管 MinerU

日期：2026-09-28。

状态：发布定位已获用户确认；下述技术实施计划为本轮交付的待执行草案。
用户选择：**插件稳定发布；托管 MinerU 经实测后保留实验性标注。**
本轮只编写计划；本文件不代表已经执行修复、下载模型、提交、推送或发布。

## 1. 目标、取舍和边界

本次目标是让当前开发成果成为可安装、可恢复、可验证的发布候选。
保留内置解析、原有云 API、自部署 MinerU 接入、结构化证据和现有检索能力。
托管安装首期只交付 Basic / ONNX，安装前明确展示环境、路径、下载源与空间信息。

三种交付方案的取舍：

| 方案 | 代价与结果 | 本次决定 |
| --- | --- | --- |
| 插件稳定版 + 实测后的托管 Preview | 既有功能必须通过稳定版门槛；托管能力按已验收组合声明支持 | 采用 |
| 托管功能也全面稳定 | 还需更完整的安装恢复、卸载、平台与环境覆盖 | 后续升级目标 |
| 本次仅发布外部服务接入 | 发布更快，但用户仍需自行搭建服务 | 托管验收失败时的降级交付方案，需要明确调整发行范围 |

本次不扩大到 Standard/Advanced 一键安装、自动安装 Python/CUDA、GraphRAG、
新的 embedding 空间迁移、Issue #6 或全面视觉重设计。旧版设计文档中尚未实现的这些
内容列为后续工作，不继续作为本次发布的隐含承诺。

安装和解析始终是两个独立的显式动作。安装 npm 插件、打开设置或探测 Python
不得下载模型；本地解析不得隐式切换云 API。用户已有云配置、文件、索引和模型目录应继续可用。

## 2. 已知基线与证据等级

当前分支 `feat/mineru-structured-evidence`，最近提交 `9b784de`，包版本 `0.4.1`。
工作区包含 11 个已跟踪文件的修改，以及托管部署源码、测试和设计文档等未跟踪文件。
这些是现有开发成果，实施时逐项核对归属，不用 reset、clean 或批量覆盖处理。

上一轮记录的结果：35 个测试文件、442 个测试通过；typecheck、build、package verification、
release metadata verification 通过。它们是已有验证记录，最终发行仍需绑定最终代码提交重新验收。
`audit:prod` 本机执行因访问 npm registry 失败，没有获得有效审计结论。

需要正确解释两项现状：

- 工作区尚未提交是交付状态，不应单独记成代码缺陷；最终发布前必须形成可复现的干净提交。
- `verify:release` 当前通过，只说明现有 0.4.1 元数据一致，不证明新增功能已经包含在新版发布说明中。

代码与验证缺口登记：

| 编号 | 当前证据 | 实施时的处理 |
| --- | --- | --- |
| R1 | `mineru-download.ts` 固定访问 huggingface.co；`mineru-runtime.ts` 固定 PyPI，未接入现有镜像选择 | 已确认行为，补下载源设置和实际源展示 |
| R2 | `prepare()` 会先替换当前 state；失败后 `start()` 要求 phase 为 ready | 代码级风险；先用已有 ready 安装重装失败/取消的用例复现，再修复 |
| R3 | 新目录无 deployment.json 时，preflight 的 ENOENT 分支保留旧 state；UI 又持有独立路径草稿 | 代码级风险；验证 A/B 目录切换，消除状态与操作对象歧义 |
| R4 | ownership marker 与 restore 对根路径使用字符串全等 | 代码级风险；在 Windows 验证盘符/目录大小写变化后制定一致身份比较 |
| R5 | runtime 命令丢弃 stderr；部分失败只报告 preparation_failed | 已确认诊断能力不足；补有界、脱敏的阶段化错误 |
| R6 | 真实模型安装/推理及浏览器验收未完成；现有 CI 无托管安装 smoke | 已确认验收缺口，补独立实测与报告 |
| R7 | 固定引擎版本但 Python 传递依赖仍按安装当日解析 | 已知可复现性限制，为实际支持的组合冻结依赖约束 |

不能把这些候选问题全部写成“已复现 bug”，也不能用单元测试通过推导真实 OCR 效果。

## 3. 执行顺序与阶段产物

共 8 步。第 1–2 步确定基线和兼容目标，第 3–5 步形成修复，第 6–7 步验收，
第 8 步整理可审查的发布候选。第 3–4 步之间安排一次最小真实安装探针，尽早发现上游契约问题；
最后仍须完成第 6 步的完整验收。

### 第 1 步：冻结本次范围，建立可追溯基线

工作：

1. 记录 HEAD、已跟踪/未跟踪改动、当前版本、已有验证结果及测试环境。
2. 比较当前分支与最新 main；实施期间保留已有提交，不把功能改动丢到新的空分支。
   如 main 已前进，先安全整合，再验证受影响模块。
3. 将现有结构化证据、托管部署和 UI 改动分别列入交付清单；确认它们之间的依赖。
4. 标记旧设计中的延期项，避免“设计过”被误读为“已实现”。
5. 在修复提交准备好后，使用显式文件清单暂存；不把私人诊断、模型、虚拟环境或临时产物纳入 Git。

产物：基线清单、缺陷登记、候选提交划分。
完成条件：每个待交付文件都有用途；无来源不明的改动被覆盖或丢弃。

### 第 2 步：核对上游契约和生产依赖

主要文件：`mineru-manifest.ts`、`mineru-runtime.ts`、`mineru-local.ts`、
`parsed-document.ts`、`scripts/audit-production.mjs`。

工作：

1. 以固定 tag 的源码、包元数据和 API 响应为依据，核对启动参数、配置路径、模型目录布局、
   必需文件、输出 schema、模型就绪判定及 completion marker 行为。
   官方文档提及文件与 completion marker 共同影响就绪状态，不能仅凭下载哈希推断本地模式可加载。
   若需要额外就绪元数据，应使用上游验证流程；不得手写假 marker 跳过验证。
2. 默认继续以 4.0.6 为兼容基线；比较 4.0.7 的相关修复。只有影响本次路径的问题或验证收益明确时
   才升级，升级必须同时更新 runtime pin、适配测试、模型兼容记录和实测报告。
3. Python 3.10–3.14 只表示解释器候选范围；单独记录实际经过依赖安装和推理验证的 OS/架构/minor 组合。
4. 为已验收组合生成完整的版本约束文件，安装使用固定 MinerU 版本和该组合的 constraints。
   记录完整依赖版本、约束摘要及关键推理库版本。未验收组合不能套用另一平台的约束文件。
   如新增运行时资源文件，build 必须复制到 lib，package verifier 必须检查其存在和引用路径。
5. 在能访问 registry 的环境重跑生产审计。区分连接失败、审计格式错误和真实漏洞，均不可记作通过。
6. 复核当前两项 sharp 风险例外：当前到期日为 2026-10-14。依据实际调用路径和修复版本决定处理，
   不为赶发布删除审计步骤或直接延长期限。托管 Python 依赖也保留对应的依赖审计结果。

产物：固定版本兼容记录、已验收组合的依赖约束、有效的依赖审计报告。
完成条件：上游安装/解析契约有可核验依据；阻断漏洞已处理，任何保留例外都有独立理由和有效期限。

### 第 3 步：修复托管状态、重试和恢复

主要文件：`mineru-deployment.ts`、`mineru-deployment-types.ts`、
`mineru-deployment-plan.ts`、`mineru-runtime.ts`、相关生命周期测试。

设计：

- 区分“最后一次验证成功的安装”“当前候选安装任务”和“当前服务进程”。
  保留现有 API 字段，新增必要的 installationId、operationId、失败阶段与已验证安装摘要。
- 候选环境使用独立目录；候选配置不得覆盖已验证配置。只有文件验证和真实 probe 均成功后
  才原子更新当前可用安装指针。失败/取消时仍可启动上一次已验证安装。
- 准備路径、已部署路径和当前服务绑定对象各有明确身份。预检不应静默切换活跃安装；
  多目录场景必须明确显示下一次操作的目标。
- Windows 使用规范化路径身份比较，同时保留可显示的路径；延续对链接/junction 逃逸的拒绝。
- 所有状态更新绑定 operation/generation；迟到进度与旧子进程退出消息不能覆盖新任务。
- 将失败阶段、稳定错误码、可重试性与保留资源分开记录。诊断输出设置大小上限并脱敏；
  不把原始 stderr、环境变量或私密路径整体回传给前端。
- 正常关闭有界等待并释放已确认退出的自有子进程。异常退出保留需要核查的锁，提供明确的
  查看状态/恢复说明；不通过 PID 或端口猜测并杀掉其他进程。
- v1 托管状态按固定规则校验并兼容读取。状态格式变更只涉及托管安装文件，不能触发用户知识库重建。

必要用例：

1. 有 ready 安装时重新准备，分别在创建 venv、pip、下载、probe 失败和取消，旧安装仍能使用。
2. A 安装已就绪，预检空目录 B、再切回 A，状态和操作对象始终一致。
3. Windows 路径大小写、空格、中文路径；标记错误、目录缺失和损坏状态均有明确错误。
4. 双击、两个页面、两个宿主进程、过期 plan、解释器变化、端口占用。
5. 各阶段取消、宿主退出、服务崩溃、迟到回调及重启后状态恢复。

产物：聚焦的生命周期修复提交、回归用例、明确恢复流程。
完成条件：失败可解释、旧安装可保留、不会重复安装或操作错误的目录/进程。

### 第 4 步：下载源、空间和模型复用

主要文件：`mineru-download.ts`、`mineru-runtime.ts`、`mineru-deployment-plan.ts`、
配置 schema、HTTP/API 与部署面板。

工作：

1. 默认复用既有 HF 下载源配置的解析规则，解析后把最终源写入预检计划，安装确认时显示。
   增加托管 Python 安装源设置，默认官方 PyPI；仅接受经过 URL 校验的源，不接受命令字符串。
2. 修改源、解释器、目录或 manifest 后旧计划失效，必须重新预检。禁止静默切换第三方镜像。
3. 下载传输与解析服务分开配置；安装源不能改变文档上传目的地，云 API Key 不得用于模型下载。
4. 需要代理的环境使用显式配置的 HTTP(S) 代理，仅用于安装/下载，不恢复继承全部系统 Python
   配置的行为。本轮先支持无认证代理；带凭据代理不落入普通配置、日志或前端回显，列为后续能力。
5. 延续固定 revision、大小和 digest 验证；测试 Range 续传、服务器忽略 Range、截断、校验不符、
   中途断网和重定向。镜像不能绕过完整性校验，也不能让循环重试超过总时间预算。
6. 现有固定清单为 13 个文件，共 858,204,914 字节，约 818.4 MiB，只代表模型。
   UI 分别显示模型总量、可复用量、剩余下载、额外复制空间、目标剩余空间和 Python 依赖占用。
   Python 占用未实测时显示未知；实测值注明平台及依赖约束版本，不能作为全平台固定值。
7. 现有外部模型经验证后复制，源目录保持只读；“零下载”不等于“零新增磁盘占用”。
   安装中继续检查可用空间，磁盘不足退出时保留可恢复文件，不标 ready。

产物：可配置下载链路、准确容量卡片、失败重试测试。
完成条件：配置镜像实际改变请求目标；断网/取消后可续传；空间说明与真实写入路径一致。

### 第 5 步：完成设置和知识库界面验收

主要文件：`MineruDeploymentSection.tsx`、`LocalModelsSection.tsx`、`rag-config.tsx`、
`processing-evidence.tsx`、`api.ts`、`locales.ts`、`theme.ts`。

布局延续现有主题，围绕“选择环境 → 检查空间 → 确认安装 → 启动服务”呈现。
知识库设置按文档处理、嵌入/重排、检索与上下文分组；保留全部原有字段与操作。

交互要求：

- 关闭/重开设置保留解释器和路径草稿；“记住路径”与“该环境已验证”显示为不同状态。
  草稿按宿主/profile 身份隔离；服务端已部署路径优先用于实际操作，不能被旧浏览器草稿误导。
- 模型状态、验证阶段和按钮可用性一致。禁用按钮说明原因；成功轮询后清除过期连接错误。
- 请求超时不等于后台安装取消。页面恢复时重查服务端状态，再决定是否重试；按钮连击不重复提交。
- 确认对话框展示最终安装目录、解释器、runtime/model 版本、下载源和空间限制。
- “检测服务”只证明可连接；“解析验证通过”才证明相应模型能工作；“设为默认”仍需单独点击。
- 状态轮询与动作请求发生竞态时，旧响应不能把最新状态改回去。
- 加强标题、说明和控件间距。长路径允许换行/查看；窄侧栏避免双列字段挤压，按钮文字不逐字断行。
- 验证键盘焦点、Esc、焦点返回、loading/error/success 提示、深浅色和窄屏；截图必须来自实际加载的新包。
- 证据翻页、重试、关闭重开及重解析后的旧引用失效，均给出明确操作提示。

浏览器验收使用隔离 profile 和合成知识库：至少覆盖 390、768、1280 CSS px 视口及桌面 200% 缩放。
在用户使用的 Edge 或内嵌浏览器检查实际页面；测试安装不覆盖当前真实知识库和默认解析器。

产物：必要的交互修复、前后截图、操作路径记录。
完成条件：截图中的文字拥挤和换行问题不再出现；上述流程实际点击通过，功能没有减少。

### 第 6 步：真实安装、解析质量和完整证据链

新增拟议命令 `smoke:mineru-managed`，扩展现有 `smoke:mineru-local`。
新脚本必须调用生产托管管理流程和打包后的代码，不复制一套独立的测试安装器。
一切测试文档为合成或明确许可的公共样例。

实机矩阵：

| 层次 | 组合 | 放行规则 |
| --- | --- | --- |
| 主要用户环境 | Windows x64，Node 24，CPython 3.13 | 本次托管 Preview 必过 |
| Linux 桌面/服务 | Ubuntu x64，Node 24，CPython 3.12 | 本次托管 Preview 必过 |
| macOS | 实际 runner 的 OS/架构，Node 24，CPython 3.12 | 执行验收；通过才列入本次托管支持矩阵 |
| 其他 Python minor/架构 | 候选范围内的其余组合 | 可以检测，不宣称真实部署已验证；未验收组合本次不开放托管安装，可用外部服务 |

解释器检测范围保持 3.10–3.14；托管安装准入另依据已验收组合判断，并在预检/API 与 UI 一致执行。
macOS 托管尚未通过不阻塞插件其他功能，但不得隐藏其安装限制或用 Linux 成功代替 macOS 结论。
若 Windows 或 Ubuntu 基线失败，则继续修复；若要删减托管发行范围，需明确做出新的产品决定。

完整路径：

1. 干净目录冷安装 → 依赖检查 → 下载/验证 → 模型真实加载与公开 PDF probe。
2. 启动 → 连续解析两次 → 停止 → 重启宿主 → 手动启动 → 再次解析。
3. 网络中断、主动取消、受控子进程崩溃、端口占用、修改模型文件、部分缓存复用。
4. 在隔离宿主中导入文件 → 检索 → 显示实际可见片段 → 页/块续读 → reparse/rechunk → 删除测试数据。
5. Rechunk 不新增解析服务提交；reparse 产生新证据 revision；失败时仍可检索旧已发布代。
6. 明确关闭云解析及独立图表描述后，验证没有云上传；已有云模式测试与此分别记录。

建立至少 6 个可复现的小型 PDF 用例：带文本层、纯扫描、中文多栏、表格、公式、跨页长文档。
分别记录解析文本、页/块定位和模型最终可见证据，不把“原始解析里有答案”当作“AI 已看到答案”。

门槛：

- 合成关键用例的数量/单位、负号语义、表格指定单元格值及页码/来源断言必须全通过。
  允许空格与等价 Unicode 表示归一化，不允许把正负号丢失当格式差异。
- 高难度公开样例逐项报告 OCR 和结构保留情况；不宣称所有扫描件准确率 100%。
- 上下文顺序、token 上限、revision 一致性和检索的原有 40 题阈值维持现状。
- 安装时间、峰值空间、内存、解析 p50/p95 作为报告数据，暂不设跨机器统一性能阈值。

每份报告记录 source SHA、包版本、tarball SHA-256、OS/架构、Node/Python、MinerU 版本、
约束文件摘要、model revision、用例结果和失败阶段。报告不收集私人文档或密钥。

产物：可重放 smoke、公共用例、支持矩阵和实测报告。

### 第 7 步：CI、旧数据与最终 npm 包

保留已有 required check 名称：三项 Quality、三项 Native、两项 Packed DSH smoke。
它们已经用于 main 的分支保护，不能随意改名或把新的手动模型检查设成每个 PR 必需。

常规门槛：

```text
typecheck
全量 Vitest
既有 retrieval benchmark
benchmark:structured（离线结构与协议回归，不是实测 OCR）
build + verify:package + verify:release
audit:prod:self-test + 有效的 audit:prod
smoke:workers
Ubuntu Node 22.19 / 24 / 26 Quality
Windows / Linux / macOS Node 24 Native
Windows / Linux Packed DSH smoke
```

按发布候选单独执行真实 local embedding/rerank smoke 与 MinerU 安装/解析 smoke。
重模型 workflow 使用维护者控制的 ref 和显式运行；普通 PR 无需下载大模型或使用个人凭据。
缓存键包含 runtime/model/约束版本及平台，不能用上次 warm cache 代替一次 cold-install 验收。

报告与当前待发布提交绑定。合并后在 main 的 merge commit 重跑发布验收；旧分支报告只能作背景证据，
不能直接声称是合并提交的通过结果。代码或依赖发生相关变化后重跑受影响检查；准备正式发行时
再对最终提交完成整套门槛。

兼容性专项：

- 使用合成的 0.4.1 格式数据目录验证启动、搜索、分页读取、目录同步、重建和删除。
- 原配置 builtin/mineru/embedding/rerank 行为保持；没有来源几何的旧数据继续显示“未知”。
- 新表/字段如已有加法初始化，验证其兼容性；不做破坏性迁移，不自动触发重解析/重嵌入。
- 保留并扩展 `document-generations.spec.ts` 已有的 SQL/DomainKV 失败恢复用例，
  聚焦尚未覆盖的入口组合；不重新造一套持久化框架。
- 安装 tarball 后确认宿主加载的是该 tarball 的新 client/host bundle，避免检查到旧插件 UI。
- `lib/` 当前被 Git 忽略且没有跟踪文件：通过构建与 npm 包验证生成，不强制把它加入源码提交。
- 包内不得出现模型、venv、日志、私人评测、临时计划目录；新增 runtime 资源必须包含在包中。

产物：最终提交对应的 CI 结果、升级兼容结果、经过验证的 npm tarball 与摘要。
完成条件：所有必需检查通过；未执行的真实测试明确记录，不以 skipped 冒充通过。

### 第 8 步：文档、审查和发布候选交付

工作：

1. 同步中英 README、CHANGELOG、MinerU 文档和 release notes，明确云 API、自部署和托管 Preview 的差异。
2. 展示实测平台、模型大小及依赖额外占用、下载源、重试/恢复方式、失败代码和升级注意事项。
   保留项目署名及固定版本许可证链接，不把 MinerU 的能力写成插件自行训练/实现的模型。
3. 将旧设计/计划标明“已完成/本次延期/已被新计划替代”，避免文档声称尚未实现的 Python bootstrap、
   Standard 托管、卸载和回滚 UI 已经具备。
4. 版本建议：本次为新增解析和证据能力，准备候选 `0.5.0` 比 `0.4.2` 更能表达范围。
   这只是计划建议，当前不改版本。正式制作候选时以维护者最终选定版本统一更新 package、
   插件 manifest、lockfile、安装示例、issue template 和 release notes。
5. 整理清晰提交；实施阶段获准交付到 GitHub 后，在当前功能分支创建/更新 PR，描述实际行为和验证。
   不改贡献者分支；按项目习惯用 merge commit 保留提交历史。
6. 审查当前提交，CI 全绿后才进入合并步骤。此次计划不等于授权自动合并、创建 tag 或发布。
   合并后同步本地 main，按第 7 步验证最终 merge commit 并生成待发布包。
7. 交付 release 文案、验证报告、tarball 摘要和发布命令。tag、GitHub Release、npm publish
   仍是后续明确的发布动作；npm 发布继续由用户决定何时执行。

完成条件：用户拿到的候选版本、Git 提交、CI、实测报告和 npm 包能互相对应。

## 4. 建议提交划分

保留当前已有结构化证据提交；新增收尾改动按用途提交，不为了凑数量拆坏可构建性。

1. `fix(mineru): align runtime contracts and qualified dependency profiles`
2. `fix(mineru): preserve ready installations across failed preparation`
3. `feat(mineru): honor download sources and report installation capacity`
4. `fix(ui): reconcile deployment state and improve settings readability`
5. `test(mineru): add managed install and end-to-end evidence acceptance`
6. `ci: validate release artifacts and compatibility on supported platforms`
7. `docs: document supported platforms and prepare release candidate`

已有未提交的托管基础代码必须先形成可构建的基础提交，或与其首个修复合为一个完整提交；
不要把仅有 import、缺少未跟踪实现文件的中间状态推送到 PR。

## 5. 放行与延期规则

- P0 数据破坏、越权或凭据泄露；P1 核心流程不可用、旧数据回归、误报 ready：阻断发布。
- 托管 Preview 也必须做到失败不破坏旧安装、不误改全局环境、不错误标 ready；实验性不是免验收。
- 其他未验收平台只展示检测/外部服务说明，不开放本次托管安装。已验收平台也保留 Preview 标注。
- 浏览器中导致无法完成安装、保存、检索、续读的交互问题必须修复；轻微视觉细节可登记后续处理。
- 真实报告必须描述实际通过的版本和用例；已实现、已单测、已实测分别陈述。
- 网络审计拿不到结果时保留阻断状态；不凭之前一轮 CI 绿色判断新候选可发布。

明确延期：托管 Python 下载、Standard/Advanced 托管、跨平台任意 Python 全覆盖、
带凭据代理、自动孤儿进程回收、完整卸载/版本回滚界面、跨 embedding 空间和其它独立检索策略。
本次需要“失败保留上一次可用安装”，不因此扩大为完整版本管理产品。

## 6. 计划自查

- 没有把上一轮测试结果写成当前候选已经通过。
- 没有把当前 version metadata 验证通过写成新版发布内容已齐备。
- 生命周期候选问题有明确复现步骤；已有 generation 恢复测试被复用而非遗漏。
- 不更名现有 required checks；手动真实模型门槛与普通 PR 检查分开。
- Git 忽略的 lib 用构建验包交付；不要求强制跟踪生成文件。
- 稳定插件与实验性托管有各自门槛，且支持矩阵限制在 API 和 UI 一致执行。
- 实施、提交、合并、发行是不同里程碑，本轮只完成计划文档。

## 7. 参考依据

- 当前仓库：`src/knowledge/mineru-*.ts`、`tests/mineru-*.spec.ts`、
  `tests/document-generations.spec.ts`、`benchmarks/baseline.json`、`.github/workflows/ci.yml`。
- [MinerU 固定 4.0.6 包元数据](https://raw.githubusercontent.com/opendatalab/MinerU/mineru-4.0.6-released/pyproject.toml)。
- [MinerU 4.0.6 release](https://github.com/opendatalab/MinerU/releases/tag/mineru-4.0.6-released)。
- [MinerU 4.0.7 release](https://github.com/opendatalab/MinerU/releases/tag/mineru-4.0.7-released)。
- [官方模型来源与就绪说明](https://github.com/opendatalab/MinerU/blob/master/docs/en/usage/model_source.md)：
  用于发现需要核对的契约；实施仍以选定固定版本源码为准。
- [现有托管设计](../specs/2026-09-27-mineru-managed-deployment-design.md)。
- [现有 Python 发现补充](../specs/2026-09-27-mineru-python-discovery.md)。
- [现有结构化证据设计](../specs/2026-09-24-mineru-structured-rag-design.md)。
