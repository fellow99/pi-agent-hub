<script setup lang="ts">
import { computed } from "vue";
import { MdPreview } from "md-editor-v3";
import "md-editor-v3/lib/preview.css";
import type { TranscriptBlock } from "../api.js";
import { useTheme } from "../composables/useTheme.js";

const props = defineProps<{ block: TranscriptBlock }>();
const emit = defineEmits<{ jumpSubagent: [subagentId: string] }>();

// 与全局皮肤联动（md-editor-v3 自带 light/dark 两套预览变量）
const { resolvedTheme } = useTheme();

const prettyInput = computed(() => {
  if (props.block.kind !== "toolCall") return "";
  const input = props.block.input;
  if (input === null || input === undefined) return "(无参数)";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
});

function asText(block: TranscriptBlock): string {
  return "text" in block && typeof block.text === "string" ? block.text : "";
}
</script>

<template>
  <div class="block-card" :class="`block-card--${block.kind}`">
    <!-- markdown 正文：md-editor-v3 内置 xss 净化，默认不输出原始 HTML 脚本 -->
    <MdPreview
      v-if="block.kind === 'text'"
      :model-value="asText(block)"
      :theme="resolvedTheme"
      preview-only
      class="block-md"
    />

    <el-collapse v-else-if="block.kind === 'thinking'" class="block-thinking">
      <el-collapse-item title="Thinking">
        <pre class="block-pre">{{ block.text }}</pre>
      </el-collapse-item>
    </el-collapse>

    <div v-else-if="block.kind === 'toolCall'" class="block-tool">
      <div class="block-tool__head">
        <el-tag size="small" type="warning">🔧 {{ block.name }}</el-tag>
        <span class="block-tool__callid">{{ block.callId.slice(0, 16) }}</span>
      </div>
      <pre class="block-pre block-pre--input">{{ prettyInput }}</pre>
    </div>

    <div v-else-if="block.kind === 'toolResult'" class="block-tool">
      <div class="block-tool__head">
        <el-tag size="small" :type="block.ok ? 'success' : 'danger'">
          {{ block.ok ? "✓ result" : "✗ error" }} · {{ block.name }}
        </el-tag>
        <span v-if="block.truncated" class="block-tool__warn">已截断</span>
      </div>
      <pre v-if="block.preview" class="block-pre">{{ block.preview }}</pre>
    </div>

    <div v-else-if="block.kind === 'bash'" class="block-bash">
      <div class="block-bash__cmd"><span class="prompt">$</span> {{ block.command }}</div>
      <pre v-if="block.output" class="block-pre">{{ block.output }}</pre>
      <div v-if="block.exitCode !== undefined" class="block-bash__exit">exit: {{ block.exitCode }}</div>
    </div>

    <div v-else-if="block.kind === 'summary'" class="block-summary">
      <el-tag size="small" effect="plain">{{ block.summaryType }}</el-tag>
      <span>{{ block.text }}</span>
    </div>

    <div v-else-if="block.kind === 'subagentMarker'" class="block-subagent">
      <el-tag size="small" type="primary">🤖 子 agent · {{ block.agentName }}</el-tag>
      <el-button text size="small" @click="emit('jumpSubagent', block.parentToolCallId)">
        查看子 agent 上下文 →
      </el-button>
    </div>

    <div v-else-if="block.kind === 'image'" class="block-image">
      <el-tag size="small" effect="plain">image: {{ block.mime }}</el-tag>
    </div>

    <div v-else-if="block.kind === 'meta'" class="block-meta">
      <el-tag size="small" effect="info">{{ block.label }}</el-tag>
      <span v-if="block.detail">{{ block.detail }}</span>
    </div>

    <div v-else class="block-meta">
      <el-tag size="small" effect="info">{{ block.kind }}</el-tag>
    </div>
  </div>
</template>
