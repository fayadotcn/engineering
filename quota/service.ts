import { QUOTA_LIBRARY, type QuotaEntry } from "./library";
import { fromJson } from "@shared/json";
import { parseSemanticFeature } from "@cost-engine/semantic";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toRe = (v: unknown) =>
  typeof v === "string" && v ? new RegExp(escapeRe(v), "i") : undefined;
/** 直径/规格这类离散值要整词匹配：DN15 不应命中 DN150 */
const toExactRe = (v: unknown) =>
  typeof v === "string" && v ? new RegExp(`^${escapeRe(v)}$`, "i") : undefined;

// 定额分册码 → 所属系统词（用于跨册同名子目的 tiebreak）
// SC21=川2020清单定额（CA机械设备…CJ消防/CK给排水/CG通风/CM刷油绝热），5A–5K=川2000旧库
const BOOK_SYSTEM: Record<string, string> = {
  "CA": "机械设备", "CB": "热力|锅炉", "CC": "静置|金属结构|储罐|球罐",
  "CD": "电气|配电|照明|电缆|桥架|防雷", "CE": "建筑智能化|弱电|智能",
  "CF": "自动化|仪表|自控", "CG": "通风|空调|防排烟|风管",
  "CH": "工业管道|工艺管道", "CJ": "消防|喷淋|消火栓|火灾报警|气体灭火",
  "CK": "给水|排水|采暖|燃气|卫生器具", "CL": "通信|弱电|线路",
  "CM": "刷油|防腐|绝热|保温",
  "5A": "机械设备", "5B": "电气|配电|照明|电缆|桥架|防雷",
  "5C": "热力|锅炉", "5D": "炉窑|砌筑", "5E": "静置|金属结构|储罐|球罐",
  "5F": "工业管道|工艺管道", "5G": "消防|喷淋|消火栓|火灾报警|气体灭火",
  "5H": "给水|排水|采暖|燃气|卫生器具", "5I": "通风|空调|防排烟|风管",
  "5J": "自动化|仪表|自控", "5K": "刷油|防腐|绝热|保温",
};
/** 内置参考库 + 后台上传的定额数据集，合并成匹配库 */
export async function getQuotaLibrary(): Promise<QuotaEntry[]> {
    const { prisma } = await import("@database/client");
    const rows = await prisma.quotaRow.findMany({
      where: { OR: [{ datasetId: null }, { dataset: { active: true } }] },
      // 同分定额按编号裁决——无固定序时 top2 结果不可复现
      orderBy: [{ code: "asc" }, { id: "asc" }],
    });
    const db: QuotaEntry[] = rows.map((r) => {
      // 脏 JSON 行不拖垮整库匹配——兜底为空对象，该行退化为低分候选
      const mk = fromJson<Record<string, string>>(r.matchKeys, {});
      const fresh = parseSemanticFeature(r.name, "");
      const raw = fromJson<{ gcnr?: string; fb?: string; chapter?: string; jj?: number; mainMaterial?: string; qtsm?: string; jsgz?: string; mlsm?: string; glf?: number; lr?: number }>(r.raw, {});
      const mats = fromJson<{ name?: string; unit?: string; qtyPerUnit?: number }[]>(r.materials, [])
        .filter((m) => m.name && Number(m.qtyPerUnit) > 0)
        .map((m) => ({ name: String(m.name), unit: String(m.unit ?? ""), qtyPerUnit: Number(m.qtyPerUnit) }));
      // 脏数字行兜底为 0——NaN 会沿测算公式传播成 "NaN" 字符串单价；
      // 负数人材机在定额里无意义；unitScale 必须为正（否则折算翻号）
      const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
      const pos = (v: unknown, fb: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fb; };
      return {
        code: r.code,
        name: r.name,
        unit: r.unit,
        unitScale: pos(r.unitScale, 1),
        labor: num(r.labor),
        material: num(r.material),
        machine: num(r.machine),
        mainQtyPerUnit: pos(r.mainQtyPerUnit, 1),
        materials: mats,
        detail: { gcnr: raw.gcnr, fb: raw.fb, chapter: raw.chapter, jj: raw.jj, mainMaterial: raw.mainMaterial, qtsm: raw.qtsm, jsgz: raw.jsgz, mlsm: raw.mlsm },
        match: {
          // matchKeys 是导入时固化的旧规则产物——按当前语义规则重解析定额名，
          // 新类别（卫生器具/计量表/装饰类）立即可用，无需重导定额库
          category: fresh.category ?? mk.category,
          material: toRe(fresh.material ?? mk.material),
          materialLabel: fresh.material ?? mk.material,
          diameter: toExactRe(fresh.diameter ?? mk.diameter),
          spec: toExactRe(fresh.specification ?? mk.spec),
          // DB 特征值常带后缀（"沟槽连接" vs 清单特征 "沟槽"），剥掉使匹配方向一致
          connection: toRe((fresh.connectionMethod ?? mk.connection)?.replace(/(连接|方式|敷设|安装)$/, "")),
          connectionLabel: (fresh.connectionMethod ?? mk.connection)?.replace(/(连接|方式|敷设|安装)$/, ""),
          keywords: toRe(mk.keywords),
          // xmbh 是软件内部的「册章节树码」(03+册序+章+节)，不是 GB 清单编码，不能拿来比对 item.code。
          // 改用定额编号前缀推断所属系统，给跨册同名子目做系统词 tiebreak。
          system: mk.system ?? BOOK_SYSTEM[r.code.slice(0, 2)],
        },
      };
    });
    // 数据集在前：匹配同分时先迭代者胜出（top2Quota 严格 >），
    // 真实定额库应优先于内置演示参考值——内置库仅作无数据集时的兜底
    return [...db, ...QUOTA_LIBRARY];
}
