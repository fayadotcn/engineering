// 扫描宏业工程文件(.GCFX/.SGCFX/.GCFZ/.SGCFZ)，解析私有二进制流，
// 提取 清单项(F目)→定额子目(F定) 的实际套用关系（含换算/主材/派生费），
// 聚合成"同类清单通常套哪些定额"的经验库。
//
// 文件格式（逆向）:
//   zip 容器 → 内部流 {proj}/{group}/{streamId}，清单表主要在 */3003
//   行标记: 内联 UTF16 行号 "F" + 类型字(目/定/段/派…) + 序号数字
//   字符串字段: <u32 长度><UTF16>，两种变体：长度=字符数 | 长度=字节数；
//               个别变体中纯 ASCII 字段按 UTF16BE 存储 → 解码按可读性打分
//   数值: 变体A "10 00 00 00"+2×f64；变体B "01"+<u32字节长>+数字字符串
//
// 用法: npx tsx scripts/extract-gcfx-quota.ts [rootDir=D:/] [outDir=storage/gcfx-corpus]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import JSZip from "jszip";

const ROOT = process.argv[2] ?? "D:/";
const OUT = process.argv[3] ?? "storage/gcfx-corpus";
const EXTS = new Set([".gcfx", ".sgcfx", ".gcfz", ".sgcfz"]);
const SKIP_DIRS = new Set([
  "$recycle.bin", "system volume information", "config.msi", "$av_nll",
  "windows", "program files", "program files (x86)", "programdata", "msocache",
]);

// ---------- 字符串解码（LE/BE × charLen/byteLen 打分取优） ----------
const EXTRA_OK = new Set(
  [..."（）()×Φφ-—~、，。；：·%@/*+.,;[]【】<>《》#!?？&=|_^　 ≤≥"].map((c) => c.codePointAt(0)!)
);
const BAD_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

function scoreStr(s: string): number {
  let sc = 0;
  for (const ch of s) {
    const k = ch.codePointAt(0)!;
    if ((k >= 0x30 && k <= 0x39) || (k >= 0x41 && k <= 0x5a) || (k >= 0x61 && k <= 0x7a)) { sc += 3; continue; }
    if (k >= 0x4e00 && k <= 0x9fa5) { sc += 2; continue; }              // 常用汉字
    if (k >= 0x20 && k < 0x7f) { sc += 2; continue; }                   // ASCII 标点/空格
    if (EXTRA_OK.has(k) || (k >= 0xff00 && k <= 0xffef)) { sc += 1; continue; }
    if (k >= 0x3000 && k <= 0x4dbf) { sc -= 2; continue; }              // BE 误读 ASCII 的典型垃圾区
    sc -= 3;
  }
  return sc;
}

interface StrHit { o: number; s: string }

function decodeBE(raw: Buffer): string {
  const b = Buffer.alloc(raw.length);
  for (let i = 0; i + 1 < raw.length; i += 2) { b[i] = raw[i + 1]; b[i + 1] = raw[i]; }
  return b.toString("utf16le");
}

/** 扫描 [lo,hi) 内所有 <u32 len><UTF16> 字符串 */
function scanStrings(buf: Buffer, lo: number, hi: number): StrHit[] {
  const out: StrHit[] = [];
  let p = lo;
  while (p + 5 < hi) {
    const L = buf.readUInt32LE(p);
    type Cand = { bytes: number; s: string; sc: number };
    const cands: Cand[] = [];
    if (L >= 1 && L <= 600 && p + 4 + L * 2 <= hi) {
      const raw = buf.slice(p + 4, p + 4 + L * 2);
      cands.push({ bytes: L * 2, s: raw.toString("utf16le").replace(/\0+$/, ""), sc: 0 });
      cands.push({ bytes: L * 2, s: decodeBE(raw).replace(/\0+$/, ""), sc: 0 });
    }
    if (L >= 2 && L <= 1200 && L % 2 === 0 && p + 4 + L <= hi) {
      const raw = buf.slice(p + 4, p + 4 + L);
      cands.push({ bytes: L, s: raw.toString("utf16le").replace(/\0+$/, ""), sc: 0 });
      cands.push({ bytes: L, s: decodeBE(raw).replace(/\0+$/, ""), sc: 0 });
    }
    let best: Cand | null = null;
    for (const c of cands) {
      c.s = c.s.trim();
      if (!c.s || BAD_CHAR.test(c.s)) continue;   // 含控制符/NUL = 错位吞并，拒绝
      c.sc = scoreStr(c.s);
      if (c.sc <= 0) continue;
      // 等分时取字节更短者（真字段边界更紧）
      if (!best || c.sc > best.sc || (c.sc === best.sc && c.bytes < best.bytes)) best = c;
    }
    if (best) { out.push({ o: p, s: best.s }); p += 4 + best.bytes; }
    else p += 1;
  }
  return out;
}

interface Row {
  id: string; type: string; off: number;
  strs: StrHit[]; nums: number[];
}

