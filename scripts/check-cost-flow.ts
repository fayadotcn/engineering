// Real API + official Harness tool-runtime regression on an isolated SQLite DB.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { Context } from "@deepseek-ai/cordis";
import { createServer } from "node:net";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";

async function main() {
  const root = process.cwd();
  const checkDir = path.join(root, ".harness", `verification-${Date.now()}`);
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
  const cordis = new Context();
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) { try { ready = (await fetch(base + "/api/projects")).ok; if (ready) break; } catch {} await sleep(200); }
    assert(ready, serverLog);
    const project = await request("/api/projects", "POST", { name: "安装造价接口验收" });
    await request("/api/projects", "POST", { name: 23 }, 400);
    const id = project.id as string;
    const sessionId = "session-36d1b1c7-2505-45f3-b31e-2c7bfc052c21";
    await request(`/api/projects/${id}`, "PATCH", { harnessSessionId: sessionId });
    assert.equal((await request(`/api/projects/${id}`)).harnessSessionId, sessionId);
    await request(`/api/projects/${id}`, "PATCH", { harnessSessionId: "invalid-session" }, 400);
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
    assert.equal(edited.unitPrice, item.unitPrice); assert.equal(edited.totalPrice, item.totalPrice);
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

    await cordis.plugin(SystemPrompt); await cordis.plugin(ToolRuntime, { mode: "native" });
    const { apply } = await import(pathToFileURL(path.join(root, "harness/plugin/dist/host.mjs")).href) as { apply(ctx: Context, config: { businessUrl: string }): void };
    apply(cordis, { businessUrl: base });
    const result = await cordis.tools.execute({ name: "installation__project__read", arguments: { projectId: id }, callId: "cost-verification" as never, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert(result.content.some(c => c.type === "text" && c.text.includes("recentChanges")));
    const exported = await cordis.tools.execute({ name: "installation__report__exportExcel", arguments: { projectId: id }, callId: "cost-export" as never, signal: new AbortController().signal });
    assert.equal(exported.isError, false, JSON.stringify(exported.content));
    const exportText = exported.content.find(c => c.type === "text");
    assert(exportText?.type === "text");
    const artifactId = JSON.parse(exportText.text).observation.artifactId;
    const download = await fetch(`${base}/api/artifacts/${artifactId}/download`);
    assert.equal(download.status, 200);
    const exportedBook = new ExcelJS.Workbook();
    await exportedBook.xlsx.load(await download.arrayBuffer());
    assert.equal(exportedBook.worksheets[0].rowCount, 3);
    const summary = await request(`/api/projects/${id}/summary`);
    assert.equal(summary.fees.preTax, "864.30"); assert.equal(summary.fees.grandTotal, "942.09");
    console.log("PASS: 映射确认与 SSE、设置取价、主材价格语义、撤销冲突保护、费用复核、官方 Harness 工具执行、真实 Excel 导出");
    console.log(`隔离验收工程：${checkDir}`);
  } finally { await cordis.fiber.dispose(); await prisma.$disconnect(); server.kill(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
