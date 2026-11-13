<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
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

const rootNodes = ref<FsTreeNode[]>([]);
const rootLoading = ref(false);
const rootError = ref("");
const rootTruncated = ref(false);

const currentFile = ref<{ path: string; loading: boolean; content: FileContentResult | null; error: string }>({
  path: "",
  loading: false,
  content: null,
  error: "",
});
let fileAbort: AbortController | undefined;
let rootAbort: AbortController | undefined;

const role = computed(() => getRole());
const isAdmin = computed(() => role.value === "admin");
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

async function loadRoot(): Promise<void> {
  if (!props.session) return;
  rootAbort?.abort();
  rootAbort = new AbortController();
  rootLoading.value = true;
  rootError.value = "";
  rootTruncated.value = false;
  rootNodes.value = [];
  try {
    const listing = await fetchDir(props.session.cwd, rootAbort.signal);
    rootNodes.value = listing.entries.map((entry) => toNode(entry, listing.path));
    rootTruncated.value = listing.truncated;
  } catch (cause) {
    if (isAbort(cause)) return;
    rootError.value = fsErrorMessage(cause);
  } finally {
    rootLoading.value = false;
  }
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
  node: { level: number; data: FsTreeNode },
  resolve: (nodes: FsTreeNode[]) => void,
  reject: (error: Error) => void,
): Promise<void> {
  if (node.level === 0 || !node.data.isDir || !props.session) {
    resolve([]);
    return;
  }
  try {
    const listing = await fetchDir(node.data.path, new AbortController().signal);
    const children = listing.entries.map((entry) => toNode(entry, listing.path));
    node.data.children = children;
    node.data.loaded = true;
    resolve(children);
  } catch (cause) {
    if (isAbort(cause)) {
      resolve([]);
      return;
    }
    reject(cause instanceof Error ? cause : new Error(String(cause)));
  }
}

async function onNodeClick(data: FsTreeNode): Promise<void> {
  if (data.isDir || !props.session) return;
  fileAbort?.abort();
  fileAbort = new AbortController();
  currentFile.value = { path: data.path, loading: true, content: null, error: "" };
  try {
    const content = await readFile(props.session.hostId, data.path, fileAbort.signal);
    currentFile.value.content = content;
  } catch (cause) {
    if (isAbort(cause)) return;
    currentFile.value.error = fsErrorMessage(cause);
  } finally {
    currentFile.value.loading = false;
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
  rootAbort?.abort();
  fileAbort?.abort();
  rootNodes.value = [];
  rootError.value = "";
  rootTruncated.value = false;
  currentFile.value = { path: "", loading: false, content: null, error: "" };
}

watch(
  () => props.session?.id,
  (id) => {
    reset();
    dirCache.clear();
    if (id && isAdmin.value) void loadRoot();
  },
  { immediate: true },
);

onUnmounted(() => {
  rootAbort?.abort();
  fileAbort?.abort();
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
        <div v-loading="rootLoading" class="file-tree-wrap">
          <div v-if="rootTruncated" class="file-truncated-tip">子项过多，仅展示前 2000 项</div>
          <el-tree
            v-if="rootNodes.length > 0"
            :data="rootNodes"
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
          <el-empty v-else-if="!rootLoading && !rootError" description="该目录为空" :image-size="60" />
        </div>

        <div class="file-viewer">
          <div v-if="currentFile.path" class="file-viewer__head">
            <span class="file-viewer__path" :title="currentFile.path">{{ currentFile.path }}</span>
            <span v-if="currentFile.content" class="file-viewer__size">{{ formatSize(currentFile.content.size) }}</span>
          </div>
          <div v-loading="currentFile.loading" class="file-viewer__body">
            <el-alert
              v-if="currentFile.error"
              :title="currentFile.error"
              type="warning"
              :closable="false"
              show-icon
            />
            <template v-else-if="currentFile.content">
              <MdPreview
                v-if="currentFile.content.type === 'text' && isMarkdown(currentFile.path)"
                :modelValue="currentFile.content.content"
              />
              <pre v-else-if="currentFile.content.type === 'text'" class="file-viewer__pre">{{ currentFile.content.content }}</pre>
              <img
                v-else-if="currentFile.content.type === 'image'"
                class="file-viewer__media"
                :src="currentFile.content.dataUrl"
                :alt="currentFile.path"
              >
              <video
                v-else-if="currentFile.content.type === 'video'"
                class="file-viewer__media"
                controls
                :src="currentFile.content.dataUrl"
              />
              <iframe
                v-else-if="currentFile.content.type === 'pdf'"
                class="file-viewer__pdf"
                :src="currentFile.content.dataUrl"
                title="pdf-preview"
              />
            </template>
            <el-empty v-else-if="!currentFile.loading" description="点击文件查看主机真实内容" :image-size="70" />
          </div>
        </div>
      </template>
    </template>
    <el-empty v-else description="请先选择会话" :image-size="70" />
  </div>
</template>
