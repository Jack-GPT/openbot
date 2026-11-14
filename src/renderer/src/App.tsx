import { NotificationObserver, Toaster } from "@openbot/ui";
import { AppAccessGate } from "./AppView";
import { type AppProps, AppProviders } from "./app-providers";
import { reportNotification } from "./error-reports";
import { MainWindowCloseDialog } from "./features/window/MainWindowCloseDialog";

export function App(props: AppProps = {}) {
  return (
    <NotificationObserver onShown={reportNotification}>
      <AppProviders
        landingPreview={props.landingPreview}
        peopleEnabled={props.peopleEnabled}
        chatWindow={props.chatWindow}
      >
        <AppAccessGate />
        {props.chatWindow || props.landingPreview ? null : <MainWindowCloseDialog />}
      </AppProviders>
      <Toaster onToastShown={reportNotification} />
    </NotificationObserver>
  );
}
