import type { MainWindowCloseAction } from "@openbot/contracts/ipc";
import { Button, ConfirmDialog, LogOut } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, onSettled } from "solid-js";
import { appPort } from "../../app-port";

const [open, setOpen] = createSignal(false);

export function mainWindowCloseDialogOpen(): boolean {
  return open();
}

export function MainWindowCloseDialog() {
  const { t } = useText();
  const [pending, setPending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  onSettled(() => {
    const unsubscribe = appPort().onMainWindowCloseRequested(() => {
      setFailed(false);
      setOpen(true);
    });
    return () => {
      unsubscribe();
      setOpen(false);
    };
  });

  async function choose(action: MainWindowCloseAction): Promise<void> {
    if (pending()) return;
    setPending(true);
    setFailed(false);
    try {
      await appPort().resolveMainWindowClose(action);
      setOpen(false);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <ConfirmDialog
      open={mainWindowCloseDialogOpen()}
      title={t("window.closePrompt")}
      description={t("menu.quitConfirmBody")}
      icon={<LogOut />}
      tone="default"
      confirmLabel={t("menu.quitConfirm")}
      initialFocus="cancel"
      pending={pending()}
      error={failed() ? t("app.error.actionFailed") : undefined}
      onCancel={() => void choose("cancel")}
      onConfirm={() => choose("quit")}
      secondaryAction={
        <Button type="button" variant="secondary" disabled={pending()} onClick={() => void choose("minimize")}>
          {t("window.minimize")}
        </Button>
      }
    />
  );
}
