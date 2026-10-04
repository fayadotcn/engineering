"use client";
import type { BoqItemDTO } from "@shared/types";
import { copyRowsToExcel } from "./clipboard";

/** 清单行右键菜单：复制到 Excel / 向下复制一行 / 批量调价 / 删除 */
export function RowContextMenu({ ctxMenu, items, selIds, onClose, onDuplicate, onBatchAdjust, onDelete }: {
  ctxMenu: { x: number; y: number; id: string };
  items: BoqItemDTO[];
  selIds: ReadonlySet<string>;
  onClose: () => void;
  onDuplicate: (it: BoqItemDTO) => Promise<void>;
  onBatchAdjust: (targets: BoqItemDTO[]) => void;
  onDelete: (targets: BoqItemDTO[]) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40"
      onClick={() => onClose()}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
    >
      <div
        className="menu-in absolute min-w-36 rounded-[12px] border border-border bg-[var(--card)] p-1 shadow-[var(--shadow-md)]"
        style={{ left: Math.min(ctxMenu.x, globalThis.innerWidth - 180), top: Math.min(ctxMenu.y, globalThis.innerHeight - 180) }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-2.5 py-1 text-[10.5px] text-muted-foreground">清单行</div>
        {(() => {
          const it = items.find((i) => i.id === ctxMenu.id);
          if (!it || it.isHeader) return <div className="px-2.5 py-1.5 text-[12px] text-muted-foreground">分部标题不可删除</div>;
          const targets = selIds.size > 1 && selIds.has(ctxMenu.id)
            ? items.filter((i) => selIds.has(i.id) && !i.isHeader)
            : [it];
          return (
            <>
              <button
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-foreground hover:bg-[var(--accent)]"
                onClick={() => { onClose(); void copyRowsToExcel(targets); }}
              >
                {targets.length > 1 ? `复制 ${targets.length} 行到 Excel` : "复制到 Excel"}
                <span className="ml-1.5 text-[10.5px] text-muted-foreground">Ctrl+C</span>
              </button>
              {targets.length === 1 && (
                <button
                  className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-foreground hover:bg-[var(--accent)]"
                  onClick={() => { onClose(); void onDuplicate(it); }}
                >
                  向下复制一行
                </button>
              )}
              {targets.length > 1 && (
                <button
                  className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-foreground hover:bg-[var(--accent)]"
                  onClick={() => { onClose(); onBatchAdjust(targets); }}
                >
                  批量调价…
                </button>
              )}
              <button
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--accent)]"
                style={{ color: "var(--destructive)" }}
                onClick={() => { onClose(); onDelete(targets); }}
              >
                {targets.length > 1 ? `删除所选 ${targets.length} 行` : "删除此行"}
              </button>
            </>
          );
        })()}
      </div>
    </div>
  );
}
