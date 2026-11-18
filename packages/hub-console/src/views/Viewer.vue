<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { DArrowLeft, DArrowRight, Files, Menu } from "@element-plus/icons-vue";
import SessionTreePanel from "../components/SessionTreePanel.vue";
import TranscriptPane from "../components/TranscriptPane.vue";
import FileTreePanel from "../components/FileTreePanel.vue";
import SubagentPanel from "../components/SubagentPanel.vue";
import { useViewport } from "../composables/useViewport.js";
import type { SessionSummary } from "../api.js";

const { isCompact, isNarrow } = useViewport();

const selectedSession = ref<SessionSummary | null>(null);
const rightTab = ref<"files" | "subagents">("files");
/** 主区 marker 跳转请求（携带 subagentId），由 SubagentPanel 消费。 */
const jumpSubagentId = ref<string | null>(null);

/**
 * 宽屏偏好：右栏桌面端开合状态，与窄屏 overlay 开关相互独立
 * （参考 pi-web desktopSidebarOpenRef：移动端抽屉操作不改写桌面偏好）。
 */
const desktopRightCollapsed = ref(false);
/** 窄屏 overlay 抽屉开关。 */
const leftDrawerOpen = ref(false);
const rightDrawerOpen = ref(false);

/** 右栏在当前模式下是否展开（宽屏看桌面偏好，窄屏看 overlay 开关）。 */
const rightPanelOpen = computed(() =>
  isCompact.value ? rightDrawerOpen.value : !desktopRightCollapsed.value,
);

const viewerClass = computed(() => ({
  "viewer--compact": isCompact.value,
  "viewer--narrow": isNarrow.value,
  "viewer--right-collapsed": !isCompact.value && desktopRightCollapsed.value,
}));

const overlayVisible = computed(() => isCompact.value && (leftDrawerOpen.value || rightDrawerOpen.value));

function selectSession(session: SessionSummary): void {
  selectedSession.value = session;
  rightTab.value = "files";
  jumpSubagentId.value = null;
  // 窄屏下选中会话后自动收起左栏，直接露出正文（FR-203-014）。
  if (isCompact.value) leftDrawerOpen.value = false;
}

function jumpToSubagent(subagentId: string): void {
  rightTab.value = "subagents";
  jumpSubagentId.value = subagentId;
}

function openLeftDrawer(): void {
  leftDrawerOpen.value = true;
  rightDrawerOpen.value = false;
}

function openRightDrawer(): void {
  rightDrawerOpen.value = true;
  leftDrawerOpen.value = false;
}

function closeDrawers(): void {
  leftDrawerOpen.value = false;
  rightDrawerOpen.value = false;
}

/** 右栏头部按钮：宽屏折叠桌面右栏；窄屏关闭 overlay。 */
function collapseRight(): void {
  if (isCompact.value) rightDrawerOpen.value = false;
  else desktopRightCollapsed.value = true;
}

/** 跨断点切换（含 compact 内旋转触发的 isNarrow 变化）：overlay 全部复位；宽屏按桌面偏好渲染（FR-203-009/015）。 */
watch([isCompact, isNarrow], () => {
  closeDrawers();
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && isCompact.value) closeDrawers();
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="viewer" :class="viewerClass">
    <!-- 窄屏 overlay 遮罩：点遮罩关闭（Esc 由脚本处理） -->
    <div
      v-if="overlayVisible"
      class="viewer-overlay"
      aria-hidden="true"
      @click="closeDrawers"
    />

    <aside
      class="left-panel panel-drawer panel-drawer--left"
      :class="{ 'is-open': !isCompact || leftDrawerOpen }"
      :role="isCompact ? 'dialog' : undefined"
      aria-label="会话列表"
    >
      <SessionTreePanel :selected-id="selectedSession?.id ?? null" @select="selectSession" />
    </aside>

    <section class="center-panel">
      <TranscriptPane
        :session="selectedSession"
        @jump-subagent="jumpToSubagent"
      />
    </section>

    <aside
      class="right-panel panel-drawer panel-drawer--right"
      :class="{ 'is-open': rightPanelOpen }"
      :role="isCompact ? 'dialog' : undefined"
      aria-label="文件与子 agent"
    >
      <div class="right-header">
        <el-radio-group v-if="rightPanelOpen" v-model="rightTab" size="small">
          <el-radio-button value="files">文件</el-radio-button>
          <el-radio-button value="subagents">子 agent</el-radio-button>
        </el-radio-group>
        <el-button
          text
          size="small"
          class="collapse-btn"
          :aria-label="isCompact ? '关闭右栏' : '收起右栏'"
          @click="collapseRight"
        >
          <el-icon :size="16">
            <DArrowLeft v-if="rightPanelOpen" />
            <DArrowRight v-else />
          </el-icon>
        </el-button>
      </div>
      <div v-show="rightPanelOpen" class="right-body">
        <div v-show="rightTab === 'files'" class="right-tab-pane">
          <FileTreePanel :session="selectedSession" />
        </div>
        <div v-show="rightTab === 'subagents'" class="right-tab-pane">
          <SubagentPanel :session="selectedSession" :jump-id="jumpSubagentId" />
        </div>
      </div>
    </aside>

    <!-- 窄屏浮动触发按钮：对应抽屉打开时隐藏 -->
    <button
      v-if="isCompact && !leftDrawerOpen"
      type="button"
      class="fab fab--left"
      aria-label="打开会话列表"
      @click="openLeftDrawer"
    >
      <el-icon :size="20"><Menu /></el-icon>
    </button>
    <button
      v-if="isCompact && !rightDrawerOpen"
      type="button"
      class="fab fab--right"
      aria-label="打开文件与子 agent"
      @click="openRightDrawer"
    >
      <el-icon :size="20"><Files /></el-icon>
    </button>

    <!-- 宽屏右栏零宽收起后的浮动展开按钮 -->
    <button
      v-if="!isCompact && desktopRightCollapsed"
      type="button"
      class="fab fab--right-restore"
      aria-label="展开右栏"
      @click="desktopRightCollapsed = false"
    >
      <el-icon :size="18"><DArrowRight /></el-icon>
    </button>
  </div>
</template>
