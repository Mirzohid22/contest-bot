import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Contest, useLoad } from "./api";
import { AppContext, type AppState, useRoute } from "./app";
import { Broadcasts } from "./pages/Broadcasts";
import { ContestEditor } from "./pages/ContestEditor";
import { Contests } from "./pages/Contests";
import { Leaderboard } from "./pages/Leaderboard";
import { Overview } from "./pages/Overview";
import { Participants } from "./pages/Participants";
import { System } from "./pages/System";
import { Icon, Loading, StatusBadge, UiProvider } from "./ui";
import "./styles.css";

const NAV = [
  { path: "", label: "Overview", icon: "overview" },
  { path: "contests", label: "Contests", icon: "trophy" },
  { path: "participants", label: "Participants", icon: "users" },
  { path: "leaderboard", label: "Leaderboard", icon: "medal" },
  { path: "broadcasts", label: "Broadcasts", icon: "send" },
  { path: "system", label: "System", icon: "activity" },
];

type Theme = "system" | "light" | "dark";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the setting just is not remembered */
  }
}

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => (readStored("theme") as Theme) || "system");
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    store("theme", theme);
  }, [theme]);
  return [theme, setTheme];
}

function App() {
  const route = useRoute();
  const [signedOut, setSignedOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const me = useLoad(() => api<{ tg_id: number; bot: string }>("/me"), []);
  const contests = useLoad(() => api<Contest[]>("/contests"), []);
  const [selected, setSelected] = useState<number | null>(() => Number(readStored("contest")) || null);

  useEffect(() => {
    const on = () => setSignedOut(true);
    window.addEventListener("unauthorized", on);
    return () => window.removeEventListener("unauthorized", on);
  }, []);
  useEffect(() => setMenuOpen(false), [route.join("/")]);

  const list = contests.data ?? [];
  const contest = useMemo(
    () => list.find((c) => c.id === selected) ?? list.find((c) => c.status === "active") ?? list[0] ?? null,
    [list, selected],
  );

  if (signedOut) {
    return (
      <main className="center-screen">
        <div className="signin-card">
          <div className="brand-mark big">
            <Icon name="trophy" size={26} />
          </div>
          <h2>Signed out</h2>
          <p className="muted">
            Send <code>/admin</code> to the bot in Telegram and open the one-time link it replies with.
          </p>
        </div>
      </main>
    );
  }
  if (!me.data) {
    return <main className="center-screen">{me.error ? <p>{me.error}</p> : <Loading />}</main>;
  }

  const state: AppState = {
    bot: me.data.bot,
    contests: list,
    reloadContests: contests.reload,
    contest,
    selectContest: (id) => {
      setSelected(id);
      store("contest", String(id));
    },
  };

  const section = route[0] ?? "";
  let page;
  if (section === "contests" && route[1]) page = <ContestEditor id={Number(route[1])} step={route[2]} />;
  else if (section === "contests") page = <Contests />;
  else if (section === "participants") page = <Participants />;
  else if (section === "leaderboard") page = <Leaderboard />;
  else if (section === "broadcasts") page = <Broadcasts />;
  else if (section === "system") page = <System />;
  else page = <Overview />;

  const showPicker = ["", "participants", "leaderboard", "broadcasts"].includes(section) && list.length > 0;

  return (
    <AppContext.Provider value={state}>
      <div className={`shell ${menuOpen ? "menu-open" : ""}`}>
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">
              <Icon name="trophy" size={18} />
            </div>
            <div>
              <div className="brand-name">Contest Admin</div>
              <div className="brand-sub">@{me.data.bot}</div>
            </div>
          </div>
          <nav className="nav">
            {NAV.map((n) => (
              <a key={n.path} href={`#/${n.path}`} className={section === n.path ? "on" : ""}>
                <Icon name={n.icon} />
                <span>{n.label}</span>
              </a>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div className="theme-switch" role="group" aria-label="Theme">
              {(["light", "system", "dark"] as Theme[]).map((t) => (
                <button key={t} className={theme === t ? "on" : ""} onClick={() => setTheme(t)} title={`${t} theme`}>
                  <Icon name={t === "light" ? "sun" : t === "dark" ? "moon" : "overview"} size={15} />
                </button>
              ))}
            </div>
            <button
              className="nav-signout"
              onClick={() => api("/logout", { method: "POST" }).finally(() => setSignedOut(true))}
            >
              <Icon name="logout" size={16} /> Sign out
            </button>
          </div>
        </aside>
        <div className="scrim" onClick={() => setMenuOpen(false)} />
        <div className="main">
          <header className="topbar">
            <button className="icon-btn menu-btn" onClick={() => setMenuOpen(true)} aria-label="Menu">
              <Icon name="menu" />
            </button>
            <div className="topbar-title">{NAV.find((n) => n.path === section)?.label ?? "Contest"}</div>
            {showPicker && contest && (
              <label className="contest-picker">
                <StatusBadge status={contest.status} />
                <select value={contest.id} onChange={(e) => state.selectContest(Number(e.target.value))}>
                  {list.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
                <Icon name="chevronDown" size={14} />
              </label>
            )}
          </header>
          <main className="content">{page}</main>
        </div>
      </div>
    </AppContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UiProvider>
      <App />
    </UiProvider>
  </StrictMode>,
);
