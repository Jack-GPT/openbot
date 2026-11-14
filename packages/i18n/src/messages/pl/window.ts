import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/window";

export const messages = {
  "window.localHostTitle": "OpenBot – lokalny host",
  "window.localClientTitle": "OpenBot – lokalny klient",
  "window.computerUsePermissionTitle": "Włącz Sterowanie komputerem",
  "window.closePrompt": "Zminimalizować czy zamknąć OpenBot?",
  "window.minimize": "Minimalizuj",
} as const satisfies PartialTranslation<typeof source>;
