import { z } from "zod";
import type { WorkspaceView } from "@shared/types";

// Unified Tool Registry. Every tool: name, zod schema, handler.
// Handlers return { observation } for the reasoner + optional workspace views
// + optional receipts (persisted by the executor).

export interface ToolContext {
  projectId: string;
  runId: string;
  userId: string;
  emit: (type: string, payload: Record<string, unknown>) => Promise<void>;
}

export interface ToolReceiptDraft {
  actionType: string;
  summary: string;
  before: unknown;
  after: unknown;
  reversible?: boolean;
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
  confirm?: (args: A) => string | null;
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
    } else {
      return s;
    }
  }
}

function leafSchema(s: z.ZodType<unknown>): Record<string, unknown> {
  const u = unwrap(s);
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
