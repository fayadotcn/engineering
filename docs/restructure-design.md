# 单系统重构设计（v1）

> 依据：docs/real-world-learning.md（2137 真实文件抽样 + 互联网调研）。目标：一个端口、一个系统、会话原生、装得下真实造价全过程。

## 0. 现状问题

```
3210  DSH Harness Web（LLM循环/会话UI/审批UI/模型配置）
        │  postMessage: installation:task / focus / ready / catalog
        ▼  iframe
3211  Next 工作台（清单/视图/导入/价格库/后台）
```

- 两个进程两套会话模型（Harness agent ↔ Project.harnessSessionId）；工作台 send() 离了父窗口就哑。
- Harness 把每次工具调用各建一条 AgentRun（planner="harness"），会话历史碎成工具粒度的 run。
- 我们自有的完整引擎（llm.ts/planner/executor/pending/SSE/confirm 路由）被 410 冻结。

## 1. 目标架构

```
next dev -p 3210（单端口）
├─ /            项目列表（首页）
├─ /new         新建项目
├─ /admin       数据管理后台（数据集/定额/价格行，不变）
└─ /p/[id]      项目工作台 = 左：原生会话轨 ｜ 右：工作区
     会话轨 ──POST /api/projects/[id]/agent/runs {message}──► startRun
             ◄──SSE /api/runs/[runId]/stream──── emit 事件流
     确认卡 ──POST /api/runs/[runId]/confirm────► pending.resolve
```

- **引擎完全自有**：runtime.executeRun = resolveContext → modelConfig()? runLLMLoop : RulePlanner → executeTool（confirm 门已内建）→ 事件持久化 → SSE。模型不可达自动降规则引擎（现有逻辑，git ad74656 可对照恢复）。
- **模型配置**：MODEL_PROVIDER/BASE_URL/API_KEY/NAME 优先；未配置但存在 DEEPSEEK_API_KEY 时自动按 deepseek 官方端点接 openai-compatible（deepseek-chat），可在 .env 覆盖；完全无模型时工作台全功能可用，仅对话走规则引擎并明示。
- **Harness 降级为可选遗留**：`npm run harness` 保留；默认 `npm run dev` 不再起 harness。工作台在 iframe 内也照常工作（fetch 打自己源），3210/3211 不再互为依赖。
- **postMessage 桥全部保留但不再必需**（window.parent===window 时自然短路）；store.send() 改为直连自有 API，删掉 harnessOrigin 门槛。

## 2. 会话 UI（左轨，原生）

复用现有 store.blocks 全套块类型（user/agent/thought/activity/tool/receipt/error/upload/confirm），新增渲染组件 `src/ui/Conversation.tsx`：

- 渲染策略对齐「用户只看高层步骤」红线：activity/tool_started 折叠为进度行；thought 灰字；confirm 卡置顶（复用 ImportConfirmation 的模式泛化为 ConfirmCard）；tool 结果不堆 JSON。
- composer：Enter 发送 / Esc 清空；📎 上传 xls/xlsx/csv/pdf；发送即 `send()` → POST agent/runs → streamRun。AskBar 保留为工作区内第二入口（同一 send）。
- 断线重放：`/api/projects/[id]/runs` 已有（run+events → blocks 重建，lastPatch 去重）。

## 3. 数据模型与导入管道（Phase B，学习归纳驱动）

### 3.1 BoqItem 增字段
```prisma
unitProject String?   // 单项/单位工程，如「地下室‖消防水工程」「1#楼‖电气工程」
taxIncluded Boolean @default(false) // 单价含税标记（含9%税单价等）
```
- unitProject 来源：sheet 名 `【A‖B】`/`【A】` 后缀 → A（必要时连 B）；表内「单位工程名称：X」行；文件名兜底。进 sectionPath 展示层级：单位工程 > 分部 > 项。
- taxIncluded 来源：价列表头含「含税」「含X%税」→ true；feeSummary 对含税项不再叠税（行内注明）。

### 3.2 Sheet 类型学扩展（inspectWorkbook 输出）
现 BOQ/QUOTATION/GENERIC → 增：
| 新类型 | 信号 | 处置 |
|---|---|---|
| COMPARE | ≥2 个「…综合单价/价」列 或 ≥2 数量列 + 差值列（价差/量差/量差率） | 不导入清单；提示走对审 |
| APPROVAL | 报审/出厂证明/使用部位/补资料/合格证 | document 视图 |
| PENDING_QUOTE | 名称+特征+单位+量 且**无任何价列**（待报价清单/Z833器材表） | 可导入为无价 BOQ（明确提示）或按询价底稿对待 |
| FACTS | 表-03/04/13/扉页（汇总内容/规费税金/招标人） | 不产清单行；抽台账事实 |
| MATERIAL_PRICE | 首列角色 materialName + 品牌列 + （调价|材料单价|参考单价） | 按询价表管道进 MaterialPrice/主材暂估价 |

判定顺序（修订）：措施表名 > COMPARE > APPROVAL > 清单信号 > MATERIAL_PRICE > 询价信号 > 有量有价→清单。

### 3.3 红线修复
- **price 角色**：BOQ 型 sheet 里 price 仅当表头含「材料|主材|设备」（不含「人工/机械」时才升格 laborPrice/machinePrice）；「报价/投标价/单价」一律 unitPrice；reconcilePriceRole 排除词表删「报价」（报价≠材料价）。导入后 sanity：unitPrice 全空且 price 非空 → 视图红标提示。
- **双列检测**：同名义列族 ≥2（XX单价 vs YY单价 / 已报送量 vs 结算量 / 工程数量 vs 图算量）→ COMPARE；或量列取「结算工程量」优先于「代表数量」（报审语境）。
- **无表头错位**（`名|量|空|单位|价`）：headerless 画像加「单位词列定位」——先找 unit 词列（m/m2/个/套/台 命中率），再向左量向右价，修复抗震支吊架型失败。

### 3.4 事实抽取（FACTS sheet，Phase C）
- 表-13：行「规费」→ 规费费率；「销项增值税额」→ 税率；「附加税」→ 附加税率。计算基数文字进台账备注。
- 表-04：分部分项及单价措施项目费/措施/其他项目/规费/税金/合计 → feeSummary 真值校验对（单位工程维度）。
- 扉页/表头：工程名称/招标人/施工单位 → 台账（FILE_EXTRACTED）。
- ProjectFile 增 `stage`（招标/投标/进度/变更/报审/结算/财评）+ `period`（YYYY-MM，进度申报从文件名抽）→ 「本期 vs 上期」对审入口（fileCompare 已具备能力）。

## 4. 实施分期

| 期 | 内容 | 验证 |
|---|---|---|
| A 单系统 | 复活 agent/runs POST；runtime 恢复通用循环；store.send 直连；Conversation 左轨；dev 脚本单端口；AGENTS.md 更新 | 浏览器实测：发消息→SSE→确认门→视图；npm test+typecheck |
| B 导入管道 | unitProject/taxIncluded 字段；类型学扩展；price 红线；双列/无表头修复 | learn-real-files 回归 + vitest + 真实文件抽测 |
| C 事实抽取 | 表-13/04/扉页→facts；file.stage/period | 宏业导出文件实测 |
| D 迭代打磨 | 继续商用级打磨轮 | 浏览器实测 |

## 5. 不做什么

- 不动 cost-engine 纯函数边界；造价业务规则不进 prompt（红线）。
- 不删 harness/plugin（可选遗留）；不破坏现有 DB（全部 additive 迁移）。
- 模型会话不写业务规则到 prompt——planner/工具照旧。
