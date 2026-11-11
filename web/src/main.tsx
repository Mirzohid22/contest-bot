import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Contest, useLoad } from "./api";
import { ContestPage } from "./ContestPage";
import { Contests } from "./Contests";
import { Dashboard } from "./Dashboard";
import { Participants } from "./Participants";
import "./styles.css";

type Tab = "dashboard" | "contests" | "participants";

function App() {
  const [signedOut, setSignedOut] = useState(false);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [contestId, setContestId] = useState<number | null>(null);
  const me = useLoad(() => api<{ tg_id: number; bot: string }>("/me"), []);
  const contests = useLoad(() => api<Contest[]>("/contests"), []);

  useEffect(() => {
    const on = () => setSignedOut(true);
    window.addEventListener("unauthorized", on);
    return () => window.removeEventListener("unauthorized", on);
  }, []);

  if (signedOut) {
    return (
      <main className="center">
        <div className="card">
          <h2>Not signed in</h2>
          <p>
            Send <code>/admin</code> to the bot in Telegram and open the link it replies with.
          </p>
        </div>
      </main>
    );
  }
  if (!me.data) return <main className="center muted">{me.error ?? "Loading…"}</main>;

  const open = (id: number) => {
    setContestId(id);
    setTab("contests");
  };

  return (
    <>
      <header className="top">
        <strong>@{me.data.bot}</strong>
        <nav>
          {(["dashboard", "contests", "participants"] as Tab[]).map((t) => (
            <button
              key={t}
              className={tab === t ? "tab on" : "tab"}
              onClick={() => {
                setTab(t);
                if (t === "contests") setContestId(null);
              }}
            >
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
        <button
          className="link"
          onClick={() => api("/logout", { method: "POST" }).finally(() => setSignedOut(true))}
        >
          Sign out
        </button>
      </header>
      <main>
        {tab === "dashboard" && <Dashboard contests={contests.data ?? []} onOpen={open} />}
        {tab === "contests" &&
          (contestId === null ? (
            <Contests contests={contests.data ?? []} reload={contests.reload} onOpen={open} />
          ) : (
            <ContestPage id={contestId} onBack={() => setContestId(null)} onChanged={contests.reload} />
          ))}
        {tab === "participants" && <Participants contests={contests.data ?? []} />}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
