import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/window";

export const messages = {
  "window.localHostTitle": "OpenBot — host locale",
  "window.localClientTitle": "OpenBot — client locale",
  "window.computerUsePermissionTitle": "Attiva il Controllo del computer",
  "window.closePrompt": "Ridurre a icona OpenBot o uscire?",
  "window.minimize": "Riduci a icona",
} as const satisfies PartialTranslation<typeof source>;
