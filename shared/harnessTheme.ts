/** 专业页面直接使用主工作台的实际主题值，避免两套配色。 */
export const HARNESS_THEME = {
  "--bg": "--dsw-alias-bg-base",
  "--surface": "--dsw-alias-bg-base",
  "--sidebar": "--dsw-specific-sidebar-fill",
  "--hover": "--dsw-alias-interactive-bg-hover",
  "--ink-1": "--dsw-alias-label-primary",
  "--ink-2": "--dsw-alias-label-secondary",
  "--ink-3": "--dsw-alias-label-tertiary",
  "--ink-4": "--dsw-alias-label-tertiary",
  "--hairline": "--dsw-alias-border-l2",
  "--hairline-strong": "--dsw-alias-border-l1",
  "--brand-accent": "--dsw-alias-button-info-fill",
  "--font-sans": "--dsw-font-family",
} as const;
