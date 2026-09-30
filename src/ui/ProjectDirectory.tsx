"use client";
import { useState } from "react";
import { ArrowUpRight, FolderOpen, Search } from "lucide-react";

export function ProjectDirectory({ projects }: { projects: { id: string; name: string; rows: number; files: number; updatedAt: string }[] }) {
  const [query, setQuery] = useState("");
  const filtered = projects.filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="cost-directory"><div className="section-heading"><h2>我的项目 <small>{projects.length}</small></h2><label className="cost-search"><Search size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索工程名称" aria-label="搜索工程项目" /></label></div><div className="cost-directory-table"><div className="cost-directory-head"><span>项目名称</span><span>项目资料</span><span>清单行数</span><span>最近更新</span><span /></div>{filtered.map(p => <a key={p.id} href={`/p/${p.id}`} className="cost-directory-row"><span className="cost-directory-name"><i><FolderOpen size={19} /></i><span><strong>{p.name}</strong><small>安装工程 · {p.rows ? "已有清单" : "待导入资料"}</small></span></span><span>{p.files} 份</span><span>{p.rows} 行</span><span>{new Date(p.updatedAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}</span><ArrowUpRight size={16} /></a>)}{!filtered.length && <div className="cost-section-empty"><FolderOpen size={28} /><p>{projects.length ? "没有匹配的工程项目" : "创建第一个项目，开始整理工程资料"}</p></div>}</div></section>;
}
