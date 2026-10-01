"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return <main className="cost-home"><div className="cost-empty" role="alert"><h1>页面暂时无法加载</h1><p>请重试。已保存的工程资料和数据仍保留在项目中。</p><div className="cost-actions"><button className="cost-btn primary" onClick={reset}>重新加载</button><a className="cost-btn" href="/">返回工程项目</a></div></div></main>;
}
