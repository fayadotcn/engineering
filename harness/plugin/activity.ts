/**
 * 业务数据的第二个客户端。
 *
 * 对话里的卡片要在专业面板关闭时也能说话（最近导入、待确认、Agent 产出的结果视图），
 * 所以插件直接读写 3211 的项目状态，而不是等面板里的 iframe 转发。
 * 这里只放纯数据动作，不带 React。
 */

export type ActivitySheet = {
  sheetName: string;
  type: string;
  rowCount: number;
  minConfidence: number;
  templateHit: boolean;
  userEdited: boolean;
  lowColumns: number;
};

export type ActivityView = { id: string; kind: string; title: string; rows?: number };

export type ProjectActivity = {
  confirm: { runId: string; confirmId: string; tool: string; description: string } | null;
  import: {
    runId: string;
    status: string;
    at: string;
    filename: string;
    /** 该文件自己的列映射视图 id；「检查映射」直接定位到它 */
    mappingViewId: string | null;
    summary: string;
    totals: { items: number; priced: number; pricable: number; amount: string } | null;
    sheets: ActivitySheet[];
  } | null;
  result: { runId: string; status: string; at: string; summary: string; views: ActivityView[] } | null;
};

export type UploadOutcome =
  | { kind: "queued"; runId: string; filename: string }
  | { kind: "duplicate"; filename: string }
  | { kind: "error"; message: string };

export async function fetchActivity(businessUrl: string, projectId: string): Promise<ProjectActivity | null> {
  try {
    const res = await fetch(`${businessUrl}/api/projects/${encodeURIComponent(projectId)}/activity`);
    if (!res.ok) return null;
    return (await res.json()) as ProjectActivity;
  } catch {
    return null;
  }
}

export async function uploadProjectFile(businessUrl: string, projectId: string, file: File): Promise<UploadOutcome> {
  const form = new FormData();
  form.append("file", file);
  // multipart 的文件名可能以非 UTF-8 到达，显式字段优先
  form.append("filename", file.name);
  try {
    const res = await fetch(`${businessUrl}/api/projects/${encodeURIComponent(projectId)}/files`, { method: "POST", body: form });
    const data = (await res.json().catch(() => ({}))) as { runId?: string | null; duplicate?: boolean; file?: { filename?: string }; error?: string };
    if (!res.ok) return { kind: "error", message: data.error ?? `上传失败（HTTP ${res.status}）` };
    if (data.duplicate) return { kind: "duplicate", filename: data.file?.filename ?? file.name };
    if (!data.runId) return { kind: "error", message: "导入任务未创建" };
    return { kind: "queued", runId: data.runId, filename: file.name };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : "上传失败" };
  }
}

export type RunEvent = { type: string; payload: Record<string, unknown> };

/**
 * 与专业面板同一套事件流：卡片据此显示"正在识别…"与被要求确认的内容。
 *
 * 确认门会让 run 停在 AWAITING_CONFIRM（run_finished 要等用户批准才来），
 * 所以必须允许调用方在确认点收流，否则卡片会一直停在"正在导入"。
 */
export async function streamRun(
  businessUrl: string,
  runId: string,
  onEvent: (event: RunEvent) => void,
  shouldStop?: () => boolean
): Promise<void> {
  try {
    const res = await fetch(`${businessUrl}/api/runs/${encodeURIComponent(runId)}/stream`);
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5)) as RunEvent);
        } catch {
          // 半条事件不值得打断导入
        }
        if (shouldStop?.()) {
          await reader.cancel().catch(() => {});
          return;
        }
      }
    }
  } catch {
    // 断流由活动刷新兜底
  }
}

export async function confirmRun(businessUrl: string, runId: string, approve: boolean): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`${businessUrl}/api/runs/${encodeURIComponent(runId)}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return { ok: false, message: data.error ?? `操作失败（HTTP ${res.status}）` };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "操作失败" };
  }
}

/** 从 markdown 摘要里取一句能放在卡片上的结论。 */
export function gistOf(summary: string, limit = 96): string {
  const lines = summary
    .split("\n")
    .map((line) => line.replace(/^[#>\-*\s]+/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);
  const line = lines.find((l) => l.length > 12) ?? lines[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** 导入摘要的最后一行是 project.summary 的口径说明，比整段 markdown 更适合卡片。 */
export function summaryLine(summary: string): string {
  const lines = summary
    .split("\n")
    .map((line) => line.replace(/^[#>\-*\s]+/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);
  return lines.reverse().find((l) => /清单\s*\d+\s*行/.test(l)) ?? lines[0] ?? "";
}
