import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-agent";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
type JsonSchemaNode = ToolDefinition["parameters"];
import { prisma } from "@database/client";
import { makeEmitter } from "@agent/events";
import { executeTool } from "@agent/executor";
import { listTools, toolSchemasForLLM } from "@agent/tools/registry";
import { createProject, listProjects } from "@project/service";

export const name = "installation-cost";
export const inject = ["tools", "systemPrompt", "approval"];

export function apply(ctx: Context, config: { businessUrl: string }) {
  // Project identity belongs to the session context, not to visible user messages.
  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const assembly = await next();
    if (context.agent) {
      const project = await prisma.project.findFirst({ where: { harnessSessionId: context.agent.id }, select: { id: true, name: true } });
      if (project) assembly.sections.push({ name: "installation:project", interpolate: false, text: `当前会话绑定的安装工程造价项目：${JSON.stringify(project)}。用户任务默认针对该项目；先调用 installation__project__read 获取最新资料和计价条件。` });
    }
    return assembly;
  });
  const render = (_: unknown, value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }];
  const output = { schema: { type: "object" as const, additionalProperties: true }, render };

  ctx.tools.register({
    name: "installation__listProjects",
    description: "列出安装工程造价项目及准确的 projectId；项目不明确时先调用此工具。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    presentCall: () => ({ card: "generic", title: "读取造价项目", kind: "read" }),
    output,
    async execute() {
      return { projects: (await listProjects()).map(p => ({ id: p.id, name: p.name, items: p._count.boqItems, files: p._count.files })) };
    },
  });
  ctx.tools.register({
    name: "installation__createProject",
    description: "按用户提供的工程名称新建造价项目。",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    output,
    async execute(args) {
      const name = (args as { name: string }).name.trim();
      if (!name || name.length > 120) throw new Error("项目名称应为 1–120 个字符");
      const project = await createProject(name);
      return { projectId: project.id, name: project.name, panelUrl: `${config.businessUrl}/p/${project.id}` };
    },
  });

  const schemas = toolSchemasForLLM();
  for (const def of listTools().filter(t => t.implemented && t.handler && t.name !== "project.create")) {
    const schema = schemas.find(s => s.name === def.name.replace(/\./g, "__"))!;
    const parameters = schema.parameters as { properties?: Record<string, JsonSchemaNode>; required?: string[] };
    ctx.tools.register({
      name: `installation__${schema.name}`,
      description: def.description,
      presentCall: () => ({ card: "generic", title: def.description.split(/[：:（(]/)[0], kind: def.confirm ? "edit" : "read" }),
      presentResult: (_, result) => {
        const content = result.content.find(c => c.type === "text");
        if (content?.type !== "text" || result.isError) return { card: "generic" };
        try {
          const data = JSON.parse(content.text) as { message?: string };
          return { card: "generic", content: [{ type: "text", text: data.message ?? "已完成" }] };
        } catch { return { card: "generic" }; }
      },
      parameters: {
        type: "object",
        properties: { ...parameters.properties, projectId: { type: "string", description: "项目的准确 ID" } },
        required: [...(parameters.required ?? []), "projectId"],
        additionalProperties: false,
      },
      output,
      async execute(input, exec) {
        exec.signal.throwIfAborted();
        const { projectId, ...args } = input as { projectId: string; [key: string]: unknown };
        const project = await prisma.project.findUnique({ where: { id: projectId } });
        if (!project) throw new Error("造价项目不存在，请先列出项目");
        const parsed = def.schema.parse(args);
        // A file mapping confirmation may inspect data: check ownership first.
        if (typeof args.fileId === "string") {
          const file = await prisma.projectFile.findFirst({ where: { id: args.fileId, projectId } });
          if (!file) throw new Error("该文件不属于当前造价项目");
        }
        const description = await def.confirm?.(parsed);
        if (description) {
          if (!exec.agent) throw new Error("写入操作需要一个有效的 Harness 会话");
          const outcome = await ctx.approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason: description, signal: exec.signal });
          if (outcome !== "allowed-once") throw new Error("用户未批准此修改，已停止；不得自动重试或改用其他写入工具");
        }
        exec.signal.throwIfAborted();
        const run = await prisma.agentRun.create({ data: { projectId, userMessage: `Harness：${def.description}`, planner: "harness" } });
        const emit = makeEmitter(run.id);
        try {
          const result = await executeTool({ projectId, runId: run.id, userId: "local", emit }, def.name, parsed);
          const observation = result.observation as { error?: string; ok?: boolean; reason?: string } | null;
          if (observation?.error || observation?.ok === false) throw new Error(observation.error ?? observation.reason ?? "造价工具执行失败");
          await prisma.agentRun.update({ where: { id: run.id }, data: { status: "DONE", summary: result.message ?? def.description, finishedAt: new Date() } });
          await emit("run_finished", { status: "DONE" });
          // Exact view IDs also survive in the project's receipt/event history.
          return { observation: result.observation ?? null, message: result.message ?? "执行完成", panelUrl: `${config.businessUrl}/p/${projectId}`, views: (result.views ?? []).map(v => ({ id: v.id, kind: v.kind, title: v.title })) };
        } catch (error) {
          await prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED", summary: String(error), finishedAt: new Date() } });
          await emit("error", { text: error instanceof Error ? error.message : String(error) });
          await emit("run_finished", { status: "FAILED" });
          throw error;
        }
      },
    });
  }
}
