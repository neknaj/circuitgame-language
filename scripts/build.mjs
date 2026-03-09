import * as fs from "node:fs/promises";
import * as path from "node:path";
import esbuild from "esbuild";

const rootPath = new URL("..", import.meta.url).pathname;
const outDir = path.join(rootPath, "out");

await fs.rm(outDir, { recursive: true, force: true });

await Promise.all([
  esbuild.build({
    entryPoints: [path.join(rootPath, "src/client/extension.ts")],
    outfile: path.join(outDir, "client/extension.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: ["node18"],
    external: ["vscode"],
  }),
  esbuild.build({
    entryPoints: [path.join(rootPath, "src/server/server.ts")],
    outfile: path.join(outDir, "server/server.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: ["node18"],
  }),
]);
