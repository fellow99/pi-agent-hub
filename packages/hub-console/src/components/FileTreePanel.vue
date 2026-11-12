<script setup lang="ts">
import { ref, watch } from "vue";
import {
  getFileContent,
  getSessionFiles,
  type FileContentResponse,
  type SessionSummary,
  type VirtualFileNode,
} from "../api.js";

const props = defineProps<{ session: SessionSummary | null }>();

const tree = ref<VirtualFileNode | null>(null);
const truncated = ref(false);
const loading = ref(false);
const error = ref("");
/** 会话级文件树缓存：Map 迭代顺序即插入顺序，超上限淘汰最久未访问项。 */
const cache = new Map<string, { tree: VirtualFileNode; truncated: boolean }>();
const CACHE_LIMIT = 30;
const currentPath = ref<string | null>(null);
const content = ref<FileContentResponse | null>(null);
const contentLoading = ref(false);

function remember(sessionId: string, value: { tree: VirtualFileNode; truncated: boolean }): void {
  const existing = cache.get(sessionId);
  if (existing) cache.delete(sessionId);
  cache.set(sessionId, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

async function load(sessionId: string): Promise<void> {
  const cached = cache.get(sessionId);
  if (cached) {
    // 刷新访问顺序，使最近访问的项留在缓存内
    cache.delete(sessionId);
    cache.set(sessionId, cached);
    tree.value = cached.tree;
    truncated.value = cached.truncated;
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const data = await getSessionFiles(sessionId);
    tree.value = data.root;
    truncated.value = data.truncated;
    remember(sessionId, { tree: data.root, truncated: data.truncated });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.session?.id,
  (id) => {
    tree.value = null;
    currentPath.value = null;
    content.value = null;
    if (id) void load(id);
  },
  { immediate: true },
);

async function openFile(node: VirtualFileNode): Promise<void> {
  if (node.isDir || !props.session) return;
  currentPath.value = node.path;
  contentLoading.value = true;
  content.value = null;
  try {
    content.value = await getFileContent(props.session.id, node.path);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    contentLoading.value = false;
  }
}

const treeProps = { label: "name", children: "children" };
</script>

<template>
  <div class="file-panel">
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <template v-if="session">
      <div v-loading="loading" class="file-tree-wrap">
        <div v-if="truncated" class="file-truncated-tip">路径数达上限，仅展示部分文件</div>
        <el-tree
          v-if="tree"
          :data="tree.children"
          :props="treeProps"
          node-key="path"
          :highlight-current="true"
          @node-click="openFile"
        >
          <template #default="{ data }">
            <span class="file-node" :class="{ 'file-node--dir': data.isDir, 'file-node--active': data.path === currentPath }">
              <span class="file-node__name">{{ data.isDir ? "📁" : "📄" }} {{ data.name }}</span>
              <el-tag
                v-for="tool in data.touchedBy.slice(0, 2)"
                :key="tool"
                size="small"
                effect="plain"
                class="file-node__tool"
              >{{ tool }}</el-tag>
            </span>
          </template>
        </el-tree>
        <el-empty v-else-if="!loading" description="该会话暂无文件活动" :image-size="60" />
      </div>

      <div class="file-viewer">
        <div v-if="currentPath" class="file-viewer__head">
          <span class="file-viewer__path" :title="currentPath">{{ currentPath }}</span>
        </div>
        <div v-loading="contentLoading" class="file-viewer__body">
          <template v-if="content">
            <template v-if="content.available">
              <div class="file-viewer__meta">
                <el-tag size="small" type="info">{{ content.source }}</el-tag>
                <span>{{ content.toolName }} · seq #{{ content.entrySeq }}</span>
                <el-tag v-if="content.truncated" size="small" type="warning">内容已截断</el-tag>
              </div>
              <pre class="file-viewer__pre">{{ content.content }}</pre>
            </template>
            <el-empty
              :image-size="70"
              description="镜像中无完整内容（仅记录到工具触碰，未留存正文）"
            />
          </template>
          <el-empty v-else-if="!contentLoading" description="点击文件查看镜像内容" :image-size="70" />
        </div>
      </div>
    </template>
    <el-empty v-else description="请先选择会话" :image-size="70" />
  </div>
</template>
