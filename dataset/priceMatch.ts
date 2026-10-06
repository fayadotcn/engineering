import { periodKey, LABOR_UNIT } from "./priceParse";
import { normUnit } from "@cost-engine/semantic";

// 价格库候选行打分：名称/规格是基础分（沿用既有阈值 60/80），
// 品牌偏好 / 地区 / 期次新旧 / 价格类型 在候选间做加减分裁决。
// 纯函数——候选集由调用方（dataset/service）从 DB 取出。

export interface PriceCandidate {
  id?: string;
  name: string;
  spec: string;
  unit: string;
  brand: string;
  price: number;
  priceType: string;
  region: string;
  period: string;
  source?: string;
  createdAt?: string;
  /** 行特征解析出的材料类别（同一解析器口径，跨侧可比） */
  category?: string;
}

export interface PricePrefs {
  /** 品牌偏好：appliesTo 为空 = 全局指定（如「品牌=上上」）；否则只作用于名称/材质含该词的条目（「电缆品牌=上上」→电缆类） */
  brands?: { appliesTo: string; value: string }[];
  /** 地区偏好（项目所在地区），候选 region 命中优先 */
  region?: string;
  /** 指定期次 YYYY-MM：按「截至该期最新价」取（信息价口径），超出该期的候选降权 */
  period?: string;
  /** 价格类型偏好 INFO|MARKET|SUPPLY|LABOR */
  priceType?: string;
}

// 规格归一化：分隔符 ×÷*xX 全部归一为 X（4×35 ≡ 4x35 ≡ 4*35），
// 全角已在上游 parse 层处理；上标 ²/³ 归一为数字（清单特征写 4mm²、库行写 4mm2 是同物）。
// 先归一分隔符再大写——原写法 x→X 被 toUpperCase 抵消。
const norm = (s: string | null | undefined): string =>
  String(s ?? "").replace(/\s/g, "").toUpperCase().replace(/[×*]/g, "X").replace(/²/g, "2").replace(/³/g, "3");

/** 名称弱同义归一：行业惯用叫法不同写法是同一物（翘板开关=跷板开关、JDG管=紧定钢管）。 */
const NAME_EQUIV: [RegExp, string][] = [
  [/翘板/g, "跷板"],           // 翘板开关 ↔ 跷板开关（定额/报价写法不一）
  [/JDG/ig, "紧定"],          // JDG = 套接紧定式钢导管
  [/KBG/ig, "扣压"],          // KBG = 扣压式薄壁钢导管
  [/UPVC|PVC-U/g, "PVC"],     // 硬聚氯乙烯写法变体
];
const normName = (s: string) => {
  let t = norm(s);
  for (const [re, canon] of NAME_EQUIV) t = t.replace(re, canon);
  return t;
};
/** 供检索侧复用的同义归一名（翘板↔跷板、JDG↔紧定 写法归一后再 contains） */
export const normalizeNameKey = normName;

/** 泛名词 bigram：命中不能当名称证据——「小便器」撞「大便器」、「翘板开关」撞「照明开关」、
 *  「绝缘电线」撞「矿物绝缘电力电缆」只差一个泛词根，靠它取价就是错价。
 *  区分度 bigram（跷板/蹲式/紧定/可调…）才算证据。 */
/** 泛规格占位词：库行 spec 写「综合/综合考虑」是报价口径不是型号，
 *  拿它做 contains/词根会在行描述长文里瞎撞（面漆|综合 → 防爆风机「…综合考虑…」）。 */
export const GENERIC_SPEC = /^(综合|综合考虑|通用|常规|标准|标准型|无|-)$/i;

/** 名称文本（仅留产品词）：剥括注段（「(二加三孔)」「(带防护门)」是规格/安装说明，不是名称头），
 *  拼合 CJK 连段——型号/电压/尺寸段（拉丁数字）不参与头部比对。 */
const cjkText = (s: string): string =>
  (normName(s).replace(/[（(][^）)]*[）)]/g, "").match(/[一-龥]+/g) ?? []).join("");

