import { computed, ref, watch } from "vue";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "pi-agent-hub.theme";
const VALID_MODES: readonly ThemeMode[] = ["system", "light", "dark"];

function readStoredMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored && (VALID_MODES as readonly string[]).includes(stored) ? (stored as ThemeMode) : "system";
}

function currentSystemTheme(): ResolvedTheme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 模块级单例：整个 SPA 共享同一份主题状态（含 md-editor-v3 联动）。 */
const mode = ref<ThemeMode>(readStoredMode());
const systemTheme = ref<ResolvedTheme>(currentSystemTheme());

// 随系统主题变化实时更新（仅当用户选择「随系统主题」时影响最终外观）
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
  systemTheme.value = event.matches ? "dark" : "light";
});

/** 实际生效的浅色/深色主题，供 MdPreview 的 theme prop 与 html.dark class 消费。 */
const resolvedTheme = computed<ResolvedTheme>(() =>
  mode.value === "system" ? systemTheme.value : mode.value,
);

function applyDocumentClass(theme: ResolvedTheme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

watch(resolvedTheme, applyDocumentClass, { immediate: true });
watch(mode, (value) => localStorage.setItem(STORAGE_KEY, value));

export function useTheme(): {
  mode: typeof mode;
  resolvedTheme: typeof resolvedTheme;
  setMode: (next: ThemeMode) => void;
} {
  return {
    mode,
    resolvedTheme,
    setMode(next: ThemeMode): void {
      mode.value = next;
    },
  };
}
