import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import nextEnv from "@next/env";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
nextEnv.loadEnvConfig(root);
const development = process.argv.includes("--dev");
const env = { ...process.env, DSH_HOME: path.join(root, ".harness") };
await mkdir(env.DSH_HOME, { recursive: true });
const children = [];
const launch = (file, args, harness = false) => {
  const child = spawn(process.execPath, [file, ...args], { cwd: root, env, stdio: harness ? ["inherit", "pipe", "inherit"] : "inherit", windowsHide: true });
  if (harness) {
    let buffer = "";
    child.stdout.on("data", chunk => {
      process.stdout.write(chunk);
      buffer += chunk.toString();
      const url = buffer.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/)?.[1];
      if (url) { void writeFile(path.join(env.DSH_HOME, "web.url"), url); buffer = ""; }
    });
  }
  children.push(child);
  child.on("error", error => { console.error(error.message); shutdown(1); });
  child.on("exit", code => shutdown(code ?? 1));
  return child;
};
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

const build = spawn(process.execPath, ["scripts/build-harness.mjs"], { cwd: root, env, stdio: "inherit", windowsHide: true });
await new Promise((resolve, reject) => { build.on("exit", code => code === 0 ? resolve() : reject(new Error("造价插件构建失败"))); build.on("error", reject); });
launch("node_modules/next/dist/bin/next", [development ? "dev" : "start", "-p", "3211", "-H", "127.0.0.1"]);
// The official CLI owns the actual Harness application and its profile.
launch("node_modules/@deepseek-ai/dsh/lib/bin.js", ["web", "--patch", "harness/cordis.patch.yml", "--no-open", "--port", "3210"], true);
