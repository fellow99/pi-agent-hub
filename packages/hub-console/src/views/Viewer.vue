<script setup lang="ts">
import { computed, ref } from "vue";
import { DArrowLeft, DArrowRight } from "@element-plus/icons-vue";
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

const viewerClass = computed(() => (rightCollapsed.value ? "viewer viewer--right-collapsed" : "viewer"));
</script>

<template>
  <div :class="viewerClass">
    <aside class="left-panel">
      <SessionTreePanel :selected-id="selectedSession?.id ?? null" @select="selectSession" />
    </aside>

    <section class="center-panel">
      <TranscriptPane
        :session="selectedSession"
        @jump-subagent="jumpToSubagent"
      />
    </section>

    <aside class="right-panel">
      <div class="right-header">
        <el-radio-group v-if="!rightCollapsed" v-model="rightTab" size="small">
          <el-radio-button value="files">文件</el-radio-button>
          <el-radio-button value="subagents">子 agent</el-radio-button>
        </el-radio-group>
        <el-button
          text
          size="small"
          class="collapse-btn"
          :aria-label="rightCollapsed ? '展开右栏' : '收起右栏'"
          @click="rightCollapsed = !rightCollapsed"
        >
          <el-icon :size="16">
            <DArrowLeft v-if="!rightCollapsed" />
            <DArrowRight v-else />
          </el-icon>
        </el-button>
      </div>
      <div v-if="!rightCollapsed" class="right-body">
        <div v-show="rightTab === 'files'" class="right-tab-pane">
          <FileTreePanel :session="selectedSession" />
        </div>
        <div v-show="rightTab === 'subagents'" class="right-tab-pane">
          <SubagentPanel :session="selectedSession" :jump-id="jumpSubagentId" />
        </div>
      </div>
    </aside>
  </div>
</template>
