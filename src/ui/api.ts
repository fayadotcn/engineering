import type { AgentEventDTO, BoqItemDTO, CostFactDTO, ReceiptDTO } from "@shared/types";

/** 保留服务端的业务错误；非 JSON 错误页使用可读的提示。 */
export async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `${fallback}（${response.status}）`);
  if (data === null) throw new Error(fallback);
  return data as T;
}

async function request<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  return readResponse<T>(await fetch(url, init), fallback);
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export interface FileMeta {
  id: string;
  filename: string;
  kind: string;
  kindLabel: string;
  status: string;
  stage?: string;
  period?: string;
  sizeBytes?: number;
  createdAt?: string;
}

export interface ProjectPayload {
  id: string;
  name: string;
  files: FileMeta[];
  facts: CostFactDTO[];
  receipts: ReceiptDTO[];
}

export interface ProjectSummary {
  itemCount: number;
  pricedCount: number;
  pricableCount: number;
  totalAmount: string;
  fees: { grandTotal: string; preTax: string; unpricedCount: number; rows: { seq: string; name: string; basis: string; rate: string | null; amount: string; level: "leaf" | "subtotal" | "total"; note?: string }[] };
  disciplines: { key: string; label: string; amount: string; share: number; count: number }[];
  missingSettings: string[];
  declaredCheck?: { file: string; checks: { label: string; declared: number; computed: number; diff: number; pct: number; note?: string }[] }[] | null;
  /** 实际参与申报核对的文件数（>0 且 declaredCheck 为空 = 核对一致） */
  declaredChecked?: number;
}

export interface RunRecord {
  id: string;
  userMessage: string;
  status: string;
  legacy?: boolean;
  events: AgentEventDTO[];
}

export interface ItemChange { field: string; label: string; from: string | null; to: string | null }

export type NewItemPayload = {
  name: string; code?: string; unit?: string; quantity?: string; quantityExpr?: string; unitPrice?: string;
  mainMaterialPrice?: string; totalPrice?: string; feeType?: string; insertAfter?: string; rawFeature?: string;
  unitProject?: string;
  laborUnitPrice?: string; machineUnitPrice?: string; pricingPlan?: string;
};

export type AdjustSpec = { field: "unitPrice" | "quantity" | "mainMaterialPrice"; mode: "percent" | "value"; value: string };
export type PastePatch = { id: string; quantity?: string; unitPrice?: string; mainMaterialPrice?: string };
type BatchResult = { receiptId?: string; updated?: number; affectedIds?: string[] };

/** 工作台访问的全部业务接口。组件和 store 不直接拼 URL。 */
export const api = {
  project: (id: string, signal?: AbortSignal) => request<ProjectPayload>(`/api/projects/${id}`, { signal }, "项目不存在或暂时无法读取"),
  renameProject: (id: string, name: string) => request<{ ok: true }>(`/api/projects/${id}`, json("PATCH", { name }), "改名失败"),
  boq: (id: string, signal?: AbortSignal) => request<BoqItemDTO[]>(`/api/projects/${id}/boq`, { signal }, "清单读取失败"),
  summary: (id: string, signal?: AbortSignal) => request<ProjectSummary>(`/api/projects/${id}/summary`, { signal }, "汇总读取失败"),
  runs: (id: string, signal?: AbortSignal) => request<RunRecord[]>(`/api/projects/${id}/runs`, { signal }, "任务记录读取失败"),
  /** 空闲同步探针：指纹 = 最新回执/run/行数/台账，变才触发全量刷新 */
  digest: (id: string, signal?: AbortSignal) =>
    request<{ receiptId: string | null; runId: string | null; runStatus: string | null; boqCount: number; fileCount: number; factId: string | null }>(
      `/api/projects/${id}/digest`, { signal }, "同步失败"),
  saveSettings: (id: string, values: Record<string, string>) => request<unknown>(`/api/projects/${id}/settings`, json("PUT", values), "保存失败"),

  startRun: (projectId: string, message: string, extra?: Record<string, unknown>) => request<{ runId: string }>(`/api/projects/${projectId}/agent/runs`, json("POST", { message, extra }), "任务启动失败"),
  confirmRun: (runId: string, approve: boolean) => request<{ ok: true }>(`/api/runs/${runId}/confirm`, json("POST", { approve }), "确认失败"),
  streamUrl: (runId: string) => `/api/runs/${runId}/stream`,

  upload: (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("filename", file.name);
    return request<{ runId: string | null; duplicate?: boolean; file?: { filename: string } }>(`/api/projects/${projectId}/files`, { method: "POST", body: fd }, "上传失败");
  },

  patchItem: (id: string, patch: Partial<BoqItemDTO>) =>
    request<{ item?: BoqItemDTO | null; receiptId?: string | null; changes?: ItemChange[] } | null>(`/api/boq-items/${id}`, json("PATCH", patch), "保存失败，请重试"),
  deleteItem: (id: string) => request<{ receiptId?: string }>(`/api/boq-items/${id}`, { method: "DELETE" }, "删除失败，请重试"),
  deleteItems: (ids: string[]) => request<{ receiptId?: string }>(`/api/boq-items/batch-delete`, json("POST", { ids }), "删除失败，请重试"),
  adjustItems: (ids: string[], spec: AdjustSpec) => request<BatchResult>(`/api/boq-items/batch-adjust`, json("POST", { ids, ...spec }), "调整失败，请重试"),
  pasteItems: (patches: PastePatch[]) => request<BatchResult>(`/api/boq-items/batch-patch`, json("POST", { patches }), "粘贴失败，请重试"),
  createItem: (projectId: string, payload: NewItemPayload) =>
    request<{ item?: { id?: string }; receiptId?: string }>(`/api/boq-items`, json("POST", { ...payload, projectId }), "添加失败，请重试"),
  revertReceipt: (receiptId: string) =>
    request<{ affectedIds?: string[]; restored?: BoqItemDTO[]; removedIds?: string[] }>(`/api/receipts/${receiptId}/revert`, { method: "POST" }, "撤销失败，请重试"),
};
