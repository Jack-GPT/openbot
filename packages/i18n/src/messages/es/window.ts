import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/window";

export const messages = {
  "window.localHostTitle": "Host local de OpenBot",
  "window.localClientTitle": "Cliente local de OpenBot",
  "window.computerUsePermissionTitle": "Activar el uso del equipo",
  "window.closePrompt": "¿Minimizar OpenBot o salir?",
  "window.minimize": "Minimizar",
} as const satisfies PartialTranslation<typeof source>;
