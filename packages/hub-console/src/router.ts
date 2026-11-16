import { createRouter, createWebHistory } from "vue-router";
import Login from "./views/Login.vue";
import Viewer from "./views/Viewer.vue";
import { getCsrf } from "./api.js";
import { currentAppBase } from "./base-path.js";

// history base 运行时推导：直连为 /hub/，子路径反代为 <前缀>/hub/
export const router = createRouter({
  history: createWebHistory(currentAppBase()),
  routes: [
    { path: "/login", component: Login },
    { path: "/", component: Viewer, meta: { requiresAuth: true } },
    // 旧版 /sessions /agents /hosts 链接统一兜底到查看器（FR-202 验收场景）
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach((to) => {
  if (to.meta.requiresAuth && !getCsrf()) return { path: "/login" };
  if (to.path === "/login" && getCsrf()) return { path: "/" };
  return true;
});
