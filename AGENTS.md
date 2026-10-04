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

## 模型配置

单系统自有引擎（`agent/` runtime + llm + planner + executor + pending + SSE）。`POST /api/projects/[id]/agent/runs` 发起任务，事件经 `/api/runs/[runId]/stream` 回放至工作台左轨原生会话面板；确认门走 `/api/runs/[runId]/confirm`。模型请求失败时 runtime 发 `model_fallback` 事件（payload.reason=失败原因）并降规则引擎——前端据此显示常驻「固定任务模式」横幅，下一次模型产出 thought 事件自动解除。上下文含 `lastRun`（最近一轮的 tool_finished 摘要），供「刚才/那些/继续」类指代解析。

**一键报价（autopilot）**：`agent/autopilot.ts` 把造价师标准动作链固化成确定性管线——`extra.autopilot=true`（或文本「一键报价/自动报价」）触发，**绕过 LLM** 走 `matchLibrary→(命中才)fillFromLibrary→quota.match→calculate→(费率齐才)applyCalc→(测算有匹配才)measureFees→feeSummary`；写操作仍过确认门，缺管理费率/利润率时跳过写回并在结尾说明补设置后回复「写回组价」续接（planner 对该词优先于预览/写回Excel 路由）。

```env
# 任一方式配置模型；全不配时对话走内置规则引擎，其余功能照常
MODEL_PROVIDER=openai-compatible   # 或 anthropic；=rule 强制规则引擎
MODEL_BASE_URL=https://api.deepseek.com
MODEL_API_KEY=sk-...               # 只给 DEEPSEEK_API_KEY 也行（自动按官方端点+deepseek-chat 兜底）
MODEL_NAME=deepseek-chat
```

正式构建 `npm run build`，运行 `npm start`。（旧 DeepSeek Harness 模式已下线；存量 planner="harness" 的 run 仅作历史数据展示。）

## 架构红线

- `cost-engine/` 纯函数、零 LLM、确定性可复算（decimal.js）。所有金额/工程量/汇总只能在这里算。
- `agent/` 自有引擎负责认知与会话（llm 循环或规则引擎 → 确认门 → executor）；`agent/tools` 提供专业工具、回执与结果视图。造价业务规则禁止写进 prompt。
- `file/excel.ts` 解析真实造价 Excel：双行表头、无表头数据表、续行合并、"1、名称：X" 内嵌字段、分页噪声。
- **通用清单接入管道**（任意格式 Excel）：`file.inspect`（`inspectWorkbook` 识别 → 套 `ImportTemplate` 模板 → 存 `ProjectFile.meta.mapping` → 推 `columnMapping` 视图）→ `file.ingest`（async 确认门：模板命中/用户改过/minConfidence≥0.9 才自动放行，否则暂停等用户在视图改列/改类型后批准；先 `deleteByFile` 保证重导幂等；确认过的映射按表头指纹 sha1 沉淀为全局模板）。列角色最强证据是**数值一致性**（`lockByArithmetic`：数量×单价≈合价 锁定三列，0.97），不是表头字；类型判定顺序：措施表名 > 清单信号(项目编码/工程量/综合单价) > 强询价信号(材料名称/品牌/询价) > 有量有价→清单(裸「单价」=综合单价) ；「规格型号+量×价=合价」在简式清单与询价单间真实歧义（typeConfidence 0.6）→ 靠文件名 `applyTypeHint` 纠偏或让用户确认。改类型时 price↔unitPrice 角色必须用 `shared/mapping.ts reconcilePriceRole` 同步（客户端/服务端共用）。`BoqItem.rawCells` 保留整行原文 + `__nonNumeric/__derived`；无综合单价列时 unitPrice=合价÷量。`ProjectFile.contentHash` 同项目同内容不重复导入；`POST /api/files/[id]/reingest` 按当前映射重导。人工/机械单价列（laborPrice/machinePrice）导入时升格为 `BoqItem.laborUnitPrice/machineUnitPrice`（rawCells 仍留原文），由 `cost.composition` 人材机成本构成分析直接消费。
- `file/pdf.ts` PDF 文本层提取（pdfjs-dist，serverExternal）+ BOQ 行识别（编码+单位+量+价正则）；≥5 行自动导入清单，否则按文档展示（document 视图）。
- `cost-engine/fileCompare.ts` 两版清单对审：编码优先对齐、无编码按语义组键；输出 价差/量差/独有项 + 总额差（fileCompare 视图）。
- 确认门：带 `confirm` 标记的专业工具经 `agent/pending.ts` 挂起 run（AWAITING_CONFIRM），POST /api/runs/[runId]/confirm 批准后才执行；文件导入的映射确认同走此门。跨请求的导入待确认表和事件订阅必须存 globalThis（Next 每个 route 独立 module graph）。
- `cost-engine/calcExpr.ts` 工程量计算式求值（递归下降，禁 eval；×÷（）全角与单位词自动处理）。
- 前端样式：`src/ui/styles/` 分文件，`tokens.css` 管全部设计变量。明暗主题走 `<html data-theme>`：`layout.tsx` 内联脚本首帧前落定（localStorage `cost-theme`=auto|light|dark，auto 跟随系统+跨页签同步），`ui/ThemeToggle.tsx` 三态切换。**品牌蓝分两档**：填充背景/按钮底用 `--brand-accent`，作前景（文字、图标、细线、焦点描边）一律用 `--brand-ink`（深色下提亮、浅色下加深，保小字对比度）；`#fff` 文字配品牌底时用 `--brand-on-accent`。打印强制浅色口径（tokens.css 尾部 @media print 重置）。
- 语义比较：BoqSemanticFeature 分组 → featureCompatible 冲突检查 → 价格比。禁止纯字符串匹配。
- 每个修改动作产生 ActionReceipt；工作区用户编辑也产生（createdBy=user），Agent 上下文可见。
- DB schema 用 SQLite 但保持 Postgres 可移植（Json/枚举→String + shared/json helpers）。

