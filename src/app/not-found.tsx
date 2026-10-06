import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/ui/shell/SiteHeader";

export default function NotFound() {
  return <><SiteHeader /><main id="main-content" className="cost-home"><div className="cost-empty"><span className="page-eyebrow">404 · 页面不存在</span><h1 className="text-xl font-semibold">没有找到这个页面</h1><p>工程或资料可能已删除，请回到项目列表继续。</p><Button asChild><a href="/">返回工程项目</a></Button></div></main></>;
}
