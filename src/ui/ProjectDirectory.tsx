"use client";
import { EmptyState } from "@/components/ui/empty-state";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, FolderOpen, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";


export function ProjectDirectory({ projects }: { projects: { id: string; name: string; rows: number; files: number; updatedAt: string }[] }) {
  const [query, setQuery] = useState("");
  const filtered = projects.filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="cost-directory" aria-label="我的工程">
    <div className="directory-toolbar">
      <h2>我的工程 <span>{projects.length}</span></h2>
      <div className="directory-search">
        <Search size={15} aria-hidden="true" />
        <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索工程名称" aria-label="搜索工程项目" className="pl-9 pr-9" />
        {query && <Button variant="ghost" size="icon-xs" onClick={() => setQuery("")} aria-label="清除工程搜索"><X size={13} /></Button>}
      </div>
    </div>
    <div className="cost-directory-table">
      <div className="cost-directory-head"><span>工程名称</span><span>工作进度</span><span>最近更新</span><span /></div>
      {filtered.map(p => <Link key={p.id} href={`/p/${p.id}`} className="cost-directory-row">
        <span className="cost-directory-name"><i aria-hidden="true"><FolderOpen size={20} /></i><span><strong>{p.name}</strong><small>{p.rows.toLocaleString("zh-CN")} 项清单 · {p.files} 份资料</small></span></span>
        <span className="directory-state"><Badge variant={p.rows ? "secondary" : "outline"}>{p.rows ? "继续工作" : "待上传清单"}</Badge></span>
        <time dateTime={p.updatedAt}>{new Date(p.updatedAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "short", day: "numeric" })}</time>
        <ArrowRight size={16} aria-hidden="true" />
      </Link>)}
      {!filtered.length && <EmptyState icon={<FolderOpen size={22} />} title={projects.length ? "没有匹配的工程项目" : "从第一个工程开始"} hint={projects.length ? "换一个工程名称搜索，或清除搜索查看全部。" : "创建工程后，上传清单，助手会带你完成报价。"} action={projects.length ? <Button variant="outline" size="sm" onClick={() => setQuery("")}>清除搜索</Button> : undefined} />}
    </div>
    {query.trim() && <p className="directory-search-count" role="status">找到 {filtered.length} 个工程</p>}
  </section>;
}
