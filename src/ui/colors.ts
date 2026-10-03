/** 专业配色固定：电气=琥珀、水=蓝、消防=红、风=青、弱电=紫——总览、占比图、清单筛选各视图保持一致。
 *  走 CSS 变量，深色主题下由 globals.css 整体提亮。 */
export const DISCIPLINE_COLOR: Record<string, string> = {
  ELECTRICAL: "var(--disc-electrical)",
  PLUMBING: "var(--disc-plumbing)",
  FIRE: "var(--disc-fire)",
  HVAC: "var(--disc-hvac)",
  WEAK_CURRENT: "var(--disc-weak)",
  OTHER: "var(--disc-other)",
};
