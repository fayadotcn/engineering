"use client";
import { useStore } from "../store";
import { EmptyState } from "../primitives";
import { cn, SOURCE_LABEL } from "./shared";

/* ---------------- 事实台账 ---------------- */

export function FactList() {
  const { facts } = useStore();
  return (
    <div className="h-full overflow-auto p-4">
      <div className="xl-sheet overflow-auto rounded-lg">
      <table className="xl-table">
        <thead>
          <tr>
            <th className="xl-rn"></th>
            <th className="w-32">类型</th>
            <th>键</th>
            <th>值</th>
            <th className="w-24">来源</th>
          </tr>
        </thead>
        <tbody>
          {facts.map((f, fi) => (
            <tr key={f.id}>
              <td className="xl-rn">{fi + 1}</td>
              <td className="text-neutral-500">{f.factType}</td>
              <td>{f.key}</td>
              <td className="max-w-80 truncate" title={f.value}>{f.value}</td>
              <td>
                <span className={cn("chip", f.source === "INFERRED" && "warn")}>
                  {SOURCE_LABEL[f.source] ?? f.source}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {!facts.length && <EmptyState title="暂无项目事实" hint="计价条件、品牌与价格口径会随工作过程沉淀在这里。" />}
    </div>
  );
}
