import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { AppTextKey } from "@openbot/i18n";
import { createSignal } from "solid-js";
import { currentDevicePlatform } from "../../send-shortcut-preference";

export const APP_SHORTCUTS = {
  globalSearch: { label: "conversation.globalSearch.title", key: "K" },
  chatSearch: { label: "chat.search.label", key: "F" },
  settings: { label: "conversation.globalSearch.appSettings", key: "," },
  back: { label: "sidebar.topbar.back", key: "ArrowLeft" },
  forward: { label: "sidebar.topbar.forward", key: "ArrowRight" },
} as const satisfies Record<string, { label: AppTextKey; key: string }>;

export type AppShortcutId = keyof typeof APP_SHORTCUTS;
export const appShortcutIds = Object.keys(APP_SHORTCUTS).filter((id): id is AppShortcutId =>
  Object.hasOwn(APP_SHORTCUTS, id),
);
const STORAGE_KEY = "openbot:app-shortcuts";
type Bindings = Partial<Record<AppShortcutId, string>>;
type ShortcutKey = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

export function shortcutFromKey(event: ShortcutKey): string {
  const letter = /^(?:Key[A-Z]|Digit[0-9])$/u.test(event.code) ? event.code.at(-1) : undefined;
  const key =
    letter ?? (event.key === " " ? "Space" : /^[a-z]$/i.test(event.key) ? event.key.toUpperCase() : event.key);
  return `${event.ctrlKey ? "Control+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}${event.metaKey ? "Super+" : ""}${key ?? ""}`;
}

export function isAppShortcut(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?=(?:Control|Alt|Super)\+|Shift\+Super\+)(?:Control\+)?(?:Alt\+)?(?:Shift\+)?(?:Super\+)?(?:[A-Z0-9,.[\]]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Arrow(?:Left|Right|Up|Down))$/u.test(
      value,
    )
  );
}

function readBindings(): Bindings {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    const bindings: Bindings = {};
    if (!isDynamicRecord(saved)) return bindings;
    for (const id of appShortcutIds) {
      const shortcut = saved[id];
      if (isAppShortcut(shortcut)) bindings[id] = shortcut;
    }
    return bindings;
  } catch {
    return {};
  }
}

const [bindings, setBindings] = createSignal(readBindings());

function syncBindings(event: StorageEvent) {
  if (event.key === STORAGE_KEY || event.key === null) setBindings(readBindings());
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", syncBindings);
  import.meta.hot?.dispose(() => window.removeEventListener("storage", syncBindings));
}

function defaultShortcut(id: AppShortcutId, mac: boolean): string {
  if (id === "back") return mac ? "Super+[" : "Alt+ArrowLeft";
  if (id === "forward") return mac ? "Super+]" : "Alt+ArrowRight";
  return `${mac ? "Super" : "Control"}+${APP_SHORTCUTS[id].key}`;
}

export function appShortcut(id: AppShortcutId, mac = currentDevicePlatform() === "darwin"): string {
  return bindings()[id] ?? defaultShortcut(id, mac);
}

export function matchesAppShortcut(
  id: AppShortcutId,
  event: ShortcutKey,
  mac = currentDevicePlatform() === "darwin",
): boolean {
  const shortcut = shortcutFromKey(event);
  const custom = bindings()[id];
  if (custom) return shortcut === custom;
  if (id === "back" || id === "forward") return shortcut === defaultShortcut(id, mac);
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key?.toUpperCase() === APP_SHORTCUTS[id].key
  );
}

export function saveAppShortcut(id: AppShortcutId, shortcut: string): void {
  const next = { ...bindings(), [id]: shortcut };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  setBindings(next);
}

export function resetAppShortcuts(): void {
  window.localStorage.removeItem(STORAGE_KEY);
  setBindings({});
}

export function appShortcutIsTaken(id: AppShortcutId | null, shortcut: string): boolean {
  if (/^(?:Control|Super)\+[1-9]$/u.test(shortcut)) return true;
  return appShortcutIds.some((other) => {
    if (other === id) return false;
    if (appShortcut(other) === shortcut) return true;
    return (
      !bindings()[other] &&
      other !== "back" &&
      other !== "forward" &&
      (shortcut === `Control+${APP_SHORTCUTS[other].key}` || shortcut === `Super+${APP_SHORTCUTS[other].key}`)
    );
  });
}

export function shortcutKeyLabels(shortcut: string, platform: string | undefined): string[] {
  const labels: Record<string, string> = {
    Control: "Ctrl",
    Super: platform === "darwin" ? "⌘" : platform === "win32" ? "Win" : "Super",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
  };
  return shortcut.split("+").map((key) => labels[key] ?? key);
}
