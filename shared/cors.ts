/**
 * Harness 主入口（3210）是业务数据的第二个一等客户端。
 *
 * 对话里的"导入摘要卡"和"结果卡"都要求插件在专业面板未打开时也能读到项目状态
 * （最近导入、待确认、Agent 产出的结果视图），否则用户每看一个结果都要先把面板顶开。
 * 因此把 API 开放给这一个来源，而不是开放给任意来源。
 */
export const HARNESS_ORIGIN = "http://127.0.0.1:3210";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": HARNESS_ORIGIN,
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  Vary: "Origin",
};

/**
 * 需要 JSON POST 的路由必须自己应答预检：next.config 的 headers 只是附加在
 * 路由产出的响应上，而带 JSON body 的跨源请求在路由被调用前就要先过预检。
 */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
