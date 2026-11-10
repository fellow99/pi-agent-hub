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
  <el-container class="app-shell">
    <el-header class="app-header">
      <div class="brand">pi-agent-hub</div>
      <el-menu mode="horizontal" :default-active="route.path" router class="app-menu">
        <el-menu-item index="/sessions">Sessions</el-menu-item>
        <el-menu-item index="/agents">Agents</el-menu-item>
        <el-menu-item index="/hosts">Hosts</el-menu-item>
      </el-menu>
      <el-button text @click="signOut">Sign out</el-button>
    </el-header>
    <el-main>
      <router-view />
    </el-main>
  </el-container>
</template>
