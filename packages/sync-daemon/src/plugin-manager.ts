import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  AgentInstanceConfig,
  DeliverRequest,
  ExportNativeRequest,
  ImportRequest,
  PluginCapabilities,
  PluginMetadata,
  PluginSpec,
} from "@pi-agent-hub/protocol";
import { RpcClient, expandHome } from "@pi-agent-hub/sync-plugin-sdk";
import type { Logger } from "./logger.js";

const execFileAsync = promisify(execFile);

export interface ResolvedPlugin {
  spec: PluginSpec;
  packageDir: string;
  packageName: string;
  version: string;
  metadata: PluginMetadata;
  binPath: string;
}

export interface AgentRuntime {
  agentId: string;
  kind: string;
  instanceId: string;
  displayName: string;
  homeDir: string;
  plugin: ResolvedPlugin;
  client: RpcClient;
  capabilities: PluginCapabilities;
}

interface PackageJson {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
  piAgentHub?: PluginMetadata;
}

export class PluginManager {
  private readonly runtimes: AgentRuntime[] = [];
  private readonly requireFromRoot: NodeJS.Require;

  constructor(
    private readonly options: {
      pluginRoot: string;
      pluginInstall: boolean;
      allowlist: string[];
      agents: Record<string, { options?: Record<string, unknown>; instances?: AgentInstanceConfig[] }>;
      hostId: string;
      logger: Logger;
    },
  ) {
    this.requireFromRoot = createRequire(join(options.pluginRoot, "package.json"));
  }

  async start(specs: readonly (string | PluginSpec)[]): Promise<void> {
    for (const raw of specs) {
      const spec: PluginSpec = typeof raw === "string" ? { package: raw } : raw;
      const resolved = await this.resolve(spec);
      const instance = this.options.agents[resolved.metadata.kind]?.instances?.[0] ?? { name: "default" };
      const agentId = stableAgentId(this.options.hostId, resolved.metadata.kind, instance.name);
      const client = new RpcClient({
        command: process.execPath,
        args: [resolved.binPath],
        onLog: (line) => void this.options.logger.info(`[${resolved.metadata.kind}] ${line}`),
      });
      await client.request("initialize", {
        protocolVersion: "1.0",
        daemonVersion: "0.1.0",
        hostId: this.options.hostId,
        agentId,
        kind: resolved.metadata.kind,
        workDir: join(this.options.pluginRoot, ".work", resolved.metadata.kind),
        config: {
          options: { ...this.options.agents[resolved.metadata.kind]?.options, ...spec.options },
          instance,
        },
      }, 20_000);

      const detected = await client.request<{ instances: Array<{ instanceId: string; displayName: string; homeDir: string }> }>(
        "detect",
        {},
        20_000,
      );
      const detectedInstance = detected.instances[0] ?? { instanceId: agentId, displayName: instance.name, homeDir: "" };
      this.runtimes.push({
        agentId,
        kind: resolved.metadata.kind,
        instanceId: detectedInstance.instanceId,
        displayName: detectedInstance.displayName,
        homeDir: detectedInstance.homeDir,
        plugin: resolved,
        client,
        capabilities: resolved.metadata.capabilities,
      });
      await this.options.logger.info("plugin ready", { kind: resolved.metadata.kind, version: resolved.version });
    }
  }

  list(): readonly AgentRuntime[] {
    return this.runtimes;
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.runtimes.map((runtime) => runtime.client.close()));
  }

  private async resolve(spec: PluginSpec): Promise<ResolvedPlugin> {
    if (isLocal(spec.package)) {
      const dir = expandHome(spec.package);
      const pkg = await readPackageJson(join(dir, "package.json"));
      return this.toResolved(spec, dir, pkg);
    }

    const name = packageNameOf(spec.package);
    const candidates = [this.options.pluginRoot, process.cwd()];
    for (const base of candidates) {
      const dir = await this.tryResolve(name, base);
      if (dir) return this.toResolved(spec, dir, await readPackageJson(join(dir, "package.json")));
    }

    if (!this.options.pluginInstall) {
      throw new Error(`plugin not installed: ${name}`);
    }
    if (!this.allowed(name)) throw new Error(`plugin not allowed: ${name}`);
    await this.install(spec.package);
    const dir = await this.tryResolve(name, this.options.pluginRoot);
    if (!dir) throw new Error(`plugin install failed: ${name}`);
    return this.toResolved(spec, dir, await readPackageJson(join(dir, "package.json")));
  }

  private async tryResolve(name: string, base: string): Promise<string | undefined> {
    try {
      // 从 base 向上逐级找 <base>/node_modules/<name>/package.json。
      // 不依赖 require.resolve：插件的 package.json 声明了 exports（未导出 ./package.json 子路径），
      // 标准 resolve('<pkg>/package.json') 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED 而解析失败。
      let dir = resolve(base);
      for (;;) {
        const candidate = join(dir, "node_modules", name);
        if (existsSync(join(candidate, "package.json"))) {
          return candidate;
        }
        const parent = dirname(dir);
        if (parent === dir) {
          return undefined;
        }
        dir = parent;
      }
    } catch {
      return undefined;
    }
  }

  private async install(packageSpec: string): Promise<void> {
    await mkdir(this.options.pluginRoot, { recursive: true });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    await execFileAsync(npm, [
      "install",
      "--prefix",
      this.options.pluginRoot,
      "--save-exact",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      packageSpec,
    ], { cwd: this.options.pluginRoot });
  }

  private toResolved(spec: PluginSpec, dir: string, pkg: PackageJson): ResolvedPlugin {
    if (!pkg.name || !pkg.version || !pkg.piAgentHub) {
      throw new Error(`invalid plugin package (missing name/version/piAgentHub): ${dir}`);
    }
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin ? Object.values(pkg.bin)[0] : undefined;
    if (!bin) throw new Error(`plugin package has no bin: ${pkg.name}`);
    return {
      spec,
      packageDir: dir,
      packageName: pkg.name,
      version: pkg.version,
      metadata: pkg.piAgentHub,
      binPath: resolve(dir, bin),
    };
  }

  private allowed(name: string): boolean {
    return this.options.allowlist.some((entry) => {
      if (entry.endsWith("/*")) return name.startsWith(entry.slice(0, -1));
      return entry === name;
    });
  }
}

export async function readPackageJson(path: string): Promise<PackageJson> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null) throw new Error(`invalid package.json: ${path}`);
  return value as PackageJson;
}

export function stableAgentId(hostId: string, kind: string, instanceName: string): string {
  const hash = createHash("sha256").update(`${hostId}\0${kind}\0${instanceName}`).digest("base64url");
  return `a_${hash.slice(0, 26).toLowerCase()}`;
}

function isLocal(value: string): boolean {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || /^[A-Za-z]:[\\/]/.test(value);
}

function packageNameOf(spec: string): string {
  const at = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.indexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

import { createHash } from "node:crypto";