/** 名称证据 = 两侧 CJK 名的**共同后缀**长度。
 *  中文材料名的产品名词在词尾（三孔→插座、螺纹→减压阀、翘板暗→开关），前缀全是
 *  修饰语（安全型/单相/照明/智能）——修饰语/中段共享不证明同物：
 *    「减压阀」= 共同后缀 3 字 → 同族 ✓；「小便器」=「挂式小便器」尾 → ✓
 *    「照明开关」落在行「智能照明开关面板」**中段**（行头是面板）→ 共同后缀 0 ✓
 *    「氯磺化聚乙烯漆」与「实壁硬聚氯乙烯」共享「乙烯」但不在词尾 → 0 ✓
 *    「单相电度表」「矿物绝缘电力电缆」同法——表/缆 尾不同直接出局。
 *  功能后缀（配件/附件/材料…）是语法尾不是产品词——闭合小集，命中也不作数。 */
const FUNCTIONAL_SUFFIX = new Set(["配件", "附件", "装置", "设备", "材料", "制品", "工具", "用品", "散件", "杂件"]);
const commonSuffixLen = (row: string, itemName: string): number => {
  const a = cjkText(row), b = cjkText(itemName);
  if (!a.length || !b.length) return 0;
  let n = 0;
  for (let i = 1; i <= Math.min(a.length, b.length, 8) && a[a.length - i] === b[b.length - i]; i++) n = i;
  if (n >= 2 && FUNCTIONAL_SUFFIX.has(b.slice(-n))) return 0;
  return n >= 2 ? n : 0;
};

/** 量词修饰：联/孔/极/位/控/管/芯/路/相 是闭合量词类（不是开放词表）——
 *  三联≠单联、5孔≡2+3孔（和式等价）。提取每类量词的数值，同类异值即冲突。
 *  值可为 CJK 数词/阿拉伯数/加和式（「二加三」「2+3」）。 */
const MOD_UNITS = "联孔极位控管芯路相层";
const CJK_NUM: Record<string, number> = { 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10 };
const modVals = (s: string): Map<string, number> => {
  const t = norm(s);
  const out = new Map<string, number>();
  const re = new RegExp(`(\\d+(?:\\+\\d+)*|[一二两三四五六七八九十]+(?:加[一二两三四五六七八九十]+)*)(${MOD_UNITS})`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const val = m[1].split(/[\+加]/).reduce((sum, p) =>
      sum + (/^\d+$/.test(p) ? Number(p)
        : [...p].reduce((s2, c) => s2 + (CJK_NUM[c] ?? 0), 0)), 0);
    // 同量词重复出现求和：「二孔加三孔」=2+3=5 孔插座
    if (val > 0) out.set(m[2], (out.get(m[2]) ?? 0) + val);
  }
  return out;
};
/** 同类量词异值 → true（单联 vs 三联、4孔 vs 5孔）；一侧无该类量词不判 */
const modConflict = (row: string, itemName: string): boolean => {
  const a = modVals(row), b = modVals(itemName);
  for (const [u, v] of b) if (a.has(u) && a.get(u) !== v) return true;
  return false;
};

/** 共享 CJK 片段数（含括注原文）：只做同头候选间的贴脸加分，不作门槛——
 *  「安全型普通暗插座(二加三孔)」对「安全型三孔插座」共享 4 段，比裸「插座」行更贴。 */
const sharedSegs = (a: string, b: string): number => {
  const bg = (s: string) => {
    const t = (normName(s).match(/[一-龥]+/g) ?? []).join("");
    const o = new Set<string>();
    for (let i = 0; i + 1 < t.length; i++) o.add(t.slice(i, i + 2));
    return o;
  };
  const A = bg(a), B = bg(b);
  let n = 0;
  for (const g of A) if (B.has(g)) n++;
  return n;
};

/**
 * 规格里的型号词根：「WDZB1-YJY-0.6/1kV 3*10」→ {WDZB1, YJY, 1KV}。
 * 纯数字不进（3/10 太泛）；型号式价格行（报价单无材料名列）靠它对上清单规格。
 * 尾置裸数（WDZB1-BYJ-4、YJV22-3*120 的线径/芯数段）补出一个截面词根——
 * 电线报价惯例「型号-数字」的末位就是 mm²，不然 BYJ-4 永远对不上 4mm²。
 */
