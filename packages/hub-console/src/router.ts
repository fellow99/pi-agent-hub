import { createRouter, createWebHistory } from "vue-router";
import Login from "./views/Login.vue";
import Sessions from "./views/Sessions.vue";
import SessionDetail from "./views/SessionDetail.vue";
import Hosts from "./views/Hosts.vue";

export const router = createRouter({
  history: createWebHistory("/hub/"),
  routes: [
    { path: "/", redirect: "/sessions" },
    { path: "/login", component: Login },
    { path: "/sessions", component: Sessions },
    { path: "/sessions/:id", component: SessionDetail },
    { path: "/hosts", component: Hosts },
  ],
});
