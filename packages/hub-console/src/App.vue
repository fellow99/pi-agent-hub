<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { Monitor, Moon, Sunny, UserFilled } from "@element-plus/icons-vue";
import { logout } from "./api.js";
import { useTheme, type ThemeMode } from "./composables/useTheme.js";

const route = useRoute();
const router = useRouter();
const { mode, resolvedTheme, setMode } = useTheme();

const themeOptions: Array<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "随系统主题" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

/** 主题按钮图标：按实际生效的浅/深色显示相反的提示图标。 */
const themeIcon = computed(() => (resolvedTheme.value === "dark" ? Moon : Sunny));

function onThemeCommand(command: ThemeMode): void {
  setMode(command);
}

function onUserCommand(command: string): void {
  if (command === "logout") void signOut();
}

async function signOut(): Promise<void> {
  await logout();
  await router.push("/login");
}

function notImplemented(): void {
  ElMessage.info("设置功能暂未实现");
}
</script>

<template>
  <router-view v-if="route.path === '/login'" />
  <div v-else class="app-shell">
    <header class="app-topbar">
      <div class="brand">pi-agent-hub</div>
      <span class="topbar-sub">会话查看</span>

      <div class="topbar-actions">
        <!-- 主题切换：图标 + 下拉（随系统/浅色/深色） -->
        <el-dropdown trigger="click" @command="onThemeCommand">
          <el-button text class="topbar-icon-btn" :aria-label="'切换主题'">
            <el-icon :size="18"><component :is="themeIcon" /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="option in themeOptions"
                :key="option.value"
                :command="option.value"
                :class="{ 'is-active-theme': mode === option.value }"
              >
                <el-icon class="theme-option-icon">
                  <Monitor v-if="option.value === 'system'" />
                  <Sunny v-else-if="option.value === 'light'" />
                  <Moon v-else />
                </el-icon>
                <span>{{ option.label }}</span>
                <el-icon v-if="mode === option.value" class="theme-option-check">✓</el-icon>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>

        <!-- 用户菜单：设置（暂不实现）+ 退出登录 -->
        <el-dropdown trigger="click" @command="onUserCommand">
          <el-button text class="topbar-icon-btn" aria-label="用户菜单">
            <el-icon :size="18"><UserFilled /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="settings" @click="notImplemented">设置</el-dropdown-item>
              <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>
    <main class="app-body">
      <router-view />
    </main>
  </div>
</template>
