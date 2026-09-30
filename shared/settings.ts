/** Visible project inputs; no assumed region, rate, or pricing period. */
export const PRICING_FIELDS = [
  { key: "地区", label: "项目地区", hint: "如：四川、海南", group: "价格依据" },
  { key: "价格期", label: "材料价格期", hint: "如：2026-09", group: "价格依据" },
  { key: "价格类型", label: "材料价格类型", hint: "信息价 / 市场价 / 供应价", group: "价格依据" },
  { key: "品牌", label: "材料品牌偏好", hint: "留空表示未指定品牌", group: "价格依据" },
  { key: "管理费率", label: "管理费率", hint: "如：5%", group: "组价与取费" },
  { key: "利润率", label: "利润率", hint: "如：3%", group: "组价与取费" },
  { key: "措施费率", label: "措施费估算率", hint: "已导入措施清单时采用清单金额", group: "组价与取费" },
  { key: "规费费率", label: "规费费率", hint: "按项目适用口径填写", group: "组价与取费" },
  { key: "暂列金额", label: "暂列金额（元）", hint: "支持 50000 或 5万", group: "组价与取费" },
  { key: "暂列金额率", label: "暂列金额估算率", hint: "固定暂列金额优先", group: "组价与取费" },
  { key: "税率", label: "适用税率", hint: "填写适用税率；0% 表示明确不计税", group: "组价与取费" },
  { key: "檐口高度", label: "檐口高度（m）", hint: "系数措施费的计取条件", group: "工程条件" },
  { key: "操作物高度", label: "操作物高度（m）", hint: "系数措施费的计取条件", group: "工程条件" },
] as const;
