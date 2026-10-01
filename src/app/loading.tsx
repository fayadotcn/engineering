import { Loader2 } from "lucide-react";

export default function Loading() {
  return <main className="cost-home"><div className="cost-empty" role="status" aria-live="polite"><Loader2 size={22} className="spin" /><p>正在读取工程资料，请稍候</p></div></main>;
}
