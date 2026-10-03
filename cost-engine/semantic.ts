import type { BoqSemanticFeature, Discipline } from "@shared/types";

// Rule-based engineering semantic parser for 安装工程 BOQ text.
// Deterministic: same input -> same features. LLM is never involved.

const norm = (s: string) =>
  s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    )
    .replace(/Φ/g, "Φ")
    .toUpperCase();

const SYSTEMS: [RegExp, string][] = [
  [/消火栓|喷淋|消防|火灾报警|灭火/, "消防"],
  [/给排水|给水|排水|污水|雨水|废水|中水|水表/, "给排水"],
  [/暖通|空调|通风|防排烟|风管|风机/, "暖通"],
  [/弱电|智能化|安防|监控|网络|广播|综合布线/, "弱电智能化"],
  [/电气|强电|照明|动力|配电|防雷|接地|电缆|电线|桥架|母线/, "电气"],
];

const CATEGORIES: [RegExp, string][] = [
  [/桥架|线槽|梯架/, "桥架"],
  [/电缆(?!头)|电力电缆|控制电缆|矿物绝缘电缆/, "电缆"],
  [/电缆头|电缆终端|电缆中间头/, "电缆附件"],
  [/电线|导线|BV|BVR|RVV|RVS|BYJ/, "电线"],
  [/配电箱|控制箱|配电柜|开关柜|电表箱|接线箱/, "配电箱柜"],
  [/母线|母线槽/, "母线"],
  [/镀锌钢管|钢塑复合管|不锈钢管|无缝钢管|焊接钢管|螺旋钢管|铸铁管|PPR|PE(?!X)(?!\s*=)|PVC|UPVC|HDPE|JDG|KBG|SC管|穿线管|软管|金属软管|水管|管道|管材/, "管道"],
  [/蝶阀|闸阀|球阀|止回阀|截止阀|安全阀|减压阀|排气阀|电磁阀|信号阀|阀门/, "阀门"],
  [/喷头|喷淋头|水流指示器|湿式报警阀|末端试水/, "喷淋设备"],
  [/消火栓|灭火器|水泵接合器/, "消防设备"],
  [/灯具|灯管|吸顶灯|筒灯|应急灯|疏散指示|照明灯/, "灯具"],
  [/开关|插座|面板/, "开关插座"],
  [/风机|水泵|泵组|机组|水箱|冷却塔/, "设备"],
  [/支架|支吊架|抗震支架/, "支架"],
  [/套管|防水套管/, "套管"],
  [/保温|橡塑|岩棉|聚氨酯|玻璃棉/, "保温"],
  [/刷油|防腐|除锈|油漆/, "防腐刷油"],
  [/法兰|盲板|管件|弯头|三通|四通|大小头|管箍/, "管件"],
  [/接线盒|灯头盒|分线盒/, "接线盒"],
  [/调试|试验|检测/, "调试试验"],
  [/土方|挖填|开挖|回填/, "土方"],
];

const MATERIALS: [RegExp, string][] = [
  [/热镀锌钢管|镀锌钢管/, "镀锌钢管"],
  [/钢塑复合管|衬塑钢管/, "钢塑复合管"],
  [/不锈钢(无缝)?管/, "不锈钢管"],
  [/无缝钢管/, "无缝钢管"],
  [/焊接钢管/, "焊接钢管"],
  [/球墨铸铁|铸铁管/, "铸铁管"],
  [/PPR|PP-R/, "PPR"],
  [/HDPE|PE(?!X)(?!\s*=)/, "PE"],
  [/UPVC|PVC-U|PVC/, "PVC"],
  [/JDG/, "JDG"],
  [/KBG/, "KBG"],
  [/YJV|WDZ[A-Z]?-?YJY?|ZR-?YJV|NH-?YJV/, "YJV电缆"],
  [/BV(?!R)|WDZ[A-Z]?-?BYJ|ZR-?BV|NH-?BV/, "BV电线"],
  [/BVR/, "BVR电线"],
  [/RVV|RVS|RVVP/, "RVV电线"],
  [/矿物绝缘|BTTZ|BTLY|YTTW/, "矿物绝缘电缆"],
  [/镀锌板|镀锌钢板|镀锌铁皮/, "镀锌钢板"],
  [/铝合金/, "铝合金"],
  [/铜|紫铜/, "铜"],
];

const CONNECTIONS: [RegExp, string][] = [
  [/沟槽|卡箍|卡套/, "沟槽连接"],
  [/螺纹|丝扣|丝接/, "螺纹连接"],
  [/热熔/, "热熔连接"],
  [/电熔/, "电熔连接"],
  [/承插/, "承插连接"],
  [/卡压|环压/, "卡压连接"],
  [/法兰(连接|盘)/, "法兰连接"],
  [/焊接|电弧焊|氩弧焊|对焊/, "焊接"],
  [/粘接|胶水|胶粘/, "粘接"],
  [/压接|冷压/, "压接"],
];

