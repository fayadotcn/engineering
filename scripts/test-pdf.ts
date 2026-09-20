import { extractPdfText, detectBoqLines } from "../file/pdf";
import { readFileSync } from "fs";

(async () => {
  const buf = readFileSync("fixtures/out/test_boq.pdf");
  const pages = await extractPdfText(buf);
  console.log("pages:", pages.length);
  console.log("---page0---");
  console.log(pages[0]);
  console.log("---lines---");
  const lines = detectBoqLines(pages);
  console.log("boq lines:", lines.length);
  lines.forEach((l) => console.log(l.code, "|", l.name, "|", l.feature, "|", l.unit, l.quantity, l.unitPrice, l.totalPrice));
  process.exit(0);
})().catch((e) => {
  console.log("ERR", e);
  process.exit(1);
});
