import type { BoqItemDTO } from "@shared/types";
import { toast } from "../../primitives";
import { displayFeature } from "../shared";

/** 清单行 → TSV 写剪贴板：Excel/WPS 直接成表，列与表格所见一致。 */
export const copyRowsToExcel = async (rows: BoqItemDTO[]) => {
  const head = ["项目编码", "项目名称", "项目特征", "单位", "工程量", "综合单价", "合价"];
  const cell = (v: unknown) => String(v ?? "").replace(/[\t\r\n]+/g, " ").trim();
  const lines = rows.map((it) => [
    it.code, it.name, displayFeature(it.rawFeature ?? "", it.name), it.unit, it.quantity, it.unitPrice, it.totalPrice,
  ].map(cell).join("\t"));
  try {
    await navigator.clipboard.writeText([head.join("\t"), ...lines].join("\n"));
    toast.success(`已复制 ${rows.length} 行，可直接粘贴到 Excel`);
  } catch {
    toast.error("复制失败：浏览器未授权剪贴板");
  }
};