const INSTALL_METHODS: [RegExp, string][] = [
  [/明装|明敷/, "明装"],
  [/暗装|暗敷|埋地|直埋/, "暗装/埋地"],
  [/吊装|吊挂/, "吊装"],
  [/沿墙|墙面/, "沿墙敷设"],
  [/管内|穿管/, "管内敷设"],
  [/桥架内|线槽内/, "桥架内敷设"],
  [/竖井|井道/, "竖井敷设"],
];

const LOCATIONS: [RegExp, string][] = [
  [/室内|户内/, "室内"],
  [/室外|户外/, "室外"],
  [/地下(?!室)/, "地下"],
  [/屋面|楼顶/, "屋面"],
  [/管廊|综合管廊/, "管廊"],
  [/吊顶/, "吊顶内"],
];

const first = (text: string, rules: [RegExp, string][]) => {
  for (const [re, label] of rules) {
    const m = text.match(re);
    if (m) return label;
  }
  return undefined;
};

export function parseSemanticFeature(
  name: string,
  rawFeature = ""
): BoqSemanticFeature {
  const text = norm(`${name} ${rawFeature}`);
  const f: BoqSemanticFeature = {};

  f.system = first(text, SYSTEMS);
  f.installationMethod = first(text, INSTALL_METHODS);
  // category comes from the name first; scan the feature text with
  // installation-method phrases stripped so "桥架内敷设" can't hijack it
  const featureOnly = norm(rawFeature)
    .replace(/桥架内敷设|线槽内敷设|管内敷设|沿墙敷设|竖井敷设|明敷|暗敷|直埋/g, " ");
  f.category = first(norm(name), CATEGORIES) ?? first(featureOnly, CATEGORIES);
  f.material = first(text, MATERIALS);
  f.connectionMethod = first(text, CONNECTIONS);
  f.location = first(text, LOCATIONS);

  // 管径：DN100 / De110 / Φ108 与定额式「公称直径 100mm以内」「直径50以下」「外径」
  const dn =
    text.match(/(?:DN|DE|Φ)\s*(\d+(?:\.\d+)?)/) ??
    text.match(/(?:公称直径|公称口径|公称外径|外径|内径|直径|口径)\s*(\d+(?:\.\d+)?)\s*(?:mm|MM)?\s*(?:以内|以下|之内|内|≤)?/);
  if (dn) f.diameter = `DN${dn[1]}`;

  const pn = text.match(/PN\s*(\d+(?:\.\d+)?)/);
  const mpa = text.match(/(\d+(?:\.\d+)?)\s*MPA/);
  if (pn) f.pressure = `PN${pn[1]}`;
  else if (mpa) f.pressure = `${mpa[1]}MPa`;

  // 设备额定功率：Pe=60kW / Pjs=30kW / N=4.0kW(水泵风机电机) / 功率 7.5kW / 315kVA。
  // 配电箱柜、风机、水泵等的第一定价因子——不进特征，
  // 不同功率的设备会被当「相同项」误报单价不一致（5kW 与 132kW 本就该不同价）。
  // 复合写法 Pe=165+165(备)kW 取第一个数（额定容量，备机不计）。
  // 单位强制 kW/kVA：N=/PN= 之类的非功率写法拿不到单位就不会误中。
  const power =
    text.match(/\b(?:P[EJSN]{0,2}|N)\s*[=＝]\s*(\d+(?:\.\d+)?)\s*(?:\+\s*\d+(?:\.\d+)?\s*[(（]?备?[)）]?\s*)*(KVA|KW)\b/i) ??
    text.match(/(?:功率|额定功率|容量|额定容量)\s*[:：=＝]?\s*(\d+(?:\.\d+)?)\s*(KVA|KW)\b/i);
  if (power) f.power = `${power[1]}${power[2].toUpperCase() === "KVA" ? "kVA" : "kW"}`;

  // Cable/duct spec: 4x25+1x16, 3x2.5, 100x200, 2*4, De25*2.3(壁厚)。
  // 第二段允许小数（壁厚 2.3/4.2 是区分冷热水管的关键特征），分隔符统一归一为 x，
  // 否则 4x25 与 4*25 会被特征比对当成「规格不同」误报。
  const cable = text.match(/(\d+)\s*[X×*]\s*(\d+(?:\.\d+)?)(\s*\+\s*\d+\s*[X×*]\s*\d+(?:\.\d+)?)*/);
  const dim = text.match(/(\d{2,4})\s*[X×*]\s*(\d+(?:\.\d+)?)(?!\d)/);
  if (cable && /电缆|电线|导线|YJV|BV|RVV|BYJ|芯/.test(text)) {
    f.specification = cable[0].replace(/\s/g, "").replace(/[×*X]/g, "x");
  } else if (dim) {
    f.specification = dim[0].replace(/\s/g, "").replace(/[×*X]/g, "x");
  }
  // 定额式上限规格：截面 35mm²以内 / 重量 0.3t以内 / 容量 500L以内 / 功率 15kW以下
  // 归一化为「值+单位」，两侧（定额名/清单特征）同式可精确比对
  if (!f.specification) {
    const bound = text.match(
      /(?:截面[积]?|重量|容量|容积|功率|风量|扬程|流量|压力等级?)?\s*(?:≤|≥)?\s*(\d+(?:\.\d+)?)\s*(mm²|mm2|t|T|kg|KG|kW|KW|kw|W|kV|KV|kv|V|v|A|m³|m3|L|l|kPa|KPa|kpa|Pa)\s*(?:以内|以下|之上|以内者|及以下|≤|≥|内|以上)/
    );
    if (bound) {
      const u = bound[2].replace(/mm2/i, "mm²").replace(/m3/i, "m³")
        .replace(/^KW$/i, "kW").replace(/^KV$/i, "kV").replace(/^T$/, "t").replace(/^KG$/i, "kg").replace(/^l$/, "L");
      f.specification = `${bound[1]}${u}`;
    }
  }
  if (!f.specification && dn) f.specification = `DN${dn[1]}`;

  const brand = text.match(/品牌[:：]?\s*([A-Z一-龥]{2,8})/);
  if (brand) f.brand = brand[1];

  const fire = text.match(/耐火|阻燃|WDZ|NH|ZR/);
  if (fire) f.fireRating = fire[0];

  // residual tokens for fuzzy matching
  const cleaned = text
    .replace(/(?:DN|DE|Φ)\s*\d+(?:\.\d+)?/g, " ")
    .replace(/PN\s*\d+(?:\.\d+)?/g, " ")
    .replace(/\d+(?:\.\d+)?\s*MPA/g, " ")
    .replace(/\d+\s*[X×*]\s*\d+(?:\.\d+)?(\s*\+\s*\d+\s*[X×*]\s*\d+(?:\.\d+)?)*/g, " ")
    .replace(/[^\p{Script=Han}A-Z0-9]+/gu, " ")
    .trim();
  f.tokens = cleaned.split(/\s+/).filter((t) => t.length >= 2).slice(0, 12);

  return f;
}

