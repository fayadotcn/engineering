"use client";
import { useState } from "react";
import { Check, ChevronDown, Database, FolderKanban, Pencil, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useStore } from "../store";

export type ProjectEntry = { id: string; name: string };

const initialOf = (name: string) => (name || "造").trim()[0]?.toUpperCase();

/** 工程切换器：点头像/名称展开下拉——切换工程、回全部工程、新建工程、进定额库、重命名。 */
export function ProjectSwitch({ projects }: { projects: ProjectEntry[] }) {
  const s = useStore();
  const [editing, setEditing] = useState<string | null>(null);

  const commit = async () => {
    const name = editing?.trim();
    if (name && name !== s.projectName) await s.renameProject(name);
    setEditing(null);
  };

  if (editing !== null) {
    return (
      <span className="wb-switch">
        <span className="wb-avatar" aria-hidden="true">{initialOf(s.projectName)}</span>
        <input
          className="wb-name-input" autoFocus value={editing} maxLength={120} aria-label="工程名称"
          onChange={(e) => setEditing(e.target.value)} onBlur={() => void commit()}
          onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") setEditing(null); }}
        />
      </span>
    );
  }

  return (
    <span className="wb-switch">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="wb-switch-trigger"
            aria-haspopup="menu"
            title="切换工程 / 更多操作"
          >
            <span className="wb-avatar" aria-hidden="true">{initialOf(s.projectName)}</span>
            <span className="wb-switch-name">{s.projectName || "工程"}</span>
            <ChevronDown size={13} className="wb-switch-caret" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-54 max-w-[min(320px,calc(100vw-24px))] text-[12.5px]">
          <DropdownMenuItem onSelect={() => setEditing(s.projectName)}>
            <Pencil />重命名工程
          </DropdownMenuItem>
          {projects.length > 0 && <DropdownMenuSeparator />}
          {projects.length > 0 && <DropdownMenuLabel className="text-[10.5px] font-normal text-muted-foreground">切换工程</DropdownMenuLabel>}
          <div className="max-h-63 overflow-y-auto">
            {projects.map((p) => {
              const current = p.id === s.projectId;
              const name = current ? s.projectName || p.name : p.name;
              return (
                <DropdownMenuItem key={p.id} asChild>
                  <a href={`/p/${p.id}`} className={current ? "font-medium" : undefined}>
                    <span className="wb-switch-item-avatar" aria-hidden="true">{initialOf(name)}</span>
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{name}</span>
                    {current ? <Check className="text-foreground" aria-label="当前工程" /> : null}
                  </a>
                </DropdownMenuItem>
              );
            })}
            {projects.length === 1 && (
              <div className="px-2 pt-1 pb-2 text-[11.5px] text-muted-foreground">只有这一个工程</div>
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild><a href="/"><FolderKanban />全部工程</a></DropdownMenuItem>
          <DropdownMenuItem asChild><a href="/new"><Plus />新建工程</a></DropdownMenuItem>
          <DropdownMenuItem asChild><a href="/admin"><Database />材料与定额库</a></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
