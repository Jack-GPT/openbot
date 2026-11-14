import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/window";

export const messages = {
  // Native window titles.
  "window.localHostTitle": "OpenBot ローカルホスト",
  "window.localClientTitle": "OpenBot ローカルクライアント",
  "window.computerUsePermissionTitle": "Computer Use をオンにする",
  "window.closePrompt": "OpenBot を最小化しますか？ それとも終了しますか？",
  "window.minimize": "最小化",
} as const satisfies PartialTranslation<typeof source>;
