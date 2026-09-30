# 安装工程造价工作台

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方 `0.2.0-rc.2` Web 面板，安装工程造价功能以 Cordis 插件接入。对话、会话、模型设置和修改确认使用 Harness 原生能力。

## 运行

需要 Node.js 22.19 以上（或 24 以上）。

```sh
npm install
npm run db:push
npm run dev
```

打开启动时打印的 `dsh web` 地址。主入口为 `127.0.0.1:3210`，地址中的令牌用于官方面板的本地访问认证。完整地址保存在 `.harness/web.url`；重启后以新地址为准。

生产运行：

```sh
npm run build
npm start
```

专业数据服务在 `127.0.0.1:3211`，由主入口内嵌打开。左侧工程列表，主区域为工程的原生 Agent 对话，点击「打开工作区」在右侧查看专业数据。工作区固定为总览、工程清单、项目资料、计价条件、成果五个入口；操作结果在对应页面保留，刷新不会切走当前页面。导入低置信度资料时提示核对映射，确认后继续导入。工程上下文、任务状态与主题同步。

数据库和文件存储通过 `.env` 设置：

```dotenv
DATABASE_URL="file:./dev.db"
STORAGE_DIR="./storage"
```

在 Harness 的「设置 → 模型」配置模型与密钥；也可以按官方方式设置 `DEEPSEEK_API_KEY`。原先的 `MODEL_*` 配置已不参与对话执行。

## 工作流程

1. 点击「新建工程」，填写名称后直接进入该工程的 Agent 对话。
2. 在对话区或工作区顶部「导入资料」上传 Excel 或带文本层的 PDF；待确认时核对类型与列映射，修改后先保存，再确认导入。
3. 在 Harness 中要求匹配主材报价、匹配定额、测算综合单价。
4. 在「工程清单」预览主材匹配与定额测算，核对后在对话中批准写回；「计价条件」中保存价格依据与取费口径。
5. 在「成果」汇总费用、检查异常、导出 Excel；在总览查看下一步和变更记录。

主材询价只写主材暂估价，综合单价由定额组价生成。缺主材价的测算默认不写回。管理费率、利润率未确认时可按零预览，写回前必须明确填写；未设置税率暂不计税并提示。已导入的措施和其他项目金额优先，包括明确为零的金额。

## 结构

- `harness/cordis.patch.yml`：官方 Web 配置的造价适配。
- `harness/plugin/host.ts`：原生造价工具、确认与业务执行记录。
- `harness/plugin/client.tsx`：专业工作台入口及项目会话关联。
- `cost-engine/`：确定性的金额、工程量、定额组价和费用计算。
- `src/ui/`：项目总览、清单、映射、组价结果、计价设置与变更记录。
- `agent/runtime.ts`：确定性的文件导入；模型对话只由 Harness 执行。

默认使用「安装工程造价」Agent 预设，保留原生问答确认和长对话压缩；导航围绕工程组织，每个工程绑定独立会话。编程预设、通用文件写入与终端工具关闭。材料库、定额库继续通过专业后台管理。

## 验证

```sh
npm test
npm run typecheck
npx tsx scripts/test-real.ts
npm run build
npx tsx scripts/check-cost-flow.ts
```

`.harness/` 保存本地 Harness 状态与访问地址，不应提交。数据文件、上传资料和模型密钥也不应提交。
