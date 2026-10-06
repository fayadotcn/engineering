"use client";
import { usePathname } from "next/navigation";
import { Database, FolderKanban, Layers3 } from "lucide-react";
import { ThemeToggle } from "../ThemeToggle";

const LINKS = [
  { href: "/", label: "工程项目", Icon: FolderKanban, match: (p: string) => p === "/" || p.startsWith("/p/") },
  { href: "/admin", label: "材料与定额库", Icon: Database, match: (p: string) => p.startsWith("/admin") },
];

/** 全局顶栏：官方条 + 品牌回首页 + 站点菜单 + 新建工程 + 主题。非工作台页面共用。 */
export function SiteHeader() {
  const pathname = usePathname() ?? "/";
  return (
    <>
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <div className="gov-strip">安装造价工作台 · <b>对话即造价</b></div>
    <header className="site-nav">
      <a href="/" className="site-nav-brand" aria-label="安装造价 · 返回首页">
        <span className="brand-tile"><Layers3 size={15} /></span>
        <span className="site-nav-brand-name">安装造价</span>
      </a>
      <nav className="site-nav-links" aria-label="站点导航">
        {LINKS.map(({ href, label, Icon, match }) => (
          <a key={href} href={href} aria-current={match(pathname) ? "page" : undefined}>
            <Icon size={13} />{label}
          </a>
        ))}
      </nav>
      <div className="site-nav-actions">
        <ThemeToggle />
      </div>
    </header>
    </>
  );
}
