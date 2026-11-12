import { createContext, useContext, useEffect, useState } from "react";
import type { Contest } from "./api";

// ---- routing: #/path/segments ----

export function useRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

export const go = (path: string) => {
  location.hash = path.startsWith("/") ? path : `/${path}`;
};

// ---- app-wide state: who is signed in, the contests, and which one is selected ----

export interface AppState {
  bot: string;
  contests: Contest[];
  reloadContests: () => Promise<void>;
  /** The contest the data pages show. */
  contest: Contest | null;
  selectContest: (id: number) => void;
}

export const AppContext = createContext<AppState | null>(null);
export const useApp = () => useContext(AppContext)!;

