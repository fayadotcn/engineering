import Decimal from "decimal.js";
import { D, round2 } from "@cost-engine/money";
import { QUOTA_LIBRARY, type QuotaEntry } from "@quota/library";
import { parseSemanticFeature } from "@cost-engine/semantic";
import type { BoqItemDTO, PricingPlanLine, PlanMaterial } from "@shared/types";

// 定额匹配 + 组价。全部确定性计算。
// 综合单价 = (人工费+辅材费+机械费)/定额倍数 + 主材价×耗量 + (人工+机械)/倍数×(管理费率+利润率)

const sysReCache = new Map<string, RegExp>();
function sysRe(s: string): RegExp {
  let r = sysReCache.get(s);
  if (!r) { r = new RegExp(s); sysReCache.set(s, r); }
  return r;
}

export interface QuotaMatch {
  item: BoqItemDTO;
  quota: QuotaEntry | null;
  score: number;
}

export interface QuotaScoreDetail {
  /** 总分（含 keywords/system 弱信号与名称命中加成） */
  score: number;
  /** 实质特征分：category+material+diameter+spec+connection（含同类冲突扣分，不含 keywords/system/名称） */
  substantive: number;
  /** 清单名与定额名存在共同汉字 bigram（名称语义证据） */
  nameHit: boolean;
  /** 共享名称 bigram 数（名称证据强度分级） */
  nameHits: number;
  /** 单位族不相容（个↔m³）——铁证错配信号 */
  unitMismatch: boolean;
  /** 同材料组内材质不同（YJV电缆 vs 铝芯电缆、镀锌钢管 vs PVC管）——错配铁证 */
  materialConflict?: boolean;
  /** 清单规格超出定额档位上限（DN100 清单撞 DN50 子目） */
  bandMiss?: boolean;
  /** 分册域惩罚被触发（电气项撞市政册子目） */
  domainPenalty?: boolean;
}

const CJK_RUN = /[一-龥]+/g;
/** 定额/清单名中的通用工序词：剥掉再取 bigram——「X安装」撞上「Y安装」不算名称证据 */
const NAME_STOP = /安装|敷设|制作|连接|工程|以内|室内|室外|明配|暗配|材料|规格/g;
/** 同义工法词归一：清单惯用词 → 定额用词。词形不同的同义工序不该漏配（举一反三层）。
 *  两侧同表归一，保证对称（清单「清扫口」与定额「地面扫除口」映射到同一词）。 */
