import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/window";

export const messages = {
  "window.localHostTitle": "OpenBot: локальный хост",
  "window.localClientTitle": "OpenBot: локальный клиент",
  "window.computerUsePermissionTitle": "Включите управление компьютером",
  "window.closePrompt": "Свернуть или закрыть OpenBot?",
  "window.minimize": "Свернуть",
} as const satisfies PartialTranslation<typeof source>;
