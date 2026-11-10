<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listAgents, type AgentRow } from "../api.js";

const agents = ref<AgentRow[]>([]);
const error = ref("");
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    agents.value = await listAgents();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

function capFlags(capabilities: Record<string, unknown>): string {
  const picks = ["collect", "deliver", "import", "losslessImport", "exportNative", "watch"];
  return picks
    .filter((key) => capabilities[key] === true)
    .map((key) => key)
    .join(", ");
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px">
      <h2 style="margin: 0">Agents</h2>
      <el-button size="small" @click="load" :loading="loading">Refresh</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-table v-if="agents.length > 0" :data="agents" stripe>
      <el-table-column prop="hostId" label="Host" width="160" />
      <el-table-column prop="kind" label="Kind" width="90" />
      <el-table-column prop="displayName" label="Instance" width="120" />
      <el-table-column prop="id" label="Agent ID" min-width="220" show-overflow-tooltip />
      <el-table-column prop="version" label="Version" width="80" />
      <el-table-column label="Capabilities" min-width="160">
        <template #default="{ row }">{{ capFlags(row.capabilities ?? {}) || "—" }}</template>
      </el-table-column>
      <el-table-column prop="homeDir" label="Home dir" min-width="220" show-overflow-tooltip />
      <el-table-column label="Status" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'online' ? 'success' : 'info'" size="small">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="Last seen" width="180">
        <template #default="{ row }">
          {{ row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : "—" }}
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-else-if="!loading && !error" description="No agents reported yet. Start the sync-daemon to register agents." />
  </div>
</template>
