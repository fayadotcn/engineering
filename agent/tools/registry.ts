import { z } from "zod";
import type { WorkspaceView } from "@shared/types";

// Unified Tool Registry. Every tool: name, zod schema, handler.
// Handlers return { observation } for the reasoner + optional workspace views
// + optional receipts (persisted by the executor).

export interface ToolContext {
  projectId: string;
  runId: string;
  userId: string;
  emit: {
    (type: string, payload: Record<string, unknown>): Promise<void>;
    /** 瞬时事件：只推 SSE 不落库（流式增量等高频事件用） */
    live?(type: string, payload: Record<string, unknown>): void;
  };
}

export interface ToolReceiptDraft {
  actionType: string;
  summary: string;
  before: unknown;
  after: unknown;
  reversible?: boolean;
  /** 已在 handler 内随业务写同一事务落库的回执 id：executor 不再重复 create，
   *  只回填 toolCallId 关联并 emit（破坏性操作必须走这条——先删后写回执
   *  存在「删了但回执没落库」的审计空洞） */
  persistedId?: string;
}

export interface ToolResult {
  observation: unknown; // compact, reasoner-facing
  views?: WorkspaceView[]; // pushed to dynamic workspace
  receipts?: ToolReceiptDraft[];
  message?: string; // optional short line appended to agent reply
}

export interface ToolDef<A = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  implemented: boolean;
  /** 执行前需用户确认；返回值是展示给用户的中文描述，返回 null 表示本次不需要确认 */
  confirm?: (args: NoInfer<A>, ctx: ToolContext) => string | null | Promise<string | null>;
  handler?: (ctx: ToolContext, args: A) => Promise<ToolResult>;
}

const tools = new Map<string, ToolDef>();

export function registerTool<A>(def: ToolDef<A>) {
  tools.set(def.name, def as ToolDef);
}

export function getTool(name: string): ToolDef | undefined {
  return tools.get(name);
}

export function listTools(): ToolDef[] {
  return [...tools.values()];
}

/** JSON schemas for LLM tool-calling.
 *  注：DeepSeek/OpenAI/Anthropic 的 function name 只允许 [a-zA-Z0-9_-]，
 *  「material.matchLibrary」这类点号名会被 400 拒绝，线上用 __ 转义。 */
export function toolSchemasForLLM() {
  return listTools()
    .filter((t) => t.implemented)
    .map((t) => ({
      name: t.name.replace(/\./g, "__"),
      description: t.description,
      parameters: zodToJsonSchema(t.schema),
    }));
}

export function toolNameFromWire(wireName: string): string {
  return wireName.replace(/__/g, ".");
}

function unwrap(s: z.ZodType<unknown>): z.ZodType<unknown> {
  for (;;) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) {
      s = (s as z.ZodOptional<z.ZodType<unknown>>).unwrap();
    } else if (s instanceof z.ZodDefault) {
      s = (s as z.ZodDefault<z.ZodType<unknown>>).removeDefault();
    } else if (s instanceof z.ZodEffects) {
      // .refine()/.transform() 挂在顶层会让整个工具 schema 退化成 {type:"string"}——剥掉看真身
      s = s.innerType();
    } else {
      return s;
    }
  }
}

function leafSchema(s: z.ZodType<unknown>): Record<string, unknown> {
  const u = unwrap(s);
  // .describe() 可能挂在外层 optional 或内层 schema 上——两端都取，
  // 否则 LLM 只看到类型看不到字段语义（replace/append 之类全靠猜）
  const desc = (s.description ?? u.description) as string | undefined;
  const out = leafType(u);
  if (desc) out.description = desc;
  return out;
}

function leafType(u: z.ZodType<unknown>): Record<string, unknown> {
  if (u instanceof z.ZodString) return { type: "string" };
  if (u instanceof z.ZodNumber) return { type: "number" };
  if (u instanceof z.ZodBoolean) return { type: "boolean" };
  if (u instanceof z.ZodEnum) return { type: "string", enum: u.options };
  if (u instanceof z.ZodLiteral) return { type: "string", enum: [u.value] };
  if (u instanceof z.ZodArray) return { type: "array", items: leafSchema(u.element) };
  if (u instanceof z.ZodObject) return zodToJsonSchema(u);
  if (u instanceof z.ZodUnion) return leafSchema(u.options[0]);
  return { type: "string" };
}

function zodToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const u = unwrap(schema);
  if (u instanceof z.ZodObject) {
    const shape = u.shape as Record<string, z.ZodType<unknown>>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = leafSchema(v);
      if (!(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault))
        required.push(k);
    }
    return { type: "object", properties, required };
  }
  return leafSchema(u);
}
