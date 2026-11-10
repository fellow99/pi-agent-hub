#!/usr/bin/env node
// assemble-resources.mjs — 跨平台安装包资源组装（FR-301-027~031）
// 用法: node packages/sync-daemon-tray/scripts/assemble-resources.mjs --target win-x64|darwin-arm64|darwin-x64
// 产出: src-tauri/resources/{node, sync-daemon-starter.js, node_modules/@pi-agent-hub/*, bundle-manifest.json}
//
// 说明：@pi-agent-hub 全部运行时包仅依赖内部 @pi-agent-hub/* 包（无外部运行时依赖），
//       故 node_modules 直接复制各包 dist/package.json 即可，无需 npm registry 参与。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "v26.13.0";
const TARGETS = {
  "win-x64": { ext: "zip" },
  "darwin-arm64": { ext: "tar.gz" },
  "darwin-x64": { ext: "tar.gz" },
};
// 运行时包清单（@pi-agent-hub/* 内部包）
const PACKAGES = [
  "protocol",
  "pi-session",
  "sync-plugin-sdk",
  "sync-daemon",
  "sync-plugin-pi-agent",
  "sync-plugin-opencode",
  "sync-plugin-dsh",
];

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // packages/sync-daemon-tray
const RESOURCES_DIR = join(PACKAGE_DIR, "src-tauri", "resources");
const PACKAGES_ROOT = resolve(PACKAGE_DIR, ".."); // packages
const REPO_ROOT = resolve(PACKAGES_ROOT, ".."); // pi-agent-hub

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sh(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }).trim();
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return response.text();
}

async function main() {
  const target = arg("--target");
  if (!target || !TARGETS[target]) {
    process.stderr.write("usage: node assemble-resources.mjs --target <win-x64|darwin-arm64|darwin-x64>\n");
    process.exit(2);
  }
  const { ext } = TARGETS[target];
  const archive = `node-${NODE_VERSION}-${target}.${ext}`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${archive}`;

  // 1) 下载 Node v26.13.0 并做 SHA256 校验
  console.log(`[1/4] downloading ${url}`);
  const archiveBytes = await fetchBuffer(url);
  const shasums = await fetchText(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`);
  const expected = shasums
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(archive))?.split(/\s+/)[0];
  if (!expected) throw new Error(`cannot find ${archive} in SHASUMS256.txt`);
  const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
  if (sha256 !== expected) {
    throw new Error(`SHA256 mismatch for ${archive}: expected ${expected}, got ${sha256}`);
  }
  console.log(`     sha256 ok: ${sha256}`);

  // 2) 清理并解压到 resources/node
  rmSync(RESOURCES_DIR, { recursive: true, force: true });
  mkdirSync(RESOURCES_DIR, { recursive: true });
  const archivePath = join(RESOURCES_DIR, archive);
  writeFileSync(archivePath, archiveBytes);
  const extractDir = mkdtempSync(join(tmpdir(), "pi-hub-node-"));
  console.log(`[2/4] extracting to ${join(RESOURCES_DIR, "node")}`);
  try {
    if (ext === "zip") {
      if (process.platform === "win32") {
        sh("powershell", [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${extractDir}' -Force`,
        ]);
      } else {
        sh("unzip", ["-q", archivePath, "-d", extractDir]);
      }
    } else {
      sh("tar", ["-xzf", archivePath, "-C", extractDir]);
    }
    const inner = join(extractDir, `node-${NODE_VERSION}-${target}`);
    if (!existsSync(inner)) throw new Error(`expected extracted dir missing: ${inner}`);
    cpSync(inner, join(RESOURCES_DIR, "node"), { recursive: true });
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
  rmSync(archivePath, { force: true });

  // 3) 复制 starter 与 node_modules
  console.log("[3/4] assembling starter + node_modules");
  cpSync(join(PACKAGE_DIR, "sync-daemon-starter.js"), join(RESOURCES_DIR, "sync-daemon-starter.js"));
  const nmRoot = join(RESOURCES_DIR, "node_modules", "@pi-agent-hub");
  for (const pkg of PACKAGES) {
    const src = join(PACKAGES_ROOT, pkg);
    const dest = join(nmRoot, pkg);
    mkdirSync(dest, { recursive: true });
    for (const file of ["package.json", "dist"]) {
      const from = join(src, file);
      if (existsSync(from)) cpSync(from, join(dest, file), { recursive: true });
    }
  }

  // 4) bundle-manifest.json
  console.log("[4/4] writing bundle-manifest.json");
  const packages = {};
  for (const pkg of PACKAGES) {
    const meta = JSON.parse(readFileSync(join(PACKAGES_ROOT, pkg, "package.json"), "utf8"));
    packages[meta.name] = meta.version;
  }
  writeFileSync(
    join(RESOURCES_DIR, "bundle-manifest.json"),
    JSON.stringify(
      { node: { version: NODE_VERSION, archive, sha256 }, packages, target, assembledAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log("done. resources at", RESOURCES_DIR);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
