"use client";
import { useEffect, useState } from "react";

/** 当前生效的明暗主题（读 <html data-theme>，跟随系统/手动切换实时更新）。
 *  首帧值由 layout.tsx 内联脚本落定，这里只做 React 侧订阅。 */
export function useResolvedTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const read = () =>
      setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    read();
    const ob = new MutationObserver(read);
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => ob.disconnect();
  }, []);
  return theme;
}
