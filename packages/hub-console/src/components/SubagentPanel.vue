<script setup lang="ts">
import { ref, watch } from "vue";
import BlockCard from "./BlockCard.vue";
import {
  getSubagentTranscript,
  listSubagents,
  type SessionSummary,
  type SubagentSummary,
  type TranscriptItem,
} from "../api.js";

const props = defineProps<{ session: SessionSummary | null; jumpId: string | null }>();

const subagents = ref<SubagentSummary[]>([]);
const loading = ref(false);
const error = ref("");
const activeId = ref<string | null>(null);
const transcript = ref<TranscriptItem[]>([]);
const transcriptLoading = ref(false);
/** 会话级子 agent 列表缓存，超上限淘汰最久未访问项。 */
const cache = new Map<string, SubagentSummary[]>();
const CACHE_LIMIT = 30;

async function loadList(sessionId: string): Promise<void> {
  const cached = cache.get(sessionId);
  if (cached) {
    cache.delete(sessionId);
    cache.set(sessionId, cached);
    subagents.value = cached;
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    subagents.value = await listSubagents(sessionId);
    cache.set(sessionId, subagents.value);
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

async function openSubagent(subagentId: string): Promise<void> {
  if (!props.session) return;
  activeId.value = subagentId;
  transcript.value = [];
  transcriptLoading.value = true;
  try {
    const data = await getSubagentTranscript(props.session.id, subagentId);
    transcript.value = data.items;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    transcriptLoading.value = false;
  }
}

function backToList(): void {
  activeId.value = null;
  transcript.value = [];
}

watch(
  () => props.session?.id,
  (id) => {
    subagents.value = [];
    activeId.value = null;
    transcript.value = [];
    error.value = "";
    if (id) void loadList(id);
  },
  { immediate: true },
);

// 主区 marker 跳转联动
watch(
  () => props.jumpId,
  (id) => {
    if (id && subagents.value.some((item) => item.subagentId === id)) void openSubagent(id);
  },
);

function formatTime(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}
</script>

<template>
  <div class="subagent-panel">
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <template v-if="session">
      <!-- 子上下文视图 -->
      <template v-if="activeId">
        <div class="subagent-view-head">
          <el-button size="small" text @click="backToList">← 返回列表</el-button>
          <span class="subagent-view-id" :title="activeId">{{ activeId.slice(0, 22) }}…</span>
        </div>
        <div v-loading="transcriptLoading" class="subagent-transcript">
          <el-empty v-if="!transcriptLoading && transcript.length === 0" description="该子 agent 无消息段" :image-size="60" />
          <div v-for="item in transcript" :key="item.seq" class="turn">
            <div class="turn-meta">
              <span class="turn-seq">#{{ item.seq }}</span>
              <el-tag size="small" effect="plain">{{ item.role ?? item.type }}</el-tag>
            </div>
            <BlockCard v-for="(block, index) in item.blocks" :key="`${item.seq}-${index}`" :block="block" />
          </div>
        </div>
      </template>

      <!-- 调用列表 -->
      <div v-else v-loading="loading" class="subagent-list">
        <el-empty v-if="!loading && subagents.length === 0" description="该会话无子 agent 调用" :image-size="70" />
        <div
          v-for="item in subagents"
          :key="item.subagentId"
          class="subagent-item"
          @click="openSubagent(item.subagentId)"
        >
          <div class="subagent-item__head">
            <el-tag size="small" type="primary">🤖 {{ item.agentName }}</el-tag>
            <el-tag size="small" effect="plain">{{ item.markerCount }} 标记</el-tag>
          </div>
          <div v-if="item.description" class="subagent-item__desc" :title="item.description">
            {{ item.description }}
          </div>
          <div class="subagent-item__time">
            {{ formatTime(item.firstTs) }} → {{ formatTime(item.lastTs) }}
          </div>
        </div>
      </div>
    </template>
    <el-empty v-else description="请先选择会话" :image-size="70" />
  </div>
</template>
