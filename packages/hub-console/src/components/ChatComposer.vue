<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Picture, UploadFilled } from "@element-plus/icons-vue";
import ModelSelector from "./ModelSelector.vue";
import ThinkingLevelSelector from "./ThinkingLevelSelector.vue";
import {
  getModelInfo,
  sendDelivery,
  pollDelivery,
  getRole,
  type DeliveryState,
  type ModelInfoResult,
  type SessionSummary,
} from "../api.js";

/**
 * 007：会话底部聊天输入框。
 * 文本 + 图片（预览/移除/拖拽）+ 模型切换 + 思考深度切换 + 策略（idle-only|force）+ 发送后状态轮询。
 * viewer 与未选会话禁用。
 */
const props = defineProps<{ session: SessionSummary | null }>();
const emit = defineEmits<{ sent: [] }>();

const text = ref("");
const images = ref<Array<{ mime: string; dataBase64: string; name: string; previewUrl: string }>>([]);
const fileInput = ref<HTMLInputElement | null>(null);

const modelInfo = ref<ModelInfoResult | null>(null);
const modelLoading = ref(false);
const modelError = ref("");
const selectedModel = ref<{ provider: string; modelId: string } | null>(null);
const thinkingLevel = ref<string | null>(null);
const policy = ref<"idle-only" | "force">("idle-only");

const sending = ref(false);
const deliveryState = ref<DeliveryState | null>(null);
const deliveryError = ref("");
const deliveryWarnings = ref<string[]>([]);
let pollController: AbortController | null = null;

const isAdmin = computed(() => getRole() === "admin");
const disabled = computed(() => !isAdmin.value || !props.session || sending.value);
const canSend = computed(() => !disabled.value && (text.value.trim().length > 0 || images.value.length > 0));

const selectedLevels = computed(() => {
  if (!selectedModel.value) return modelInfo.value?.currentThinkingLevel ? null : null;
  const m = (modelInfo.value?.models ?? []).find((candidate) =>
    candidate.provider === selectedModel.value!.provider && candidate.modelId === selectedModel.value!.modelId);
  return m?.thinkingLevels ?? null;
});

watch(() => props.session?.id, () => resetComposer());

function resetComposer(): void {
  text.value = "";
  images.value = [];
  modelInfo.value = null;
  modelError.value = "";
  selectedModel.value = null;
  thinkingLevel.value = null;
  policy.value = "idle-only";
  deliveryState.value = null;
  deliveryError.value = "";
  deliveryWarnings.value = [];
  pollController?.abort();
}

function triggerPick(): void {
  if (disabled.value) return;
  fileInput.value?.click();
}

function onFilesPicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = input.files;
  if (files) void addFiles([...files]);
  input.value = "";
}

