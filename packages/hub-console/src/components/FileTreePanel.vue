<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { ElMessage } from "element-plus";
import { MdPreview } from "md-editor-v3";
import "md-editor-v3/lib/preview.css";
import {
  FsRequestError,
  getRole,
  listDir,
  readFile,
  type DirEntry,
  type DirListingResult,
  type FileContentResult,
  type SessionSummary,
} from "../api.js";
import { useTheme } from "../composables/useTheme.js";
import { useViewport } from "../composables/useViewport.js";

const props = defineProps<{ session: SessionSummary | null }>();

interface FsTreeNode {
  label: string;
  path: string;
  isDir: boolean;
  size?: number;
  mtimeMs?: number;
  isLeaf?: boolean;
  children?: FsTreeNode[];
  loaded?: boolean;
}

const CACHE_LIMIT = 30;
/** 目录列表 LRU：仅缓存列表，不缓存文件内容（防 dataUrl 内存膨胀）。 */
const dirCache = new Map<string, DirListingResult>();

const rootError = ref("");
const rootTruncated = ref(false);
/** 树重载键：切换会话时递增，强制 el-tree 重建并重新触发根级懒加载。 */
const treeKey = ref(0);
/** 根级加载状态由 el-tree 自身的 loading 控制；错误经 rootError 展示。 */
const rootLoading = ref(false);

/** 文件内容抽屉：仅在请求成功后打开；下方不再常驻查看器。 */
const drawerVisible = ref(false);
const currentFile = ref<{ path: string; content: FileContentResult | null }>({
  path: "",
  content: null,
});
/** 抽屉打开期间的加载态（点击文件到拿到内容之间）。 */
const fileLoading = ref(false);
let fileAbort: AbortController | undefined;
/** 所有懒加载（含根级）共用句柄：切换会话/卸载时统一中止，避免 resolve 写回旧树节点。 */
let lazyAbort = new AbortController();

const role = computed(() => getRole());
const isAdmin = computed(() => role.value === "admin");
// 与全局皮肤联动（md-editor-v3 自带 light/dark 两套预览变量）。
const { resolvedTheme } = useTheme();
// 203：文件内容抽屉窄屏近乎全屏，宽屏维持 50%。
const { isCompact } = useViewport();
const drawerSize = computed(() => (isCompact.value ? "90%" : "50%"));
const treeProps = { label: "label", children: "children", isLeaf: (data: FsTreeNode) => data.isLeaf ?? !data.isDir };

function remember(path: string, listing: DirListingResult): void {
  if (dirCache.has(path)) dirCache.delete(path);
  dirCache.set(path, listing);
  while (dirCache.size > CACHE_LIMIT) {
    const oldest = dirCache.keys().next().value;
    if (oldest === undefined) break;
    dirCache.delete(oldest);
  }
}

function toNode(entry: DirEntry, parentPath: string): FsTreeNode {
  // 目录路径拼接同时兼容 Windows 反斜杠与 posix 斜杠。
  const separator = parentPath.includes("/") && !parentPath.includes("\\") ? "/" : "\\";
  return {
    label: entry.name,
    path: parentPath.endsWith(separator) ? parentPath + entry.name : parentPath + separator + entry.name,
    isDir: entry.isDir,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    isLeaf: !entry.isDir,
    loaded: false,
  };
}



async function fetchDir(path: string, signal: AbortSignal): Promise<DirListingResult> {
  const cached = dirCache.get(path);
  if (cached) {
    dirCache.delete(path);
    dirCache.set(path, cached);
    return cached;
  }
  if (!props.session) throw new Error("no session");
  const listing = await listDir(props.session.hostId, path, signal);
  remember(path, listing);
  return listing;
}

async function onLazyLoad(
  node: { level: number; data: FsTreeNode | null },
  resolve: (nodes: FsTreeNode[]) => void,
  reject: (error: Error) => void,
): Promise<void> {
  if (!props.session) {
    resolve([]);
    return;
  }
  // 根级（level 0）拉取会话 cwd；其余层级仅目录可展开。
  const targetPath = node.level === 0 ? props.session.cwd : node.data?.path ?? "";
  if (node.level !== 0 && !node.data?.isDir) {
    resolve([]);
    return;
  }
  if (node.level === 0) rootLoading.value = true;
  try {
    const listing = await fetchDir(targetPath, lazyAbort.signal);
    const children = listing.entries.map((entry) => toNode(entry, listing.path));
    if (node.level === 0) rootTruncated.value = listing.truncated;
    if (node.data) node.data.children = children;
    resolve(children);
  } catch (cause) {
    if (isAbort(cause)) {
      resolve([]);
      return;
    }
    if (node.level === 0) rootError.value = fsErrorMessage(cause);
    reject(cause instanceof Error ? cause : new Error(String(cause)));
  } finally {
    if (node.level === 0) rootLoading.value = false;
  }
}

