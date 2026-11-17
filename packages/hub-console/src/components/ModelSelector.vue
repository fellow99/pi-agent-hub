<script setup lang="ts">
import { computed, ref } from "vue";
import type { ModelInfoEntry } from "../api.js";

/**
 * 模型选择器（消费 006 ModelInfoResult）。
 * 顶部「跟随会话当前」= emit(null)；选中具体模型 = emit({provider, modelId})。
 */
const props = withDefaults(defineProps<{
  models?: ModelInfoEntry[] | null;
  current?: { provider: string; modelId: string } | null;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
}>(), { models: null, current: null, loading: false, error: null, disabled: false });

const emit = defineEmits<{ select: [model: { provider: string; modelId: string } | null]; open: [] }>();

const open = ref(false);
const filter = ref("");

const groups = computed(() => {
  const list = props.models ?? [];
  const filtered = filter.value.trim()
    ? list.filter((m) => `${m.name} ${m.provider} ${m.modelId}`.toLocaleLowerCase().includes(filter.value.trim().toLocaleLowerCase()))
    : list;
  const result: { provider: string; items: ModelInfoEntry[] }[] = [];
  for (const m of filtered) {
    const group = result.find((g) => g.provider === m.provider);
    if (group) group.items.push(m);
    else result.push({ provider: m.provider, items: [m] });
  }
  return result;
});

const currentLabel = computed(() => {
  if (!props.current) return "跟随会话当前";
  const m = (props.models ?? []).find((candidate) =>
    candidate.provider === props.current?.provider && candidate.modelId === props.current?.modelId);
  return m?.name ?? `${props.current.provider}/${props.current.modelId}`;
});

function toggle(): void {
  if (props.disabled) return;
  if (!open.value) emit("open");
  open.value = !open.value;
}

function select(model: { provider: string; modelId: string } | null): void {
  open.value = false;
  emit("select", model);
}
</script>

<template>
  <el-popover
    :visible="open"
    :width="300"
    trigger="manual"
    :disabled="disabled"
    @show="() => {}"
  >
    <template #reference>
      <el-button
        size="small"
        :disabled="disabled || loading"
        :loading="loading"
        @click="toggle"
      >
        <span class="sel-label">模型</span>
        <span class="sel-value" :title="currentLabel">{{ currentLabel }}</span>
      </el-button>
    </template>

    <div class="model-selector">
      <el-input
        v-if="(models?.length ?? 0) > 8"
        v-model="filter"
        size="small"
        placeholder="过滤模型"
        clearable
      />
      <div v-if="error" class="selector-error">{{ error }}</div>
      <el-empty v-else-if="!models || models.length === 0" description="无可用模型" :image-size="48" />
      <div v-else class="model-groups">
        <div v-for="group in groups" :key="group.provider" class="model-group">
          <div class="model-group-title">{{ group.provider }}</div>
          <div
            v-for="m in group.items"
            :key="`${m.provider}:${m.modelId}`"
            class="model-item"
            :class="{ active: current?.provider === m.provider && current?.modelId === m.modelId }"
            @click="select({ provider: m.provider, modelId: m.modelId })"
          >
            <span class="model-item-name">{{ m.name }}</span>
            <el-tag v-if="!m.reasoning" size="small" type="info">无思考</el-tag>
          </div>
        </div>
        <div class="model-follow" @click="select(null)">
          <span>跟随会话当前</span>
          <el-tag v-if="!current" size="small" type="success">当前</el-tag>
        </div>
      </div>
    </div>
  </el-popover>
</template>

<style scoped>
.sel-label { margin-right: 6px; color: var(--text-secondary); }
.sel-value { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-groups { max-height: 280px; overflow: auto; }
.model-group-title { font-size: 11px; color: var(--text-muted); padding: 4px 0; }
.model-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.model-item:hover { background: var(--el-fill-color-light); }
.model-item.active { background: var(--el-color-primary-light-9); }
.model-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-follow { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; padding: 6px 8px; border-top: 1px dashed var(--border); cursor: pointer; }
.model-follow:hover { background: var(--el-fill-color-light); }
.selector-error { color: var(--el-color-danger); font-size: 12px; padding: 4px 0; }
</style>
