"use client";
import { useEffect, useRef } from "react";
import type { BoqItemDTO } from "@shared/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { copyRowsToExcel } from "./clipboard";

/** 清单行右键菜单：复制到 Excel / 向下复制一行 / 批量调价 / 删除。
    Radix ContextMenu 承载：role=menu/menuitem、↑↓/Home/End/Enter、Esc、点外关闭与焦点回归都由它给。
    Radix 的锚点是「指针位置」（contextmenu 事件里的 clientX/clientY），而本菜单由 BoqTable 的
    ctxMenu 状态驱动、触发器是隐形的——所以挂载后补发一次 contextmenu，把锚点钉在真实点击坐标上，
    越界翻转/避让交给 popper（比原先手写 min(x, innerWidth-180) 更稳）。 */
export function RowContextMenu({ ctxMenu, items, selIds, onClose, onDuplicate, onBatchAdjust, onDelete }: {
  ctxMenu: { x: number; y: number; id: string };
  items: BoqItemDTO[];
  selIds: ReadonlySet<string>;
  onClose: () => void;
  onDuplicate: (it: BoqItemDTO) => Promise<void>;
  onBatchAdjust: (targets: BoqItemDTO[]) => void;
  onDelete: (targets: BoqItemDTO[]) => void;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const focusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const prev = document.activeElement;
    if (focusRef.current === null && prev instanceof HTMLElement && prev !== document.body) focusRef.current = prev;
    anchorRef.current?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: ctxMenu.x, clientY: ctxMenu.y,
    }));
  }, [ctxMenu.x, ctxMenu.y, ctxMenu.id]);

  const it = items.find((i) => i.id === ctxMenu.id);
  const targets: BoqItemDTO[] = !it || it.isHeader
    ? []
    : selIds.size > 1 && selIds.has(it.id)
      ? items.filter((i) => selIds.has(i.id) && !i.isHeader)
      : [it];

  return (
    <ContextMenu onOpenChange={(open) => { if (!open) onClose(); }}>
      <ContextMenuTrigger asChild>
        {/* 隐形触发器：只负责给出锚点，不参与布局，也不吃指针事件 */}
        <span ref={anchorRef} aria-hidden="true" className="pointer-events-none fixed top-0 left-0 size-0" />
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          // 菜单关掉后把焦点还给右键前的元素（键盘用户按 Esc 不该被扔回文档开头）
          event.preventDefault();
          const prev = focusRef.current;
          if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
        }}
      >
        <ContextMenuLabel className="px-2.5 text-xs font-normal text-muted-foreground">清单行</ContextMenuLabel>
        {!it || it.isHeader
          ? <ContextMenuLabel className="px-2.5 text-xs font-normal text-muted-foreground">分部标题不可删除</ContextMenuLabel>
          : <>
            <ContextMenuItem onSelect={() => { onClose(); void copyRowsToExcel(targets); }}>
              {targets.length > 1 ? `复制 ${targets.length} 行到 Excel` : "复制到 Excel"}
              <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
            </ContextMenuItem>
            {targets.length === 1 && (
              <ContextMenuItem onSelect={() => { onClose(); void onDuplicate(it); }}>
                向下复制一行
              </ContextMenuItem>
            )}
            {targets.length > 1 && (
              <ContextMenuItem onSelect={() => { onClose(); onBatchAdjust(targets); }}>
                批量调价…
              </ContextMenuItem>
            )}
            <ContextMenuItem variant="destructive" onSelect={() => { onClose(); onDelete(targets); }}>
              {targets.length > 1 ? `删除所选 ${targets.length} 行` : "删除此行"}
            </ContextMenuItem>
          </>}
      </ContextMenuContent>
    </ContextMenu>
  );
}
