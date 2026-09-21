// 内置参考定额库 —— 结构对齐消耗量定额（人工/辅材/机械/主材耗量）。
// 数值为演示级参考值，来源标记 QUOTA_BUILTIN；接入正式定额库（如四川2020）
// 时只需替换本表，匹配与组价逻辑不变。

export interface QuotaEntry {
  code: string; // 定额编号
  name: string; // 子目名称
  unit: string; // 定额单位
  unitScale: number; // 定额单位倍数（10m → 10）
  labor: number; // 人工费 元/定额单位
  material: number; // 辅材费
  machine: number; // 机械费
  mainQtyPerUnit: number; // 主材耗量 / 每清单单位（含损耗）
  match: {
    category?: string;
    material?: RegExp;
    diameter?: RegExp;
    spec?: RegExp;
    connection?: RegExp;
    system?: string;
    keywords?: RegExp;
    /** 关联的清单编码前9位（计价软件的清单↔定额映射，命中是强信号） */
    codes?: Set<string>;
  };
}

export const QUOTA_LIBRARY: QuotaEntry[] = [
  // 消防管道 — 沟槽连接
  { code: "XA-9-21", name: "镀锌钢管(沟槽连接) DN100", unit: "10m", unitScale: 10, labor: 156.2, material: 42.8, machine: 18.6, mainQtyPerUnit: 1.02, match: { category: "管道", material: /镀锌/, diameter: /DN100/, connection: /沟槽/ } },
  { code: "XA-9-22", name: "镀锌钢管(沟槽连接) DN150", unit: "10m", unitScale: 10, labor: 198.4, material: 56.3, machine: 24.1, mainQtyPerUnit: 1.02, match: { category: "管道", material: /镀锌/, diameter: /DN150/, connection: /沟槽/ } },
  { code: "XA-9-18", name: "镀锌钢管(沟槽连接) DN65", unit: "10m", unitScale: 10, labor: 118.7, material: 33.5, machine: 12.4, mainQtyPerUnit: 1.02, match: { category: "管道", material: /镀锌/, diameter: /DN65/, connection: /沟槽/ } },
  // 给水 PPR 热熔
  { code: "JB-8-45", name: "PPR给水管(热熔) DN50", unit: "10m", unitScale: 10, labor: 68.9, material: 12.6, machine: 2.1, mainQtyPerUnit: 1.016, match: { category: "管道", material: /PPR/, diameter: /DN50/, connection: /热熔/ } },
  { code: "JB-8-44", name: "PPR给水管(热熔) DN25", unit: "10m", unitScale: 10, labor: 45.2, material: 8.4, machine: 1.6, mainQtyPerUnit: 1.016, match: { category: "管道", material: /PPR/, diameter: /DN25/, connection: /热熔/ } },
  // 排水 UPVC 粘接
  { code: "JB-9-78", name: "UPVC排水管(粘接) DN110", unit: "10m", unitScale: 10, labor: 52.4, material: 15.8, machine: 0.8, mainQtyPerUnit: 1.05, match: { category: "管道", material: /PVC/, diameter: /DN110/ } },
  // 电缆敷设（每100m）
  { code: "DB-4-112", name: "铜芯电力电缆敷设 截面≤35mm²", unit: "100m", unitScale: 100, labor: 486.5, material: 92.4, machine: 45.8, mainQtyPerUnit: 1.01, match: { category: "电缆", spec: /[x×*](\d+(\.\d+)?)(\+|$)/, keywords: /电力电缆|电缆敷设/ } },
  { code: "DB-4-115", name: "铜芯电力电缆敷设 截面≤120mm²", unit: "100m", unitScale: 100, labor: 728.3, material: 118.6, machine: 68.2, mainQtyPerUnit: 1.01, match: { category: "电缆", spec: /150|120|95|70/, keywords: /电力电缆|电缆敷设/ } },
  // 桥架（每10m）
  { code: "DB-4-201", name: "槽式桥架安装 宽+高≤400", unit: "10m", unitScale: 10, labor: 124.8, material: 38.2, machine: 12.6, mainQtyPerUnit: 1.005, match: { category: "桥架", spec: /(\d{2,4})[x×*](\d{2,4})/, keywords: /桥架/ } },
  { code: "DB-4-202", name: "槽式桥架安装 宽+高≤1000", unit: "10m", unitScale: 10, labor: 168.4, material: 52.7, machine: 18.3, mainQtyPerUnit: 1.005, match: { category: "桥架", spec: /([4-9]\d{2}|\d{4})[x×*]/, keywords: /桥架/ } },
  // 阀门
  { code: "JA-7-55", name: "对夹蝶阀 DN100", unit: "个", unitScale: 1, labor: 38.6, material: 8.2, machine: 1.5, mainQtyPerUnit: 1, match: { category: "阀门", diameter: /DN100/, keywords: /蝶阀/ } },
  { code: "JA-7-56", name: "对夹蝶阀 DN150", unit: "个", unitScale: 1, labor: 52.4, material: 11.8, machine: 2.2, mainQtyPerUnit: 1, match: { category: "阀门", diameter: /DN150/, keywords: /蝶阀/ } },
  // 消防
  { code: "XA-10-8", name: "洒水喷头安装 DN15", unit: "个", unitScale: 1, labor: 8.6, material: 2.4, machine: 0, mainQtyPerUnit: 1.01, match: { category: "喷淋设备", keywords: /喷头|喷淋头/ } },
  // 电气
  { code: "DB-2-88", name: "成套配电箱安装 落地式", unit: "台", unitScale: 1, labor: 186.4, material: 45.2, machine: 12.8, mainQtyPerUnit: 1, match: { category: "配电箱柜", keywords: /配电箱|配电柜|落地/ } },
  { code: "DB-13-35", name: "双管荧光灯 吸顶安装", unit: "套", unitScale: 1, labor: 16.8, material: 3.6, machine: 0, mainQtyPerUnit: 1.01, match: { category: "灯具", keywords: /荧光灯|双管|吸顶/ } },
  { code: "DB-13-92", name: "单相五孔插座 暗装", unit: "个", unitScale: 1, labor: 4.2, material: 1.1, machine: 0, mainQtyPerUnit: 1.02, match: { category: "开关插座", keywords: /插座|五孔/ } },
];
