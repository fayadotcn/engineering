"use client";

import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/ui/shell/SiteHeader";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return <><SiteHeader /><main className="cost-home"><div className="cost-empty" role="alert"><h1>页面暂时无法加载</h1><p>请重试。已保存的工程资料和数据仍保留在项目中。</p><div className="cost-actions"><Button onClick={reset}>重新加载</Button><Button variant="outline" asChild><a href="/">返回工程项目</a></Button></div></div></main></>;
}
