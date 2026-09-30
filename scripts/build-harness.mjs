import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
await build({
  absWorkingDir: root,
  entryPoints: ["harness/plugin/host.ts"],
  outfile: "harness/plugin/dist/host.mjs",
  bundle: true, platform: "node", format: "esm", packages: "external", target: "node22",
  tsconfig: "tsconfig.json",
});
await build({
  absWorkingDir: root,
  entryPoints: ["harness/plugin/client.tsx"],
  outfile: "harness/plugin/dist/client.js",
  bundle: true, platform: "browser", format: "cjs", target: "es2022", jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  banner: { js: 'window.__ModuleLoader__.load({id:"@zaojia/installation-harness",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: "return module.exports;}});" },
});
console.log("Harness 安装造价插件已构建");
