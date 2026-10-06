import { NewProject } from "@/ui/NewProject";
import { SiteHeader } from "@/ui/shell/SiteHeader";
import { ArrowLeft } from "lucide-react";

export default function NewEngineeringPage() {
  return <><SiteHeader /><main id="main-content" className="cost-new-engineering"><a href="/" className="page-back"><ArrowLeft size={14} />工程项目</a><section className="new-project-main"><h1>新建工程</h1><p>一个名称就可以开始。资料、计价条件和每次修改都会保存在这个工程里。</p><NewProject /><ul className="new-project-guide" aria-label="创建后的操作">{["上传工程资料", "核对计价条件", "完成报价导出"].map((t, i) => <li key={t}><span className="guide-index">{i + 1}</span>{t}</li>)}</ul></section></main></>;
}
