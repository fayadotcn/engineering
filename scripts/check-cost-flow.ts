// 端到端回归：隔离 SQLite + 生产构建（next start）上走真实 API，并在同库内直接调用 Agent 工具执行器。
// 前置：npm run build。
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { createServer } from "node:net";

async function main() {
  const root = process.cwd();
  const checkDir = path.join(root, ".verify", `e2e-${Date.now()}`);
  await mkdir(checkDir, { recursive: true });
  await writeFile(path.join(checkDir, "check.db"), "");
  process.env.DATABASE_URL = `file:${path.relative(path.join(root, "prisma"), path.join(checkDir, "check.db")).replaceAll("\\", "/")}`;
  process.env.STORAGE_DIR = path.join(checkDir, "storage");
  const setup = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { cwd: root, env: process.env, encoding: "utf8", windowsHide: true });
  if (setup.status !== 0) throw new Error(setup.stdout + setup.stderr);
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(3212, "127.0.0.1", () => probe.close(() => resolve())); });
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3212", "-H", "127.0.0.1"], { cwd: root, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "";
  server.stdout.on("data", value => { serverLog = (serverLog + value).slice(-4000); });
  server.stderr.on("data", value => { serverLog = (serverLog + value).slice(-4000); });
  const base = "http://127.0.0.1:3212";
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const request = async (url: string, method = "GET", body?: unknown, status = 200) => {
    const res = await fetch(base + url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json(); assert.equal(res.status, status, JSON.stringify(data)); return data;
  };
  const { prisma } = await import("../database/client");
  const { executeTool } = await import("../agent/executor");
  const { makeEmitter } = await import("../agent/events");
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) { try { ready = (await fetch(base + "/api/projects")).ok; if (ready) break; } catch {} await sleep(200); }
    assert(ready, serverLog);
    const project = await request("/api/projects", "POST", { name: "安装造价接口验收" });
    await request("/api/projects", "POST", { name: 23 }, 400);
    const id = project.id as string;
    await request(`/api/projects/${id}`, "PATCH", { name: "安装造价接口验收（改名）" });
    assert.equal((await request(`/api/projects/${id}`)).name, "安装造价接口验收（改名）");
    await request(`/api/projects/${id}`, "PATCH", { name: "  " }, 400);
    const runTool = async (tool: string, args: Record<string, unknown>) => {
      const run = await prisma.agentRun.create({ data: { projectId: id, userMessage: `验收：${tool}` } });
      const result = await executeTool({ projectId: id, runId: run.id, userId: "e2e", emit: makeEmitter(run.id) }, tool, args);
      assert(!(result.observation as { error?: string } | null)?.error, JSON.stringify(result.observation));
      return result.observation as Record<string, unknown>;
    };
    await request(`/api/projects/${id}/settings`, "PUT", { 地区: "四川", 价格期: "2026-09", 品牌: "上上", 管理费率: "0%", 利润率: "0%", 税率: "9%", 暂列金额率: "0.5%" });
    await request(`/api/projects/${id}/settings`, "PUT", { 税率: "101%" }, 400);
    const { getPricePrefs } = await import("../dataset/service");
    const prefs = await getPricePrefs(id);
    assert.equal(prefs.region, "四川"); assert.equal(prefs.period, "2026-09"); assert.equal(prefs.brands?.[0]?.value, "上上");

    const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("数据");
    sheet.addRow(["名称", "规格型号", "单位", "数量", "单价", "金额"]);
    sheet.addRow(["镀锌钢管", "DN100", "m", 10, 50, 500]);
    sheet.addRow(["镀锌钢管", "DN50", "m", 10, 30, 300]);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(await book.xlsx.writeBuffer())]), "用途待确认.xlsx");
    const uploaded = await fetch(`${base}/api/projects/${id}/files`, { method: "POST", body: form }).then(r => r.json());
    assert(uploaded.runId);
    let run;
    for (let i = 0; i < 100; i++) { run = await prisma.agentRun.findUniqueOrThrow({ where: { id: uploaded.runId } }); if (run.status !== "RUNNING") break; await sleep(100); }
    assert.equal(run?.status, "AWAITING_CONFIRM");
    const abort = new AbortController();
    const stream = await fetch(`${base}/api/runs/${uploaded.runId}/stream`, { signal: abort.signal });
    assert.equal(stream.status, 200); const reader = stream.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false); assert(!new TextDecoder().decode(first.value).includes('"run_finished"'));
    await request(`/api/files/${uploaded.file.id}/mapping`, "PATCH", { sheetName: "数据", type: "BOQ" });
    await request(`/api/runs/${uploaded.runId}/confirm`, "POST", {}, 400);
    await request(`/api/runs/${uploaded.runId}/confirm`, "POST", { approve: true });
    let finished = false;
    const timer = setTimeout(() => abort.abort(), 15000);
    try { for (;;) { const value = await reader.read(); if (value.done) break; if (new TextDecoder().decode(value.value).includes('"run_finished"')) finished = true; } }
    finally { clearTimeout(timer); }
    assert(finished, "SSE should remain connected through approval and completion");
    const items = await request(`/api/projects/${id}/boq`); assert.equal(items.filter((i: { isHeader: boolean }) => !i.isHeader).length, 2);
    const item = items.find((i: { isHeader: boolean }) => !i.isHeader);
    const edited = await request(`/api/boq-items/${item.id}`, "PATCH", { mainMaterialPrice: "12.50" });
    assert.equal(edited.item.unitPrice, item.unitPrice); assert.equal(edited.item.totalPrice, item.totalPrice); assert(edited.receiptId);
    const firstEdit = (await request(`/api/projects/${id}`)).receipts.find((r: { actionType: string }) => r.actionType === "USER_EDIT");
    await request(`/api/boq-items/${item.id}`, "PATCH", { name: "镀锌钢管核对后" });
    await request(`/api/receipts/${firstEdit.id}/revert`, "POST");
    let current = (await request(`/api/projects/${id}/boq`)).find((i: { id: string }) => i.id === item.id);
    assert.equal(current.mainMaterialPrice, "0"); assert.equal(current.name, "镀锌钢管核对后");
    await request(`/api/boq-items/${item.id}`, "PATCH", { unitPrice: "55" });
    const priceEdit = (await request(`/api/projects/${id}`)).receipts.find((r: { actionType: string }) => r.actionType === "USER_EDIT");
    await request(`/api/boq-items/${item.id}`, "PATCH", { unitPrice: "56" });
    await request(`/api/receipts/${priceEdit.id}/revert`, "POST", undefined, 409);
    await request(`/api/projects/${id}/settings`, "PUT", { 地区: "", 品牌: "" });
    const cleared = await getPricePrefs(id); assert.equal(cleared.region, undefined); assert.deepEqual(cleared.brands, []);

    assert("recentChanges" in await runTool("project.read", {}));
    const artifactId = (await runTool("report.exportExcel", {})).artifactId as string;
    const download = await fetch(`${base}/api/artifacts/${artifactId}/download`);
    assert.equal(download.status, 200);
    const exportedBook = new ExcelJS.Workbook();
    await exportedBook.xlsx.load(await download.arrayBuffer());
    // 首页固定「费用汇总」（R68 交付口径），清单明细页从第二页起
    assert.equal(exportedBook.worksheets[0].name, "费用汇总");
    // 明细页：表头 + 2 行明细 + 表尾「合价合计」复核行
    assert.equal(exportedBook.worksheets[1].rowCount, 4);
    assert.equal(exportedBook.worksheets[1].lastRow?.getCell(3).value, "合价合计");
    const summary = await request(`/api/projects/${id}/summary`);
    assert.equal(summary.fees.preTax, "864.30"); assert.equal(summary.fees.grandTotal, "942.09");

    const feeFile = await prisma.projectFile.create({ data: { projectId: id, filename: "措施清单.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", storageKey: "isolated-test", sizeBytes: 0, status: "PARSED", kind: "BOQ_TENDER" } });
    const feeItem = await prisma.boqItem.create({ data: { projectId: id, fileId: feeFile.id, sheetName: "数据", rowIndex: 2, name: "安全文明施工费", feeType: "总价措施", totalPrice: "1200.50", sortOrder: 100 } });
    const feeEdit = await request(`/api/boq-items/${feeItem.id}`, "PATCH", { totalPrice: "1500.555" });
    assert.equal(feeEdit.item.totalPrice, "1500.56"); assert.equal(feeEdit.item.unitPrice, "0"); assert.equal(feeEdit.item.quantity, "0");
    const feeReceipt = (await request(`/api/projects/${id}`)).receipts.find((r: { actionType: string; summary: string }) => r.actionType === "USER_EDIT" && r.summary.includes("安全文明施工费"));
    assert(feeReceipt);
    await request(`/api/boq-items/${feeItem.id}`, "PATCH", { unitPrice: "20" }, 400);
    await request(`/api/boq-items/${feeItem.id}`, "PATCH", { quantity: "1" }, 400);
    await request(`/api/boq-items/${feeItem.id}`, "PATCH", { totalPrice: "NaN" }, 400);
    await request(`/api/boq-items/${item.id}`, "PATCH", { totalPrice: "999" }, 400);
    const withFee = await request(`/api/projects/${id}/summary`);
    assert.equal(withFee.fees.preTax, "2364.86"); assert.equal(withFee.fees.grandTotal, "2577.70");
    await request(`/api/receipts/${feeReceipt.id}/revert`, "POST");
    assert.equal((await request(`/api/projects/${id}/boq`)).find((i: { id: string }) => i.id === feeItem.id).totalPrice, "1200.5");

    await runTool("boq.update", { patches: [{ id: feeItem.id, totalPrice: "1400" }] });
    assert.equal((await request(`/api/projects/${id}/boq`)).find((i: { id: string }) => i.id === feeItem.id).totalPrice, "1400");
    const feeExportId = (await runTool("report.exportExcel", {})).artifactId as string;
    const feeExport = new ExcelJS.Workbook(); await feeExport.xlsx.load(await fetch(`${base}/api/artifacts/${feeExportId}/download`).then(r => r.arrayBuffer()));
    assert.deepEqual(feeExport.worksheets.map(s => s.name), ["费用汇总", "数据", "数据 (2)"]);
    // 导出列序：…工程量(F) 计算式(G) 综合单价(H) 合价(I) 主材暂估价(J) 定价状态(K) 费用类别(L) 单位工程(M) 源文件(N)
    assert.equal(feeExport.worksheets[2].getCell("I2").value, 1400);
    assert.equal(feeExport.worksheets[2].getCell("L2").value, "总价措施");
    assert.equal(feeExport.worksheets[2].getCell("N2").value, "措施清单.xlsx");
    console.log("PASS: 映射确认与 SSE、设置取价、主材价格语义、撤销冲突保护、费用复核、Agent 工具执行、总额编辑与撤销、同名源表 Excel 导出");
    console.log(`隔离验收工程：${checkDir}`);
  } finally { await prisma.$disconnect(); server.kill(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
