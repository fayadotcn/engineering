# 造价 Agent — Agent Native 安装工程造价

「对话即造价」：用户通过自然语言 + Excel/PDF 完成造价工作，Agent 理解任务、调用工具、修改数据、输出结果。

## 运行

```bash
npm install
npx prisma db push        # 初始化 SQLite (dev.db)
npm run dev               # http://localhost:3210
npm test                  # cost-engine 单元测试 (vitest)
npm run typecheck         # tsc --noEmit
npm run fixtures          # 生成测试用 Excel 到 fixtures/out/
```

## 模型配置（可选）

不配置模型时，内置规则引擎照样跑通完整闭环（所有任务仍走 Tool/Receipt/Trace）。
配置后启用 LLM 规划（OpenAI 兼容协议，DeepSeek/ Moonshot/ 各类网关均可）：

```env
# .env.local
MODEL_PROVIDER=openai-compatible
MODEL_BASE_URL=https://your-gateway/v1
MODEL_API_KEY=...
MODEL_NAME=deepseek-chat
```

## 架构红线

- `cost-engine/` 纯函数、零 LLM、确定性可复算（decimal.js）。所有金额/工程量/汇总只能在这里算。
- `agent/` 负责认知：context → plan → tool calls → receipts。造价业务规则禁止写进 prompt。
- `file/excel.ts` 解析真实造价 Excel：双行表头、无表头数据表、续行合并、"1、名称：X" 内嵌字段、分页噪声。
- `file/pdf.ts` PDF 文本层提取（pdfjs-dist，serverExternal）+ BOQ 行识别（编码+单位+量+价正则）；≥5 行自动导入清单，否则按文档展示（document 视图）。
- `cost-engine/fileCompare.ts` 两版清单对审：编码优先对齐、无编码按语义组键；输出 价差/量差/独有项 + 总额差（fileCompare 视图）。
- 确认门：带 `confirm` 标记的工具（boq.update / material.applyQuotation / material.fillFromLibrary / quantity.adjust(apply) / quantity.calculate(写回)）执行前暂停 run（AWAITING_CONFIRM），POST /api/runs/[runId]/confirm 批准或取消。跨请求的待确认表必须存 globalThis（Next 每个 route 独立 module graph）。
- `cost-engine/calcExpr.ts` 工程量计算式求值（递归下降，禁 eval；×÷（）全角与单位词自动处理）。
- 语义比较：BoqSemanticFeature 分组 → featureCompatible 冲突检查 → 价格比。禁止纯字符串匹配。
- 每个修改动作产生 ActionReceipt；工作区用户编辑也产生（createdBy=user），Agent 上下文可见。
- DB schema 用 SQLite 但保持 Postgres 可移植（Json/枚举→String + shared/json helpers）。

## 目录

`/agent` runtime+planner+tools · `/cost-engine` money/semantic/compare/aggregate/adjust · `/boq` `/material` `/project` 领域服务 · `/file` 存储+excel+分类 · `/database` prisma+序列化 · `/dataset` 全局数据集（材料价格库/定额库，见下） · `/shared` 类型 · `src/app` Next 路由 · `src/ui` 双栏工作台 UI

## 全局数据集（/admin 数据管理后台）

- `Dataset` 模型 + `MaterialPrice` / `QuotaRow` 行表，跨项目共享；区别于项目内 `ProjectFile`。
- 上传：`POST /api/admin/datasets`（multipart，kind=MATERIAL_PRICE|QUOTA|GENERIC）；列表/预览/删除在同路径。
- `dataset/quotaParse.ts` 专解析定额表（定额编号/子目名称/人工费/材料费/机械费/主材耗量列）；耗量列按"每定额单位"惯例自动归一化为引擎口径"每清单单位"（耗量 ≥ unitScale 时除以倍数）。
- `quota/service.ts getQuotaLibrary()` 合并内置参考库 + 全部已上传定额数据集（内置是兜底）。
- `quota.calculate` 主材价查找顺序：项目询价 → 全局材料库（findLibraryPrice）；`material.search`/`getPriceHistory` 并入材料库数据并标注来源。
- `Dataset.active` 启停开关：`PATCH /api/admin/datasets/[id] {active}`；停用的数据集对所有消费方不可见（材料搜索/取价/定额匹配/缺价匹配一律过滤），行数据保留可随时复用。
- 缺价补价闭环：`material.matchLibrary`（预览，只读，出 quotationMatch 视图）→ `material.fillFromLibrary`（确认门，写回 unitPrice + diff + 回执）；planner 区分「看看缺价」（仅预览）与「补齐/补价」（预览+写回）；总览页未定价卡片可一键触发。

## 测试

`tests/` 下 vitest。改 cost-engine/file 解析必须跑 `npm test` + `npx tsx scripts/test-real.ts`（用桌面真实造价文件回归）。