function scanRows(buf: Buffer): Row[] {
  const marks: { off: number; id: string; type: string }[] = [];
  for (let i = 0; i + 12 < buf.length; i++) {
    if (buf[i] !== 0x46 || buf[i + 1] !== 0x00) continue;
    const t = buf.readUInt16LE(i + 2);
    if (t < 0x4e00 || t > 0x9fff) continue;
    let j = i + 4, digits = "";
    while (j + 1 < buf.length) {
      const c = buf.readUInt16LE(j);
      if (c >= 0x30 && c <= 0x39) { digits += String.fromCharCode(c); j += 2; } else break;
    }
    if (!digits || digits.length > 4) continue;
    marks.push({ off: i, id: "F" + String.fromCharCode(t) + digits, type: String.fromCharCode(t) });
  }
  const rows: Row[] = [];
  for (let k = 0; k < marks.length; k++) {
    const lo = marks[k].off;
    const hi = k + 1 < marks.length ? marks[k + 1].off : buf.length;
    const strs = scanStrings(buf, lo, hi).filter((x) => x.o >= lo + 6);
    const nums: number[] = [];
    for (let p = lo; p + 20 <= hi; p++) {
      if (buf.readUInt32LE(p) !== 0x10) continue;
      const a = buf.readDoubleLE(p + 4), b = buf.readDoubleLE(p + 12);
      if (Number.isFinite(a) && Math.abs(a) < 1e13) nums.push(+a.toFixed(6));
      if (Number.isFinite(b) && Math.abs(b) < 1e13) nums.push(+b.toFixed(6));
      p += 19;
    }
    // 变体B：数字以字符串存，并入 nums 供取量参考
    for (const x of strs) {
      if (/^-?\d+(\.\d+)?$/.test(x.s) && !/^[0-9]{9,}$/.test(x.s)) {
        const v = parseFloat(x.s);
        if (Number.isFinite(v)) nums.push(v);
      }
    }
    rows.push({ id: marks[k].id, type: marks[k].type, off: lo, strs, nums });
  }
  return rows;
}

// ---------- 字段语义 ----------
const QD_CODE = /^\d{9,12}$/;
const QUOTA_CODE = /^[A-Z]{1,3}\d{2,}[换补T]?$/;
const MAT_CODE = /^(\d{5,}-\d{1,2}|GK\d{4,}|CL\d{4,}|\d{7,})$/;
const NUMERIC = /^-?\d+(\.\d+)?%?$/;
const UNITISH = /^(m|m2|m3|㎡|m²|m³|个|台|套|座|根|条|处|块|组|kg|t|km|米|樘|扇|只|具|盏|箱|柜|口|孔|点|位|宗|项|元|工日|10m|100m|10m2|100m2|10m3|100m3|10个|100个|10套|10台|10m³|100m³|10m²|100m²|t·h|kg\/m)$/i;

interface QuotaUse {
  applied: string; code: string; name: string; unit: string;
  conv: boolean; convNote: string;
  qty: number | null; nums: number[];
  materials: { name: string; unit: string; code: string }[];
}
interface QdItem {
  code: string; code9: string; name: string; unit: string; spec: string;
  nums: number[]; section: string; stream: string;
  quotas: QuotaUse[]; pai: string[];
}

function fieldsOf(row: Row): { code: string; code2: string; name: string; unit: string; spec: string } {
  const ss = row.strs.map((x) => x.s);
  // 定额行优先定额式编码（其行内可能夹带上级清单编码），清单行反之
  const primary = row.type === "定" ? QUOTA_CODE : QD_CODE;
  const secondary = row.type === "定" ? QD_CODE : QUOTA_CODE;
  let ci = ss.findIndex((s) => primary.test(s));
  if (ci < 0) ci = ss.findIndex((s) => secondary.test(s));
  const code = ci >= 0 ? ss[ci] : "";
  const after = ci >= 0 ? ss.slice(ci + 1) : ss;
  const code2 = after.find((s) => s !== code && (QD_CODE.test(s) || QUOTA_CODE.test(s))) ?? "";
  const ni = after.findIndex((s) => s !== code2 && /[一-龥]/.test(s) && !NUMERIC.test(s) && !UNITISH.test(s));
  const name = ni >= 0 ? after[ni] : "";
  const unit = ni >= 0
    ? (after.slice(ni + 1).find((s) => s.length <= 12 && UNITISH.test(s))
        ?? after.slice(ni + 1).find((s) => s.length <= 12 && !NUMERIC.test(s) && !/[\[\]【】]/.test(s))
        ?? "")
    : "";
  // 项目特征：含 名称/规格/材质 冒号清单式的长文本
  const spec = ss.find((s) => /名称|规格|材质|型号/.test(s) && /[：:]/.test(s) && s.length > 10) ?? "";
  return { code, code2, name, unit, spec };
}

