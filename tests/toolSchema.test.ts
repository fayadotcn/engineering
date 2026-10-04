import { describe, expect, it } from "vitest";
import { z } from "zod";
import "../agent/tools/boqTools";
import "../agent/tools/costTools";
import "../agent/tools/excelTools";
import "../agent/tools/materialTools";
import "../agent/tools/projectTools";
import "../agent/tools/quotaTools";
import { listTools, registerTool, toolNameFromWire, toolSchemasForLLM } from "../agent/tools/registry";

// LLM wire schema 守卫：所有已实现工具的 JSON schema 必须是合法对象型，
// required 里的键必须出现在 properties（否则 OpenAI/DeepSeek 网关 400 整轮失败）。

describe("toolSchemasForLLM wire 形态", () => {
  it("每个已实现工具转出合法 object schema", () => {
    const schemas = toolSchemasForLLM();
    expect(schemas.length).toBeGreaterThan(40);
    for (const s of schemas) {
      expect(s.parameters.type, s.name).toBe("object");
      const props = s.parameters.properties as Record<string, unknown>;
      expect(props, s.name).toBeDefined();
      for (const r of (s.parameters.required as string[]) ?? [])
        expect(props, `${s.name}.${r}`).toHaveProperty(r);
      expect(s.name).toMatch(/^[a-zA-Z0-9_-]+$/); // wire 名不含点号
    }
  });

  it("wire 名与工具名双向一致", () => {
    for (const t of listTools().filter((x) => x.implemented)) {
      const wire = t.name.replace(/\./g, "__");
      expect(toolNameFromWire(wire)).toBe(t.name);
    }
  });

  it("顶层 .refine() 包装的工具不塌成 type:string", () => {
    registerTool({
      name: "zz.testRefined",
      description: "t",
      implemented: true,
      schema: z.object({ a: z.string() }).refine(() => true),
      handler: async () => ({ observation: {} }),
    });
    const s = toolSchemasForLLM().find((x) => x.name === "zz__testRefined")!;
    expect(s.parameters.type).toBe("object");
    expect(s.parameters.properties).toHaveProperty("a");
  });

  it("optional/default 不进 required；nullable 仍 required", () => {
    registerTool({
      name: "zz.testRequired",
      description: "t",
      implemented: true,
      schema: z.object({
        a: z.string(),
        b: z.string().optional(),
        c: z.number().default(1),
        d: z.string().nullable(),
      }),
      handler: async () => ({ observation: {} }),
    });
    const s = toolSchemasForLLM().find((x) => x.name === "zz__testRequired")!;
    const req = s.parameters.required as string[];
    expect(req.sort()).toEqual(["a", "d"]);
  });
});
