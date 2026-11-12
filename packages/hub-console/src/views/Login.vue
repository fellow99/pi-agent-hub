<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { login } from "../api.js";

const router = useRouter();
const username = ref("admin");
const password = ref("");
const error = ref("");
const busy = ref(false);

async function submit(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    await login(username.value, password.value);
    await router.push("/");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login">
    <h2>Sign in</h2>
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item label="Username">
        <el-input v-model="username" autocomplete="username" />
      </el-form-item>
      <el-form-item label="Password">
        <el-input v-model="password" type="password" show-password autocomplete="current-password" />
      </el-form-item>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-button type="primary" native-type="submit" :loading="busy" style="width: 100%; margin-top: 12px">
        Sign in
      </el-button>
    </el-form>
  </div>
</template>
