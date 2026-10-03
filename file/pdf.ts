// PDF text extraction + best-effort BOQ line detection.
// Text layer grouping: y-coordinate buckets -> ordered lines.

export async function extractPdfText(buffer: Buffer): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // group items into lines by rounded y
    const lines = new Map<number, { x: number; t: string }[]>();
    for (const it of tc.items as { str?: string; transform?: number[] }[]) {
      if (!it.str?.trim() || !it.transform) continue;
      const y = Math.round(it.transform[5] / 2) * 2;
      const arr = lines.get(y) ?? [];
      arr.push({ x: it.transform[4], t: it.str });
      lines.set(y, arr);
    }
    const ordered = [...lines.entries()]
      .sort((a, b) => b[0] - a[0]) // pdf y grows upward
      .map(([, items]) =>
        items.sort((a, b) => a.x - b.x).map((i) => i.t).join(" ")
      );
    pages.push(ordered.join("\n"));
  }
  return pages;
}

// BOQ-ish line: 9-15位编码 + 名称 + (可选特征) + 单位 + 数量 + 单价 + 合价
// 特征组必须可选：招标 PDF 的特征列常为空（「配电箱 台 2 8500.00 17000.00」），
// 必填会把整行静默漏掉。内层懒惰匹配让有特征的行照常归入特征组。
const BOQ_LINE =
  /(\d{9,15})\s+([^\s\d][^\d]{1,40}?)\s+(?:(\S.{0,50}?)\s+)?(m2|m3|m²|m³|㎡|m|米|个|套|台|根|块|组|处|点|只|条|盏|座|宗|项|件|箱|卷|樘|面|付|pcs|kg|km|t|吨|系统|回路|工日|台班|延米|次)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d{0,2})\s+([\d,]+\.?\d{0,2})(?:\s|$)/;

export interface PdfBoqLine {
  line: number; // global line index
  code: string;
  name: string;
  feature: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  totalPrice: string;
}

export function detectBoqLines(pages: string[]): PdfBoqLine[] {
  const out: PdfBoqLine[] = [];
  let lineNo = 0;
  for (const page of pages) {
    for (const line of page.split("\n")) {
      lineNo++;
      const m = line.match(BOQ_LINE);
      if (!m) continue;
      out.push({
        line: lineNo,
        code: m[1],
        name: m[2].trim(),
        feature: (m[3] ?? "").trim(),
        unit: m[4],
        quantity: m[5].replace(/,/g, ""),
        unitPrice: m[6].replace(/,/g, ""),
        totalPrice: m[7].replace(/,/g, ""),
      });
    }
  }
  return out;
}
