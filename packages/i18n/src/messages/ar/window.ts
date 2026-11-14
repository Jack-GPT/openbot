import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/window";

export const messages = {
  "window.localHostTitle": "OpenBot – المضيف المحلي",
  "window.localClientTitle": "OpenBot – العميل المحلي",
  "window.computerUsePermissionTitle": "تشغيل التحكم في الحاسوب",
  "window.closePrompt": "هل تريد تصغير نافذة OpenBot أم الخروج من التطبيق؟",
  "window.minimize": "تصغير",
} as const satisfies PartialTranslation<typeof source>;
