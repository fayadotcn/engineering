import type { BoqSemanticFeature, Discipline } from "@shared/types";

// Rule-based engineering semantic parser for 安装工程 BOQ text.
// Deterministic: same input -> same features. LLM is never involved.

const norm = (s: string) =>
  s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    )
    // 直径符号全归一为 Φ：ϕ(U+03D5)/φ(U+03C6)/Ø/∅/￠(全角分币符) 在图纸与清单里
    // 都是直径写法——不归一，「ϕ108」这类真实标注就进不了 diameter 特征与定额档位比对
    .replace(/[ΦϕφØø∅￠]/g, "Φ")
    .toUpperCase();

const SYSTEMS: [RegExp, string][] = [
  [/消火栓|喷淋|消防|火灾报警|灭火/, "消防"],
  [/给排水|给水|排水|污水|雨水|废水|中水|水表/, "给排水"],
  [/暖通|空调|通风|防排烟|风管|风机/, "暖通"],
  [/弱电|智能化|安防|监控|网络|广播|综合布线/, "弱电智能化"],
  [/电气|强电|照明|动力|配电|防雷|接地|电缆|电线|桥架|母线/, "电气"],
];

const CATEGORIES: [RegExp, string][] = [
  [/桥架|梯架/, "桥架"],
  // 母线槽含「线槽」字样——必须先判母线再判线槽
  [/母线/, "母线"],
  [/线槽/, "线槽"],
  // 复合名词里的主体在后：小便器侧挡板/隔断板是隔断了，不是卫生器具——挡板必须先判
  [/挡板|隔断板/, "隔墙"],
  // 电气塑料配管：定额名「塑料管敷设(砖、混凝土结构明配/暗配)」是电线管工序不是给排水管道
  [/电线管|配线管|穿线管|线管|配管|JDG|KBG|SC管|塑料管敷设|半硬质塑料管|硬质聚氯乙烯管|刚性阻燃管/, "电线管"],
  [/电缆头|电缆终端|电缆中间头|电缆附件|电缆接头/, "电缆附件"],
  [/电缆(?!头)|电力电缆|控制电缆|矿物绝缘电缆/, "电缆"],
  [/配线|穿线|布线|电线|导线|BV|BVR|RVV|RVS|BYJ/, "电气线路"],
  [/等电位|均压环|避雷|接闪|引下线|接地母线|接地线|接地极|接地装置|防雷/, "防雷接地"],
  [/配电箱|控制箱|配电柜|开关柜|电表箱|接线箱|照明箱|动力箱|插座箱|端子箱|等电位箱|户内箱|弱电箱/, "配电箱柜"],
  // 卫生器具/计量表要在「设备/管道」之前：蹲式大便器水箱、水龙头不能被水箱/水管规则抢走
  [/大便器|小便器|坐便器|蹲便器|洗脸盆|洗手盆|洗涤盆|拖布池|浴盆|淋浴器|净身盆|化验盆|地漏|清扫口|扫除口|检查口|雨水斗|存水弯|排水栓|水龙头|水嘴|冲洗阀|自闭阀|感应龙头|卫生器具/, "卫生器具"],
  [/水表|热量表|燃气表|电度表|电表|表箱/, "计量表"],
  [/镀锌钢管|钢塑复合管|不锈钢管|无缝钢管|焊接钢管|螺旋钢管|铸铁管|PPR|PE(?!X)(?!\s*=)|PVC|UPVC|HDPE|软管|金属软管|水管|管道|管材/, "管道"],
  // 暖通部件先于「阀门/设备」：风口/风阀/消声/风机盘管/风管各有独立子目章
  [/风口|散流器|排烟口|送风口|回风口|排风口|百叶风口/, "风口"],
  [/防火阀|排烟阀|风量调节阀|对开多叶调节阀|风阀|风管蝶阀/, "风阀"],
  [/消声器|静压箱|消声弯头|消音器/, "消声静压"],
  [/风机盘管|盘管风机/, "风机盘管"],
  [/风管/, "风管"],
  [/蝶阀|闸阀|球阀|止回阀|截止阀|安全阀|减压阀|排气阀|电磁阀|信号阀|阀门/, "阀门"],
  [/喷头|喷淋头|水流指示器|湿式报警阀|末端试水/, "喷淋设备"],
  [/消火栓|灭火器|水泵接合器/, "消防设备"],
  [/探测器|报警按钮|手动报警|声光报警|警铃|广播|扬声器|摄像机|摄像头|监控|模块箱|消防模块/, "弱电末端"],
  [/灯具|灯管|吸顶灯|筒灯|应急灯|疏散指示|照明灯|吊灯|射灯|灯带/, "灯具"],
  // 开关电器（断路器/空开）必须在「开关插座」之前——空气开关不是面板开关
  [/空气开关|断路器|漏电保护|漏电开关|漏电断路器|空开|刀开关|隔离开关|熔断器|负荷开关|真空开关/, "开关电器"],
  [/开关|插座|面板|按钮/, "开关插座"],
  [/风机|水泵|泵组|机组|水箱|冷却塔|吊扇|风扇|换气扇|排气扇/, "设备"],
  [/支架|支吊架|抗震支架/, "支架"],
  // 阻火圈/防火套管在「套管」之前——防火套管≠普通套管子目
  [/阻火圈|防火套管/, "阻火圈"],
  [/套管|防水套管/, "套管"],
  [/保温|橡塑|岩棉|聚氨酯|玻璃棉/, "保温"],
  // 装饰装修类：与建筑定额（1A-1L/2A-2E）同名同类，类别对了册就对了
  // 抹灰/批荡必须在楼地面之前——「墙面假饰面砖」是抹灰仿砖工序，不是贴砖
  [/抹灰|批荡|找平层|找坡层|一般抹灰|装饰抹灰/, "抹灰"],
  [/吊顶|天棚/, "天棚"],
  [/隔断|隔墙/, "隔墙"],
  // 墙面/柱面块料是「墙柱面」不是楼地面——quota 侧「面砖 内墙面」同口径
  [/墙柱面|墙面砖|内墙面|外墙面|墙裙|柱面|立面/, "墙柱面"],
  [/踢脚线|门槛石|地砖|地板|楼地面|地台|地垫|花岗石|大理石|玻化砖|釉面砖|抛光砖|抛釉砖|防滑砖|瓷片|面砖|地面砖|锦砖|马赛克|缸砖/, "楼地面"],
  [/乳胶漆|涂料|腻子|裱糊|墙纸|墙布|真石漆|刮白|刮灰/, "涂饰"],
  [/门窗套|门套|窗套|木门|钢门|铝合金门|玻璃门|大门|防火门|防盗门|塑钢门|窗户/, "门窗"],
  [/砌体|砌砖|砌筑|砖墙|砌块|砌墙|新砌/, "砌筑"],
  [/防水|防潮/, "防水"],
  [/美缝|填缝|勾缝/, "勾缝"],
  [/刷油|防腐|除锈|油漆/, "防腐刷油"],
  [/法兰|盲板|管件|弯头|三通|四通|大小头|管箍/, "管件"],
  [/接线盒|灯头盒|分线盒|底盒/, "接线盒"],
  [/调试|试验|检测/, "调试试验"],
  [/土方|挖填|开挖|回填/, "土方"],
];