export const specTokens = (s: string | null | undefined): Set<string> => {
  const t = String(s ?? "").toUpperCase().replace(/[×*]/g, "X").replace(/²/g, "2").replace(/³/g, "3");
  const out = new Set(
    (t.match(/[A-Z]+\d*|\d+[A-Z]+\d*/g) ?? []).filter((x) => x.length >= 2)
  );
  const tail = t.match(/[-\/](\d+(?:\.\d+)?)\s*$/);
  if (tail) out.add(`${tail[1]}MM2`);
  return out;
};

/** 共有型号词根数：strong=长度≥3（YJY/WDZB1 这类才足以定位型号系列） */
const sharedSpecTokens = (a: string, b: string) => {
  const sa = specTokens(a), sb = specTokens(b);
  let any = 0, strong = 0;
  for (const t of sa)
    if (sb.has(t)) {
      any++;
      if (t.length >= 3) strong++;
    }
  return { any, strong };
};

/** 当前条目适用的品牌偏好值列表 */
export function applicableBrands(prefs: PricePrefs | undefined, text: string): string[] {
  if (!prefs?.brands?.length) return [];
  const t = norm(text);
  return prefs.brands
    .filter((b) => !b.appliesTo || t.includes(norm(b.appliesTo)))
    .map((b) => b.value)
    .filter(Boolean);
}

export interface PricePick {
  row: PriceCandidate;
  score: number;
  /** 需要向用户说明的偏差（如品牌非指定、期次早于指定） */
  notes: string[];
}

/**
 * 候选集里挑最优价。baseline 与既有 matchLibraryForItem 一致：
 *   名称命中 +40 / 规格精确 +50 包含 +30 无规格 +20 / 单位一致 +10。
 * 新维度：品牌偏好命中 +30（无品牌 +8，异品牌 -15）、地区命中 +15（空 +5）、
 *   期次默认取候选中最新一期 +12；指定期次时取「≤该期」中最新（+14，最早扣分），
 *   价格类型偏好命中 +10。
 */
