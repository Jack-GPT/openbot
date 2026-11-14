import { type AppInfo, DEFAULT_VOICE_SHORTCUT, isVoiceShortcut } from "@openbot/contracts/ipc";
import { Button, ItemGroup, toast } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, For, onSettled } from "solid-js";
import { currentDevicePlatform } from "../../send-shortcut-preference";
import { speechPort } from "../speech/speech-port";
import {
  APP_SHORTCUTS,
  type AppShortcutId,
  appShortcut,
  appShortcutIds,
  appShortcutIsTaken,
  isAppShortcut,
  resetAppShortcuts,
  saveAppShortcut,
} from "./app-shortcuts";
import { ShortcutSettingRow } from "./ShortcutSettingRow";

export function SettingsShortcutsTab(props: { platform: AppInfo["platform"] | undefined }) {
  const { t, errorMessage } = useText();
  const platform = () => props.platform ?? currentDevicePlatform();
  const [voice, setVoice] = createSignal<string | null>();
  const [saving, setSaving] = createSignal(false);
  let pending = false;
  onSettled(() => {
    void speechPort()
      .voice.getShortcut()
      .then(setVoice, (error: unknown) => {
        toast.error(errorMessage(error, t("settings.preferences.loadFailed")));
      });
  });

  async function apply(action: () => Promise<void>) {
    if (pending) return;
    pending = true;
    setSaving(true);
    try {
      await action();
    } catch (error) {
      toast.error(errorMessage(error, t("settings.preferences.saveFailed")));
    } finally {
      pending = false;
      setSaving(false);
    }
  }

  async function saveVoice(shortcut: string) {
    if (!isVoiceShortcut(shortcut)) throw new Error(t("error.voice.shortcut.invalid"));
    if (appShortcutIsTaken(null, shortcut)) throw new Error(t("settings.shortcuts.conflict"));
    setVoice(await speechPort().voice.setShortcut(shortcut));
  }

  async function saveAppBinding(id: AppShortcutId, shortcut: string) {
    if (!isAppShortcut(shortcut)) throw new Error(t("settings.shortcuts.invalid"));
    const activeVoice = await speechPort().voice.getShortcut();
    if (appShortcutIsTaken(id, shortcut) || shortcut === activeVoice) {
      throw new Error(t("settings.shortcuts.conflict"));
    }
    saveAppShortcut(id, shortcut);
  }

  async function resetAll() {
    const port = speechPort().voice;
    const previous = await port.getShortcut();
    setVoice(await port.setShortcut(DEFAULT_VOICE_SHORTCUT));
    try {
      resetAppShortcuts();
    } catch (error) {
      if (previous !== DEFAULT_VOICE_SHORTCUT) setVoice(await port.setShortcut(previous));
      throw error;
    }
  }

  return (
    <>
      <Button
        class="settings-shortcuts-reset"
        type="button"
        variant="outline"
        size="sm"
        disabled={saving()}
        onClick={() => void apply(resetAll)}
      >
        {t("settings.shortcuts.reset")}
      </Button>
      <ItemGroup class="settings-modal-card settings-shortcuts-list">
        <ShortcutSettingRow
          labelKey="settings.voiceShortcut.title"
          platform={platform()}
          value={voice()}
          disabled={saving()}
          onSave={(shortcut) => void apply(() => saveVoice(shortcut))}
        />
        <For each={appShortcutIds}>
          {(id) => (
            <ShortcutSettingRow
              labelKey={APP_SHORTCUTS[id].label}
              platform={platform()}
              value={appShortcut(id, platform() === "darwin")}
              disabled={saving()}
              onSave={(shortcut) => void apply(() => saveAppBinding(id, shortcut))}
            />
          )}
        </For>
      </ItemGroup>
    </>
  );
}
