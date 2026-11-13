# 401-sync-daemon-sync-workspace Technical Plan（sync-daemon 实现方案）

> Corresponding spec: ./spec.md · 上游：005-sync-workspace/plan.md
> Last Updated: 2026-11-13

## 1. 技术上下文

- daemon 主机进程（本机 Node 24），`Daemon` 类已有：`handleEvent` 事件分派、`syncAll()` 内每 runtime
  `list_sessions`（返回含 cwd）、`HubClient.request()` Bearer REST、`loadConfig()` 仅做最小形状校验。
- 配置文件 `examples/sync-daemon.json`（pluginInstall:false、本地插件路径）即联调入口。
- daemon 与 hub 不同：daemon 与被访问文件系统同机，node:path/path.resolve/realpath 可直接使用且语义正确。

## 2. Constitution 符合性

- ✅ 不新增插件协议：cwd 集合复用 syncAll 已取得的 list_sessions 数据，插件零改动。
- ✅ 只读边界：fs-bridge 仅引入 readdir/readFile/realpath/lstat/stat；代码评审按 import 清单核查。
- ✅ 错误归一：全部失败走 FsError 稳定 code，与 protocol FsErrorCode 对齐，不回传原始堆栈。
- ✅ 配置向后兼容：fsAllowedDirs 缺省=null 走 cwd 回退；严格类型、无 as any、无空 catch。

## 3. 模块设计

### 3.1 config.ts 扩展

- 在现有校验后追加 `validateFsAllowedDirs(parsed.fsAllowedDirs)`：
  - undefined → 原样透传（protocol 字段可选）；null/[] 直接通过；
  - 数组：每条要求 typeof string 且 trim 非空；`path.parse` 判定盘根（win：根 === 条目且带盘符；
    posix：`=== "/"`）；`await fs.realpath` 归一，不存在即抛错（消息带原始条目）。
- 返回配置时把 realpath 归一后的数组挂回（统一比较基准），保留 null 语义。

### 3.2 `src/fs-bridge.ts`（新增）

```ts
export class FsError extends Error { constructor(public code: FsErrorCode, message: string) { super(message); } }

export interface FsBridgeDeps {
  getRoots: () => readonly string[];      // 显式白名单 realpath 集合；null 模式返回 []
  isExplicitMode: () => boolean;          // fsAllowedDirs 是否为数组（含 []）
  getKnownCwds: () => readonly string[];  // null 模式快照
}

export class FsBridge {
  async listDir(path: string): Promise<DirListingResult>;
  async readFile(path: string): Promise<FileContentResult>;
  private async assertAllowed(input: string): Promise<string>;  // 返回 realpath
}
```

判定实现：
- `normalize(input)`：NUL 检查 → `path.resolve` → 盘符合一小写。
- `within(target, roots)`：段边界 `roots.some(r => target === r || target.startsWith(r + sep))`，
  sep 用 `path.sep`（同机平台一致）。
- assertAllowed：显式模式先看空数组→denied_all；realpath（目标存在时）后 within(roots)；
  null 模式 within(knownCwds)；失败抛 FsError("denied"/"denied_all")。
- listDir：readdir withFileTypes → 逐项 lstat（不用 stat，避免 symlink 自动跟随）→ 排序/截断；
  DirEntry 的 isDir 取 `dirent.isDirectory()`（symlink 视为文件项，点击读取时再由 realpath 判定）。
- readFile：lstat/stat → 分类 → 限额 → 文本用 `new TextDecoder("utf-8", { fatal: true })`；
  二进制 `buf.toString("base64")` 拼 dataUrl；MIME 用内置小映射表（不引第三方 mime 包）。
- 错误映射 try/catch：FsError 透传；ENOENT→not_found；其它按 spec FR-DFS-011/015 归类。

### 3.3 daemon.ts 接线

- 构造期：`this.knownCwds = new Set<string>()`；创建 `this.fs = new FsBridge({...})`，
  roots 取自 `config.fsAllowedDirs`（config 已 realpath），explicit = Array.isArray(...)。
- syncAll：在组装 agents 时顺手收集 `session.cwd`（过滤空值），末尾
  `this.knownCwds = new Set(await realpathAll(cwds))`（realpath 失败的条目跳过并 warn）。
- handleEvent 增分支：
  ```ts
  else if (event.event === FS_REQUEST_EVENT) await this.handleFsRequest(data);
  ```
  handleFsRequest：payload guard（三字段字符串、kind 枚举）→ await fsAck（失败仅 warn 继续，
  与 deliver 分支风格一致）→ try fs.listDir/readFile → fsResult ok/!ok；catch FsError 映射 error 体，
  catch 未知错误归 daemon_error；全程不抛出到 runEvents 循环。

### 3.4 hub-client.ts

```ts
async fsAck(requestId: string): Promise<void>;
async fsResult(requestId: string, body: FsResultPayload): Promise<void>;
```
均走既有 `this.request()`，路径 encodeURIComponent。

### 3.5 配置样例

- `examples/sync-daemon.json`：增 `"fsAllowedDirs": ["D:\\pi-workspace"]`（本机真实目录，联调即生效）。
- `deploy/sync-daemon.json`：增同键，值给占位注释说明（JSON 无注释，采用示例路径并在 deploy/README 补说明），
  不写死个人机路径。

## 4. 文件清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `packages/sync-daemon/src/config.ts` | 修改 | fsAllowedDirs 校验/realpath/盘根拒绝 |
| `packages/sync-daemon/src/fs-bridge.ts` | 新增 | FsError + FsBridge（白名单/listDir/readFile/分类） |
| `packages/sync-daemon/src/daemon.ts` | 修改 | knownCwds 快照、fs 实例、handleFsRequest |
| `packages/sync-daemon/src/hub-client.ts` | 修改 | fsAck/fsResult |
| `packages/sync-daemon/src/__tests__/fs-bridge.test.ts` | 新增 | tmpdir 全量安全/分类用例 |
| `examples/sync-daemon.json`、`deploy/sync-daemon.json` | 修改 | fsAllowedDirs 示例 |

## 5. 测试方案（vitest，tmpdir 自造样本）

- beforeAll：`fs.mkdtemp(join(tmpdir(), "fs-bridge-"))` 下造 allowed/proj（含子目录、.ts/.md/.png/.bin、
  超限文件、非法 UTF-8 .txt）、allowed-evil 兄弟目录、allowed 内 symlink 指向 allowed-evil/secret.txt。
- 覆盖 TC-009~018：放行/denied/denied_all/null 回退/段边界/symlink/排序截断/分类/限额/类型错误/解码失败。
- config 校验单测可并入同文件：盘根拒绝、非字符串条目、不存在目录报错。
- 测试结尾清理 tmpdir；不依赖 D:\ 真实路径（保证可移植），真实路径验证留集成阶段。

## 6. 风险

| 风险 | 对策 |
|---|---|
| realpath 在目标不存在时抛 ENOENT 与白名单判定顺序冲突 | 先字符串级段边界快速判定，存在路径再 realpath 复核；ENOENT 最终归 not_found |
| 首次同步前 knownCwds 为空导致 null 模式全拒 | 文档与错误 message 明示「尚未同步会话目录」；推荐显式 fsAllowedDirs；启动即 syncAll 缩短空窗 |
| Windows/symlink 权限与开发者模式 | lstat/realpath 异常归 daemon_error 并在联调记录；不降级安全判定 |
| 大目录 lstat 慢 | 2000 项截断即上限保护；单级懒加载避免递归风暴 |
