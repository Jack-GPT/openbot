import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/window";

export const messages = {
  // Native window titles.
  "window.localHostTitle": "OpenBot – Hôte local",
  "window.localClientTitle": "OpenBot – Client local",
  "window.computerUsePermissionTitle": "Activer Computer Use",
  "window.closePrompt": "Réduire la fenêtre OpenBot ou quitter ?",
  "window.minimize": "Réduire",
} as const satisfies PartialTranslation<typeof source>;