const NAME_SYN: [RegExp, string][] = [
  [/配线|布线|放线/, "穿线"],
  [/水龙头|水嘴|感应龙头/, "龙头"],
  [/坐便器|蹲便器/, "大便器"],
  [/清扫口/, "扫除口"],           // 定额叫「地面扫除口」
  [/瓷片|内墙砖|釉面砖|墙砖/, "面砖"],     // 装饰册「面砖 内墙面」
  [/抛釉砖|玻化砖|抛光砖|防滑砖|地面砖|地砖/, "地面砖"], // 装饰册「粘结剂贴地面砖」
  [/石塑|塑扣|塑木|SPC|石晶/, "塑料"],     // 石塑/塑木地板 → 塑料地板子目
  [/批荡/, "抹灰"],               // 方言：批荡=抹灰
  [/新砌/, "砌筑"],
  [/翘板/, "扳式"],               // 翘板开关 = 扳式开关
  [/空开|断路器/, "空气开关"],     // 断路器 = 自动空气开关子目
  [/美缝剂|美缝|填缝剂|填缝/, "勾缝"],
  [/过门石/, "门槛石"],
  [/挡板/, "隔断"],               // 小便器挡板 = 隔断子目
  [/吸声/, "吸音"],               // 矿棉吸声板 = 矿棉吸音板
  [/拖布盆/, "拖布池"],
  [/潜水泵|潜污泵|排污泵/, "泵"],
  [/风口百叶|百叶风口/, "风口"],
  [/检修口/, "检查口"],
];
export function nameBigrams(s: string): Set<string> {
  let t = ((s.match(CJK_RUN) ?? []).join("")).replace(NAME_STOP, "");
  for (const [re, canon] of NAME_SYN) t = t.replace(re, canon);
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 名称证据分级：共享 bigram 数——「大便器」(1hit) 与「螺纹水表」(2hit) 证据强度不同 */
export function quotaNameHits(item: BoqItemDTO, q: QuotaEntry): number {
  // N10 定额名自带章节前缀（「配线、配管工程 电线管敷设」）——剥掉再比，
  // 否则清单「配线」被章名里的「配线」假命中，子目差异被抹平
  const qname = q.name.replace(/^[一-龥、]{2,}?工程\s*/, "");
  const qb = nameBigrams(qname);
  if (!qb.size) return 0;
  let hits = 0;
  for (const b of nameBigrams(item.name)) if (qb.has(b)) hits++;
  return hits;
}
export function quotaNameHit(item: BoqItemDTO, q: QuotaEntry): boolean {
  return quotaNameHits(item, q) > 0;
}

/** 对立变体词：清单与定额名各说其一即互斥（坐式↔蹲式、单联↔双联、明装↔暗装） */
const OPPOSITES: [RegExp, RegExp][] = [
  [/坐式/, /蹲式/], [/蹲式/, /坐式/],
  [/明装|明敷|明配/, /暗装|暗敷|暗配|埋地|直埋/], [/暗装|暗敷|暗配|埋地|直埋/, /明装|明敷|明配/],
  [/单联/, /双联|三联|四联|多位/], [/双联/, /单联|三联|四联|多位/], [/三联/, /单联|双联|四联|多位/], [/四联/, /单联|双联|三联/],
  [/单控/, /双控|多控/], [/双控/, /单控|多控/],
  [/立式/, /挂式|壁挂|卧式/], [/挂式|壁挂/, /立式/], [/卧式/, /立式/],
  [/台上/, /台下/], [/台下/, /台上/],
  [/挂墙/, /落地/], [/落地/, /挂墙/],
  [/单相/, /三相/], [/三相/, /单相/],
  [/圆形/, /矩形|方形/], [/矩形|方形/, /圆形/],
  [/单管/, /双管/], [/双管/, /单管/],
];
/** 特殊语境词：定额名限定使用场景（塔器配管/盘柜配线/歌舞厅灯具/防爆区钢管），
 *  清单没提该语境就不能默认套用——通用项硬套特种子目是错配重灾区 */
const CONTEXT_WORDS = /塔器|盘柜|防爆|矿井|井下|船用|歌舞厅|舞台|地道|涵洞|隧道|人防|医用|手术|桥面|桥梁|公路|路基|轨道|铁路|输变电|路灯|钢索|窑炉|炉体|船台|码头|管廊|地沟|涵管/;

/** 定额名限定词：出现在定额名、但清单未声明 → 该子目是特化型，默认套用即错配。
 *  iRe 是清单侧等价词族（同义算已声明），pen 为每词扣分。 */
const QUOTA_QUALIFIERS: { qRe: RegExp; iRe: RegExp; pen: number }[] = [
  { qRe: /柔性|刚性/, iRe: /柔性|刚性|防水/, pen: 10 },          // 柔性/刚性防水套管 vs 普通套管
  { qRe: /中压|高压/, iRe: /中压|高压/, pen: 10 },               // 工业管道册压力档
  { qRe: /耐酸|耐碱/, iRe: /耐酸|耐碱/, pen: 10 },
  { qRe: /钢结构支架|钢索/, iRe: /钢结构支架|钢索/, pen: 10 },   // 特种配管方式
  { qRe: /防爆|隔爆/, iRe: /防爆|隔爆/, pen: 10 },
  { qRe: /带旁通|旁通管/, iRe: /旁通/, pen: 6 },                 // 水表带旁通管及止回阀
  { qRe: /耐火|阻燃/, iRe: /耐火|阻燃|NH|ZR|WDZ/, pen: 8 },
  { qRe: /医用|洁净|手术/, iRe: /医用|洁净|手术/, pen: 8 },
  { qRe: /木结构|槽板/, iRe: /木结构|槽板/, pen: 8 },          // 槽板配线是明敷工艺，管内穿线清单不套
  { qRe: /五孔|二孔加三孔|三孔加二孔|多用/, iRe: /五孔|二孔加三孔|三孔加二孔|多用/, pen: 8 }, // 插座孔位变体互斥
  { qRe: /防水防尘|工厂罩灯|投光灯|泛光灯/, iRe: /防水|防尘|防潮|工厂|投光|泛光/, pen: 8 },
  { qRe: /浮球|蝶阀|球阀|减压阀|安全阀|排气阀|止回|截止|闸阀|旋塞|隔膜阀|柱塞|疏水/, iRe: /浮球|蝶阀|球阀|减压|安全阀|排气|止回|截止|闸阀|旋塞|隔膜|柱塞|疏水/, pen: 8 }, // 阀门亚型互斥：清单闸阀不套浮球阀子目
  { qRe: /预制|预拌/, iRe: /预制|预拌/, pen: 4 },
];

/** 材料分组：同组内「定额材≠清单材」=错配铁证（YJV电缆≠铝芯电缆、镀锌钢管≠PVC管）。
 *  跨组不判——材料标签覆盖面不全，跨组差异多半是同物异名而非真冲突。 */
const MAT_GROUP: Record<string, string> = {
  镀锌钢管: "管材", 焊接钢管: "管材", 无缝钢管: "管材", 不锈钢管: "管材", 合金钢管: "管材",
  铸铁管: "管材", 铝塑复合管: "管材", 钢塑复合管: "管材", PPR: "管材", PE: "管材",
  PVC: "管材", ABS: "管材", 玻璃钢: "管材", 塑料管: "管材", 钢管: "管材",
  YJV电缆: "线缆", 铝芯电缆: "线缆", 矿物绝缘电缆: "线缆", BV电线: "线缆", BVR电线: "线缆",
  RVV电线: "线缆", 铜: "线缆", 铝: "线缆",
  石材: "板材", 陶瓷砖: "板材", 木地板: "板材", 塑料地板: "板材", 石膏板: "板材",
  铝板: "板材", 矿棉板: "板材", 不锈钢: "板材", 玻璃: "板材", 镀锌钢板: "板材", 铝合金: "板材",
  橡塑: "保温", 岩棉: "保温", 玻璃棉: "保温", 聚氨酯: "保温", 硅酸铝: "保温",
};
/** 泛称标签：定额写「塑料管」是对全组开放的通用子目（定额说明：塑料管安装适用 UPVC/PPC/PPR/PE/PB）。
 *  注意「钢管」不算泛称——定额里钢管子目特指焊接钢管类，与塑料管/不锈钢管是真错配 */
const GENERIC_MATS = new Set(["塑料管"]);
/** 型号词/泛称 → 归一材：YJV电缆本质就是铜芯电缆（同材不冲突）；定额泛称「钢管」=焊接钢管 */
const MAT_SUB_EQUIV: Record<string, string> = {
  YJV电缆: "铜", BV电线: "铜", BVR电线: "铜", RVV电线: "铜", 铝芯电缆: "铝", 钢管: "焊接钢管",
};
/** 定额说明允许的借套对（软兼容）：镀锌钢管螺纹连接适用焊接钢管、沟槽连接适用焊接/无缝钢管 */
const MAT_SOFT = new Set(["焊接钢管~镀锌钢管", "焊接钢管~无缝钢管", "无缝钢管~镀锌钢管"]);

/** 材质冲突判定：同组、都具体、归一后仍不同 → 铁证错配 */
function materialConflictOf(itemMat: string, quotaMat: string): boolean {
  const g = MAT_GROUP[itemMat];
  if (!g || g !== MAT_GROUP[quotaMat]) return false;
  if (GENERIC_MATS.has(itemMat) || GENERIC_MATS.has(quotaMat)) return false;
  if ((MAT_SUB_EQUIV[itemMat] ?? itemMat) === (MAT_SUB_EQUIV[quotaMat] ?? quotaMat)) return false;
  if (MAT_SOFT.has([itemMat, quotaMat].sort().join("~"))) return false;
  return true;
}

/** 定额分册域：编号前缀 → 专业域。跨域套用是错配重灾区（电气配管撞市政册同名子目）。
 *  川标编码：SC21(2020清单定额) 安装=CA–CN、房建(含装饰)=A*、仿古=B*、市政=D*、园林=E*、
 *  构筑物=F*、轨道=G*、维修=H*、爆破=J*、管廊=K*、绿建=L*、装配式=M*、排水养护=N*、
 *  道路养护=P*、轨道维护=Q*、路灯=S*；SC20(2000定额) 安装=5A–5K、土建=1*、装饰=2*、市政=3*。 */
export type QuotaDomain = "INST" | "BUILD" | "DECOR" | "MUNI" | "OTHER";
export function bookDomain(code: string): QuotaDomain {
  if (/^5[A-Z]/.test(code)) return "INST";                 // 四川2000 安装 5A–5K（旧库）
  if (/^C[A-N]/.test(code)) return "INST";                 // 四川2020 安装 CA–CN
  if (/^[A-Z]{2}-\d/.test(code)) return "INST";            // 内置演示库（DB-/XA-/JB-/JA-）
  const p = code[0];
  if (p === "1" || /^[ABEFHLM]/.test(code)) return "BUILD"; // 房建/仿古/园林/构筑物/维修/绿建/装配式
  if (p === "2") return "DECOR";                           // 装饰（2000 旧库编码；2020 装饰并入房建 A）
  if (p === "3" || /^[DGKNPQS]/.test(code)) return "MUNI"; // 市政/轨道/管廊/排水养护/道路养护/路灯
  return "OTHER";
}

/** 安装类类别：discipline=OTHER 时也按类别给域偏好（卫生器具/阀门永远属安装册） */
const INST_CATS = new Set([
  "管道", "管件", "阀门", "电缆", "电气线路", "电线管", "电缆附件", "桥架", "母线", "线槽",
  "配电箱柜", "开关电器", "开关插座", "灯具", "接线盒", "卫生器具", "计量表", "喷淋设备",
  "消防设备", "设备", "支架", "套管", "保温", "防腐刷油", "调试试验", "风管", "风口",
  "风阀", "消声静压", "风机盘管", "防雷接地", "阻火圈", "弱电末端",
]);
const DECOR_CATS = new Set(["天棚", "隔墙", "楼地面", "墙柱面", "涂饰", "门窗", "抹灰", "勾缝"]);
const BUILD_CATS = new Set(["土方", "砌筑", "防水"]);

/** 清单项 → 分册域偏好（discipline 强信号 > 类别推断）。
 *  返回 域→加减分；空表 = 中性（不缺证据不干扰打分）。 */
function itemDomainAdj(item: BoqItemDTO): Partial<Record<QuotaDomain, number>> {
  const disc = item.discipline;
  const cat = item.features?.category;
  if (disc && disc !== "OTHER")
    return { INST: 8, BUILD: -15, DECOR: -15, MUNI: -25 };
  if (cat && INST_CATS.has(cat))
    return { INST: 8, MUNI: -25 };            // 类别推断的安装项只硬挡市政（土建/装饰偶有正当跨界，留给分数竞争）
  if (cat && DECOR_CATS.has(cat))
    return { DECOR: 8, BUILD: 4, INST: -15, MUNI: -20 };
  if (cat && BUILD_CATS.has(cat))
    return { BUILD: 6, DECOR: 2, INST: -15, MUNI: -15 };
  return {};
}

/** 单位族归一：定额「10m/100个」剥数字后与清单同族才可配——个对 m³ 是铁证错配 */
export function unitFamily(u: string): string {
  const s = u.trim().toLowerCase().replace(/^\d+(?:\.\d+)?/, "").replace(/\s/g, "");
  if (/^(m|米|km|公里|千米)$/.test(s)) return "L";
  if (/^(㎡|m2|m²|平方米|平米)$/.test(s)) return "A";
  if (/^(m3|m³|立方米|立米)$/.test(s)) return "V";
  if (/^(t|kg|吨|公斤|千克|g|克)$/.test(s)) return "W";
  if (/^(个|台|套|组|副|只|樘|扇|件|块|座|具|条|根|位|盏|处|点|眼|口|部|榀|面|张|把|户|端|头|台套|系统|回路)$/.test(s)) return "C";
  return s || "?";
}

/** 定额档位语义：定额名中的规格数就是覆盖边界——
 *  「以内/以下/≤/<」或裸值（地漏 公称直径50mm）=档顶（hi），「以上/≥/>」=档底（lo），
 *  「100-150mm以下」=区间。清单值落在区间内给贴档分，越界是错档（扣分，不只是不得分）。 */
interface Band { lo?: number; hi?: number }
function quotaDiaBand(name: string): Band | null {
  const m = name.match(
    /(?:DN|De|Φ|ϕ|φ|Ø|ø|∅|￠|公称直径|公称口径|公称外径|外径|内径|直径|口径|管外径|套管外径|公称通径)\s*([<≤>≥=])?\s*(\d+(?:\.\d+)?)\s*(?:[-~—～]\s*(\d+(?:\.\d+)?))?\s*(?:mm)?\s*(以内|以下|≤|<|以内者|及以下|以上|≥|>)?/i
  );
  if (!m) return null;
  const pre = m[1] ?? "", v = Number(m[2]), range2 = m[3] ? Number(m[3]) : undefined, post = m[4] ?? "";
  if (!(v > 0)) return null;
  if (pre === ">" || pre === "≥" || /以上|≥|>/.test(post)) return { lo: range2 ?? v, hi: range2 };
  if (range2 !== undefined) return { lo: v, hi: range2 }; // 区间：100-150mm以下 → [100,150]
  return { hi: v };
}

/** 贴档分：值落区间满分近档，越界返回 null（由调用方扣分）。 */
function bandCover(v: number, b: Band, full: number): number | null {
  if (b.lo !== undefined && v <= b.lo) return null;     // 低于档底
  if (b.hi !== undefined && v > b.hi) return null;      // 高于档顶——错档
  if (b.lo !== undefined) return Math.round(full * 0.9); // 纯底档（>1120）覆盖即可
  if (b.hi === undefined) return Math.round(full * 0.9);
  const span = b.hi - (b.lo ?? 0) || b.hi;
  const margin = b.hi - v;                              // 贴档越近分越高
  return Math.max(Math.round(full * 0.55), Math.round(full - (margin / Math.max(span, 1)) * (full * 0.45)));
}

/** 规格档提取（mm²/kW/kV/t/kg/L/芯…）：定额「截面35mm²以内」「6芯以下」「2kg以下」 */
interface SpecBand { lo?: number; hi?: number; unit: string }
const SPEC_UNIT_RE = "mm²|mm2|kW|KW|kw|kVA|kV|KV|kv|W|w|A|L|l|t|T|kg|KG|m³|m3|Pa|kPa|MPa|芯";
function quotaSpecBand(name: string): SpecBand | null {
  const m = name.match(
    new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:[-~—～]\\s*(\\d+(?:\\.\\d+)?))?\\s*(${SPEC_UNIT_RE})\\s*(以内|以下|≤|<|以内者|及以下|以上|≥|>)?`)
  );
  if (!m) return null;
  const v = Number(m[1]), range2 = m[2] ? Number(m[2]) : undefined, post = m[4] ?? "";
  const u = m[3].replace(/mm2/i, "mm²").replace(/m3/i, "m³").replace(/^kw$/i, "kW").replace(/^kv$/i, "kV").replace(/^t$/i, "t").replace(/^kg$/i, "kg").replace(/^l$/, "L");
  if (!(v > 0)) return null;
  if (/以上|≥|>/.test(post)) return { lo: v, unit: u };
  if (range2 !== undefined) return { lo: v, hi: range2, unit: u };
  return { hi: v, unit: u };
}

/** 清单规格值提取：电缆「4x35+1x16」→ 截面35mm²（主芯最大）+芯数5；裸「2.5mm²」「15kW」直读。 */
function itemMeasure(item: BoqItemDTO): { diaV?: number; specV?: number; specU?: string; cores?: number; powerV?: number; powerU?: string } {
  const f = item.features ?? {};
  const out: ReturnType<typeof itemMeasure> = {};
  const dia = f.diameter ?? (f.specification?.startsWith("DN") ? f.specification : undefined);
  if (dia) out.diaV = Number(dia.replace(/\D/g, ""));
  const spec = f.specification ?? "";
  const seg = spec.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/g);
  if (seg?.length) {
    let cores = 0, maxS = 0;
    for (const sgm of seg) {
      const mm = sgm.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/);
      if (!mm) continue;
      cores += Number(mm[1]); maxS = Math.max(maxS, Number(mm[2]));
    }
    out.cores = cores; out.specV = maxS; out.specU = "mm²";
  } else {
    const bm = spec.match(/(\d+(?:\.\d+)?)\s*(mm²|mm2|kW|kVA|kV|W|A|L|t|kg|m³|m3)/i);
    if (bm) { out.specV = Number(bm[1]); out.specU = bm[2].replace(/mm2/i, "mm²").replace(/m3/i, "m³").replace(/^kw$/i, "kW").replace(/^kv$/i, "kV").replace(/^t$/i, "t").replace(/^kg$/i, "kg").replace(/^l$/i, "L"); }
  }
  if (f.power) {
    const pm = f.power.match(/(\d+(?:\.\d+)?)\s*(kW|kVA)/i);
    if (pm) { out.powerV = Number(pm[1]); out.powerU = pm[2].replace(/^kw$/i, "kW"); }
  }
  return out;
}

export function scoreQuotaDetail(item: BoqItemDTO, q: QuotaEntry): QuotaScoreDetail {
  const f = item.features ?? {};
  const m = q.match;
  const text = `${item.name} ${item.rawFeature ?? ""}`;
  let s = 0;
  let materialConflict = false;
  let bandMiss = false;
  let domainPenalty = false;
  const unitMismatch = !!item.unit && !!q.unit && unitFamily(item.unit) !== unitFamily(q.unit);
  if (unitMismatch) s -= 30;

  // 分册域治理：错配重灾区（电气配管→市政册同名子目）。域加减在实质分之外，只做候选排序门。
  const domAdj = itemDomainAdj(item);
  const domDelta = domAdj[bookDomain(q.code)] ?? 0;
  s += domDelta;
  if (domDelta <= -15) domainPenalty = true;

  if (m.category) {
    if (f.category === m.category) s += 40;
    // 双方都定了类别却不同类：跨域错配铁证（涂饰项套阀门、隔墙套门窗扇）
    else if (f.category) s -= 20;
  }
  if (m.material) {
    if (m.material.test(f.material ?? text)) s += 25;
    else if (f.material && m.materialLabel && f.material !== m.materialLabel) {
      if (materialConflictOf(f.material, m.materialLabel)) { s -= 25; materialConflict = true; }
      else {
        const gI = MAT_GROUP[f.material], gQ = MAT_GROUP[m.materialLabel];
        if (gI && gI === gQ) {
          // 同组方向不对称：定额泛称（塑料管）对清单具体材开放 +12；
          // 清单泛称撞定额具体材只是弱证据 +4（清单没说清材质，子目可能不对口）
          s += GENERIC_MATS.has(m.materialLabel) ? 12 : GENERIC_MATS.has(f.material) ? 4 : 8;
        } else if (gI && gQ) s -= 15;                    // 跨组异材：弱冲突扣分
      }
    }
  }

  const meas = itemMeasure(item);
  const itemDia = f.diameter ?? f.specification ?? "";
  if (m.diameter) {
    if (m.diameter.test(itemDia)) s += 20;
    else if (meas.diaV) {
      const band = quotaDiaBand(q.name);
      if (band) {
        const cov = bandCover(meas.diaV, band, 20);
        if (cov === null) { s -= 12; bandMiss = true; }  // 错档：DN75清单撞DN50子目
        else s += cov;                                   // 档位制：DN32→40以内给贴档分
      }
    }
  }
  if (m.spec) {
    if (m.spec.test(f.specification ?? "")) s += 15;
    else {
      // 档位制规格泛化：定额「截面35mm²以内」「6芯以下」「功率15kW以下」——同单位覆盖得分、超档扣分
      const band = quotaSpecBand(q.name);
      const iv = band?.unit === "芯" ? meas.cores
        : band && band.unit === meas.specU ? meas.specV
        : band && band.unit === meas.powerU ? meas.powerV
        : undefined;
      if (band && iv !== undefined) {
        const cov = bandCover(iv, band, 15);
        if (cov === null) { s -= 10; bandMiss = true; }
        else s += cov;
      }
    }
  }
  if (m.connection) {
    if (m.connection.test(f.connectionMethod ?? "") || m.connection.test(f.installationMethod ?? "")) s += 10;
    else if (f.connectionMethod && m.connectionLabel && f.connectionMethod !== m.connectionLabel) s -= 10;
  }
  // 敷设方式：定额名自带明/暗配工艺限定（砖砼明配/暗配/埋地），与清单声明的 installMethod 比
  const qInst = /明配|明装|明敷/.test(q.name) ? "明" : /暗配|暗装|暗敷|埋地|直埋|钢模板|埋设/.test(q.name) ? "暗" : "";
  const iInst = f.installationMethod === "明装" ? "明" : f.installationMethod ? "暗" : "";
  if (qInst && iInst) s += qInst === iInst ? 6 : -10;
  // 实质特征分：category+material+dia+spec+connection+单位族冲突（不含域/keywords/system/名称弱信号）
  const substantive = Math.max(0, s - domDelta);
  if (m.keywords) s += m.keywords.test(text) ? 10 : 0;
  // 系统归属：清单项的分部路径/名称出现系统词时，所属分册一致的定额加分。
  // 解决「镀锌钢管DN100」在消防册(CJ)与给排水册(CK)同分的跨册歧义。
  if (m.system) {
    const scope = `${item.sectionPath ?? ""} ${text} ${f.system ?? ""}`;
    s += sysRe(m.system).test(scope) ? 12 : 0;
  }
  // 特殊语境惩罚：清单没说塔器/盘柜/歌舞厅，就不该套这些限定场景的子目
  if (CONTEXT_WORDS.test(q.name) && !CONTEXT_WORDS.test(text)) s -= 40;
  // 定额名限定词不对称：定额限定而清单未声明 → 特化子目，扣分防错套（柔性套管/中压/耐酸…）
  let qualPen = 0;
  for (const qual of QUOTA_QUALIFIERS) {
    if (qual.qRe.test(q.name) && !qual.iRe.test(text)) qualPen += qual.pen;
  }
  s -= Math.min(qualPen, 24);
  // 名称证据分级 + 对立变体互斥
  const nameHits = quotaNameHits(item, q);
  if (nameHits) s += Math.min(15 + (nameHits - 1) * 8, 40);
  for (const [a, b] of OPPOSITES) {
    if (a.test(item.name) && b.test(q.name)) { s -= 30; break; }
  }
  return { score: s, substantive, nameHit: nameHits > 0, nameHits, unitMismatch, materialConflict, bandMiss, domainPenalty };
}

export function scoreQuota(item: BoqItemDTO, q: QuotaEntry): number {
  return scoreQuotaDetail(item, q).score;
}

/** 实质特征下限：匹配至少要 category+material/直径/连接 两类证据，或名称命中兜底。
 *  单靠 category(40)+弱信号凑过 50 分的「塑木地板→手工除锈」式错配不能进组价。
 *  单位族不相容时单 bigram 命中也不够（「蹲式大便器水箱」对「屋顶水箱m³」）——要 ≥2 hit。 */
export const QUOTA_SUBSTANTIVE_MIN = 75;
export function hasMatchEvidence(
  d: Pick<QuotaScoreDetail, "substantive" | "nameHit" | "nameHits" | "unitMismatch" | "materialConflict" | "bandMiss"> | null | undefined
): boolean {
  if (!d) return false;
  if (d.materialConflict) return false;               // 同材料组异材：错配铁证（YJV电缆子目装不了铝芯电缆清单）
  if (d.unitMismatch && (d.nameHits ?? 0) < 2) return false;
  if (d.bandMiss && (d.nameHits ?? 0) < 2) return false; // 超档且名称不贴合：DN75清单不该套DN50子目
  return d.substantive >= QUOTA_SUBSTANTIVE_MIN || d.nameHit;
}

/** 清单特征入库时固化——匹配前按当前语义规则重解析（新类别即析即用）。
 *  全量替换而非合并：features 与 boq/mapRow.ts 入库口径同源（parseSemanticFeature(name, rawFeature)），
 *  旧解析残留字段（如旧版把「电线管 PVC20」判成 镀锌钢管）必须被清除而非保留 */
export function refreshItemFeatures(items: BoqItemDTO[]): BoqItemDTO[] {
  return items.map((item) => ({
    ...item,
    features: parseSemanticFeature(item.name, item.rawFeature ?? ""),
  }));
}

export function matchQuota(
  item: BoqItemDTO,
  threshold = 50,
  lib: QuotaEntry[] = QUOTA_LIBRARY
): QuotaMatch {
  const { best } = top2Quota(item, lib);
  if (best.s < threshold || !hasMatchEvidence(best.detail)) return { item, quota: null, score: best.s };
  return { item, quota: best.q, score: best.s };
}

/** top2 候选 + 存疑判定：分差≤10 且基价差>5% 且两候选都有实质证据才算「拿不准」
 *  （跨册同名同价不算歧义；第二名只是凑分的也不算——那不是真备选） */
export function top2Quota(item: BoqItemDTO, lib: QuotaEntry[]) {
  let best: { q: QuotaEntry | null; s: number; detail: QuotaScoreDetail | null } = { q: null, s: 0, detail: null };
  let alt: { q: QuotaEntry | null; s: number; detail: QuotaScoreDetail | null } = { q: null, s: 0, detail: null };
  for (const q of lib) {
    const d = scoreQuotaDetail(item, q);
    if (d.score > best.s) { alt = { q: best.q, s: best.s, detail: best.detail }; best = { q, s: d.score, detail: d }; }
    else if (d.score > alt.s) alt = { q, s: d.score, detail: d };
  }
  const price = (q: QuotaEntry) => D(q.labor).add(q.material).add(q.machine);
  const ambiguous = !!(best.q && alt.q && hasMatchEvidence(best.detail) && hasMatchEvidence(alt.detail) && best.s - alt.s <= 10 &&
    price(best.q).minus(price(alt.q)).abs().div(Decimal.max(1, price(best.q))).gt(0.05));
  return { best, alt, ambiguous };
}

export interface QuotaCalcRow {
  itemId: string;
  code: string;
  name: string;
  quantity: string;
  listPrice: string; // 清单现有单价
  quotaCode: string | null;
  quotaName: string | null;
  labor: string | null;
  materialAux: string | null;
  machine: string | null;
  mainMaterial: string | null; // 主材费 = 主材价 × 耗量
  fee: string | null; // 管理费+利润
  calcPrice: string | null; // 测算综合单价
  deviation: string | null; // vs 清单单价 %
  needsMainPrice: boolean;
  /** 缺价材料名清单（管件/法兰/配件等）——缺价即不完整测算 */
  missingMaterials?: string[];
  /** 未匹配原因（quotaCode 为 null 时）：供审查判定属于错档/材质不合/证据不足 */
  unmatchedReason?: string;
  /** 定额解释详情：工程内容/分册/章节路径/基价/主材名 */
  quotaGcnr?: string | null;
  quotaFb?: string | null;
  quotaChapter?: string | null;
  quotaBase?: string | null;
  quotaMainName?: string | null;
  /** 存在得分相近且基价不同的备选子目 */
  ambiguous?: boolean;
  altQuota?: string | null; // 备选子目 "code name"
  /** 组价方案：第 1 行是主项定额（计入测算价），suggested 行是工作内容缺口的建议增列 */
  plan?: PricingPlanLine[];
}

/** 定额人工费：规费总基数及各分册措施费基数，均按工程量计算。 */
export function quotaLaborTotals(rows: QuotaCalcRow[]) {
  let total = D(0);
  const books: Record<string, Decimal> = {};
  for (const row of rows.filter(r => r.quotaCode)) {
    const amount = D(row.labor ?? 0).mul(D(row.quantity));
    // 册码取编号前缀：SC21 安装 CA–CN/房建 A* 等两位字母；SC20 旧库 5A–5K
    const book = row.quotaCode!.match(/^([5C][A-Z]|[A-Z]{2})/)?.[1] ?? "通用";
    total = total.plus(amount);
    books[book] = (books[book] ?? D(0)).plus(amount);
  }
  return { total: total.toFixed(2), byBook: Object.fromEntries(Object.entries(books).map(([book, amount]) => [book, amount.toFixed(2)])) };
}

/** 定额未计价材料清单：materials[] 优先（az_yl 全量导入），
 *  缺省回退单一主材（内置库/旧数据：detail.mainMaterial + mainQtyPerUnit）。 */
export function quotaMaterials(q: QuotaEntry): { name: string; unit: string; qtyPerUnit: number }[] {
  if (q.materials?.length) return q.materials;
  if (q.detail === undefined || q.detail.mainMaterial)
    return [{ name: q.detail?.mainMaterial ?? "主材", unit: "", qtyPerUnit: q.mainQtyPerUnit }];
  return [];
}

/** 主材标记：材料名与 detail.mainMaterial 对齐者为首主材（取价走清单暂估价通道） */
export function primaryMatIdx(q: QuotaEntry, mats: { name: string }[]): number {
  if (!mats.length) return -1;
  const pm = q.detail?.mainMaterial;
  const i = pm ? mats.findIndex((m) => m.name === pm || m.name.includes(pm) || pm.includes(m.name)) : -1;
  return i >= 0 ? i : 0;
}

/** 伪材料名：定额用料表里的汇总/摊销口径行（其他材料费/水/损耗…），
 *  不是可询价材料——计入缺价清单就是把「缺主材价」误报成普遍现象，
 *  取价查询这类名字也永远搜不到正经价格行。 */
export const PSEUDO_MAT = /^(?:其他?|其它)?材料费$|^水$|^电$|损耗|摊销|周转|^(?:其他|其它)费|合价|小计/;

/** 定额声明的首主材（取价搜索词）：跳过伪材料，泛名「主材」由调用方回退清单名 */
export function primaryMaterialOf(q: QuotaEntry): { name: string; unit: string } | null {
  const mats = quotaMaterials(q);
  const i = primaryMatIdx(q, mats);
  const m = i >= 0 ? mats[i] : null;
  if (!m || PSEUDO_MAT.test(m.name.trim())) return null;
  return { name: m.name.trim(), unit: m.unit };
}

/** 单条定额 → 组价方案行（每清单单位口径：定额单位倍数已折算）。
 *  多材料：materials[] 逐一按含量计价——首主材走 mainPrice（清单暂估价/匹配价），
 *  管件/法兰/配件等辅助材料走 matPrices[name]（缺价 price=null，不计入小计）。 */
export function lineFromQuota(
  item: BoqItemDTO,
  q: QuotaEntry,
  opts: {
    mgmtRate: Decimal.Value; profitRate: Decimal.Value;
    mainPrice?: number;
    /** 辅助未计价材料的单价表：材料名→单价（询价/材料库解析结果） */
    matPrices?: Record<string, number>;
    suggested?: boolean; manual?: boolean; scope?: string;
  }
): PricingPlanLine {
  const mgmt = D(opts.mgmtRate), profit = D(opts.profitRate);
  const perUnit = (v: number) => D(v).div(q.unitScale || 1);
  const labor = perUnit(q.labor);
  const aux = perUnit(q.material);
  const mach = perUnit(q.machine);
  const fee = labor.plus(mach).mul(mgmt.plus(profit));
  const mats = quotaMaterials(q);
  const pi = primaryMatIdx(q, mats);
  const planMats: PlanMaterial[] = mats.map((m, i) => {
    const price = i === pi ? opts.mainPrice : opts.matPrices?.[m.name];
    const amount = price === undefined || price === null ? null : D(price).mul(m.qtyPerUnit);
    return {
      name: m.name, unit: m.unit, qty: String(m.qtyPerUnit),
      price: price === undefined || price === null ? null : round2(D(price)).toString(),
      amount: amount === null ? null : round2(amount).toString(),
      primary: i === pi || undefined,
    };
  });
  const mainSum = planMats.reduce((a, m) => a.plus(m.amount ?? 0), D(0));
  const subtotal = labor.plus(aux).plus(mach).plus(fee).plus(mainSum);
  const primary = pi >= 0 ? mats[pi] : null;
  return {
    quotaCode: q.code,
    quotaName: q.name,
    labor: round2(labor).toString(),
    materialAux: round2(aux).toString(),
    machine: round2(mach).toString(),
    fee: round2(fee).toString(),
    mainMaterialName: q.detail?.mainMaterial ?? primary?.name ?? null,
    mainQty: primary ? String(primary.qtyPerUnit) : null,
    mainPrice: opts.mainPrice !== undefined && opts.mainPrice !== null ? round2(D(opts.mainPrice)).toString() : null,
    materials: planMats.length ? planMats : undefined,
    subtotal: round2(subtotal).toString(),
    suggested: opts.suggested || undefined,
    manual: opts.manual || undefined,
    scope: opts.scope ?? q.detail?.gcnr ?? undefined,
  };
}

/** 组价方案合计 → 每清单单位综合单价（只计已确认行，suggested 不计入） */
export function planPrice(plan: PricingPlanLine[]): Decimal {
  return plan.filter((l) => !l.suggested).reduce((a, l) => a.plus(D(l.subtotal)), D(0));
}

// 工作内容缺口分析：主定额 gcnr/定额说明没写到的工序 → 找配套子目建议增列。
// 这是真实组价：给水管道 = 管道安装 + 消毒冲洗 + 支吊架；沟槽/法兰连接的管件另计；
// 电缆敷设不含电缆头；刷漆/除锈/保温属 5K 册独立子目。
const SCOPE_NEEDS: {
  key: string; covered: RegExp; find: RegExp; reason: string;
  applies?: (item: BoqItemDTO, q?: QuotaEntry) => boolean;
  /** 允许跨册取子目的前缀（刷油/防腐/绝热在 C.M 册，保温在 C.M/房建册） */
  books?: RegExp;
  /** 找不到定额子目时的材料提示（仍出建议行，提醒该内容要另计） */
  materialNote?: string;
  /** 材料类缺口的已含判据：定额 materials[] 里有匹配未计价材料才算覆盖。
   *  gcnr 文字「上零件/管件安装」只说明安装工含了——材料按定额说明仍按设计/按实另计，
   *  借套子目（沟槽件清单套螺纹子目）尤其不能靠文字覆盖挡掉建议。 */
  matCovered?: RegExp;
}[] = [
  {
    key: "管道消毒冲洗", covered: /冲洗|消毒/, find: /消毒.*冲洗|冲洗.*消毒|管道消毒|管道冲洗/,
    reason: "主定额工作内容未含冲洗消毒，给水/消防管道规范要求另套",
    applies: (i) => /给水|饮用|消防|喷淋|消火栓|供水/.test(`${i.name}${i.rawFeature}`),
  },
  {
    key: "支吊架", covered: /支吊架|支架|吊架|托钩|管卡/, find: /支吊架|管道支架|支架制作.*安装/,
    reason: "主定额工作内容未含支吊架制作安装",
    applies: (i, q) => !/支架|吊架/.test(q?.name ?? ""), // 主项本身就是支架子目时不再建议支架
  },
  {
    key: "水压试验", covered: /水压|试压|压力试验|严密性|灌水|通球|吹扫|气密/, find: /水压试验|压力试验|管道试压|灌水试验|通球试验|管道吹扫/,
    reason: "主定额工作内容未含管道试验（水压/灌水/通球/吹扫）",
  },
  {
    // C.J.1：管道安装（沟槽连接）已包括直接卡箍件安装，其他沟槽管件另行执行相关项目；
    // 沟槽管件主材包括卡箍及密封圈以"套"计。借套螺纹子目时「上零件」绝不能当沟槽管件已含。
    key: "沟槽管件", covered: /沟槽.*管件|卡箍/, find: /沟槽.*管件|管件.*沟槽|卡箍/,
    reason: "沟槽连接的管件（弯头/三通/机械三通/卡箍）另行执行管件连接子目，主材按套另计",
    applies: (i) => /沟槽|卡箍/.test(`${i.name}${i.rawFeature}${i.features?.connectionMethod ?? ""}`),
    materialNote: "沟槽管件（含卡箍及密封圈）为未计价主材，按设计数量另计",
    matCovered: /沟槽|卡箍/,
  },
  {
    key: "管件", covered: /管件|零件|接头/, find: /管件.*连接|管件/,
    reason: "卡压/特殊连接的管件为独立主材，定额通常未含",
    applies: (i) => /卡压|卡套|环压/.test(i.features?.connectionMethod ?? ""),
    materialNote: "管件为未计价主材，按实另计",
    matCovered: /卡压|卡套|环压/,
  },
  {
    // C.J.1：钢管（法兰连接）定额中包括管件及法兰安装，但管件、法兰数量应按设计图纸用——
    // 安装工含了，法兰片/垫片/螺栓材料仍按设计数量另计，不能被「法兰连接」gcnr 挡掉。
    key: "法兰", covered: /法兰/, find: /法兰安装|法兰盘安装/,
    reason: "法兰连接件（法兰片/垫片/螺栓）为独立子目或主材",
    applies: (i) => /法兰/.test(`${i.features?.connectionMethod ?? ""}${i.name}`) &&
      !/法兰/.test(`${i.features?.category ?? ""}`) , // 法兰阀门类自身已是法兰项不单列
    materialNote: "法兰及紧固件为未计价主材，按设计数量另计",
    matCovered: /法兰|垫片|紧固件|螺栓/,
  },
  {
    key: "套管", covered: /套管/, find: /套管.*制作|套管.*安装|一般套管|刚性套管|柔性套管|塑料套管/,
    reason: "管道穿墙/楼板套管为独立子目",
    applies: (i) => /穿墙|穿楼板|过墙|套管/.test(`${i.name}${i.rawFeature}`),
  },
  {
    key: "除锈", covered: /除锈/, find: /除锈/,
    reason: "除锈为独立子目（C.M 刷油防腐蚀绝热册）",
    // 黑色金属管道（焊接/无缝/铸铁管）惯例要除锈刷漆，清单不写也要建议
    applies: (i) => /除锈/.test(`${i.name}${i.rawFeature}`) ||
      /^(钢管|焊接钢管|无缝钢管|铸铁管|钢管.*)$/.test(i.features?.material ?? "") ||
      /焊接钢管|无缝钢管|铸铁管/.test(`${i.name}${i.rawFeature}`),
    books: /^5[Kk]|^CM/,
  },
  {
    key: "刷油防腐", covered: /刷油|刷漆|防锈漆|调和漆|沥青漆|防腐漆|油漆|银粉|防腐/, find: /刷油|刷漆|防锈漆|调和漆|沥青漆|防腐漆|银粉/,
    reason: "刷漆/防腐涂装为独立子目（C.M 册），管道本体定额不含",
    applies: (i) => /刷漆|刷油|防锈|调和漆|沥青漆|防腐漆|油漆|银粉|防腐/.test(`${i.name}${i.rawFeature}`) ||
      /^(钢管|焊接钢管|无缝钢管|铸铁管)$/.test(i.features?.material ?? "") ||
      /焊接钢管|无缝钢管|铸铁管/.test(`${i.name}${i.rawFeature}`),
    books: /^5[Kk]|^1[Hh]|^CM|^A/,
  },
  {
    key: "保温绝热", covered: /保温|绝热|保冷|橡塑|岩棉|玻璃棉|聚氨酯|硅酸铝/, find: /绝热|保温|橡塑|岩棉|玻璃棉|聚氨酯|硅酸铝|保冷/,
    reason: "保温/绝热层为独立子目（C.M 册），管道本体定额不含",
    applies: (i) => /保温|绝热|保冷|橡塑|岩棉|玻璃棉|聚氨酯|硅酸铝/.test(`${i.name}${i.rawFeature}`),
    books: /^5[Kk]|^1[Hh]|^CM|^A/,
  },
  {
    key: "电缆头", covered: /电缆头|终端头|中间头/, find: /电缆头|电缆终端|电缆中间头/,
    reason: "电缆头制作安装为独立子目，敷设定额不含",
    applies: (i) => i.features?.category === "电缆",
    materialNote: "电缆头（终端/中间头）及附件为未计价主材",
  },
  {
    key: "水表前阀", covered: /阀门|截止阀|闸阀/, find: /阀门安装.*螺纹|螺纹阀|截止阀/,
    reason: "定额说明：水表安装不含表前阀门，阀门单独套用",
    applies: (i) => i.features?.category === "计量表" || /水表/.test(i.name),
  },
];

const i0 = (i: BoqItemDTO) => `${i.name} ${i.rawFeature}`;

/** 定额说明 sentence 级判定：条文里某工序是「已含」还是「不含/另计」。
 *  gcnr 是工作内容清单（出现即含）；spec 章节条文要句子级解析——「不包括/另行」句才算排除。 */
function specCovered(need: { covered: RegExp }, specText: string): "covered" | "excluded" | "unknown" {
  if (!specText) return "unknown";
  const sentences = specText.split(/[。；;\n]/).filter((s) => need.covered.test(s));
  let covered = false, excluded = false;
  for (const s of sentences) {
    if (/不包括|不含|未含|另行|另计|不得重复|重复计算|应按.*另|需单独/.test(s)) excluded = true;
    else if (/包括|已含|含/.test(s)) covered = true;
  }
  return excluded ? "excluded" : covered ? "covered" : "unknown";
}

function suggestSupplementary(
  item: BoqItemDTO,
  q: QuotaEntry,
  lib: QuotaEntry[],
  mgmt: Decimal.Value,
  profit: Decimal.Value,
  specText = ""
): PricingPlanLine[] {
  const it = i0(item);
  const cat = item.features?.category ?? "";
  const pipeish = cat === "管道" || /管|给水|排水|喷淋|消火栓|采暖|冷凝水|雨水|污水|风管/.test(it);
  const elecrish = cat === "电缆" || cat === "电气线路" || /电缆|电线/.test(it);
  const hvacish = cat === "风管" || cat === "风口" || cat === "风阀" || /风管|通风|空调/.test(it);
  // 任何一个 need 的 applies 命中才算适用——不再整类拒之门外（电缆头/除锈/保温不属管道类）
  const applicable = SCOPE_NEEDS.filter((n) => !n.applies || n.applies(item, q));
  if (!applicable.length && !pipeish && !elecrish && !hvacish) return [];
  const coveredText = `${q.name} ${q.detail?.gcnr ?? ""}`;   // gcnr 列出的工作即已含
  const bookPrefix = q.code.slice(0, 2); // 川标编号前两位=分册（CJ=消防/CK=给排水…）
  // 直径档归一化：DN100/公称直径100mm以内 → 数字 "100"，只在直径语境里匹配
  // （不能裸匹配数字——"混凝土基础400×400"不是 DN400）
  const diaNum = (item.features?.diameter ?? "").replace(/\D/g, "");
  const diaHit = (name: string) =>
    !!diaNum && new RegExp(`(直径|DN|Φ|ϕ|φ|Ø|ø|∅|￠|DE|de)\\s*${diaNum}(?![\\d])|${diaNum}\\s*mm`, "i").test(name);
  const out: PricingPlanLine[] = [];
  for (const need of SCOPE_NEEDS) {
    if (out.length >= 4) break;
    if (need.applies && !need.applies(item, q)) continue;
    // 非管道/暖通类清单只跑 applies 命中的 need（电缆头/除锈/保温自报家门）；
    // 管道、风管类清单跑全量 covered 判定的通用工序（冲洗/支架/试验）
    if (!need.applies && !pipeish && !hvacish) continue;
    const spec = specCovered(need, specText);
    // 材料类缺口（沟槽管件/卡压管件/法兰）：唯一可信「已含」证据是定额 materials[]
    // 里有对应未计价材料——gcnr/说明里的「含管件安装」管的是安装工不是材料钱，
    // 让这类条文覆盖掉建议就是把材料费漏掉（费用不够）。
    const matsHit = !!need.matCovered && quotaMaterials(q).some((mm) => need.matCovered!.test(mm.name));
    if (matsHit) continue;
    if (!need.materialNote && (need.covered.test(coveredText) || spec === "covered")) continue; // 主定额/说明已含该工序
    // 候选：同分册域内自由借套（安装册间支架/冲洗互通是常态），跨域只允许 need.books 指定册
    const qDom = bookDomain(q.code);
    const cands = lib
      .filter((c) => c.code !== q.code && need.find.test(c.name) &&
        (bookDomain(c.code) === qDom || (need.books?.test(c.code) ?? false) || bookDomain(c.code) === "OTHER"))
      .sort((a, b) => {
        const sa = (a.code.startsWith(bookPrefix) ? 2 : 0) + (need.books?.test(a.code) ? 1 : 0) + (diaHit(a.name) ? 3 : 0);
        const sb = (b.code.startsWith(bookPrefix) ? 2 : 0) + (need.books?.test(b.code) ? 1 : 0) + (diaHit(b.name) ? 3 : 0);
        return sb - sa;
      });
    const c = cands[0];
    if (!c) {
      // 库内无该工序子目但说明明确不含/材料性质独立 → 出材料提示行（建议不计价）
      if (spec === "excluded" || need.materialNote) {
        out.push({
          quotaCode: "", quotaName: `【材料另计】${need.key}`,
          labor: "0", materialAux: "0", machine: "0", fee: "0",
          mainMaterialName: null, mainQty: null, mainPrice: null,
          subtotal: "0", suggested: true, scope: need.materialNote ?? need.reason,
        });
      }
      continue;
    }
    // 有规格档的定额若明确不覆盖该项直径，跳过（避免推荐错档子目误导）
    if (diaNum && /直径\s*\d+/.test(c.name) && !diaHit(c.name)) continue;
    out.push(lineFromQuota(item, c, { mgmtRate: mgmt, profitRate: profit, suggested: true, scope: need.reason }));
  }
  return out;
}

export function calcQuota(
  items: BoqItemDTO[],
  opts: {
    mainPrices?: Record<string, number>; // category/material -> 主材单价
    /** 辅助未计价材料的单价表（管件/法兰/配件…）：材料名→单价 */
    matPrices?: Record<string, number>;
    /** 定额说明章节正文（"fb|chapter" 键→条文）：工作内容「已含/不含」判定输入 */
    specTexts?: Record<string, string>;
    /** 调用方预算好的 top2 结果（item.id→候选）：材料/说明预取与测算共用一遍打分 */
    matches?: Map<string, ReturnType<typeof top2Quota>>;
    mgmtRate?: number; // 未确认时按零测算
    profitRate?: number; // 未确认时按零测算
    threshold?: number;
    lib?: QuotaEntry[];
  } = {}
): QuotaCalcRow[] {
  const mgmt = D(opts.mgmtRate ?? 0);
  const profit = D(opts.profitRate ?? 0);
  const lib = opts.lib ?? QUOTA_LIBRARY;
  return items.map((item) => {
    const t = opts.matches?.get(item.id) ?? top2Quota(item, lib);
    const m: QuotaMatch =
      t.best.q && t.best.s >= (opts.threshold ?? 50) && hasMatchEvidence(t.best.detail)
        ? { item, quota: t.best.q, score: t.best.s }
        : { item, quota: null, score: t.best.s };
    const base: QuotaCalcRow = {
      itemId: item.id,
      code: item.code,
      name: item.name,
      quantity: item.quantity,
      listPrice: item.unitPrice,
      quotaCode: null, quotaName: null,
      labor: null, materialAux: null, machine: null,
      mainMaterial: null, fee: null, calcPrice: null,
      deviation: null, needsMainPrice: false,
    };
    if (!m.quota) {
      const d = t.best.detail;
      base.unmatchedReason = !t.best.q ? "库内无候选" :
        d?.materialConflict ? "候选材质不合" :
        d?.bandMiss ? "清单规格超定额档位" :
        d?.domainPenalty ? "仅错分册候选" :
        !hasMatchEvidence(d) ? "特征证据不足" :
        t.best.s < (opts.threshold ?? 50) ? "得分不足" : "未匹配";
      return base;
    }
    const q = m.quota;
    const perUnit = (v: number) => D(v).div(q.unitScale || 1);
    const labor = perUnit(q.labor);
    const aux = perUnit(q.material);
    const mach = perUnit(q.machine);
    const fee = labor.plus(mach).mul(mgmt.plus(profit));

    // 主材价优先级：清单项已确认的主材暂估价 > 询价/材料库匹配价。
    // 缺主材价时测算价不含主材费，是不完整单价——绝不能与清单综合单价比偏差。
    const ownMain = D(item.mainMaterialPrice ?? 0);
    const mainKey = `${f2m(item)}`;
    // 定额库的口径分两类：内置参考库（detail 空）综合单价都不含主材，命中即加；
    // SC2020 导入行（detail 有值）只有写明主材名的子目才另计主材——
    // 无主材的子目其材料费已在基价里，再加就是重复计
    const mats = quotaMaterials(q);
    const expectsMain = q.detail === undefined || mats.length > 0 || !!q.detail?.mainMaterial;
    // 价格为 0 的命中等同缺价（作废/占位列）——按缺主材价处理，不误判为已取价
    const lookedUp = opts.mainPrices?.[mainKey];
    const mainPrice = expectsMain
      ? (ownMain.gt(0) ? Number(ownMain) : lookedUp && D(lookedUp).gt(0) ? Number(lookedUp) : undefined)
      : undefined;
    // 多材料解析：首主材走 mainPrice，管件/法兰/配件走 matPrices[name]，全部未计价材料逐一核价
    const primaryIdx = primaryMatIdx(q, mats);
    const missingMats: string[] = [];
    let main = D(0);
    for (let i = 0; i < mats.length; i++) {
      const price = i === primaryIdx ? mainPrice : opts.matPrices?.[mats[i].name];
      if (price === undefined || price === null) {
        // 伪材料名（其他材料费/水/损耗…）不计缺价——它们本就不是可询价材料
        if (expectsMain && !PSEUDO_MAT.test(mats[i].name.trim())) missingMats.push(mats[i].name);
        continue;
      }
      main = main.plus(D(price).mul(mats[i].qtyPerUnit));
    }
    // 任何未计价材料缺价都使测算不完整（管件/法兰/配件也是钱）——缺价名单透出，偏差不予置信
    const needsMain = expectsMain && missingMats.length > 0;

    const calc = labor.plus(aux).plus(mach).plus(main).plus(fee);
    // 缺主材的测算价缺了造价大头（阀体/管材/设备），与清单综合单价比偏差必然失真——不出偏差数
    const dev = needsMain || D(item.unitPrice).isZero()
      ? null
      : calc.minus(D(item.unitPrice)).div(D(item.unitPrice)).mul(100);

    // 组价方案：主项行 + 工作内容缺口的建议增列行（建议行不计入测算价）
    const primaryLine = lineFromQuota(item, q, {
      mgmtRate: mgmt, profitRate: profit, mainPrice, matPrices: opts.matPrices,
    });
    const specText = opts.specTexts?.[`${q.detail?.fb ?? ""}|${q.detail?.chapter ?? ""}`]
      ?? opts.specTexts?.[q.detail?.fb ?? ""] ?? "";
    const plan = [primaryLine, ...suggestSupplementary(item, q, lib, mgmt, profit, specText)];

    return {
      ...base,
      quotaCode: q.code,
      quotaName: q.name,
      labor: round2(labor).toString(),
      materialAux: round2(aux).toString(),
      machine: round2(mach).toString(),
      mainMaterial: needsMain ? null : round2(main).toString(),
      fee: round2(fee).toString(),
      calcPrice: round2(calc).toString(),
      deviation: dev === null ? null : dev.toFixed(1),
      needsMainPrice: needsMain,
      missingMaterials: missingMats.length ? missingMats : undefined,
      ambiguous: t.ambiguous,
      altQuota: t.ambiguous && t.alt.q ? `${t.alt.q.code} ${t.alt.q.name}` : null,
      quotaGcnr: q.detail?.gcnr ?? null,
      quotaFb: q.detail?.fb ?? null,
      quotaChapter: q.detail?.chapter ?? null,
      quotaBase: q.detail?.jj != null ? String(q.detail.jj) : null,
      quotaMainName: q.detail?.mainMaterial ?? null,
      plan,
    };
  });
}

// main-material price lookup key: material+spec of the item
function f2m(item: BoqItemDTO): string {
  const f = item.features ?? {};
  return [f.material ?? item.name, f.diameter ?? f.specification ?? ""]
    .filter(Boolean)
    .join("|");
}

export { f2m as mainPriceKey };
