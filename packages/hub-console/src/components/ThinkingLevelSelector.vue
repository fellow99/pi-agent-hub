<script setup lang="ts">
import { computed, ref } from "vue";

/**
 * 思考深度选择器（agent 特定 string 档位，来自 006 selectedModel.thinkingLevels）。
 * 顶部「跟随会话默认」= emit(null)；档位按所选模型过滤。
 */
const props = withDefaults(defineProps<{
  levels?: string[] | null;
  current?: string | null;
  disabled?: boolean;
}>(), { levels: null, current: null, disabled: false });

const emit = defineEmits<{ select: [level: string | null] }>();
const open = ref(false);

const items = computed(() => props.levels ?? []);

const currentLabel = computed(() => {
  if (props.current !== null && props.current !== undefined && items.value.length > 0 && items.value.includes(props.current)) {
    return props.current;
  }
  return "跟随会话默认";
});

function pick(level: string | null): void {
  open.value = false;
  emit("select", level);
}
</script>

<template>
  <el-dropdown trigger="click" :disabled="disabled" @visible-change="(v: boolean) => (open = v)">
    <el-button size="small" :disabled="disabled">
      <span class="sel-label">思考</span>
      <span class="sel-value">{{ currentLabel }}</span>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item :class="{ active: current === null || current === undefined }" @click="pick(null)">
          跟随会话默认
        </el-dropdown-item>
        <el-dropdown-item
          v-for="level in items"
          :key="level"
          :class="{ active: current === level }"
          @click="pick(level)"
        >
          {{ level }}
        </el-dropdown-item>
        <el-dropdown-item v-if="items.length === 0" disabled>当前模型无思考深度选项</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
.sel-label { margin-right: 6px; color: var(--text-secondary); }
.sel-value { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:deep(.el-dropdown-menu__item.active) { background: var(--el-color-primary-light-9); font-weight: 600; }
</style>
