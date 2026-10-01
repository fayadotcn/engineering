"use client";
import { useState } from "react";
import { ArrowUpRight, FolderOpen, Search } from "lucide-react";

export function ProjectDirectory({ projects }: { projects: { id: string; name: string; rows: number; files: number; updatedAt: string }[] }) {
  const [query, setQuery] = useState("");
  const filtered = projects.filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="cost-directory"><div className="section-heading"><h2>我的工程 <small>{projects.length}</small></h2>{(projects.length > 6 || query) && <label className="cost-search"><Search size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索工程名称" aria-label="搜索工程项目" /></label>}</div><div className="cost-directory-table"><div className="cost-directory-head"><span>工程名称</span><span>最近更新</span><span /></div>{filtered.map(p => <a key={p.id} href={`/p/${p.id}`} className="cost-directory-row"><span className="cost-directory-name"><i><FolderOpen size={19} /></i><span><strong>{p.name}</strong><small>{p.rows ? `${p.rows} 行清单 · ${p.files} 份资料` : "待导入清单"}</small></span></span><span>{new Date(p.updatedAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}</span><ArrowUpRight size={16} /></a>)}{!filtered.length && <div className="cost-section-empty"><FolderOpen size={28} /><p>{projects.length ? "没有匹配的工程项目" : "新建工程，再上传清单开始工作"}</p></div>}</div></section>;
}
