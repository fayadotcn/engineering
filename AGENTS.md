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

单系统自有引擎（`agent/` runtime + llm + planner + executor + pending + SSE）。`POST /api/projects/[id]/agent/runs` 发起任务，事件经 `/api/runs/[runId]/stream` 回放至工作台左轨原生会话面板；确认门走 `/api/runs/[runId]/confirm`。模型请求失败时 runtime 发 `model_fallback` 事件（payload.reason=失败原因）并降规则引擎——前端据此显示常驻「固定任务模式」横幅，下一次模型产出 thought 事件自动解除。上下文含 `lastRun`（最近一轮的 tool_finished 摘要），供「刚才/那些/继续」类指代解析。**轮数用尽（`runLLMLoop` 默认 8 轮）不以占位文案结束**：先做一次无工具收尾调用让模型给阶段性总结（成果/卡点/下一步），失败或空回复退 `agent/wrapUp.ts` 的确定性摘要（列出本轮真实执行过的工具与结果要点）——历史事故：145 项综合单价写回 + 2 条回执全部落库，用户只看到「已达到最大推理轮数」，误判任务中断。

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
- **通用清单接入管道**（任意格式 Excel）：`file.inspect`（`inspectWorkbook` 识别 → 套 `ImportTemplate` 模板 → 存 `ProjectFile.meta.mapping` → 推 `columnMapping` 视图）→ `file.ingest`（async 确认门：模板命中/用户改过/minConfidence≥0.9 才自动放行，否则暂停等用户在视图改列/改类型后批准；先 `deleteByFile` 保证重导幂等；确认过的映射按表头指纹 sha1 沉淀为全局模板）。列角色最强证据是**数值一致性**（`lockByArithmetic`：数量×单价≈合价 锁定三列，0.97），不是表头字；类型判定顺序：措施表名 > 清单信号(项目编码/工程量/综合单价) > 强询价信号(材料名称/品牌/询价) > 有量有价→清单(裸「单价」=综合单价) ；「规格型号+量×价=合价」在简式清单与询价单间真实歧义（typeConfidence 0.6）→ 靠文件名 `applyTypeHint` 纠偏或让用户确认。改类型时 price↔unitPrice 角色必须用 `shared/mapping.ts reconcilePriceRole` 同步（客户端/服务端共用）。`BoqItem.rawCells` 保留整行原文 + `__nonNumeric/__derived`；无综合单价列时 unitPrice=合价÷量。`ProjectFile.contentHash` 同项目同内容不重复导入；`POST /api/files/[id]/reingest` 按当前映射重导。
- **导入口径守卫（真实文件回归钉住）**：① 表头先扫前 15 行，找不到再深扫前 200 行且要求「短标签为主」——打印版清单封面/编制说明几十行后才出表头；表头文字被拆到各自一行（「计量」/「单位」/「综合单价|合价」）时按**表头块累积**（上 1 行 + 下至多 6 行，只吸收短标签行且列位不与锚点行重复）拼成完整表头，否则价列识别不到、综合单价全丢。② 同一 sheet 里挤多张表（清单+措施+规费税金，打印版常见）：按角色列标签比对识别第 2 张表的表头，之后的行不再按首表列位解析（重复表头=分部续表，不裁剪）；裁剪行号存 `SheetMapping.dataEndRow`，重导沿用。③ 名称被拆到相邻行（「干作业成孔灌注」+「桩」夹着一条只带编码/量/价的行）：锚点行缺名称时按 ±2 行回收名称碎片，碎片行不再单独出项。④ 询价单「名称及规格型号」单列 → name 与 spec 同列（否则整表判无名行全丢）；报价清单「单项工作名称/分项名称/清单名称」也认名称；询价/价格表没有名称列时用规格型号兜底成材料名。⑤ 无表头表按数据画像推断：名称列放宽到 30 字（长型号名如「配电箱 F/B1-6AEPZ」不再丢）、数字为主的行不算名称；只有名称+单位（待询价材料表/器材清册）判 `PENDING_QUOTE` 导入而不是当垃圾丢掉。⑥ 企业定额/标准清单库（一级/二级编码体系 + 清单编号 + 计算规则/工作内容 + 无工程量列，或表名 定额/企业定额/标准清单）判 `GENERIC` 不产清单行——否则 7000+ 条 0 量 0 价「清单项」灌进项目。⑦ 总价措施/其他项目表「有名称即成行」：金额列写「详见本标准表 E.4.x」也要进表（落 0 待补），整表 0 行等于把真钱丢掉。⑧ 表名含 汇总/说明/口径/扉页/取费 且不可清单化 → `FACTS`（排在 COMPARE/APPROVAL/MATERIAL_PRICE/QUOTATION 之后兜底，不抢数据表）；`factsExtract` 对 FACTS 表追加**散文口径行**取数——「税率6%；管理费率5%；地区=马来西亚」式 key=value 连写也进台账（数值键可无分隔符、文本键必须有 `=`/`：`；`增值税率/征收率`归一化为「税率」（材料/土地前缀除外），城建/所得/印花等非工程税率不入；结构化表-13 取数优先）。
- **导入行数预报**：识别结果带 `SheetMeta.itemsToImport`（= 与正式导入同一口径的 `importableRowCount`：BOQ/待报价表、名称非空、非父子去重行）；列映射视图显示「将导入 N 行（表内 M 行）」，0 行红标 + 确认门描述告警；老文件在 `ensureInspection` 里补算一次并落库。人工/机械单价列（laborPrice/machinePrice）导入时升格为 `BoqItem.laborUnitPrice/machineUnitPrice`（rawCells 仍留原文），由 `cost.composition` 人材机成本构成分析直接消费。
- `file/pdf.ts` PDF 文本层提取（pdfjs-dist，serverExternal）+ BOQ 行识别（编码+单位+量+价正则）；≥5 行自动导入清单，否则按文档展示（document 视图）。
- `cost-engine/fileCompare.ts` 两版清单对审：编码优先对齐、无编码按语义组键；输出 价差/量差/独有项 + 总额差（fileCompare 视图）。
- 确认门：带 `confirm` 标记的专业工具经 `agent/pending.ts` 挂起 run（AWAITING_CONFIRM），POST /api/runs/[runId]/confirm 批准后才执行；文件导入的映射确认同走此门。跨请求的导入待确认表和事件订阅必须存 globalThis（Next 每个 route 独立 module graph）。活 run 判定走 `agent/runtime.ts liveRunWhere()`：RUNNING 按创建窗口（15min）判，**AWAITING_CONFIRM 不按窗判**——它在本进程内必配对活 resolver（确认门 10min 超时收口），按 createdAt 判死会让第二个 run 在待确认期间起跑并发写清单。
- `cost-engine/calcExpr.ts` 工程量计算式求值（递归下降，禁 eval；×÷（）全角与单位词自动处理）。
- 前端样式：shadcn/ui new-york 体系——`src/ui/styles/` 分文件，`tokens.css` 是**唯一设计变量源**。
  - **分层是硬约束**：`globals.css` 里 `tokens.css` 不入层（`@theme` 必须顶层），其余 6 个样式文件一律 `@import ... layer(components)`。项目 CSS 未分层时会压过 Tailwind 的 `utilities` 层，组件 `variant`/`size` prop 运行时失效、调用点被迫用 `!important` 转义——这是历史坑，别再走回去。**尺寸一律用组件 prop 表达，不要用 CSS 或 className 覆盖**。
  - **tokens 刻度**：字号 6 档（`--text-2xs` 11 / `--text-xs` 12 / `--text-sm` 14 / `--text-base` 16 / `--text-xl` 20 / `--text-2xl` 26），禁止 `text-[13px]` 之类任意值与小数档；圆角 4 档 `--radius-*`；动效 3 档时长（`--dur-fast/base/slow`）+ 2 条曲线（`--ease-standard/out`）；控件高度统一 32px（全页表单 36px）。**注释里绝不能出现星号加斜杠的连续序列**（如写 `rounded-*/shadow-*`），会提前闭合注释并让整块 `@theme` 被 Tailwind 丢弃——曾导致整套圆角刻度静默失效。
  - **品牌色**：深林绿系（`--primary` 浅色 #2f5d46 / 暗色 #7fb99b），`ring`/图表/选中态同源；中性面保持灰阶不染绿。所有文字与图形对已按 WCAG 校验（正文 ≥7:1、辅助 ≥4.5:1、焦点环与图表 ≥3:1），改色前先跑 `.design-audit/palette-check.mjs`。
  - **组件库**：`src/components/ui/`（Radix + cva，统一 `cn()`）。**19 个组件全部在用，业务代码不得再手搓原生控件**：输入 `<Input>`、下拉 `<Select>`、勾选 `<Checkbox>`+`<Label>`、多行 `<Textarea>`、分隔 `<Separator>`、面板 `<Card asChild>`、提示 `<Tooltip>`、错误/警告 `<Alert>`、空态 `<EmptyState>`、骨架 `<Skeleton>`、确认门 `<AlertDialog>`（经 `primitives.tsx` 的 `ConfirmDialog`）。
    - **控件尺寸一律走 size prop，不用 className 覆盖**：`Input` xs 28 / default 32 / lg 36（整页表单主字段）；`SelectTrigger` xs 28（表格单元格内联编辑）/ sm 32（常规表单）/ default 36；`Button` xs 28 / sm 32 / default 36 / icon-xs 28 / icon-sm 32 / icon 36；`Badge` 默认 / `size="xs"`（表格行内）。原 `.cost-input` 皮肤**已删除**，不要再加回来。
    - **三个 Radix 坑（都踩过）**：① `SelectValue` 必须显式给 children——收起态靠已挂载的 item 反查文案，服务端渲染/首帧没 item 时是空白；② Select 的 item value **不能是空串**（空串即 placeholder 语义），「全部/未指定/自动」用哨兵值映射回 `""`；③ `TooltipTrigger asChild` 会让 Radix 把 `data-slot` 覆写成 `tooltip-trigger`，所以按 `data-slot="button"` 选择的地方要一并考虑（CSS 已覆盖 `a[data-slot="tooltip-trigger"]`）。
  - **表格原语是 `.xl-table`（table.css），不是 shadcn `<Table>`**：sticky 表头 + 行号槽 + `.xl-pin-last` 冻结末列 + 行态 + 容器查询收缩 + 打印重置，这套能力超出 shadcn Table（后者自带 `overflow-x-auto` 容器，会**让 sticky 表头静默失效**）。数据网格一律用 `xl-table`，`components/ui/table.tsx` 仅用于无冻结需求的普通小表。**没有** `cost-btn`/`chip`/`icon-btn`/`cost-input` 这类旧类。
  - 明暗主题走 `<html data-theme>`：`layout.tsx` 内联脚本首帧前落定（localStorage `cost-theme`=auto|light|dark）；`ui/ThemeToggle.tsx` 三态切换；Radix `TooltipProvider` 挂在 layout，说明性提示走 `<Tooltip>` 而非原生 `title=`。字体为 `next/font` 注入的 Inter（仅 Latin 子集，数字等宽）+ 系统 CJK 栈。打印强制浅色口径并带 `@page`/断页控制。
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
- **meta 一律合并写**（数据集 `mergeDatasetMeta` / 项目文件 `mergeFileMeta`：事务内重读最新 meta 再打补丁）：ingest/识别/确认门标旗都是入口快照读、执行有窗口，期间并发的 mapping PATCH 若被整写覆盖就静默丢人工改动——与文件 PATCH /mapping 的读-改-写口径同源。`createDataset` 建档失败必须回收已 put 的存储块（不落库的记录拿不到 storageKey 回收点）。
- **四川2020定额已入库**：`scripts/import-sc2020-quota.ts` 从「清单计价专家N10」本地 SQLite（`C:/Program Files/清单计价专家N10/DATABASE/`）导入 az_de 全部 14,867 条安装定额（11 分册 5A–5K）。字段映射：debh→code / xmmc→name / dw→unit+unitScale / rgf·clf·jxf→人材机 / az_yl+zh_cl→主材耗量（归一化）/ az_zy→xmbh 清单编码映射。重跑脚本幂等（同名数据集先删后建）。
- `scoreQuota` 打分：category 40 / material 25 / diameter 20 / spec 15 / connection 10 / system 12 / keywords 10 / **名称命中 15~25 分级**（清单名与定额名共享汉字 bigram 数 ≥3→25、=2→20、=1→15，剥「安装|敷设|制作|连接|工程|以内|室内|室外|明配|暗配|材料|规格」停用词）。**冲突扣分**：单位族不合直接 0 分（个/台 vs m/m³ 跨族闸门）；特征冲突 -15×条数（坐式≠蹲式、明装≠暗装、法兰≠螺纹等对立词对）；材料冲突仅金属类生效（YJV电缆 等型号词不当金属材处理，避免误伤）。**档位制比对**：定额「XXmm/mm²以内」按数值档位算（DN32 落 40 以内档、4mm² 落 4 以内档），超档扣分贴档得分；裸 `2.5mm2`/`DN20`/`Φ100` 无「以内」也进 specification/diameter。**匹配证据门槛 `hasMatchEvidence`**：实质特征分（category+material+diameter+spec+connection）≥75 或名称命中，否则即使过 50 分阈值也判未匹配。匹配时重解析定额名特征（`service.ts`）+ 清单名重解析（`refreshItemFeatures`），规则更新即时生效不依赖入库时固化值。**注意：`matchKeys.xmbh` 是软件内部「册章节树码」，不是 GB 清单编码——绝不能拿来比对 `item.code`**。
- **类别词表扩到装饰+安装全域**（`semantic.ts CATEGORIES`）：卫生器具、水表计量、开关插座、灯具、桥架母线（母线槽优先线槽）、电线管(配管)、电气线路(配线)、楼地面/墙柱面/天棚/门窗/砌筑/防水/涂饰/隔墙等——装饰项不再因无类别而随机撞安装子目。注意规则顺序敏感（母线槽须在配线前、法兰连接须在螺纹前、按钮须进开关插座词表）。
- **材料归一化**（`semantic.ts MATERIALS`）：型号词优先——`电缆|YJV|YJLV|VLV|矿物绝缘` 出现时压过芯材标注（「YJV铜芯」≡「YJV」同材）；JDG/KBG→镀锌钢管、BV/BVR/BYJ/铜芯→铜（管内穿线分芯子目）、铝芯/BLV→铝。规格比走 `specCompatible`：归一化相等或复合芯段互覆盖（询价「4×35」可命中清单「4x35+1x16」，+PE 为辅芯段）。
- 系统归属 tiebreak：定额编号前缀→系统词表（5G→消防|喷淋、5H→给排水、5I→通风空调…），清单项 `sectionPath`/名称含系统词时同册定额 +12——解决跨册同名子目同分问题（如消防管误配给排水册）。
- 存疑判定：`top2Quota` 分差≤10 且基价差>5% 且**两候选都有匹配证据**才标「存疑」（跨册同名同价不算歧义，第二名只是凑分的也不算）；存疑行 UI 出琥珀徽标+备选子目，提示用 `spec.search` 核实。
- **定额说明检索**：`spec.search` 工具查 `SpecSection` 表（201 节，来自《2020定额说明及计算规则》PDF，`scripts/import-sc2020-spec.ts` 导入）；结果出 `specResult` 工作区视图（分册徽标+条文摘录）。planner 触发词含「定额说明/计算规则/怎么计算/怎么算」等。
- **手册核查方向（quota.match 内建）**：歧义项按候选子目 `detail.chapter` 定位共享章节的条文（`specRefs`），未匹配项按名称 bigram 在 SpecSection 标题→正文二级检索给出「该查哪册哪章」（`unmatchedHints`，同分优先分册体量大的主手册）——只是核查方向，不自动改写匹配。
- **未匹配四通道（造价实务出路）**：quota.match 把无直接子目项分为 `inherited`（同项目同名项已有确认 pricingPlan，直接复用不重打分）、`borrowable`（手册章名 bigram → 同分册/同章子目候选，rank=fb命中×3+章命中×2+名命中×4，借套换算需人工 setItemQuota 确认）、`estimateOnly`（手册有方向但库无同章子目→补充单价/暂估价）、`outOfScope`（手册无方向→覆盖域外，走市场询价，不进定额人工费基数）。「找不到直接子目」是常态不是失败——借套/暂估是组价的正常路径。
- **联网检索兜底**：`web.search` 工具（DuckDuckGo lite 端点免 key，12s 超时）；断网退化链：web 失败 → `askModel`（`agent/llm.ts` 一次性问答出口，配置了模型才有）→ 双失败才报错。只读不写，结果标注来源（`source:llm-knowledge` 时提示口径仍以本地手册为准）。planner 仅在用户显式说「联网/上网/网上查/网搜」时路由；LLM 模式下经工具 schema 可见，作 spec.search 之后的第二信源。
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
- **表-08 分解列**：`其中：人工费/材料费/机械费/管理费/利润` 映射为 `laborFee/machineFee/materialFee/mgmtFee/profitFee`（**合价口径**，不是单价）：原文进 `rawCells.__decomp`，`cost.composition` 直采真值（人材机已知、管利进 other 残差、三分量齐才算 margin）；人/机另折算成每清单单位值进 `BoqItem.laborUnitPrice/machineUnitPrice`（4 位小数）。**含税过滤（taxIncluded）必须覆盖单价措施**——只过滤分部分项会让含税单价的单价措施行先并入税前造价、随后又按含税口径并一次（重复计税）。
- 费用汇总：`cost.feeSummary`（cost-engine/fees.ts）分部分项→措施→其他项目→规费→税前→税金→含税造价；费率读台账事实（措施费率/规费费率/暂列金额率/暂列金额/税率/定额人工费），未设置计 0 并在行内注明。导入了措施表/其他项目表时用真值，否则费率估算并标注。
- 成本构成：`cost.composition`（cost-engine/costComposition.ts）把可计价项合价拆成 人工/材料/机械/管利及其他 四分量——分量来源优先级 pricingPlan（定额组价）> 源表分解列（laborUnitPrice/machineUnitPrice）> 仅主材暂估价；`other = 合价 − 已知分量` 恒成立，未分解部分进 other 不猜拆；人材机三分量齐全才算 directCost/margin，margin<0 即**成本倒挂**（报价低于人材机成本）。组价方案行标了主材名但缺主材价 → 材料不完整、margin 置空。
- 费率/金额事实归一化：`project/facts.ts` 的 `parseRateValue`（"9%"/"9"/"0.09"→0.09）和 `parseAmountValue`（"5万"→50000）；**禁止 `Number(fact.value)`/`D(fact.value)` 直接消费台账值**——"9%" 会得到 NaN 或抛 DecimalError。**调整系数类事实走 `parseCoefficientValue`**（"3"/"3倍"/"×3"/"300%"→3 = 调增 300%，即人工费为定额人工费的 4 倍）——裸数字 >1 不折百分数；`validatePricingFact` 对「调整系数」按 0–10 倍数校验、不按 0–100% 费率卡；`fees.ts` 的人工费调整行必须写清「调增至 N 倍」。历史坑：「人工费参考国内×4」被写成系数 4 → 按费率解析成 4%，626,369 元调差只计了 8,351 元（差 75 倍）。

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
  原值≠新值的单元格记批注（原值→新值+计算式），可审计可复算。复制/补录行
  `rowIndex=-1` 无源表坐标——写回时跳过并在结果里报数（`skippedNoAnchor`）；
  `writeBackPrices` 对非法行号同样跳过（getRow(≤0) 会抛 Invalid Address 中止整本写回）。
  源格是「详见…」式注解（`__nonNumeric` 留痕）且当前值仍为 0 → 跳过该格不写 0
  （`skippedAnnotated`）；总价措施/其他项目行量与单价结构上不可编辑，写回只写合价。
- **撤销口径**：回执 before/after 全字段快照；删除重建时源文件已删则 fileId 置空并注明。
  撤销冲突检测「只还原受影响字段」——行被后续改过会 409 拒撤。