function extractMaterials(row: Row): { name: string; unit: string; code: string }[] {
  const ss = row.strs.map((x) => x.s);
  const out: { name: string; unit: string; code: string }[] = [];
  for (let i = 0; i < ss.length && out.length < 12; i++) {
    if (!MAT_CODE.test(ss[i])) continue;
    const a = ss[i - 1] ?? "", b = ss[i - 2] ?? "";
    const okName = (s: string) => /[一-龥]/.test(s) && s.length <= 40 && !QD_CODE.test(s) && !QUOTA_CODE.test(s) && !UNITISH.test(s);
    if (UNITISH.test(a) && okName(b)) out.push({ name: b, unit: a, code: ss[i] });
    else if (okName(a)) out.push({ name: a, unit: "", code: ss[i] });
  }
  return out;
}

function parseStream(buf: Buffer, stream: string): QdItem[] {
  const rows = scanRows(buf);
  const items: QdItem[] = [];
  let section = "";
  let cur: QdItem | null = null;
  let curQuota: QuotaUse | null = null;
  for (const r of rows) {
    const f = fieldsOf(r);
    if (r.type === "段") {
      const nm = f.name || r.strs[0]?.s || "";
      if (nm && nm !== "小计") section = nm;
      cur = null; curQuota = null; continue;
    }
    if (r.type === "目") {
      if (!f.code && !f.name) { cur = null; curQuota = null; continue; }
      cur = {
        code: f.code || f.code2, code9: (f.code || f.code2).slice(0, 9),
        name: f.name, unit: f.unit, spec: f.spec,
        nums: r.nums.slice(0, 40), section, stream,
        quotas: [], pai: [],
      };
      items.push(cur); curQuota = null; continue;
    }
    if (r.type === "定") {
      if (!cur) continue;
      const conv = /换$|T$/.test(f.code) || /[\[【].*(单价|材料|管理费|利润|\*)/.test(f.name);
      cur.quotas.push({
        applied: f.code,
        code: (f.code2 || f.code).replace(/[换补T]+$/, ""),
        name: f.name.replace(/\s*[\[【][^\]】]*[\]】]\s*/g, "").trim(),
        unit: f.unit, conv,
        convNote: conv ? f.name : "",
        qty: r.nums.length ? r.nums[0] : null,
        nums: r.nums.slice(0, 40),
        materials: extractMaterials(r),
      });
      curQuota = cur.quotas[cur.quotas.length - 1];
      continue;
    }
    if (r.type === "派") {
      const nm = f.name || r.strs[0]?.s || "";
      if (nm) { if (cur) cur.pai.push(nm); }
      continue;
    }
  }
  return items;
}

// ---------- 文件遍历 ----------
async function parseFile(file: string): Promise<QdItem[]> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const items: QdItem[] = [];
  const entries = Object.keys(zip.files).filter((n) => /\/\d+$/.test(n));
  for (const name of entries) {
    const buf = await zip.files[name].async("nodebuffer");
    items.push(...parseStream(buf, name));
  }
  return items;
}

function* walk(dir: string): Generator<string> {
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name.toLowerCase())) yield* walk(p);
    } else if (EXTS.has(path.extname(e.name).toLowerCase())) yield p;
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const files = [...walk(ROOT)].sort();
  console.log(`扫描到 ${files.length} 个宏业文件（root=${ROOT}）`);

  const out = fs.createWriteStream(path.join(OUT, "usage.jsonl"));
  const stats = { files: 0, ok: 0, empty: 0, err: 0, qd: 0, quota: 0, conv: 0 };
  const seenFiles = new Set<string>();
  const errors: string[] = [];

  for (const f of files) {
    stats.files++;
    try {
      const st = fs.statSync(f);
      const fsig = crypto.createHash("sha1").update(f).update(String(st.size)).digest("hex");
      if (seenFiles.has(fsig)) continue;
      seenFiles.add(fsig);
      const items = await parseFile(f);
      if (!items.length) { stats.empty++; continue; }
      stats.ok++;
      const seenItem = new Set<string>(); // 文件内去重（SGCFX 送审/审定双树），跨文件保留以累计频次
      for (const it of items) {
        const isig = `${it.code}|${it.name}|${it.unit}|${it.quotas.map((q) => q.code).join(",")}`;
        if (seenItem.has(isig)) continue;
        seenItem.add(isig);
        stats.qd++;
        stats.quota += it.quotas.length;
        stats.conv += it.quotas.filter((q) => q.conv).length;
        out.write(JSON.stringify({ file: f, ...it }) + "\n");
      }
    } catch (e) {
      stats.err++;
      errors.push(`${f} :: ${(e as Error).message.slice(0, 120)}`);
    }
    if (stats.files % 50 === 0) console.log(`  …${stats.files}/${files.length} qd=${stats.qd} quota=${stats.quota}`);
  }
  out.end();
  fs.writeFileSync(path.join(OUT, "errors.log"), errors.join("\n"));
  console.log("完成:", JSON.stringify(stats));
  console.log(`输出: ${path.join(OUT, "usage.jsonl")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
