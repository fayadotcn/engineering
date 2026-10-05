"use client";
import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { resolvedTheme, setThemeChoice, themeChoice, type ThemeChoice } from "./theme";
import { Button } from "@/components/ui/button";

const NEXT: Record<ThemeChoice, ThemeChoice> = { auto: "light", light: "dark", dark: "auto" };
const MODE_LABEL: Record<ThemeChoice, string> = { auto: "跟随系统", light: "浅色", dark: "深色" };
const ICON: Record<"light" | "dark" | "auto", typeof Sun> = { light: Sun, dark: Moon, auto: Monitor };

/**
 * 三态主题切换：跟随系统 → 浅色 → 深色。
 * 图标显示当前模式；生效中的明暗同时反映在 pressed 态与 tooltip 里。
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>("auto");
  const [resolved, setResolved] = useState<"light" | "dark">("light");

  useEffect(() => {
    setChoice(themeChoice());
    setResolved(resolvedTheme());
    // data-theme 也会被内联脚本/其他实例改动（如系统偏好在 auto 下翻转），跟随真实生效值
    const ob = new MutationObserver(() => setResolved(resolvedTheme()));
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const onStorage = (e: StorageEvent) => { if (e.key === "cost-theme") setChoice(themeChoice()); };
    window.addEventListener("storage", onStorage);
    return () => { ob.disconnect(); window.removeEventListener("storage", onStorage); };
  }, []);

  const toggle = () => {
    const next = NEXT[themeChoice()];
    setChoice(next);
    setResolved(setThemeChoice(next));
  };

  const Icon = ICON[choice];
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      type="button"
      onClick={toggle}
      aria-label={`主题：${MODE_LABEL[choice]}（当前${resolved === "dark" ? "深色" : "浅色"}），点击切换`}
      title={`主题：${MODE_LABEL[choice]}${choice === "auto" ? `（${resolved === "dark" ? "深色" : "浅色"}）` : ""}`}
      aria-pressed={resolved === "dark"}
      className={className}
    >
      <Icon size={15} />
    </Button>
  );
}
