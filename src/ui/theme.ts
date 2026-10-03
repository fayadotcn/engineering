"use client";

/** 明暗主题：localStorage 存用户选择（auto=跟随系统），真实生效值写在 <html data-theme>。
 *  首帧应用由 layout.tsx 的内联脚本完成（先于绘制，避免闪白）；本模块给 React 侧用。 */

const KEY = "cost-theme";

export type ThemeChoice = "auto" | "light" | "dark";

export function themeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function resolvedTheme(): "light" | "dark" {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** 持久化选择并立即应用；返回实际生效的明暗（供调用方立刻刷新本地状态）。 */
export function setThemeChoice(choice: ThemeChoice): "light" | "dark" {
  try { localStorage.setItem(KEY, choice); } catch { /* 隐私模式等场景下容忍失败，仍当次生效 */ }
  const dark = choice === "dark" || (choice === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  return dark ? "dark" : "light";
}