## 目录

`/agent` runtime+planner+tools · `/cost-engine` money/semantic/compare/aggregate/adjust · `/boq` `/material` `/project` 领域服务 · `/file` 存储+excel+分类 · `/database` prisma+序列化 · `/dataset` 全局数据集（材料价格库/定额库，见下） · `/shared` 类型 · `src/app` Next 路由 · `src/ui` 双栏工作台 UI

## 全局数据集（/admin 数据管理后台）

- `Dataset` 模型 + `MaterialPrice` / `QuotaRow` 行表，跨项目共享；区别于项目内 `ProjectFile`。
- 上传：`POST /api/admin/datasets`（multipart，kind=MATERIAL_PRICE|QUOTA|GENERIC，可选 region/period/priceType/brand 作整表默认值）；列表/预览/删除在同路径。`Dataset.contentHash` 同 kind 同内容不重复导入（返回 `duplicate:true`）。
- **价格表接入管道**（MATERIAL_PRICE，格式每次都不同）：上传即 `inspectWithTemplates`（=项目文件同款 inspect+applyTypeHint+ImportTemplate 套用，抽到 `file/inspection.ts`）→ 映射存 `Dataset.meta.mapping`、默认值存 `meta.defaults` → QUOTATION 型 sheet 全部 `templateHit||userEdited||minConfidence≥0.9` 才自动 `ingestDataset`（PARSED），否则 status=PENDING 等管理员在 `/admin` 的列映射面板（`GET/PATCH /api/admin/datasets/[id]/mapping`，PATCH 与文件映射共用 `applySheetPatch`）确认/改类型后 `POST .../ingest`。**BOQ 型 sheet 不进价格库**（综合单价≠材料价），跳过名单写 `meta.note`；管理员可把 sheet 类型改成 QUOTATION 再重导（reconcilePriceRole 会把 unitPrice→price）。
- `dataset/priceParse.ts` 纯函数行构建 `buildPriceRows`：name=materialName||name||spec；price=price||unitPrice||laborPrice；**规格碎片**——规格列右侧未映射列里 `[0-9x×*/-]` 形态的单元格并入 spec（报价单合并单元格拆列常见）；无单位列时从价格表头「单价(元/米)」推单位（米→m 等归一为引擎口径）；`region`/`period`/`priceType` 列角色进 cells；行级缺省 → meta.defaults → 文件名兜底（`filenamePeriod`/`filenameRegion`/`REGION_RE`）；`normalizePeriod` 归一化 YYYY-MM（periodKey 可排序），`normalizePriceType` → INFO|MARKET|SUPPLY|LABOR（单位是工日/台班自动 LABOR）。
- **价格行后台管理**：`GET /api/admin/datasets/[id]/prices`（q/brand/region/period/priceType 过滤 + 分页 + facets 去重值）、`PATCH/DELETE .../prices/[rowId]`（行内编辑，name/spec 变了重算 features，period/priceType 归一化，name 空/price 非数字 400）、`POST .../prices`（手工补录行）；UI 是 `src/ui/admin/PriceRowsPanel.tsx`（含新增行）+ `DatasetMappingPanel.tsx`。
- **匹配消费端**：候选取数三路 OR（`priceCandidateWhere`：名称前缀键 + 规格型号词根 `specTokens` + features.material 子串）——报价单常无「材料名称」列（name=型号），单靠 name contains 会整库漏掉；`dataset/priceMatch.ts` 纯函数 `pickBestPriceRow` 集内打分——名称/规格/单位基础分（兼容 60/80 阈值；规格词根重合≥2 或强词根≥1 在名称未命中时仍可参选 +12~22 并留痕）+ 品牌偏好命中+30/无品牌+8/异品牌-15（notes 留痕）+ 地区命中+15 + 期次默认取候选最新+12、指定 `prefs.period` 时按「截至该期最新价」计（信息价口径）、候选全无期次时退到 createdAt 最新。`getPricePrefs(projectId)` 从台账事实组装：BRAND（「电缆品牌=上上」→appliesTo=电缆，只作用于该类材料；「品牌」=全局）、REGION、价格期/价格日期、价格类型。`findLibraryPrice`/`matchLibraryForItem`/`searchMaterialPrices` 都接受 prefs；quota.calculate/applyCalc 经 `resolveMainPrices` 取价（**libHit.score<60 不取**——错价比缺价更糟）、material.matchLibrary/fillFromLibrary/search/getPriceHistory 已接线；planner 内联抽取「用上上品牌测算」「按海南价补价」「按2024年6月信息价组价」→ 先写台账事实再执行。
- `dataset/quotaParse.ts` 专解析定额表（定额编号/子目名称/人工费/材料费/机械费/主材耗量列）；耗量列按"每定额单位"惯例自动归一化为引擎口径"每清单单位"（耗量 ≥ unitScale 时除以倍数）。
- `quota/service.ts getQuotaLibrary()` 合并内置参考库 + 全部已上传定额数据集（内置是兜底）。
- **四川2020定额已入库**：`scripts/import-sc2020-quota.ts` 从「清单计价专家N10」本地 SQLite（`C:/Program Files/清单计价专家N10/DATABASE/`）导入 az_de 全部 14,867 条安装定额（11 分册 5A–5K）。字段映射：debh→code / xmmc→name / dw→unit+unitScale / rgf·clf·jxf→人材机 / az_yl+zh_cl→主材耗量（归一化）/ az_zy→xmbh 清单编码映射。重跑脚本幂等（同名数据集先删后建）。
- `scoreQuota` 打分：category 40 / material 25 / diameter 20 / spec 15 / connection 10 / system 12 / keywords 10。**注意：`matchKeys.xmbh` 是软件内部「册章节树码」(03+册序+章+节)，不是 GB 清单编码——绝不能拿来比对 `item.code`**（曾因形似误判：031001001 在树码里对应温度计定额）。
- 系统归属 tiebreak：定额编号前缀→系统词表（5G→消防|喷淋、5H→给排水、5I→通风空调…），清单项 `sectionPath`/名称含系统词时同册定额 +12——解决跨册同名子目同分问题（如消防管误配给排水册）。
- 存疑判定：`top2Quota` 分差≤10 且基价差>5% 才标「存疑」（跨册同名同价不算歧义）；存疑行 UI 出琥珀徽标+备选子目，提示用 `spec.search` 核实。
- **定额说明检索**：`spec.search` 工具查 `SpecSection` 表（201 节，来自《2020定额说明及计算规则》PDF，`scripts/import-sc2020-spec.ts` 导入）；结果出 `specResult` 工作区视图（分册徽标+条文摘录）。planner 触发词含「定额说明/计算规则/怎么计算/怎么算」等。
- `quota.calculate` 主材价查找顺序：项目询价 → 全局材料库（findLibraryPrice）；`material.search`/`getPriceHistory` 并入材料库数据并标注来源。
- `Dataset.active` 启停开关：`PATCH /api/admin/datasets/[id] {active}`；停用的数据集对所有消费方不可见（材料搜索/取价/定额匹配/缺价匹配一律过滤），行数据保留可随时复用。
- **造价专业语义红线（资深造价师口径）**：
  - `unitPrice` 是**综合单价**（人材机管利五要素组价结果）；`mainMaterialPrice` 是**主材暂估价**（询价/信息价，组价输入）。材料价/询价/材料库价**只能写 mainMaterialPrice，绝不写 unitPrice**——综合单价由定额组价生成。
  - 组价链路：`material.fillFromLibrary`/`applyQuotation` 写主材暂估价 → `quota.calculate` 测算（人材机+主材价×耗量+取费）→ `quota.applyCalc`（确认门）写回综合单价。缺主材价的项测算**不完整**：不算偏差、applyCalc 默认跳过。
  - **组价方案 `pricingPlan`**：一个清单项可挂多条定额子目（PricingPlanLine[] JSON）。`calcQuota` 产出主项行+工作内容缺口的建议增列行（`suggested`，不计入测算价——gcnr 未含的冲洗消毒/支吊架/试压/管件在同册找配套子目，直径档按数字归一化匹配）；`quota.applyCalc` 把已确认行写入 `pricingPlan`；`quota.setItemQuota`（确认门）人工 replace/append 子目并重算综合单价——存疑匹配的专业处置出口。
  - **±15% 量差调价预警**：`compareBoqSets` 对两版清单量差>15% 的行标 `qtyOver15`（GB50500 触发线，应重新组价），对审视图出危险徽标+计数。
  - **措施费系数（川标官方费率）**：Dataset「四川2020措施费系数」存 N10 `ps_fy`+`ps_fl` 费率表（meta.fees）。`cost.measureFees` 按**分册定额人工费**（quota.calculate 写台账「定额人工费明细」JSON）×费率档计取：脚手架搭拆费按册平费率、超高增加费按「操作物高度」、高层建筑增加费按「檐口高度」选档、系统调整费（采暖→5H/通风→5I）需台账启用；结果写台账「系数措施费」→ feeSummary 措施费自动叠加（导入措施清单真值+系数费并存）。费率档带人材机占比拆分。
  - `feeType` 计价表分层：分部分项 | 单价措施 | 总价措施 | 其他项目。表-11/表-12（总价措施/其他项目）只有名称+金额也必须导入（安全文明施工费是真钱）；表-04 汇总/规费税金表不导入（计算结果非清单项）。`isPricableItem()` 判定可计价项——总价措施/其他项目单价为 0 属正常，不算未定价。
  - 规费基数是**定额人工费**（四川安装口径），不是分部分项费：`quota.calculate` 测算后把 Σ(定额人工×量) 写台账 `定额人工费`，`feeSummary` 有真基数用真基数，否则退回简化口径并标注。
  - 总价控制：`quantity.adjust` 默认调**综合单价**（下浮/上浮，合规手段），`mode=quantity` 才调工程量（改变图纸口径，慎用）。