export function inferDiscipline(
  name: string,
  rawFeature: string,
  sectionPath: string
): Discipline {
  const text = norm(`${sectionPath} ${name} ${rawFeature}`);
  if (/消火栓|喷淋|消防|火灾报警|灭火/.test(text)) return "FIRE";
  if (/给排水|给水|排水|污水|雨水|废水|中水|燃气|煤气|采暖|供暖|地暖/.test(text)) return "PLUMBING";
  if (/暖通|空调|通风|防排烟|风管|风机/.test(text)) return "HVAC";
  if (/弱电|智能化|安防|监控|网络|广播|综合布线/.test(text)) return "WEAK_CURRENT";
  if (/电气|强电|照明|动力|配电|防雷|接地|电缆|电线|桥架|母线|灯具|插座/.test(text))
    return "ELECTRICAL";
  return "OTHER";
}

/**
 * 单位归一化：同义单位收敛（米≡m、平米≡㎡、公斤≡kg…），
 * 量纲不同的单位（m vs km、个 vs 台）保持区分——那是「单位不一致」检查的对象。
 */
export function normUnit(unit: string): string {
  const u = unit
    .trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/\s+/g, "");
  const alias: Record<string, string> = {
    米: "m", 公尺: "m", m: "m",
    平方米: "㎡", 平米: "㎡", "㎡": "㎡", m2: "㎡", "m²": "㎡",
    立方米: "m³", 立米: "m³", "m³": "m³", m3: "m³",
    公里: "km", 千米: "km", km: "km",
    公斤: "kg", 千克: "kg", kg: "kg",
    吨: "t", t: "t",
    克: "g", g: "g",
    毫米: "mm", mm: "mm",
    厘米: "cm", cm: "cm",
  };
  return alias[u] ?? u;
}

/**
 * Canonical group key for "same item" candidate grouping.
 * Items that cannot be parsed fall back to normalized name — never raw string equality.
 */
export function groupKey(
  name: string,
  unit: string,
  f: BoqSemanticFeature
): string {
  const u = normUnit(unit);
  const parts = [
    f.category ?? "",
    f.material ?? "",
    f.diameter ?? "",
    !f.diameter && f.specification ? f.specification : "",
    f.power ?? "",
    f.connectionMethod ?? "",
    f.system ?? "",
    u,
  ].filter(Boolean);
  if (parts.length >= 2) return parts.join("|");
  return `RAW|${norm(name).replace(/\s+/g, "")}|${u}`;
}

/** Feature-level equality used after grouping (guards false positives). */
export function featureCompatible(
  a: BoqSemanticFeature,
  b: BoqSemanticFeature
): { ok: boolean; conflicts: string[] } {
  const conflicts: string[] = [];
  const fields: (keyof BoqSemanticFeature)[] = [
    "category",
    "material",
    "diameter",
    "specification",
    "connectionMethod",
    "system",
    "pressure",
    "power",
    "installationMethod",
    "location",
  ];
  for (const k of fields) {
    const av = a[k];
    const bv = b[k];
    // 两侧值排序后拼接，避免同一冲突因行序不同出现「A≠B」与「B≠A」两条。
    if (av && bv && av !== bv) conflicts.push(`${k}: ${[av, bv].sort().join(" ≠ ")}`);
  }
  return { ok: conflicts.length === 0, conflicts };
}
