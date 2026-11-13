import { release } from "node:os";
import {
  type AppAppearancePreference,
  DEFAULT_APP_APPEARANCE,
  DEFAULT_TRANSPARENT_WINDOW,
  selectedThemePalette,
} from "@openbot/contracts/app-appearance";
import { type BrowserWindow, type BrowserWindowConstructorOptions, nativeTheme } from "electron";

/** The light canvas, `--openbot-bg-canvas` in `tokens-light.css`, so a light window opens without a dark frame. */
const LIGHT_WINDOW_BACKGROUND = "#f5f5f6";

/** The macOS material behind a transparent main window. The page paints its own tint over it. */
const GLASS_VIBRANCY = "under-window";
const WORKSPACE_HEADER_HEIGHT = 38;

/** Electron supports system backdrops on Windows 11 22H2 and later. */
export const supportsWindowMaterial = process.platform === "win32" && Number(release().split(".")[2]) >= 22621;

let current: AppAppearancePreference = {
  appearance: DEFAULT_APP_APPEARANCE,
  transparentWindow: DEFAULT_TRANSPARENT_WINDOW,
  palette: null,
  palettes: [],
  chatBackgroundLight: null,
  chatBackgroundDark: null,
  interfaceFont: null,
  codeFont: null,
};
const listeners = new Set<() => void>();

/**
 * Sets the appearance that window backgrounds follow. While the window is opaque, main leaves
 * `nativeTheme.themeSource` on the system: visited websites and the native menus follow the computer.
 * The blur behind a transparent window takes its light or dark shade from `themeSource`, so while the
 * window is transparent, `themeSource` follows the appearance, or the scheme of the selected theme
 * palette, and websites and menus follow it too.
 * Main reports `transparentWindow` as `false` where the window cannot blur.
 */
export function setWindowAppearance(preference: AppAppearancePreference): void {
  current = { ...preference };
  const appearance = selectedThemePalette(preference)?.scheme ?? preference.appearance;
  nativeTheme.themeSource = preference.transparentWindow ? appearance : "system";
  for (const listener of listeners) listener();
}

/**
 * The background a window shows before its page paints, and around it while it resizes. A theme
 * palette gives its own canvas, without its alpha: Electron reads eight hex digits as `#aarrggbb`,
 * and the window under the page is opaque.
 */
export function windowBackgroundColor(darkColor: string): string {
  const palette = selectedThemePalette(current);
  if (palette !== null) return palette.colors.canvas.slice(0, 7);
  const dark = current.appearance === "system" ? nativeTheme.shouldUseDarkColors : current.appearance === "dark";
  return dark ? darkColor : LIGHT_WINDOW_BACKGROUND;
}

function windowControlColor() {
  const appearance = selectedThemePalette(current)?.scheme ?? current.appearance;
  const dark = appearance === "system" ? nativeTheme.shouldUseDarkColors : appearance === "dark";
  return dark ? "#ffffff" : "#171717";
}

export function windowsTitleBarOptions(): BrowserWindowConstructorOptions {
  return process.platform === "win32"
    ? {
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#00000000", symbolColor: windowControlColor(), height: WORKSPACE_HEADER_HEIGHT },
      }
    : {};
}

/** Match the overlay height to the workspace toolbar when the interface size changes. */
export function setWorkspaceWindowZoom(window: BrowserWindow, zoomFactor: number): void {
  window.webContents.setZoomFactor(zoomFactor);
  if (process.platform === "win32") {
    window.setTitleBarOverlay({ height: Math.round(WORKSPACE_HEADER_HEIGHT * zoomFactor) });
  }
}

/** Keeps an opaque window's background on the current appearance until the window closes. */
export function followAppearance(window: BrowserWindow, darkColor: string): void {
  const update = () => {
    if (!window.isDestroyed()) window.setBackgroundColor(windowBackgroundColor(darkColor));
  };
  follow(window, update);
}

/** Sets the saved transparent window choice before the first window is built, so it is built with the blur. */
export function setInitialWindowGlass(transparentWindow: boolean): void {
  current = { ...current, transparentWindow };
}

/**
 * The constructor options of a window that `followWindowGlass` follows. Electron makes a macOS window
 * translucent only when it is built with vibrancy. A window that gets its vibrancy later stays opaque
 * to the compositor, which then draws the translucent page over what it drew before: on macOS 26 and
 * later the previous chat shows through and the window flickers. A window built with vibrancy and no
 * background color gets a clear background from Electron.
 */
export function glassWindowOptions(darkColor: string): BrowserWindowConstructorOptions {
  const material = current.windowMaterial;
  if (supportsWindowMaterial && material && material !== "solid") {
    return { backgroundMaterial: material, backgroundColor: "#00000000" };
  }
  return process.platform === "darwin" && current.transparentWindow
    ? { vibrancy: GLASS_VIBRANCY }
    : { backgroundColor: windowBackgroundColor(darkColor) };
}

/**
 * Keeps the workspace window and its native controls on the current appearance.
 */
export function followWindowGlass(window: BrowserWindow, darkColor: string): void {
  // The window is built with `glassWindowOptions`, so it has the blur when the preference is on. A
  // window built opaque takes the blur here when the preference turns on later.
  let glass = current.transparentWindow;
  let material = current.windowMaterial;
  let controlColor = windowControlColor();
  const update = () => {
    if (window.isDestroyed()) return;
    if (process.platform === "win32") {
      if (supportsWindowMaterial && current.windowMaterial !== material) {
        material = current.windowMaterial;
        window.setBackgroundMaterial(material === "mica" || material === "acrylic" ? material : "none");
      }
      const nextControlColor = windowControlColor();
      if (nextControlColor !== controlColor) {
        controlColor = nextControlColor;
        window.setTitleBarOverlay({ symbolColor: controlColor });
      }
    }
    if (process.platform === "darwin" && current.transparentWindow !== glass) {
      window.setVibrancy(current.transparentWindow ? GLASS_VIBRANCY : null);
    }
    glass = current.transparentWindow;
    window.setBackgroundColor(glass ? "#00000000" : windowBackgroundColor(darkColor));
  };
  update();
  follow(window, update);
}

function follow(window: BrowserWindow, update: () => void): void {
  nativeTheme.on("updated", update);
  listeners.add(update);
  window.once("closed", () => {
    nativeTheme.off("updated", update);
    listeners.delete(update);
  });
}
