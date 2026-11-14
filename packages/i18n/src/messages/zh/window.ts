import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/window";

export const messages = {
  // Native window titles.
  "window.localHostTitle": "OpenBot 本地主机",
  "window.localClientTitle": "OpenBot 本地客户端",
  "window.computerUsePermissionTitle": "开启 Computer Use",
  "window.closePrompt": "最小化窗口还是退出 OpenBot？",
  "window.minimize": "最小化",
} as const satisfies PartialTranslation<typeof source>;