const MATERIALS: [RegExp, string][] = [
  [/热镀锌钢管|镀锌钢管/, "镀锌钢管"],
  [/钢塑复合管|衬塑钢管/, "钢塑复合管"],
  [/不锈钢(无缝)?管/, "不锈钢管"],
  [/无缝钢管/, "无缝钢管"],
  [/焊接钢管/, "焊接钢管"],
  [/球墨铸铁|铸铁/, "铸铁管"],
  [/铝塑复合管|铝塑管/, "铝塑复合管"],
  [/衬塑|内衬塑|外覆塑|涂塑|内涂塑/, "钢塑复合管"],
  [/PPR|PP-R|聚丙烯/, "PPR"],
  [/HDPE|PE(?!X)(?!\s*=)|聚乙烯/, "PE"],
  [/UPVC|PVC-U|PVC|聚氯乙烯/, "PVC"],
  // 泛称「塑料管」兼容一切塑料管材（定额说明：塑料管安装适用 UPVC/PPC/PPR/PE/PB）
  // PC 管（聚碳酸酯硬质管）/刚性阻燃管/半硬质塑料管 是电气配管常用塑料线管
  [/塑料管|塑料给水管|塑料排水管|塑料线管|PC\s*\d+|刚性阻燃管|半硬质塑料管|硬质塑料管/, "塑料管"],
  [/有缝钢管|碳钢管|碳素钢管|SC管|黑铁管/, "焊接钢管"],
  [/合金钢管|高合金/, "合金钢管"],
  [/ABS/, "ABS"],
  [/玻璃钢管/, "玻璃钢"],
  // 泛称「钢管」殿后：具体管材都没命中时的兜底，与管材组内成员视为「泛称↔具体」兼容
  [/钢管/, "钢管"],
  // 装饰材：同类别内材料不同即错配（大理石面层≠陶瓷砖面层）
  [/大理石|花岗岩|花岗石|人造石|过门石|门槛石/, "石材"],
  [/陶瓷|瓷片|釉面砖|玻化砖|抛光砖|抛釉砖|面砖|内墙砖|防滑砖|地砖|地面砖|锦砖|马赛克|缸砖|彩釉砖|通体砖/, "陶瓷砖"],
  [/强化木地板|强化木|复合地板|实木地板|木地板|竹地板/, "木地板"],
  [/塑料地板|塑胶地板|橡胶地板|石塑地板|SPC|塑扣/, "塑料地板"],
  [/石膏板|纸面石膏/, "石膏板"],
  [/铝扣板|铝单板|铝塑板|铝板/, "铝板"],
  [/不锈钢板|不锈钢/, "不锈钢"],
  [/矿棉|矿棉板/, "矿棉板"],
  // 保温材料按品种分——橡塑/岩棉/聚氨酯价差数倍，同类别内互斥
  [/橡塑|橡塑海绵/, "橡塑"],
  [/岩棉/, "岩棉"],
  [/玻璃棉/, "玻璃棉"],
  [/聚氨酯/, "聚氨酯"],
  [/硅酸铝/, "硅酸铝"],
  // 芯材：铜芯BV/BVR/BYJ/铜导线 vs 铝芯——管内穿线子目分芯计价
  [/铜芯|铜导线|BV(?!R)|BYJ|BVR/, "铜"],
  [/铝芯|铝导线|BLV|YJLV|VLV/, "铝芯电缆"],
  // JDG/KBG 是套接紧定式镀锌钢导管——材料归镀锌钢管，定额走电线管/钢管敷设
  [/JDG|KBG|套接紧定|扣压式/, "镀锌钢管"],
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
  // 「螺纹法兰阀」这类名字里螺纹法兰同现时是法兰件——法兰优先于螺纹
  [/法兰(连接|盘)?|法兰(?!.*螺纹)/, "法兰连接"],
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
  [/明配|明装|明敷/, "明装"],
  [/暗配|暗装|暗敷|埋地|直埋|钢模板/, "暗装/埋地"],
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
  // 电缆型号压芯材标注：「电力电缆 YJV-4x35 铜芯」与「YJV-4x35」应判同材——
  // YJV 本身就是铜芯电缆，芯材标注只是冗余说明。铝芯型号/「铝芯」须先于裸「电缆」命中，
  // 否则「铝芯电力电缆」被泛化规则错盖成铜。
  if (/电缆|YJV|YJLV|VLV|BTTZ|BTLY|YTTW|矿物绝缘|铝芯/.test(text)) {
    f.material =
      first(text, [
        [/铝芯|铝导线|YJLV|VLV|BLV/, "铝芯电缆"],
        [/YJV|WDZ[A-Z]?-?YJY?|ZR-?YJV|NH-?YJV/, "YJV电缆"],
        [/矿物绝缘|BTTZ|BTLY|YTTW/, "矿物绝缘电缆"],
        [/电缆/, "铜"],
      ]) ?? f.material;
  }
  f.connectionMethod = first(text, CONNECTIONS);
  f.location = first(text, LOCATIONS);

  // 管径：DN100 / De110 / Φ108 与定额式「公称直径 100mm以内」「直径<200mm」「直径50以下」「外径」
  const dn =
    text.match(/(?:DN|DE|Φ)\s*(\d+(?:\.\d+)?)/) ??
    text.match(/(?:公称直径|公称口径|公称外径|外径|内径|直径|口径|管径)\s*[<≤>≥=]?\s*(\d+(?:\.\d+)?)\s*(?:mm|MM)?\s*(?:以内|以下|之内|内|≤|<|以上|≥|>)?/);
  if (dn) f.diameter = `DN${dn[1]}`;
  // 型号前缀口径：JDG20 / SC15 / PC20 / PVC25 —— 管代号+数字即公称口径（清单常不写 DN）
  if (!f.diameter) {
    const coded = text.match(/\b(?:JDG|KBG|SC|PC|PVC|PE|PPR|CP|MT|TC|RC|CE)\s*[-#]?\s*(\d{2,3})\b/i);
    if (coded) f.diameter = `DN${coded[1]}`;
  }

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
  // 裸截面规格：配线 ZC-BV-2.5mm2 无「以内」也要提取——截面是电线定额的定价档
  if (!f.specification) {
    const sq = text.match(/(\d+(?:\.\d+)?)\s*(mm²|mm2)/i);
    if (sq) f.specification = `${sq[1]}mm²`;
  }
  // 管材裸数字口径：「配管 PVC 20」「电线管 25」——无 DN 前缀的尾数就是公称口径
  if (!f.diameter && (f.category === "管道" || /管/.test(name))) {
    const bare = text.match(/(?:^|[^\d.])(\d{2,3})\s*(?:mm)?\s*$/);
    if (bare && Number(bare[1]) >= 15 && Number(bare[1]) <= 400) f.diameter = `DN${bare[1]}`;
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
