import { describe, expect, it } from "vitest";
import { readResponse } from "../src/ui/api";

describe("前端请求反馈", () => {
  it("返回成功的数据", async () => {
    expect(await readResponse(Response.json({ total: 3 }), "读取失败")).toEqual({ total: 3 });
  });
  it("保留业务错误，便于用户修改输入", async () => {
    await expect(readResponse(Response.json({ error: "名称不能为空" }, { status: 400 }), "保存失败")).rejects.toThrow("名称不能为空");
  });
  it("服务器返回 HTML 错误页时显示可读提示", async () => {
    await expect(readResponse(new Response("<html>server error</html>", { status: 503 }), "价格数据加载失败")).rejects.toThrow("价格数据加载失败");
  });
  it("损坏的成功响应不能被当作保存成功", async () => {
    await expect(readResponse(new Response(""), "保存失败，请重试")).rejects.toThrow("保存失败，请重试");
  });
});
