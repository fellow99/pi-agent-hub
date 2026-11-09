<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { listSessions, type SessionSummary } from "../api.js";

const router = useRouter();
const sessions = ref<SessionSummary[]>([]);
const error = ref("");
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    sessions.value = await listSessions();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

function open(row: SessionSummary): void {
  void router.push(`/sessions/${row.id}`);
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px">
      <h2 style="margin: 0">Sessions</h2>
      <el-button size="small" @click="load" :loading="loading">Refresh</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-table :data="sessions" stripe @row-click="open" style="cursor: pointer">
      <el-table-column prop="hostId" label="Host" width="160" />
      <el-table-column prop="agentId" label="Agent" width="180" />
      <el-table-column prop="cwd" label="Project" min-width="220" />
      <el-table-column prop="title" label="Title" min-width="220" />
      <el-table-column prop="entryCount" label="Entries" width="100" />
      <el-table-column label="Last seen" width="180">
        <template #default="{ row }">
          {{ row.lastTimestamp ? new Date(row.lastTimestamp).toLocaleString() : "—" }}
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