export function pickBestPriceRow(
  candidates: PriceCandidate[],
  item: { name: string; spec?: string; unit?: string; material?: string; category?: string },
  prefs?: PricePrefs
): PricePick | null {
  if (!candidates.length) return null;
  const specRaw = norm(item.spec ?? "");
  const spec = GENERIC_SPEC.test(specRaw) ? "" : specRaw;
  const brands = applicableBrands(prefs, `${item.name} ${item.material ?? ""}`);
  const prefPk = periodKey(prefs?.period);
  const maxPk = Math.max(0, ...candidates.map((c) => periodKey(c.period)));
  const eligiblePk = prefPk
    ? Math.max(0, ...candidates.map((c) => {
        const k = periodKey(c.period);
        return k > 0 && k <= prefPk ? k : 0;
      }))
    : 0;
  // 期次全空时退到入库时间——「最新」对无期次表也该生效
  const maxCreated =
    maxPk === 0
      ? Math.max(0, ...candidates.map((c) => Date.parse(c.createdAt ?? "") || 0))
      : 0;

  // 直径口径：spec 本质就是一个口径值（DN20/JDG20/PC25）时，库行型号里的同数字段即贴档
  // （JDG20x1.2 的 20 就是 DN20）——型号前缀不同不该判规格不合
  const diaV = spec.match(/\d{2,4}/)?.[0];
  const specIsDia = !!diaV && /^[A-Z]{0,4}\d{2,4}$/.test(spec);
  // 纯尺寸/口径/截面/功率规格（DN25、4mm²、10A、75x50）是「尺寸」不是「型号」——
  // 只靠尺寸命中异名材料就是错价重灾区（螺纹减压阀DN25 撞 喷淋头DN25），
  // 必须另有名称证据才放行；带型号词根的规格（WDZB1-BYJ-4/JDG20x1.2）才可单独成证。
  const sizeOnlySpec = !!spec &&
    /^(\d+(?:\.\d+)?(?:MM2|MM|A|KW|KVA|KV|W|V|L|PA|KPA|MPA)?(?:X\d.*)?|[A-Z]{1,4}\d{1,4}(?:\.\d+)?(?:MM|A|KW|W|L)?)$/.test(spec);

  // 名称证据=产品头部命中（较长名尾部子串落在较短名内）；
  // 材质词兜底：行名含清单材质词算弱命中（「镀锌钢管」行对材质=镀锌钢管的项）。
  const itemMat = item.material ? normName(item.material) : "";
  const heads = candidates.map((r) => {
    const h = commonSuffixLen(r.name, item.name);
    return h >= 2 ? h : itemMat && normName(r.name).includes(itemMat) ? 2 : 0;
  });
  const catEq = (rc?: string) => {
    const ic = item.category?.trim();
    if (!rc?.trim() || !ic) return 0; // 任一侧无类别不判
    const a = rc.trim(), b = ic;
    return a === b || a.includes(b) || b.includes(a) ? 1 : -1;
  };
  // 头部 ≥3 字的行在场时，头 2 字泛头（便器/开关/插座）行出局——
  // 「蹲式大便器」有瓷蹲式直达行，小便器（便器尾 2 字）不该同台竞价
  const strongHead = heads.some((h) => h >= 3);

  let best: PricePick | null = null;
  for (let ci = 0; ci < candidates.length; ci++) {
    const r = candidates[ci];
    const head = heads[ci];
    const rsSpec = norm(r.spec);
    // 库行规格常写进名称、spec 列空白或塞说明文字（「电力电缆 ZR-YJV-3×4」spec=[单价一]）——
    // 规格证据按 名称+规格 合并文本判，否则这类行的规格维度全丢
    const rs = norm(`${r.spec} ${r.name}`);
    const specExact = !!(spec && (rsSpec === spec || (!rsSpec && norm(r.name) === spec)));
    const diaHit = !!(specIsDia && diaV && (rs.match(/\d{2,4}/g) ?? ([] as string[])).includes(diaV));
    const specContain = !!(
      spec && !specExact &&
      // 纯口径只认数字段相等（DN25 不得文本包含进 DN250），其余按名称+规格包含判
      (diaHit || (!specIsDia && (rs.includes(spec) || (rsSpec && spec.includes(rsSpec)))))
    );
    // 词根按 spec 列与名称分别取再并集——尾置裸数规则认「-4」在串尾，
    // 合串「WDZB1-BYJ-4 绝缘电线」会把型号尾数盖住（BYJ-4 对不上 4mm²）
    const shared = spec && !specExact && !specContain
      ? (() => {
          const sb = new Set([...specTokens(rsSpec), ...specTokens(r.name)]);
          let any = 0, strong = 0;
          for (const t of specTokens(spec)) if (sb.has(t)) { any++; if (t.length >= 3) strong++; }
          return { any, strong };
        })()
      : { any: 0, strong: 0 };
    const nameOk = head >= 2;
    // 型号式价格行（名称为型号）无名称命中——规格词根重合度够也保留参选；
    // 纯尺寸规格永远要名称证据（同尺寸异材料是铁证错配）
    if (!nameOk && (sizeOnlySpec || (!specExact && !specContain && !shared.strong && shared.any < 2)))
      continue;
    if (head === 2 && strongHead) continue;
    let s = 40;
    const notes: string[] = [];
    // 头部长度即名称置信度：≥4 字头部基本是完整产品词（蹲式大便器/跷板开关）
    if (head >= 4) s += 15;
    else if (head === 3) s += 10;
    else if (head === 2) { s += 2; notes.push("名称弱命中"); }
    // 类别同口径（两侧同一解析器产物）：同族加分，异族扣分——
    // 电度表/插座、电线/电缆这类「修饰词雷同、产品不同」的错配靠它收口
    const ce = catEq(r.category);
    if (ce > 0) s += 8;
    else if (ce < 0) { s -= 8; notes.push("类别不同"); }
    // 量词修饰冲突（三联 vs 单联、5孔 vs 4孔）——同头产品错档价
    if (modConflict(r.name, item.name)) { s -= 15; notes.push("规格档位不同"); }
    // 贴脸加分：同头候选里共享片段更多者更近（cap 6，不作门槛）
    s += Math.min(sharedSegs(r.name, item.name) * 2, 6);
    if (specExact) s += 50;
    else if (specContain) s += 30;
    else if (shared.strong >= 1) s += 22;
    else if (shared.any >= 2) s += 12;
    else if (!spec) s += 20;
    // 词根命中后的截面/尺寸精排（4*25+1*16 ≠ 3*35+1*16 ≠ 3*10）：
    // 全命中加分，全不命中罚分，部分命中不加不罚
    if (!specExact && !specContain && spec && rs) {
      // spec/rs 已 norm（分隔符统一为 X）——正则只认 X 即可
      const dReq = spec.match(/\d+(?:X\d+)+/g) ?? [];
      const dRow = new Set(rs.match(/\d+(?:X\d+)+/g) ?? []);
      if (dReq.length && dRow.size && dReq.every((d) => dRow.has(d))) s += 8;
      // 行本身无截面信息（「综合」/无规格列）不扣分——无证据不等于错档
      else if (dReq.length && dRow.size && !dReq.some((d) => dRow.has(d))) {
        s -= 20;
        notes.push("截面/尺寸档不同");
      }
    }
    if (!nameOk) notes.push("名称未直接命中（按型号规格匹配）");
    if (r.unit && item.unit && normUnit(r.unit) === normUnit(item.unit)) s += 10;

    // 品牌：指定品牌命中 > 无品牌候选 > 异品牌候选（异品牌仍可兜底但要留痕）
    if (brands.length) {
      const rb = norm(r.brand);
      if (rb && brands.some((b) => rb === norm(b) || rb.includes(norm(b)) || norm(b).includes(rb)))
        s += 30;
      else if (!rb) s += 8;
      else {
        s -= 15;
        notes.push(`品牌「${r.brand}」非指定（${brands.join("/")}）`);
      }
    }
    // 地区
    if (prefs?.region) {
      const rr = norm(r.region), pr = norm(prefs.region);
      if (rr && (rr.includes(pr) || pr.includes(rr))) s += 15;
      else if (!rr) s += 5;
      else notes.push(`地区「${r.region}」非「${prefs.region}」`);
    }
    // 期次：默认偏好候选里最新一期；指定期次按「截至该期」取
    const pk = periodKey(r.period);
    if (prefPk) {
      if (pk > 0 && pk <= prefPk) {
        s += 12;
        if (pk === eligiblePk) s += 2;
      } else if (pk > prefPk) {
        s += 0;
        notes.push(`期次「${r.period}」晚于指定「${prefs!.period}」`);
      }
    } else if (pk > 0 && pk === maxPk) s += 12;
    else if (maxPk === 0 && maxCreated > 0 && (Date.parse(r.createdAt ?? "") || 0) === maxCreated)
      s += 12;
    // 价格类型偏好
    if (prefs?.priceType && r.priceType === prefs.priceType) s += 10;
    // 量纲语义：清单项是人工/台班口径时 LABOR 价应显著优先（同工日单价 vs 材料价）；
    // 反之材料项遇 LABOR 行降权——人工费不该去填材料暂估价
    const itemLabor = !!item.unit && LABOR_UNIT.test(normUnit(item.unit) || item.unit.trim());
    if (itemLabor && r.priceType === "LABOR") s += 15;
    else if (!itemLabor && r.priceType === "LABOR") {
      s -= 10;
      notes.push("人工费价格行，用于材料项需谨慎");
    }

    // 同分裁决取期次较新者（再退入库时间）——不能让结果依赖候选集迭代顺序
    if (!best || s > best.score || (s === best.score &&
      (pk > periodKey(best.row.period) ||
        (pk === periodKey(best.row.period) && (Date.parse(r.createdAt ?? "") || 0) > (Date.parse(best.row.createdAt ?? "") || 0)))))
      best = { row: r, score: s, notes };
  }
  return best;
}
