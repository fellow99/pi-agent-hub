<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
import { logout } from "./api.js";

const route = useRoute();
const router = useRouter();

async function signOut(): Promise<void> {
  await logout();
  await router.push("/login");
}
</script>

<template>
  <router-view v-if="route.path === '/login'" />
  <div v-else class="app-shell">
    <header class="app-topbar">
      <div class="brand">pi-agent-hub</div>
      <span class="topbar-sub">session 上下文查看器（只读）</span>
      <el-button text class="signout" @click="signOut">Sign out</el-button>
    </header>
    <main class="app-body">
      <router-view />
    </main>
  </div>
</template>
