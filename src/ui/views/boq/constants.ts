import type { BoqItemDTO } from "@shared/types";

export type BoqSortKey = "code" | "name" | "quantity" | "unitPrice" | "totalPrice";
export type BoqEditField = "quantity" | "unitPrice" | "totalPrice";

/** 手工补录行的伪分组标题：补录行无导入分部归属，独立成段便于复核 */
export const MANUAL_GROUP_ID = "__manual_group__";
export const MANUAL_GROUP_ROW = { id: MANUAL_GROUP_ID, isHeader: true, name: "手工补录" } as BoqItemDTO;

// 多选批量调价：一条回执原子撤销（对审统一下浮/统一暂估价的日常操作）
export const ADJ_FIELD: Record<string, string> = { unitPrice: "综合单价", quantity: "工程量", mainMaterialPrice: "主材暂估价" };

/** 手工补录弹窗表单 */
export type AddForm = { name: string; code: string; unit: string; quantity: string; unitPrice: string; totalPrice: string; feeType: string };
/** 批量调价弹窗表单 */
export type AdjForm = { field: "unitPrice" | "quantity" | "mainMaterialPrice"; mode: "percent" | "value"; value: string };
/** Ctrl+V 粘回预览的一行：目标清单行 + 待写入的数字列 */
export type PastePlanRow = { it: BoqItemDTO; patch: { quantity?: string; unitPrice?: string; mainMaterialPrice?: string } };