- 缺价补价闭环：`material.matchLibrary`（预览，只读，出 quotationMatch 视图）→ `material.fillFromLibrary`（确认门，写主材暂估价 + diff + 回执）→ `quota.calculate` → `quota.applyCalc`（确认门，写综合单价）；planner 区分「看看缺价」（仅预览）与「补齐/补价」（全链路）；总览页未定价卡片可一键触发。
- 费用汇总：`cost.feeSummary`（cost-engine/fees.ts）分部分项→措施→其他项目→规费→税前→税金→含税造价；费率读台账事实（措施费率/规费费率/暂列金额率/暂列金额/税率/定额人工费），未设置计 0 并在行内注明。导入了措施表/其他项目表时用真值，否则费率估算并标注。
- 成本构成：`cost.composition`（cost-engine/costComposition.ts）把可计价项合价拆成 人工/材料/机械/管利及其他 四分量——分量来源优先级 pricingPlan（定额组价）> 源表分解列（laborUnitPrice/machineUnitPrice）> 仅主材暂估价；`other = 合价 − 已知分量` 恒成立，未分解部分进 other 不猜拆；人材机三分量齐全才算 directCost/margin，margin<0 即**成本倒挂**（报价低于人材机成本）。组价方案行标了主材名但缺主材价 → 材料不完整、margin 置空。
- 费率/金额事实归一化：`project/facts.ts` 的 `parseRateValue`（"9%"/"9"/"0.09"→0.09）和 `parseAmountValue`（"5万"→50000）；**禁止 `Number(fact.value)`/`D(fact.value)` 直接消费台账值**——"9%" 会得到 NaN 或抛 DecimalError。

