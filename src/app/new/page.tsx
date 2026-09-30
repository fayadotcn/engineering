import { NewProject } from "@/ui/NewProject";

export default function NewEngineeringPage() {
  return <main className="cost-new-engineering"><h1>新建工程</h1><p>填写工程名称，创建后直接进入专属 Agent 对话。</p><NewProject /><small>资料、清单、计价条件与操作记录都会归在这个工程内。</small></main>;
}
