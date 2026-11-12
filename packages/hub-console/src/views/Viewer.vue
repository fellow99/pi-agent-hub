<script setup lang="ts">
import { computed, ref } from "vue";
import SessionTreePanel from "../components/SessionTreePanel.vue";
import TranscriptPane from "../components/TranscriptPane.vue";
import FileTreePanel from "../components/FileTreePanel.vue";
import SubagentPanel from "../components/SubagentPanel.vue";
import type { SessionSummary } from "../api.js";

const selectedSession = ref<SessionSummary | null>(null);
const rightTab = ref<"files" | "subagents">("files");
const rightCollapsed = ref(false);
/** 主区 marker 跳转请求（携带 subagentId），由 SubagentPanel 消费。 */
const jumpSubagentId = ref<string | null>(null);

function selectSession(session: SessionSummary): void {
  selectedSession.value = session;
  rightTab.value = "files";
  jumpSubagentId.value = null;
}

function jumpToSubagent(subagentId: string): void {
  rightTab.value = "subagents";
  jumpSubagentId.value = subagentId;
}

const rightPanelClass = computed(() => (rightCollapsed.value ? "right-panel collapsed" : "right-panel"));
</script>

<template>
  <div class="viewer">
    <aside class="left-panel">
      <SessionTreePanel :selected-id="selectedSession?.id ?? null" @select="selectSession" />
    </aside>

    <section class="center-panel">
      <TranscriptPane
        :session="selectedSession"
        @jump-subagent="jumpToSubagent"
      />
    </section>

    <aside :class="rightPanelClass">
      <template v-if="!rightCollapsed">
        <div class="right-header">
          <el-radio-group v-model="rightTab" size="small">
            <el-radio-button value="files">文件</el-radio-button>
            <el-radio-button value="subagents">子 agent</el-radio-button>
          </el-radio-group>
          <el-button text size="small" @click="rightCollapsed = true">收起 »</el-button>
        </div>
        <div v-show="rightTab === 'files'" class="right-body">
          <FileTreePanel :session="selectedSession" />
        </div>
        <div v-show="rightTab === 'subagents'" class="right-body">
          <SubagentPanel :session="selectedSession" :jump-id="jumpSubagentId" />
        </div>
      </template>
      <el-button v-else text class="expand-btn" @click="rightCollapsed = false">« 展开右栏</el-button>
    </aside>
  </div>
</template>
