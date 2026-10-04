# 安装工程造价工作台（对话即造价）

面向安装工程（消防/给排水/电气/通风空调/弱电）的造价工作台：上传真实的清单/询价/定额表，
用自然语言下达任务（导入、匹配、组价、清标、汇总、导出），Agent 调工具改数据，关键写操作
走确认门。金额与工程量一律由确定性引擎计算，可复算、可追溯。

## 运行

```bash
npm install
npx prisma db push        # 初始化 SQLite（prisma/dev.db）
npm run dev               # http://127.0.0.1:3210
npm run build && npm start # 生产构建
```

数据与存储位置（`.env`）：

```dotenv
DATABASE_URL="file:./dev.db"
STORAGE_DIR="./storage"
```

### 模型配置（可选）

对话默认走内置规则引擎，全功能可用；配置模型后启用 LLM 规划（造价业务规则仍在工具里，
不进 prompt）。任一方式即可：

```dotenv
MODEL_PROVIDER=openai-compatible   # 或 anthropic；=rule 强制规则引擎
MODEL_BASE_URL=https://api.deepseek.com
MODEL_API_KEY=sk-...
MODEL_NAME=deepseek-chat
# 只给 DEEPSEEK_API_KEY 也行：自动按 deepseek 官方端点 + deepseek-chat 兜底
```

模型不可达时自动降规则引擎并在会话里明示「固定任务模式」。

## 页面

| 路径 | 说明 |
|---|---|
| `/` | 项目列表（新建/切换工程） |
| `/new` | 新建工程 |
| `/p/[id]` | 工程工作台：左侧原生会话轨 ｜ 右侧工作区（清单/资料/成果） |
| `/admin` | 数据管理后台：全局数据集（材料价格库、定额库、措施费系数）与行级维护 |

## 典型流程

1. **导入资料**：拖入 Excel/PDF（清单、询价单、定额表、报审表、进度计量表…）。识别表结构与
   列角色 → 存 `ProjectFile.meta.mapping` → 推「列映射」视图；置信度不足或用户改过时挂起确认门，
   批准后才落库（同一文件重复导入幂等）。
2. **看映射再确认**：列映射视图给出每张表的类型、「将导入 N 行」和逐列证据；0 行会红标
   （有数据但没认出名称/数量列），避免确认完才发现整表没进来。
3. **补价/组价**：缺主材价 → `material.matchLibrary`（预览）→ `material.fillFromLibrary`（确认门）
   写**主材暂估价** → `quota.match`/`quota.calculate` 测算 → `quota.applyCalc`（确认门）写**综合单价**。
4. **费用与成果**：`cost.feeSummary`（分部分项→措施→其他→规费→税前→税金→含税）、
   `cost.composition`（人材机+管利成本构成、成本倒挂预警）、清标异常检查、报告与 Excel 导出。
5. **随时可撤**：每个修改动作产生 ActionReceipt（含改动前后快照），支持行级撤销与冲突拒撤。

一键报价（autopilot）：说「一键报价/自动报价」或带 `autopilot=true`，走确定性管线
`matchLibrary→fillFromLibrary→quota.match→calculate→applyCalc→measureFees→feeSummary`，
写操作仍过确认门；缺管理费率/利润率时跳过写回并提示补齐后回复「写回组价」续接。

## 目录

```
agent/        自有 Agent 引擎：runtime（会话循环）/planner（意图路由）/executor/pending（确认门）
              /llm（模型出口）/events（SSE 事件）/autopilot + tools/（专业工具，含 schema 守卫）
cost-engine/  纯函数确定性造价引擎（decimal.js）：money/semantic/match/quota/aggregate/adjust/
              fees/costComposition/calcExpr/fileCompare —— 所有金额只能在这里算
file/         解析与接入：excel（表头定位/列角色/类型学/写回）、pdf、inspection（识别+模板缓存）、
              classify（文件类型/阶段期次）、factsExtract（台账事实）、compareReport、storage
boq/          清单领域服务：service（导入/查询/改价）、mapRow（行→落库）、ingestRules（行级口径判定）
material/     材料价匹配消费端
project/      工程与计价设置领域服务（payload/facts）
dataset/      全局数据集：service、priceParse、priceMatch、quotaParse（定额表解析）
quota/        定额库（内置参考库 + 已上传数据集合并）
shared/       跨端类型与纯函数：types/mapping（角色对齐）/json/settings
src/app/      Next 路由（页面 + /api）
src/ui/       工作台 UI（会话轨、清单表、各结果视图、admin 面板、shadcn 组件）
prisma/       schema 与迁移（SQLite，保持 Postgres 可移植：Json/枚举→String）
tests/        vitest（引擎/工具/解析/前端视图）
scripts/      数据导入与回归脚本（test-real/check-cost-flow/make-fixtures/import-sc2020-*）
```

## 关键口径（红线）

- **综合单价 vs 主材价**：`unitPrice` 是综合单价（人材机管利组价结果）；
  `mainMaterialPrice` 是主材暂估价（询价/信息价）。材料价/询价**绝不写 unitPrice**。
- **含税价**：源表单价列为含税时标 `taxIncluded`（分部分项与单价措施一视同仁），
  汇总时不计入税前基数、不重复计税。
- **规费基数**：四川安装口径为**定额人工费**（测算后写台账），无基数时退化为分部分项费并标注。
- **措施费**：导入的措施清单真值优先；可叠加官方系数计取（脚手架/超高/高层/系统调整）。
- **台账事实**：费率/金额文本必须走 `parseRateValue`/`parseAmountValue`（"9%"≠9），
  禁止 `Number(fact.value)`。
- **可追溯**：源表原文全量保留在 `BoqItem.rawCells`（含 `__nonNumeric/__derived/__decomp` 标记），
  写回 Excel 时对改动单元格记批注。

## 验证

```bash
npm test                     # 单测（引擎/解析/工具/前端视图）
npm run typecheck            # tsc --noEmit
npx tsx scripts/test-real.ts # 真实造价文件解析回归（读桌面样例）
npm run build                # 生产构建
npx tsx scripts/check-cost-flow.ts   # 端到端：隔离 DB + next start 上跑真实 API（需先 build）
npm run fixtures             # 生成测试用 Excel 到 fixtures/out/
```

## 约定

- 模型密钥、`storage/`、`prisma/dev.db`、`.verify/` 等本地状态不入库（见 `.gitignore`）。
- 数据文件与模型密钥不要提交；生产使用请轮换本地调试用过的密钥。
