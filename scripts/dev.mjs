import { context } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "artifacts", "dev");
await mkdir(output, { recursive: true });
const build = await context({ absWorkingDir: root, entryPoints: ["src/dev.tsx"], outfile: path.join(output, "ui.js"),
  bundle: true, platform: "browser", format: "esm", target: "es2022", jsx: "automatic", loader: { ".css": "text" },
  legalComments: "linked" });
try {
  const server = await build.serve({ host: "127.0.0.1", port: 4174, servedir: output,
    fallback: path.join(root, "scripts", "dev-index.html") });
  console.log(`SPS Builder UI Preview: http://127.0.0.1:${server.port}/ (Core/AI not connected)`);
  const stop = async () => { await build.dispose(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) { await build.dispose(); throw error; }
