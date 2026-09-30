import { readFile } from "node:fs/promises";
import path from "node:path";

// dsh web 的登录 token 每次启动都会换，窗口一关就找不回来了。
// 启动脚本把它写在 .harness/web.url，这里把它读出来。
const file = path.join(process.cwd(), ".harness", "web.url");
try {
  const url = (await readFile(file, "utf8")).trim();
  console.log(url);
  console.log("\n打开上面这条（带 token）即可登录；登录后 30 天内直接开 http://127.0.0.1:3210 就行，重启服务也不用重新登录。");
} catch {
  console.error("还没有启动过 Harness。先运行 npm run dev，地址会写进 .harness/web.url。");
  process.exitCode = 1;
}
