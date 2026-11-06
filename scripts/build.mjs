import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildPluginWorker } from "@sonparkserver/plugin-sdk/authoring/worker-bundle-v1.mjs";
import { calculateStaticCapabilitiesDigest, validateStaticPluginManifest } from "@sonparkserver/plugin-sdk/registry/static-package-manifest-v1.mjs";
import { resolveDeclaredSdkRevision } from "./build-sdk-revision.mjs";
import manifest from "../src/manifest.mjs";
import { hostReactCommonJs } from "./host-react-commonjs.mjs";

const root = path.resolve(import.meta.dirname, "..");
const [packageJson, packageLock] = await Promise.all([
  readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "package-lock.json"), "utf8").then(JSON.parse),
]);
const sdkRevision = resolveDeclaredSdkRevision(packageJson, packageLock);
await mkdir(path.join(root, "dist"), { recursive: true });
await buildPluginWorker({ sourceDirectory: root });
await build({ absWorkingDir: root, entryPoints: ["src/manifest.mjs"], outfile: "dist/manifest.js", bundle: true,
  format: "esm", platform: "node", target: "node22", legalComments: "linked" });
const ui = await build({ absWorkingDir: root, entryPoints: ["src/ui/index.tsx"], outfile: "dist/ui-v0.1.0/index.js", bundle: true,
  format: "esm", platform: "browser", target: "es2022", loader: { ".css": "text" }, jsx: "automatic",
  external: ["react-dom", "react-dom/client", "react/jsx-runtime", "@sonparkserver/plugin-sdk/ui/bridge"],
  plugins: [hostReactCommonJs(), { name: "external-host-react", setup(build) {
    build.onResolve({ filter: /^react$/ }, () => ({ path: "react", external: true }));
  } }], legalComments: "linked", metafile: true });

// Include full upstream license/notice files, including the SDK bundled in the Worker.
const bundledPackages = new Set(["@sonparkserver/plugin-sdk"]);
for (const input of Object.keys(ui.metafile.inputs)) {
  const parts = input.replaceAll("\\", "/").split("/");
  const offset = parts.lastIndexOf("node_modules") + 1;
  if (offset === 0) continue;
  bundledPackages.add(parts[offset].startsWith("@") ? `${parts[offset]}/${parts[offset + 1]}` : parts[offset]);
}
for (const name of [...bundledPackages].sort()) {
  const packageRoot = path.join(root, "node_modules", name);
  const notices = (await readdir(packageRoot)).filter(file => /^(?:licen[cs]e|copying|notice)(?:\.[a-z0-9-]+)?$/i.test(file));
  if (notices.length === 0) throw new Error(`No upstream license/notice found for bundled package ${name}.`);
  const output = path.join(root, "dist", "third-party-notices", name);
  await mkdir(output, { recursive: true });
  for (const file of notices.sort()) await copyFile(path.join(packageRoot, file), path.join(output, file));
}
const bytes = await readFile(path.join(root, "dist/manifest.js"));
const declarative = {
  schemaVersion: 1,
  plugin: { id: manifest.id, version: manifest.version, apiVersion: "1" },
  runtime: { manifestEntry: "dist/manifest.js", manifestSha256: createHash("sha256").update(bytes).digest("hex") },
  capabilities: [...manifest.capabilities].sort(),
  permissionsDigest: calculateStaticCapabilitiesDigest(manifest.capabilities),
};
validateStaticPluginManifest(declarative);
await writeFile(path.join(root, "sps-plugin.json"), `${JSON.stringify(declarative, null, 2)}\n`);
// This reports matching manifest and lockfile pins, not attested installed SDK bytes.
console.log(JSON.stringify({ builderBuild: "completed", pluginId: manifest.id, sdkRevision, coreHostTested: false }));
