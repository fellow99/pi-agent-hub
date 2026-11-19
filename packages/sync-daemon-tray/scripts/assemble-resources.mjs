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
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  "sync-plugin-pi-cli",
  "sync-plugin-opencode-serve",
  "sync-plugin-opencode-cli",
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

/** 捕获 stderr 的 sh：失败时把 stderr/stdout 拼进错误，便于 CI 定位。 */
function shCapture(cmd, args, opts) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim().slice(-2000) : "";
    const stdout = error && error.stdout ? String(error.stdout).trim().slice(-1000) : "";
    const code = error && typeof error.status === "number" ? error.status : (error && error.code) || "?";
    const detail = [stderr, stdout].filter(Boolean).join(" | ");
    throw new Error(`${cmd} ${args.join(" ")} failed (code=${code})${detail ? `: ${detail}` : ""}`);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 解压 Node 归档（zip/tar.gz）。
 * Windows 上 PowerShell Expand-Archive 在 CI 偶发静默失败（解压后目标目录不存在），
 * 因此优先用系统自带 bsdtar（C:\Windows\System32\tar.exe，原生支持 zip），
 * 再回退 PowerShell .NET ZipFile。两次尝试间歇重试，失败信息带 stderr。
 */
function extractArchive(archivePath, extractDir, ext) {
  const attempts = [];
  if (ext === "zip" && process.platform === "win32") {
    const systemTar = "C:\\Windows\\System32\\tar.exe";
    attempts.push({ label: "system-tar", run: () => shCapture(systemTar, ["-xf", archivePath, "-C", extractDir]) });
    attempts.push({
      label: "pwsh-zipfile",
      run: () => shCapture("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
          `[System.IO.Compression.ZipFile]::ExtractToDirectory('${archivePath}', '${extractDir}')`,
      ]),
    });
  } else if (ext === "zip") {
    attempts.push({ label: "unzip", run: () => shCapture("unzip", ["-q", "-o", archivePath, "-d", extractDir]) });
  } else {
    attempts.push({ label: "tar", run: () => shCapture("tar", ["-xzf", archivePath, "-C", extractDir]) });
  }

  const errors = [];
  for (const attempt of attempts) {
    for (let round = 1; round <= 2; round += 1) {
      try {
        attempt.run();
        return attempt.label;
      } catch (error) {
        errors.push(`[${attempt.label} #${round}] ${error instanceof Error ? error.message : String(error)}`);
        rmSync(extractDir, { recursive: true, force: true });
        mkdirSync(extractDir, { recursive: true });
        if (round === 1) sleepSync(1500);
      }
    }
  }
  throw new Error(`extract failed for ${archivePath}:\n  - ${errors.join("\n  - ")}`);
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
  // 解压目录放 workspace 内（长路径 D:\a\…），避免系统 Temp 的 8.3 短路径
  // （C:\Users\RUNNER~1\…）导致 PowerShell Expand-Archive 目标解析不一致。
  const extractDir = join(RESOURCES_DIR, ".node-extract");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  console.log(`[2/4] extracting to ${join(RESOURCES_DIR, "node")}`);
  try {
    const via = extractArchive(archivePath, extractDir, ext);
    const inner = join(extractDir, `node-${NODE_VERSION}-${target}`);
    if (!existsSync(inner)) {
      const listed = existsSync(extractDir) ? readdirSync(extractDir).slice(0, 10).join(", ") : "(extract dir missing)";
      throw new Error(`expected extracted dir missing: ${inner} (via=${via}; entries: ${listed})`);
    }
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