async function addFiles(files: File[]): Promise<void> {
  const allowed = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"];
  let remaining = 10 - images.value.length;
  for (const file of files) {
    if (remaining <= 0) { ElMessage.warning("每条消息最多 10 张图片"); break; }
    if (!allowed.includes(file.type)) { ElMessage.warning(`不支持的图片类型：${file.type}`); continue; }
    if (file.size > 10 * 1024 * 1024) { ElMessage.warning(`图片过大：${file.name}（≤10MB）`); continue; }
    const dataBase64 = await readFileAsBase64(file).catch(() => "");
    if (!dataBase64) { ElMessage.error(`读取图片失败：${file.name}`); continue; }
    images.value.push({ mime: file.type, dataBase64, name: file.name, previewUrl: `data:${file.type};base64,${dataBase64}` });
    remaining -= 1;
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function onDrop(event: DragEvent): void {
  if (disabled.value) return;
  event.preventDefault();
  const files = event.dataTransfer?.files;
  if (files) void addFiles([...files]);
}

async function openModel(): Promise<void> {
  if (disabled.value || !props.session) return;
  if (modelLoading.value) return;
  if (modelError.value) { modelError.value = ""; }
  modelLoading.value = true;
  try {
    modelInfo.value = await getModelInfo(props.session!.id);
  } catch (error) {
    modelError.value = error instanceof Error ? error.message : String(error);
  } finally {
    modelLoading.value = false;
  }
}

function onSelectModel(model: { provider: string; modelId: string } | null): void {
  selectedModel.value = model;
  thinkingLevel.value = null; // 换模型后重置思考深度选择
}

function choosePolicy(): void {
  if (!isAdmin.value) return;
  if (policy.value === "idle-only") {
    void ElMessageBox.confirm(
      "强制下发会在会话被占用时仍发送消息，请确认。",
      "强制下发",
      { type: "warning", confirmButtonText: "确认强制", cancelButtonText: "取消" },
    ).then(() => { policy.value = "force"; }).catch(() => undefined);
  } else {
    policy.value = "idle-only";
  }
}

async function send(): Promise<void> {
  if (!canSend.value || !props.session || sending.value) return;
  sending.value = true;
  deliveryState.value = "queued";
  deliveryError.value = "";
  deliveryWarnings.value = [];
  const idempotencyKey = crypto.randomUUID();
  try {
    const { deliveryId } = await sendDelivery({
      sessionId: props.session.id,
      text: text.value,
      images: images.value.map((image) => ({ mime: image.mime, dataBase64: image.dataBase64, name: image.name })),
      model: selectedModel.value,
      thinkingLevel: thinkingLevel.value,
      policy: policy.value,
      force: policy.value === "force",
      idempotencyKey,
    });
    pollController?.abort();
    pollController = new AbortController();
    await waitTerminal(deliveryId, pollController.signal);
    // waitTerminal 内部已修改 deliveryState.value；此处以字符串比较规避 TS 属性窄化。
    if (String(deliveryState.value) === "completed") {
      ElMessage.success("已发送，正文已刷新");
      text.value = "";
      images.value = [];
      selectedModel.value = null;
      thinkingLevel.value = null;
      policy.value = "idle-only";
      emit("sent");
    }
  } catch (error) {
    deliveryError.value = error instanceof Error ? error.message : String(error);
    ElMessage.error(deliveryError.value);
  } finally {
    sending.value = false;
    pollController = null;
  }
}

async function waitTerminal(deliveryId: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 11 * 60_000;
  for (;;) {
    await sleep(1000, signal);
    const record = await pollDelivery(deliveryId, signal);
    deliveryState.value = record.state;
    deliveryWarnings.value = record.warnings ?? [];
    if (record.state === "completed" || record.state === "failed" || record.state === "expired" || record.state === "canceled") {
      if (record.error) deliveryError.value = record.error.message;
      else deliveryError.value = "";
      return;
    }
    if (Date.now() > deadline) { deliveryError.value = "等待超时"; deliveryState.value = "expired"; return; }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    const timer = setTimeout(() => resolve(), ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
  });
}

const stateLabel = computed(() => {
  switch (deliveryState.value) {
    case "queued": return "排队中…";
    case "dispatched": return "已下发…";
    case "accepted": return "已接受，执行中…";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "expired": return "超时";
    case "canceled": return "已取消";
    default: return "";
  }
});

onBeforeUnmount(() => pollController?.abort());
</script>

<template>
  <div
    class="chat-composer"
    :class="{ muted: !isAdmin }"
    @dragover.prevent
    @drop="onDrop"
  >
    <div v-if="!isAdmin" class="composer-banner">只读账号无法下发</div>
    <div v-if="images.length > 0" class="composer-images">
      <div v-for="(image, index) in images" :key="index" class="composer-image">
        <img :src="image.previewUrl" :alt="image.name" />
        <el-button
          v-if="isAdmin"
          text
          size="small"
          class="composer-image-remove"
          @click="images.splice(index, 1)"
        >×</el-button>
      </div>
    </div>
    <div class="composer-toolbar">
      <el-button size="small" :disabled="disabled" @click="triggerPick">
        <el-icon><Picture /></el-icon>
        图片
      </el-button>
      <ModelSelector
        :models="modelInfo?.models ?? null"
        :current="selectedModel ?? modelInfo?.currentModel ?? null"
        :loading="modelLoading"
        :error="modelError"
        :disabled="disabled"
        @select="onSelectModel"
        @open="openModel"
      />
      <ThinkingLevelSelector
        :levels="selectedLevels"
        :current="thinkingLevel"
        :disabled="disabled"
        @select="(level: string | null) => (thinkingLevel = level)"
      />
      <el-button size="small" :disabled="!isAdmin || sending" @click="choosePolicy">
        策略：{{ policy === "force" ? "强制" : "空闲" }}
      </el-button>
      <span v-if="deliveryWarnings.length" class="composer-warnings">
        {{ deliveryWarnings.join("；") }}
      </span>
    </div>
    <div class="composer-input-row">
      <el-input
        v-model="text"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 6 }"
        :disabled="disabled"
        placeholder="输入消息，Enter 发送 / Shift+Enter 换行"
        @keydown.enter.exact.prevent="void send()"
      />
      <el-button type="primary" :disabled="!canSend" :loading="sending" @click="void send()">发送</el-button>
    </div>
    <div class="composer-status">
      <span v-if="deliveryState" class="composer-state">{{ stateLabel }}</span>
      <span v-if="deliveryError" class="composer-error">{{ deliveryError }}</span>
    </div>
    <input
      ref="fileInput"
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
      multiple
      hidden
      @change="onFilesPicked"
    />
  </div>
</template>

<style scoped>
.chat-composer { flex: 0 0 auto; border-top: 1px solid var(--border); background: var(--surface); padding: 10px 12px; position: sticky; bottom: 0; z-index: 5; }
.chat-composer.muted { opacity: 0.85; }
.composer-banner { color: var(--text-muted); font-size: 12px; margin-bottom: 6px; }
.composer-images { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.composer-image { position: relative; width: 56px; height: 56px; }
.composer-image img { width: 100%; height: 100%; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); }
.composer-image-remove { position: absolute; top: -6px; right: -6px; padding: 0 4px; background: var(--el-color-danger); color: #fff; border-radius: 50%; z-index: 2; }
.composer-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.composer-input-row { display: flex; gap: 8px; align-items: flex-end; }
.composer-status { display: flex; gap: 10px; margin-top: 6px; min-height: 16px; font-size: 12px; }
.composer-state { color: var(--text-secondary); }
.composer-error { color: var(--el-color-danger); }
.composer-warnings { color: var(--el-color-warning); font-size: 12px; }
</style>
