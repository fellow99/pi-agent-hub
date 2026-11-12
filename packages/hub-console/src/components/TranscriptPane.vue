<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import BlockCard from "./BlockCard.vue";
import {
  getTranscript,
  type SessionSummary,
  type TranscriptItem,
} from "../api.js";

const props = defineProps<{ session: SessionSummary | null }>();
const emit = defineEmits<{ jumpSubagent: [subagentId: string] }>();

const items = ref<TranscriptItem[]>([]);
const hasMore = ref(false);
const loading = ref(false);
const error = ref("");
const unavailable = ref(false);
const scrollEl = ref<HTMLElement | null>(null);
const sentinelEl = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;
let requestedCursor: number | null = null;

const sortedItems = computed(() => [...items.value].sort((a, b) => a.seq - b.seq));

function resetState(): void {
  items.value = [];
  hasMore.value = false;
  error.value = "";
  unavailable.value = false;
  requestedCursor = null;
}

async function loadTail(): Promise<void> {
  if (!props.session) return;
  resetState();
  loading.value = true;
  try {
    const page = await getTranscript(props.session.id);
    items.value = page.items;
    hasMore.value = page.hasMore;
    requestedCursor = page.oldestSeq || null;
    unavailable.value = false;
    await nextTick();
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
  } catch (cause) {
    handleError(cause);
  } finally {
    loading.value = false;
  }
}

async function loadOlder(): Promise<void> {
  if (!props.session || loading.value || !hasMore.value || !requestedCursor) return;
  const cursor = requestedCursor;
  if (cursor === null) return;
  loading.value = true;
  const beforeHeight = scrollEl.value?.scrollHeight ?? 0;
  try {
    const page = await getTranscript(props.session.id, cursor);
    const existingIds = new Set(items.value.map((item) => item.seq));
    const merged = [...page.items.filter((item) => !existingIds.has(item.seq)), ...items.value];
    items.value = merged;
    hasMore.value = page.hasMore;
    requestedCursor = page.oldestSeq || null;
    await nextTick();
    if (scrollEl.value) {
      const delta = scrollEl.value.scrollHeight - beforeHeight;
      scrollEl.value.scrollTop = delta;
    }
  } catch (cause) {
    handleError(cause);
  } finally {
    loading.value = false;
  }
}

function handleError(cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.startsWith("404")) {
    unavailable.value = true;
  } else {
    error.value = message;
  }
}

function setupObserver(): void {
  teardownObserver();
  if (!sentinelEl.value || !scrollEl.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadOlder();
    },
    { root: scrollEl.value, rootMargin: "120px" },
  );
  observer.observe(sentinelEl.value);
}

function teardownObserver(): void {
  observer?.disconnect();
  observer = null;
}

watch(
  () => props.session?.id,
  (id, oldId) => {
    if (id && id !== oldId) void loadTail();
  },
);

watch(sentinelEl, () => setupObserver());

onBeforeUnmount(teardownObserver);

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <div class="transcript-pane">
    <template v-if="session">
      <div class="transcript-header">
        <h2 class="transcript-title" :title="session.title ?? session.id">
          {{ session.title || session.id }}
        </h2>
        <div class="transcript-meta">
          <el-tag size="small" effect="plain">{{ session.hostId }}</el-tag>
          <el-tag size="small" type="success" effect="plain">{{ session.agentId.slice(0, 20) }}</el-tag>
          <span :title="session.cwd">📂 {{ session.cwd }}</span>
          <span>{{ session.entryCount }} entries</span>
        </div>
      </div>

      <div ref="scrollEl" class="transcript-scroll">
        <div ref="sentinelEl" class="scroll-sentinel">
          <el-button v-if="hasMore" text :loading="loading" @click="loadOlder">加载更早记录</el-button>
          <span v-else-if="sortedItems.length > 0" class="sentinel-done">— 已到最早记录 —</span>
        </div>

        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <el-empty v-if="unavailable" description="会话镜像内容不可用（文件缺失或未完成同步）" />
        <el-empty v-else-if="!loading && sortedItems.length === 0" description="该会话暂无上下文条目" />

        <div v-for="item in sortedItems" :key="item.seq" class="turn">
          <div class="turn-meta">
            <span class="turn-seq">#{{ item.seq }}</span>
            <el-tag size="small" effect="plain">{{ item.role ?? item.type }}</el-tag>
            <span class="turn-time">{{ formatTime(item.ts) }}</span>
          </div>
          <BlockCard
            v-for="(block, index) in item.blocks"
            :key="`${item.seq}-${index}`"
            :block="block"
            @jump-subagent="emit('jumpSubagent', $event)"
          />
        </div>
      </div>
    </template>

    <el-empty v-else description="请在左侧选择会话" class="center-empty" />
  </div>
</template>
