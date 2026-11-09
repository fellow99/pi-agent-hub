<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { getSession, getTranscript, type SessionSummary, type TranscriptItem } from "../api.js";

const route = useRoute();
const session = ref<SessionSummary | null>(null);
const items = ref<TranscriptItem[]>([]);
const error = ref("");
const hasMore = ref(false);
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

async function load(): Promise<void> {
  try {
    const id = String(route.params.id);
    session.value = await getSession(id);
    const transcript = await getTranscript(id);
    items.value = transcript.items;
    hasMore.value = transcript.hasMore;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.render(text));
}

function blockText(block: Record<string, unknown>, key: string): string {
  const value = block[key];
  return typeof value === "string" ? value : "";
}

onMounted(load);
</script>

<template>
  <div class="page">
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <template v-if="session">
      <h2 style="margin-bottom: 4px">{{ session.title ?? session.id }}</h2>
      <div class="muted">
        {{ session.hostId }} · {{ session.agentId }} · {{ session.cwd }} ·
        {{ session.entryCount }} entries
      </div>
      <el-divider />
      <div class="transcript">
        <div v-for="item in items" :key="item.seq" class="turn">
          <div class="turn-meta">
            <span>#{{ item.seq }}</span>
            <span>{{ item.role ?? item.type }}</span>
            <span>{{ new Date(item.ts).toLocaleString() }}</span>
          </div>
          <template v-for="(block, index) in item.blocks" :key="index">
            <div v-if="block.kind === 'text'" class="block-text" v-html="renderMarkdown(blockText(block, 'text'))" />
            <div v-else-if="block.kind === 'thinking'" class="block-thinking">{{ blockText(block, 'text') }}</div>
            <div v-else-if="block.kind === 'toolCall'" class="block-tool">
              {{ blockText(block, 'name') }} {{ JSON.stringify(block.input) }}
            </div>
            <div v-else-if="block.kind === 'toolResult'" class="block-tool">
              {{ blockText(block, 'name') }}: {{ blockText(block, 'preview') }}
            </div>
            <div v-else-if="block.kind === 'bash'" class="block-tool">$ {{ blockText(block, 'command') }}
{{ blockText(block, 'output') }}</div>
            <div v-else-if="block.kind === 'summary'" class="block-summary">{{ blockText(block, 'text') }}</div>
            <div v-else class="muted">[{{ String(block.kind) }}]</div>
          </template>
        </div>
      </div>
      <el-empty v-if="items.length === 0" description="No transcript entries" />
    </template>
  </div>
</template>
