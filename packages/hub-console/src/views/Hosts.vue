<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../api.js";

interface HostRow {
  id: string;
  name: string;
  labels?: string[];
}

const hosts = ref<HostRow[]>([]);
const error = ref("");

onMounted(async () => {
  try {
    const result = await api<{ items: HostRow[] }>("/api/hub/hosts");
    hosts.value = result.items;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
});
</script>

<template>
  <div class="page">
    <h2>Hosts</h2>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-table :data="hosts" stripe>
      <el-table-column prop="name" label="Host" />
      <el-table-column prop="id" label="Token name" />
      <el-table-column label="Labels">
        <template #default="{ row }">{{ (row.labels ?? []).join(", ") }}</template>
      </el-table-column>
    </el-table>
  </div>
</template>
