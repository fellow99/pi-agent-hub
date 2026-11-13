<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { getSessionTree, type SessionSummary, type SessionTreeProjectNode } from "../api.js";

interface TreeNode {
  id: string;
  label: string;
  fullLabel?: string;
  level: "project" | "agent" | "session";
  hostId?: string;
  agentName?: string;
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

/** 取路径最后一段作为项目名（路径分隔符混用兼容）。 */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || trimmed;
}

/** 重名项目用父目录消歧：`name (parent)`。 */
function buildProjectNames(): Map<string, string> {
  const grouped = new Map<string, string[]>();
  for (const project of projects.value) {
    const name = baseName(project.label);
    const list = grouped.get(name) ?? [];
    list.push(project.label);
    grouped.set(name, list);
  }
  const names = new Map<string, string>();
  for (const [name, labels] of grouped) {
    for (const label of labels) {
      if (labels.length > 1) {
        const parent = baseName(label.slice(0, label.length - baseName(label).length).replace(/[\\/]+$/, ""));
        names.set(label, parent ? `${name} (${parent})` : name);
      } else {
        names.set(label, name);
      }
    }
  }
  return names;
}

/** agent 展示名：有 kind 用 kind（pi/dsh/opencode…），否则回退截断 agentId。 */
function agentDisplayName(kind: string | null, agentId: string): string {
  return kind ?? `${agentId.slice(0, 12)}…`;
}

const treeData = computed<TreeNode[]>(() => {
  const projectNames = buildProjectNames();
  return projects.value.map((project) => ({
    id: `p:${project.key}`,
    label: projectNames.get(project.label) ?? baseName(project.label),
    fullLabel: project.label,
    level: "project",
    sessionCount: project.sessionCount,
    children: project.agents.map((agent) => ({
      id: `a:${agent.key}`,
      label: `${agent.hostId} | ${agentDisplayName(agent.kind, agent.agentId)}`,
      level: "agent" as const,
      hostId: agent.hostId,
      agentName: agentDisplayName(agent.kind, agent.agentId),
      fullLabel: `${agent.hostId} | ${agent.agentId}`,
      kind: agent.kind,
      sessionCount: agent.sessionCount,
      children: agent.sessions.map((session) => ({
        id: `s:${session.id}`,
        label: session.title?.trim() || session.id.slice(0, 10),
        level: "session" as const,
        session,
      })),
    })),
  }));
});

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
              <span class="tree-node__label" :title="data.fullLabel">📁 {{ data.label }}</span>
              <el-tag size="small" type="info" effect="plain">{{ data.sessionCount }}</el-tag>
            </template>
            <template v-else-if="data.level === 'agent'">
              <el-tag size="small" type="primary" effect="light" class="tree-node__host">{{ data.hostId }}</el-tag>
              <span class="tree-node__sep">|</span>
              <el-tag size="small" type="success" effect="light" :title="data.fullLabel">{{ data.agentName }}</el-tag>
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
