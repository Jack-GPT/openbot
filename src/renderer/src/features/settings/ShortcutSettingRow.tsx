import type { AppInfo } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { Button, Item, ItemActions, ItemContent, ItemTitle, Kbd } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, For, Show } from "solid-js";
import { shortcutFromKey, shortcutKeyLabels } from "./app-shortcuts";

export function ShortcutSettingRow(props: {
  labelKey: AppTextKey;
  platform: AppInfo["platform"] | undefined;
  value: string | null | undefined;
  disabled: boolean;
  onSave: (value: string) => void;
}) {
  const { t } = useText();
  const [recording, setRecording] = createSignal(false);

  function record(event: KeyboardEvent) {
    if (!recording() || event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || ["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
    setRecording(false);
    if (event.key !== "Escape") props.onSave(shortcutFromKey(event));
  }

  return (
    <Item data-settings-row={props.labelKey} class="settings-shortcut-row">
      <ItemContent>
        <ItemTitle>{t(props.labelKey)}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <Button
          type="button"
          variant="ghost"
          class="settings-shortcut-trigger"
          aria-label={t(props.labelKey)}
          aria-pressed={recording() ? "true" : "false"}
          disabled={props.disabled || props.value === undefined}
          onClick={(event) => {
            event.currentTarget.focus();
            setRecording(true);
          }}
          onKeyDown={record}
          onBlur={() => setRecording(false)}
        >
          <Show when={!recording()} fallback={<Kbd role="status">{t("settings.voiceShortcut.record")}</Kbd>}>
            <Show
              when={props.value}
              fallback={<Kbd>{t(props.value === undefined ? "common.loading" : "settings.voiceShortcut.off")}</Kbd>}
            >
              {(value) => (
                <span class="settings-shortcut-keys" dir="ltr">
                  <For each={shortcutKeyLabels(value(), props.platform)}>{(key) => <Kbd>{key}</Kbd>}</For>
                </span>
              )}
            </Show>
          </Show>
        </Button>
      </ItemActions>
    </Item>
  );
}
