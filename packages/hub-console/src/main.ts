import { createApp } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
// Element Plus 官方深色变量（由 <html class="dark"> 激活，见 composables/useTheme.ts）
import "element-plus/theme-chalk/dark/css-vars.css";
import App from "./App.vue";
import { router } from "./router.js";
import "./styles.css";

createApp(App).use(ElementPlus).use(router).mount("#app");
