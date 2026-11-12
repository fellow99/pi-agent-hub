<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { getSessionTree, type SessionSummary, type SessionTreeProjectNode } from "../api.js";

interface TreeNode {
  id: string;
  label: string;
  level: "project" | "agent" | "session";
  session?: SessionSummary;
  kind?: string | null;
  sessionCount?: number;
  children?: TreeNode[];
}

const props = defineProps<{ selectedId: string | null }>();
const emit = defineEmits<{ select: [session: SessionSummary] }>();

const projects = ref<SessionTreeProjectNode[]>([]);
const loading = ref(false);
const error = ref("");
const keyword = ref("");
const expandedKeys = ref<string[]>([]);
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

const treeData = computed<TreeNode[]>(() =>
  projects.value.map((project) => ({
    id: `p:${project.key}`,
    label: project.label,
    level: "project",
    sessionCount: project.sessionCount,
    children: project.agents.map((agent) => ({
      id: `a:${agent.key}`,
      label: `${agent.hostId}|${agent.agentId}`,
      level: "agent" as const,
      kind: agent.kind,
      sessionCount: agent.sessionCount,
      children: agent.sessions.map((session) => ({
        id: `s:${session.id}`,
        label: session.title?.trim() || session.id.slice(0, 10),
        level: "session" as const,
        session,
      })),
    })),
  })),
);

const currentNodeKey = computed(() => (props.selectedId ? `s:${props.selectedId}` : ""));

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const data = await getSessionTree(keyword.value.trim() || undefined);
    projects.value = data.projects;
    if (!keyword.value && data.projects.length > 0) {
      expandedKeys.value = [`p:${data.projects[0]!.key}`];
    } else if (keyword.value) {
      // 搜索时展开全部项目节点，直接暴露命中的会话
      expandedKeys.value = data.projects.map((project) => `p:${project.key}`);
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

watch(keyword, () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(load, 300);
});

function onNodeClick(node: TreeNode): void {
  if (node.level === "session" && node.session) emit("select", node.session);
}

function formatTime(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

onMounted(load);
</script>

<template>
  <div class="tree-panel">
    <div class="tree-toolbar">
      <el-input
        v-model="keyword"
        size="small"
        placeholder="过滤项目/会话/host…"
        clearable
      />
      <el-button size="small" :loading="loading" @click="load">刷新</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <div v-loading="loading" class="tree-scroll">
      <el-tree
        :data="treeData"
        node-key="id"
        :props="{ label: 'label', children: 'children' }"
        :highlight-current="true"
        :current-node-key="currentNodeKey"
        :default-expanded-keys="expandedKeys"
        @node-click="onNodeClick"
      >
        <template #default="{ data }">
          <div class="tree-node" :class="`tree-node--${data.level}`">
            <template v-if="data.level === 'project'">
              <span class="tree-node__label" :title="data.label">📁 {{ data.label }}</span>
              <el-tag size="small" type="info" effect="plain">{{ data.sessionCount }}</el-tag>
            </template>
            <template v-else-if="data.level === 'agent'">
              <span class="tree-node__label" :title="data.label">🖥 {{ data.label }}</span>
              <el-tag v-if="data.kind" size="small" type="success">{{ data.kind }}</el-tag>
            </template>
            <template v-else>
              <div class="tree-node__session">
                <span class="tree-node__label" :title="data.label">💬 {{ data.label }}</span>
                <span class="tree-node__time">{{ formatTime(data.session?.lastTimestamp ?? null) }}</span>
              </div>
            </template>
          </div>
        </template>
      </el-tree>
      <el-empty v-if="!loading && treeData.length === 0" description="暂无会话" :image-size="60" />
    </div>
  </div>
</template>
