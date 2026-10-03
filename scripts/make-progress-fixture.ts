import ExcelJS from "exceljs";
import { mkdir } from "fs/promises";
import path from "path";

// 进度申报 fixture：表-03 + 表-04×3 + 表-08，编码与「水电安装.xls」真实项重叠
// （量差=完成量、价差、仅B新增项、>15%量差），供「本期 vs 上期」对审 E2E。

const num = (s: string) => s.replace(/,/g, "");

async function main() {
  const out = path.resolve("fixtures/out");
  await mkdir(out, { recursive: true });
  const wb = new ExcelJS.Workbook();

  // 1) 表-03：单位工程名单 + 申报金额
  const t03 = wb.addWorksheet("1.1 表-03 单项工程投标报价汇总表");
  t03.addRow(["水电安装工程 2025年9月进度申报"]);
  t03.addRow([]);
  t03.addRow(["序号", "单位工程名称", "金额（元）"]);
  t03.addRow(["1", "室外排水工程", "1450000.00"]);
  t03.addRow(["2", "H01综合楼安装工程", "380000.00"]);
  t03.addRow(["3", "H09二期管网工程", "120000.00"]);
  t03.addRow(["4", "合计", "1950000.00"]);

  // 2) 表-04 ×3：每单位工程一张，标签|金额
  const units: [string, number, number, number][] = [
    ["室外排水工程", 1180000, 30000, 1450000],
    ["H01综合楼安装工程", 305000, 9500, 380000],
    ["H09二期管网工程", 96000, 2800, 120000],
  ];
  units.forEach(([name, fbf, gf, hj], i) => {
    const ws = wb.addWorksheet(`${i + 2}.1 表-04 单位工程投标报价汇总表`);
    ws.addRow([`${name} 投标报价汇总表`]);
    ws.addRow(["序号", "汇总内容", "金额（元）"]);
    ws.addRow(["1", "分部分项工程费", String(fbf)]);
    ws.addRow(["2", "措施项目费", String(Math.round(fbf * 0.05))]);
    ws.addRow(["3", "其他项目费", "0"]);
    ws.addRow(["4", "规费", String(gf)]);
    const taxBase = fbf + Math.round(fbf * 0.05) + gf;
    ws.addRow(["5", "税金", String(Math.round(taxBase * 0.09))]);
    ws.addRow(["6", "合计", String(hj)]);
  });

  // 3) 表-08：清单行（编码与真实文件重叠 → 量差/价差/仅B）
  const t08 = wb.addWorksheet("4.1 表-08 分部分项工程和单价措施项目清单与计价表");
  t08.addRow(["室外排水工程 分部分项工程量清单与计价表"]);
  t08.addRow([]);
  t08.addRow(["序号", "项目编码", "项目名称", "项目特征", "计量单位", "工程量", "综合单价", "合价"]);
  const rows: (string | number)[][] = [
    ["1", "040501004001", "塑料管", "1、DN200雨水边井连接管\n2、HDPE双壁缠绕管，环刚度≥8.0kpa", "m", 620, 79.42],
    ["2", "040501004008", "塑料管", "1、DN300HDPE双壁缠绕管，环刚度≥8.0kpa", "m", 982.5, 58.12],
    ["3", "040501004002", "塑料管", "1、DN400HDPE双壁缠绕管，环刚度≥8.0kpa", "m", 416.99, 88.5], // 价差
    ["4", "040501004005", "塑料管", "1、DN800HDPE双壁缠绕管，环刚度≥8.0kpa", "m", 220, 292.78],  // 量差 +24%
    ["5", "040501004003", "塑料管", "1、DN500HDPE双壁缠绕管，环刚度≥8.0kpa", "m", 268.24, 175.27],
    ["6", "040504002001", "混凝土井", "1、ф1000mm现浇C30混凝土井，井深H=2M内", "座", 95, 2236.1],
    ["7", "040504009001", "模块式检查井", "1、ф700模块式检查井 新增段", "座", 18, 1560.0],           // 仅B
  ];
  for (const r of rows) {
    const row = t08.addRow(r);
    row.getCell(8).value = Math.round(Number(r[5]) * Number(r[6]) * 100) / 100;
  }

  const file = path.join(out, "水电安装-2025年9月进度申报.xlsx");
  await wb.xlsx.writeFile(file);
  console.log("written:", file);
}
main().catch((e) => { console.error(e); process.exit(1); });
