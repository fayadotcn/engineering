import { Loader2 } from "lucide-react";
import { LoadRetry } from "@/ui/LoadRetry";

export default function Loading() {
  return <main id="main-content" className="cost-home"><div className="cost-empty" role="status" aria-live="polite"><Loader2 size={22} className="spin" /><h2 className="text-base font-medium">正在打开工作空间</h2><p>正在读取工程资料，请稍候</p><LoadRetry /></div></main>;
}
