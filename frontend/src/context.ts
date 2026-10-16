import { createContext, useContext } from "react";
import type { FolderRow, Page, SessionInfo, Settings } from "./types";

export interface AppContextValue {
  settings: Settings;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  folders: FolderRow[];
  reloadFolders: () => Promise<void>;
  session: SessionInfo;
  reloadSession: () => Promise<void>;
  navigate: (page: Page) => void;
  /** Ends the session on this device (or everywhere) and shows the sign-in screen. */
  signOut: (everywhere: boolean) => Promise<void>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside the app shell");
  return value;
}
