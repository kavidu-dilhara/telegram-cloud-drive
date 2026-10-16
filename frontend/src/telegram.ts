/** Thin, safe wrapper around the Telegram Mini App API. Every call is a no-op outside Telegram. */
interface TelegramWebApp {
  initData: string;
  colorScheme?: "light" | "dark";
  ready: () => void;
  expand: () => void;
  disableVerticalSwipes?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  setBottomBarColor?: (color: string) => void;
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
  openTelegramLink?: (url: string) => void;
  HapticFeedback?: {
    impactOccurred: (style: "light" | "medium" | "heavy") => void;
    notificationOccurred: (type: "error" | "success" | "warning") => void;
  };
  BackButton?: {
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const webApp = () => window.Telegram?.WebApp;

export const telegramInitData = () => webApp()?.initData ?? "";
export const telegramScheme = () => webApp()?.colorScheme;

export function initTelegram() {
  const app = webApp();
  if (!app) return;
  app.ready();
  app.expand();
  // Scrolling at the top of a list must not close the Mini App.
  app.disableVerticalSwipes?.();
}

export function onTelegramThemeChange(handler: () => void) {
  const app = webApp();
  app?.onEvent?.("themeChanged", handler);
  return () => app?.offEvent?.("themeChanged", handler);
}

/** Matches Telegram's own header, background and bottom bar to the app colours. */
export function paintTelegramChrome(background: string, bottom: string) {
  const app = webApp();
  app?.setHeaderColor?.(background);
  app?.setBackgroundColor?.(background);
  app?.setBottomBarColor?.(bottom);
}

export const haptic = {
  success: () => webApp()?.HapticFeedback?.notificationOccurred("success"),
  error: () => webApp()?.HapticFeedback?.notificationOccurred("error"),
  tap: () => webApp()?.HapticFeedback?.impactOccurred("light"),
};

export function shareViaTelegram(url: string, text: string) {
  const link = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  const app = webApp();
  if (app?.openTelegramLink) app.openTelegramLink(link);
  else window.open(link, "_blank", "noopener,noreferrer");
}

// One back button shared by every screen: the most recently pushed handler wins.
const backStack: Array<() => void> = [];
const dispatchBack = () => backStack.at(-1)?.();
let backBound = false;

function syncBackButton() {
  const button = webApp()?.BackButton;
  if (!button) return;
  if (!backBound) {
    button.onClick(dispatchBack);
    backBound = true;
  }
  if (backStack.length) button.show();
  else button.hide();
}

/** Registers a handler for Telegram's Back button; returns the function that removes it. */
export function pushBack(handler: () => void) {
  backStack.push(handler);
  syncBackButton();
  return () => {
    const index = backStack.lastIndexOf(handler);
    if (index >= 0) backStack.splice(index, 1);
    syncBackButton();
  };
}
