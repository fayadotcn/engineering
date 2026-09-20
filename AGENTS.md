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
- 语义比较：BoqSemanticFeature 分组 → featureCompatible 冲突检查 → 价格比。禁止纯字符串匹配。
- 每个修改动作产生 ActionReceipt；工作区用户编辑也产生（createdBy=user），Agent 上下文可见。
- DB schema 用 SQLite 但保持 Postgres 可移植（Json/枚举→String + shared/json helpers）。

## 目录

`/agent` runtime+planner+tools · `/cost-engine` money/semantic/compare/aggregate/adjust · `/boq` `/material` `/project` 领域服务 · `/file` 存储+excel+分类 · `/database` prisma+序列化 · `/shared` 类型 · `src/app` Next 路由 · `src/ui` 双栏工作台 UI

## 测试

`tests/` 下 vitest。改 cost-engine/file 解析必须跑 `npm test` + `npx tsx scripts/test-real.ts`（用桌面真实造价文件回归）。