## 测试

`tests/` 下 vitest。改 cost-engine/file 解析必须跑 `npm test` + `npx tsx scripts/test-real.ts`（用桌面真实造价文件回归）。

## 清标检查与报告交付（R13+ 建立，勿漂移）

- **异常检查面**（`cost-engine/compare.ts`，全部确定性纯函数，`boq.compare` 一次全查）：
  相同项不同价 / 综合单价异常（离中位>15%）/ 项目特征不一致 / 合价算术不符（量×价≠合价）/
  单位不一致（量纲冲突，米≡m 归一后比对）/ 一码多名 / 非标编码（非12位国标）/
  缺编码（可计价行必填）/ 重复项（码+语义特征全同）/ 数据质量（负单价·负工程量·缺单位）。
  每个检查都有独立工具（boq.findXxx）出 anomalyTable 视图；planner 按话术路由。
- **费用符合性**：`feeCompliance`（fees.ts）查不可竞争费漏计（规费/安全文明/税金）、税率口径、
  暂列金额一致性、最高限价超限——进 `cost.feeSummary` 与报告异常摘要。
- **甲供材闭环**：OWNER_SUPPLIED 文件 → `material.checkOwnerSupplied` 匹配清单 →
  已计主材价的标「重复计价」→ `material.clearOwnerSuppliedPrice`（确认门）扣减 →
  报告「甲供材表」+ 异常摘要；autopilot 末尾自动跑。
- **报告 sheet**（`report.generate`）：项目汇总/费用汇总/分部分项清单/专业占比/材料占比/
  成本构成/综合单价分析/主要材料表/甲供材表/措施与其他项目/项目台账/异常摘要。
- **一键导出**（`assembleExportSheets`）：首页固定「费用汇总」，之后按（源文件×源工作表）
  分页，表尾「合价合计」复核行，未定价行显式标注+底色；`excel.write` 写回源表时对
  原值≠新值的单元格记批注（原值→新值+计算式），可审计可复算。
- **撤销口径**：回执 before/after 全字段快照；删除重建时源文件已删则 fileId 置空并注明。
  撤销冲突检测「只还原受影响字段」——行被后续改过会 409 拒撤。