async function onNodeClick(data: FsTreeNode): Promise<void> {
  if (data.isDir || !props.session) return;
  fileAbort?.abort();
  fileAbort = new AbortController();
  fileLoading.value = true;
  try {
    const content = await readFile(props.session.hostId, data.path, fileAbort.signal);
    // 成功才填充并打开抽屉；失败不改变现有抽屉内容。
    currentFile.value = { path: data.path, content };
    drawerVisible.value = true;
  } catch (cause) {
    // 主动切换/卸载导致的中止不提示。
    if (isAbort(cause)) return;
    ElMessage.warning(fsErrorMessage(cause));
  } finally {
    fileLoading.value = false;
  }
}

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

function fsErrorMessage(cause: unknown): string {
  if (cause instanceof FsRequestError) {
    const map: Record<string, string> = {
      denied: "无访问权限：路径不在主机白名单内",
      denied_all: "主机已禁用目录访问（白名单为空）",
      path_not_allowed: "无访问权限：路径不在已知会话目录内",
      forbidden_role: "目录浏览需要管理员权限",
      host_offline: "主机离线：sync-daemon 未连接",
      host_unknown: "主机未登记",
      file_too_large: "文件超过大小上限，无法读取",
      binary_unsupported: "不支持的二进制文件类型",
      text_decode_failed: "文本解码失败（非 UTF-8）",
      not_a_file: "目标不是文件",
      not_a_directory: "目标不是目录",
      not_found: "路径不存在",
      expired: "主机响应超时（请求已过期），可重试",
      timeout: "主机响应超时",
      daemon_error: "主机执行出错",
    };
    return map[cause.code] ?? `请求失败：${cause.code}`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

function reset(): void {
  fileAbort?.abort();
  lazyAbort?.abort();
  lazyAbort = new AbortController();
  rootError.value = "";
  rootTruncated.value = false;
  drawerVisible.value = false;
  fileLoading.value = false;
  currentFile.value = { path: "", content: null };
  treeKey.value += 1;
}

watch(
  () => props.session?.id,
  (id) => {
    reset();
    dirCache.clear();
    if (id && isAdmin.value) {
      // treeKey 变化后 el-tree 重建，自动触发 level 0 懒加载；无需显式 loadRoot。
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  fileAbort?.abort();
  lazyAbort?.abort();
});
</script>

<template>
  <div class="file-panel">
    <template v-if="session">
      <div class="file-panel__root" :title="session.cwd">
        <span class="file-panel__root-label">📁 {{ session.cwd }}</span>
      </div>

      <el-empty v-if="!isAdmin" description="目录浏览需要管理员权限" :image-size="70" />

      <template v-else>
        <el-alert v-if="rootError" :title="rootError" type="error" :closable="false" show-icon />
        <div v-loading="rootLoading || fileLoading" class="file-tree-wrap">
          <div v-if="rootTruncated" class="file-truncated-tip">子项过多，仅展示前 2000 项</div>
          <el-tree
            v-if="isAdmin"
            :key="treeKey"
            :props="treeProps"
            node-key="path"
            :highlight-current="true"
            lazy
            :load="onLazyLoad"
            @node-click="onNodeClick"
          >
            <template #default="{ data }">
              <span
                class="file-node"
                :class="{ 'file-node--dir': data.isDir, 'file-node--active': data.path === currentFile.path }"
              >
                <span class="file-node__name">{{ data.isDir ? "📁" : "📄" }} {{ data.label }}</span>
                <span v-if="!data.isDir" class="file-node__meta">{{ formatSize(data.size) }}</span>
              </span>
            </template>
          </el-tree>
        </div>
      </template>
    </template>
    <el-empty v-else description="请先选择会话" :image-size="70" />

    <!-- 文件内容抽屉：点击文件且成功返回后打开，占视口 50% 宽度。 -->
    <el-drawer
      v-model="drawerVisible"
      :title="currentFile.path"
      direction="rtl"
      :size="drawerSize"
      :append-to-body="true"
      class="file-drawer"
    >
      <template v-if="currentFile.content">
        <div class="file-drawer__body">
          <MdPreview
            v-if="currentFile.content.type === 'text' && isMarkdown(currentFile.path)"
            :modelValue="currentFile.content.content"
            :theme="resolvedTheme"
            preview-only
          />
          <pre v-else-if="currentFile.content.type === 'text'" class="file-drawer__pre">{{ currentFile.content.content }}</pre>
          <img
            v-else-if="currentFile.content.type === 'image'"
            class="file-drawer__media"
            :src="currentFile.content.dataUrl"
            :alt="currentFile.path"
          >
          <video
            v-else-if="currentFile.content.type === 'video'"
            class="file-drawer__media"
            controls
            :src="currentFile.content.dataUrl"
          />
          <iframe
            v-else-if="currentFile.content.type === 'pdf'"
            class="file-drawer__pdf"
            :src="currentFile.content.dataUrl"
            title="pdf-preview"
          />
        </div>
      </template>
    </el-drawer>
  </div>
</template>
