import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ChatCheck,
  type Contest,
  type ContestDetail,
  fmtDate,
  fmtNum,
  LOCALE_FLAG,
  LOCALE_LABEL,
  type Locale,
  LOCALES,
  type Sponsor,
  type TextDefaults,
  upload,
  useLoad,
} from "../api";
import { go, useApp } from "../app";
import { fillSample, type PreviewButton, TelegramPreview } from "../TelegramPreview";
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Icon,
  Loading,
  Note,
  Segmented,
  StatusBadge,
  useCopy,
  useUi,
} from "../ui";

const STEPS = [
  { id: "details", label: "Details", icon: "info" },
  { id: "sponsors", label: "Sponsor channels", icon: "users" },
  { id: "prize", label: "Prize chat", icon: "shield" },
  { id: "messages", label: "Messages & banner", icon: "globe" },
  { id: "launch", label: "Launch", icon: "play" },
] as const;
type StepId = (typeof STEPS)[number]["id"];

export function ContestEditor({ id, step }: { id: number; step?: string }) {
  const detail = useLoad(() => api<ContestDetail>(`/contests/${id}`), [id]);
  const { reloadContests, selectContest } = useApp();
  const current = (STEPS.find((s) => s.id === step)?.id ?? "details") as StepId;

  useEffect(() => selectContest(id), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (detail.error) return <ErrorNote>{detail.error}</ErrorNote>;
  if (!detail.data) return <Loading />;
  const { contest, sponsors } = detail.data;
  const readOnly = contest.status === "finished";

  const refresh = async () => {
    await detail.reload();
    await reloadContests();
  };

  const done: Record<StepId, boolean> = {
    details: true,
    sponsors: sponsors.length > 0 && sponsors.every((s) => s.health === "ok"),
    prize: contest.prize_invite_link !== null,
    messages: true,
    launch: contest.status !== "draft",
  };
  const idx = STEPS.findIndex((s) => s.id === current);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <a className="back" href="#/contests">
            <Icon name="chevronLeft" size={16} /> All contests
          </a>
          <h1>
            {contest.title} <StatusBadge status={contest.status} />
          </h1>
          <p className="muted">
            {fmtNum(detail.data.stats.total)} participants · {fmtNum(detail.data.stats.qualified)} qualified
          </p>
        </div>
      </div>
      {readOnly && <Note>This contest is finished. Its settings can no longer be changed.</Note>}

      <div className="wizard">
        <nav className="stepper">
          {STEPS.map((s, i) => (
            <a key={s.id} href={`#/contests/${id}/${s.id}`} className={`${s.id === current ? "on" : ""} ${done[s.id] ? "done" : ""}`}>
              <span className="step-num">{done[s.id] && s.id !== current ? <Icon name="check" size={14} /> : i + 1}</span>
              <span>{s.label}</span>
            </a>
          ))}
        </nav>
        <div className="wizard-body">
          {current === "details" && <Details contest={contest} readOnly={readOnly} onSaved={refresh} />}
          {current === "sponsors" && <Sponsors contest={contest} sponsors={sponsors} readOnly={readOnly} onChanged={refresh} />}
          {current === "prize" && <Prize contest={contest} readOnly={readOnly} onChanged={refresh} />}
          {current === "messages" && <Messages contest={contest} sponsors={sponsors} readOnly={readOnly} onSaved={refresh} />}
          {current === "launch" && <Launch detail={detail.data} done={done} onChanged={refresh} />}

          <div className="wizard-nav">
            {idx > 0 ? (
              <Button variant="ghost" icon="chevronLeft" onClick={() => go(`/contests/${id}/${STEPS[idx - 1]!.id}`)}>
                {STEPS[idx - 1]!.label}
              </Button>
            ) : (
              <span />
            )}
            {idx < STEPS.length - 1 && (
              <Button variant="primary" onClick={() => go(`/contests/${id}/${STEPS[idx + 1]!.id}`)}>
                Next: {STEPS[idx + 1]!.label} <Icon name="chevronRight" size={16} />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 1. details ----

function Details({ contest, readOnly, onSaved }: { contest: Contest; readOnly: boolean; onSaved: () => Promise<void> }) {
  const { run } = useUi();
  const [title, setTitle] = useState(contest.title);
  const [required, setRequired] = useState(contest.required_invites);
  const [busy, setBusy] = useState(false);
  const dirty = title !== contest.title || required !== contest.required_invites;

  const save = async () => {
    setBusy(true);
    const r = await run(
      () =>
        api<{ newly_qualified: number }>(`/contests/${contest.id}`, {
          method: "PATCH",
          body: { title: title.trim(), required_invites: required },
        }),
      "Saved",
    );
    setBusy(false);
    if (r) await onSaved();
  };

  return (
    <Card title="Details" subtitle="The basics people see in the bot.">
      <div className="form-grid">
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={readOnly} maxLength={200} />
        </Field>
        <Field
          label="Invites needed to qualify"
          hint={
            contest.status === "active"
              ? "Lowering it qualifies everyone who now meets it, right away."
              : "A friend counts after starting the bot with the link and subscribing."
          }
        >
          <input
            type="number"
            min={0}
            max={100000}
            value={required}
            onChange={(e) => setRequired(Number(e.target.value))}
            disabled={readOnly}
          />
        </Field>
      </div>
      {!readOnly && (
        <div className="row end">
          <Button variant="primary" onClick={save} busy={busy} disabled={!dirty || !title.trim()}>
            Save changes
          </Button>
        </div>
      )}
    </Card>
  );
}

// ---- 2. sponsors ----

interface KnownChat {
  chat_id: number;
  title: string;
  type: string;
  username: string | null;
  status: string;
  can_invite: boolean;
}

function ChatChecker({
  purpose,
  onUse,
  useLabel,
  disabled,
}: {
  purpose: "sponsor" | "prize";
  onUse: (chat: string, check: ChatCheck) => Promise<void>;
  useLabel: string;
  disabled?: boolean;
}) {
  const { run } = useUi();
  const [chat, setChat] = useState("");
  const [check, setCheck] = useState<ChatCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"check" | "use" | null>(null);

  const known = useLoad(() => api<KnownChat[]>("/chats/known"), []);

  const inspect = async (e?: React.FormEvent, value = chat) => {
    e?.preventDefault();
    if (!value.trim()) return;
    setBusy("check");
    setError(null);
    setCheck(null);
    try {
      setCheck(await api<ChatCheck>("/chats/inspect", { body: { chat: value.trim(), purpose } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const use = async () => {
    if (!check) return;
    setBusy("use");
    const ok = await run(async () => {
      await onUse(chat.trim(), check);
      return true;
    });
    setBusy(null);
    if (ok) {
      setChat("");
      setCheck(null);
    }
  };

  return (
    <div className="checker">
      <form className="row" onSubmit={inspect}>
        <input
          className="grow"
          value={chat}
          onChange={(e) => {
            setChat(e.target.value);
            setCheck(null);
            setError(null);
          }}
          placeholder="@channel, https://t.me/channel or -100… (or pick below)"
          disabled={disabled}
        />
        <Button type="submit" icon="search" busy={busy === "check"} disabled={disabled || !chat.trim()}>
          Check
        </Button>
      </form>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!check && !disabled && (
        <div className="known-chats">
          <div className="row between">
            <span className="field-label">Chats the bot is in</span>
            <button className="link-btn small" onClick={() => void known.reload()}>
              Refresh
            </button>
          </div>
          {known.data && known.data.length > 0 ? (
            <div className="known-list">
              {known.data.map((k) => (
                <button
                  key={k.chat_id}
                  type="button"
                  className="known-chat"
                  onClick={() => {
                    setChat(String(k.chat_id));
                    void inspect(undefined, String(k.chat_id));
                  }}
                >
                  <span className="check-avatar small">{k.title[0]?.toUpperCase()}</span>
                  <span className="grow">
                    <span className="known-title">{k.title}</span>
                    <span className="muted small">
                      {k.type}
                      {k.username ? ` · @${k.username}` : " · private"}
                    </span>
                  </span>
                  {k.status === "administrator" || k.status === "creator" ? (
                    <Badge tone={purpose === "prize" && !k.can_invite ? "amber" : "green"}>
                      {purpose === "prize" && !k.can_invite ? "admin, no invite right" : "admin"}
                    </Badge>
                  ) : (
                    <Badge tone="red">not admin</Badge>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted small">
              None yet. Make the bot an admin of the {purpose === "prize" ? "group or channel" : "channel"} and it appears here.
              Already an admin? In a group, send <code>/connect</code> there; in a channel, remove the bot and add it again.
            </p>
          )}
        </div>
      )}
      {check && (
        <div className={`check-card ${check.ok ? "ok" : "bad"}`}>
          <div className="check-avatar">{check.title[0]?.toUpperCase()}</div>
          <div className="grow">
            <div className="check-title">{check.title}</div>
            <div className="muted small">
              {check.type}
              {check.username && ` · @${check.username}`}
              {check.members !== null && ` · ${fmtNum(check.members)} members`}
            </div>
            <div className="check-flags">
              <Badge tone={check.bot_status === "administrator" || check.bot_status === "creator" ? "green" : "red"}>
                bot: {check.bot_status}
              </Badge>
              <Badge tone={check.can_invite_users ? "green" : purpose === "prize" ? "red" : "neutral"}>
                {check.can_invite_users ? "can invite" : "cannot invite"}
              </Badge>
            </div>
            {check.problem && <p className="field-error">{check.problem}</p>}
          </div>
          {check.ok ? (
            <Button variant="primary" icon="plus" onClick={use} busy={busy === "use"}>
              {useLabel}
            </Button>
          ) : (
            <Button icon="refresh" onClick={() => void inspect()} busy={busy === "check"}>
              Check again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Sponsors({
  contest,
  sponsors,
  readOnly,
  onChanged,
}: {
  contest: Contest;
  sponsors: Sponsor[];
  readOnly: boolean;
  onChanged: () => Promise<void>;
}) {
  const { run, confirm } = useUi();
  const [checking, setChecking] = useState(false);

  const move = async (i: number, dir: -1 | 1) => {
    const ids = sponsors.map((s) => s.id);
    const j = i + dir;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    await run(() => api(`/contests/${contest.id}/sponsors/order`, { body: { ids } }));
    await onChanged();
  };

  const remove = async (s: Sponsor) => {
    if (!(await confirm({ title: `Remove ${s.title}?`, body: "Users will no longer need to join this channel.", confirm: "Remove", danger: true }))) return;
    if (await run(() => api(`/sponsors/${s.id}`, { method: "DELETE" }), "Channel removed")) await onChanged();
  };

  const recheck = async () => {
    setChecking(true);
    const r = await run(() => api<Sponsor[]>(`/contests/${contest.id}/sponsors/check`, { body: {} }));
    setChecking(false);
    if (r) await onChanged();
  };

  return (
    <div className="stack">
      <Card
        title="Sponsor channels"
        subtitle="Users must join every channel here before they get their personal link."
        actions={
          sponsors.length > 0 && (
            <Button size="sm" icon="refresh" onClick={recheck} busy={checking}>
              Re-check all
            </Button>
          )
        }
      >
        {!readOnly && (
          <>
            <Note>
              First add the bot as an <b>administrator</b> of the channel (no special rights needed; for a private channel,
              allow <b>Invite users via link</b>). Then check it here.
            </Note>
            <ChatChecker
              purpose="sponsor"
              useLabel="Add channel"
              onUse={async (chat) => {
                await api(`/contests/${contest.id}/sponsors`, { body: { chat } });
                await onChanged();
              }}
            />
          </>
        )}
        {sponsors.length === 0 ? (
          <p className="muted center-text">No channels yet.</p>
        ) : (
          <ul className="sponsor-list">
            {sponsors.map((s, i) => (
              <li key={s.id}>
                <span className="sponsor-pos">{i + 1}</span>
                <div className="grow">
                  <div className="row-tight">
                    <b>{s.title}</b>
                    {s.health === "ok" ? <Badge tone="green">bot is admin</Badge> : <Badge tone="red">bot is not admin</Badge>}
                  </div>
                  <a className="muted small" href={s.join_url} target="_blank" rel="noreferrer">
                    {s.join_url}
                  </a>
                </div>
                {!readOnly && (
                  <div className="row-tight">
                    <button className="icon-btn" disabled={i === 0} onClick={() => void move(i, -1)} aria-label="Move up">
                      <Icon name="up" size={16} />
                    </button>
                    <button
                      className="icon-btn"
                      disabled={i === sponsors.length - 1}
                      onClick={() => void move(i, 1)}
                      aria-label="Move down"
                    >
                      <Icon name="down" size={16} />
                    </button>
                    <button className="icon-btn danger" onClick={() => void remove(s)} aria-label="Remove">
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {sponsors.some((s) => s.health !== "ok") && (
          <Note tone="warn">
            Subscription checks are skipped for channels where the bot is not an admin. Make it an admin again, then press{" "}
            <b>Re-check all</b>.
          </Note>
        )}
      </Card>
    </div>
  );
}

// ---- 3. prize ----

function Prize({ contest, readOnly, onChanged }: { contest: Contest; readOnly: boolean; onChanged: () => Promise<void> }) {
  const copy = useCopy();
  return (
    <Card title="Prize chat" subtitle="The private channel or group that qualified participants get into.">
      {contest.prize_invite_link ? (
        <div className="prize-box">
          <div className="check-avatar big">
            <Icon name="shield" size={20} />
          </div>
          <div className="grow">
            <div className="check-title">{contest.prize_chat_title}</div>
            <div className="row-tight">
              <code className="truncate">{contest.prize_invite_link}</code>
              <button className="icon-btn" onClick={() => void copy(contest.prize_invite_link!, "Link copied")}>
                <Icon name="copy" size={15} />
              </button>
            </div>
            <p className="muted small">
              One join-request link for everyone. The bot approves qualified participants and declines everyone else, so
              sharing the link does not let anyone in.
            </p>
          </div>
        </div>
      ) : (
        <Note tone="warn">No prize chat yet. Qualified users would get no link.</Note>
      )}
      {!readOnly && (
        <>
          <Note>
            Add the bot as an administrator with the <b>Invite users via link</b> right, then check the chat.
          </Note>
          <ChatChecker
            purpose="prize"
            useLabel={contest.prize_invite_link ? "Use this chat instead" : "Use this chat"}
            onUse={async (chat) => {
              await api(`/contests/${contest.id}/prize`, { body: { chat } });
              await onChanged();
            }}
          />
        </>
      )}
    </Card>
  );
}

// ---- 4. messages ----

const SCREENS: { id: string; label: string; keys: string[] }[] = [
  { id: "welcome", label: "Welcome", keys: ["gate", "gate_missing", "btn_check", "btn_lang"] },
  {
    id: "progress",
    label: "Progress card",
    keys: ["status", "share_text", "btn_share", "btn_copy", "btn_top", "btn_friends", "btn_progress"],
  },
  { id: "qualified", label: "Qualified", keys: ["status_qualified", "qualified", "btn_prize"] },
  { id: "leaderboard", label: "Leaderboard", keys: ["top_title", "top_empty", "top_you", "btn_back"] },
  { id: "friends", label: "Friends", keys: ["friends_title", "friends_empty", "friends_legend", "friends_more"] },
  {
    id: "replies",
    label: "Other replies",
    keys: ["notice", "declined", "declined_sponsors", "not_subscribed", "checking", "wait", "press_start", "no_contest", "lang_pick"],
  },
];

const KEY_INFO: Record<string, string> = {
  gate: "First message. Placeholders: {title}, {btn_check}. The channel list is added below it.",
  gate_missing: "Added when the user pressed the check button but missed a channel.",
  status: "Progress card. {title} {bar} {count} {required} {left} {link}",
  status_qualified: "Progress card once qualified. {title} {bar} {count} {required} {link}",
  qualified: "Sent once when the user qualifies. {title} {required}",
  notice: "Sent to the referrer when a friend is counted. {bar} {count} {required}",
  declined: "Reply to a prize-chat join request from someone not qualified. {bot_link}",
  declined_sponsors: "Reply when a qualified user has left a sponsor channel.",
  not_subscribed: "Pop-up when channels are missing. {channels}",
  top_you: "{rank} {count}",
  friends_title: "{total}",
  friends_more: "{n}",
  share_text: "Text that goes with the link when the user shares it.",
};

function Messages({
  contest,
  sponsors,
  readOnly,
  onSaved,
}: {
  contest: Contest;
  sponsors: Sponsor[];
  readOnly: boolean;
  onSaved: () => Promise<void>;
}) {
  const { bot } = useApp();
  const { run, confirm } = useUi();
  const defaults = useLoad(() => api<TextDefaults>("/texts/defaults"), []);
  const [locale, setLocale] = useState<Locale>("uz");
  const [screen, setScreen] = useState("welcome");
  const [draft, setDraft] = useState<Record<Locale, Record<string, string>>>(() => ({
    uz: { ...(contest.texts.uz ?? {}) },
    ru: { ...(contest.texts.ru ?? {}) },
    en: { ...(contest.texts.en ?? {}) },
  }));
  const [busy, setBusy] = useState(false);
  const [bannerBusy, setBannerBusy] = useState(false);
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (defaults.data) setLocale(defaults.data.default_locale);
  }, [defaults.data]);

  useEffect(() => {
    setBannerUrl(contest.banner_file_id ? `/admin/api/contests/${contest.id}/banner?v=${encodeURIComponent(contest.banner_file_id)}` : null);
  }, [contest.banner_file_id, contest.id]);

  const saved = useMemo(() => JSON.stringify(contest.texts), [contest.texts]);
  const dirty = useMemo(() => {
    const clean = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v.trim() !== ""));
    const now = { uz: clean(draft.uz), ru: clean(draft.ru), en: clean(draft.en) };
    const was = { uz: contest.texts.uz ?? {}, ru: contest.texts.ru ?? {}, en: contest.texts.en ?? {} };
    return JSON.stringify(now) !== JSON.stringify(was);
  }, [draft, saved]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!defaults.data) return <Loading />;
  const def = defaults.data.texts[locale];
  const value = (k: string) => draft[locale][k] ?? def[k] ?? "";
  const isCustom = (k: string) => draft[locale][k] !== undefined && draft[locale][k] !== def[k];
  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [locale]: { ...d[locale], [k]: v } }));
  const reset = (k: string) =>
    setDraft((d) => {
      const next = { ...d[locale] };
      delete next[k];
      return { ...d, [locale]: next };
    });
  const customCount = (l: Locale) => Object.keys(draft[l]).filter((k) => draft[l][k] !== defaults.data!.texts[l][k]).length;

  const save = async () => {
    setBusy(true);
    const r = await run(() => api(`/contests/${contest.id}`, { method: "PATCH", body: { texts: draft } }), "Messages saved");
    setBusy(false);
    if (r) await onSaved();
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return run(async () => Promise.reject(new Error("The picture must be under 10 MB")));
    setBannerBusy(true);
    const local = URL.createObjectURL(f);
    const r = await run(() => upload<Contest>(`/contests/${contest.id}/banner`, f), "Banner uploaded, a preview was sent to you in Telegram");
    setBannerBusy(false);
    if (r) {
      setBannerUrl(local);
      await onSaved();
    }
    if (file.current) file.current.value = "";
  };

  const removeBanner = async () => {
    if (!(await confirm({ title: "Remove the banner?", confirm: "Remove", danger: true }))) return;
    if (await run(() => api(`/contests/${contest.id}/banner`, { method: "DELETE" }), "Banner removed")) {
      setBannerUrl(null);
      await onSaved();
    }
  };

  const preview = buildPreview(screen, value, contest, sponsors, bannerUrl);
  const current = SCREENS.find((s) => s.id === screen)!;

  return (
    <div className="stack">
      <Card title="Banner" subtitle="Optional picture shown above the welcome and progress messages.">
        <div className="banner-row">
          <div className="banner-thumb">{bannerUrl ? <img src={bannerUrl} alt="" /> : <Icon name="image" size={28} />}</div>
          <div className="stack-sm">
            <p className="muted small">JPEG, PNG or WebP, up to 10 MB. A 16:9 picture looks best. Captions are limited to 1024 characters, so very long messages are sent without the picture.</p>
            {!readOnly && (
              <div className="row">
                <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
                <Button icon="image" busy={bannerBusy} onClick={() => file.current?.click()}>
                  {bannerUrl ? "Replace picture" : "Upload picture"}
                </Button>
                {bannerUrl && (
                  <Button variant="ghost" icon="trash" onClick={removeBanner}>
                    Remove
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>

      <Card
        title="Messages"
        subtitle="Every message in three languages. Users pick theirs; Uzbek is the default."
        actions={
          <Segmented
            value={locale}
            onChange={setLocale}
            options={LOCALES.map((l) => ({
              value: l,
              label: (
                <>
                  {LOCALE_FLAG[l]} {LOCALE_LABEL[l]}
                  {customCount(l) > 0 && <span className="pill">{customCount(l)}</span>}
                </>
              ),
            }))}
          />
        }
      >
        <div className="screen-tabs">
          {SCREENS.map((s) => (
            <button key={s.id} className={s.id === screen ? "on" : ""} onClick={() => setScreen(s.id)}>
              {s.label}
              {s.keys.some(isCustom) && <span className="dot dot-accent" />}
            </button>
          ))}
        </div>
        <div className="editor-split">
          <div className="stack-sm">
            {current.keys.map((k) => (
              <div key={k} className="text-field">
                <div className="text-field-head">
                  <code>{k}</code>
                  {isCustom(k) && (
                    <>
                      <Badge tone="accent">edited</Badge>
                      {!readOnly && (
                        <button className="link-btn" onClick={() => reset(k)}>
                          Reset
                        </button>
                      )}
                    </>
                  )}
                </div>
                {k.startsWith("btn_") || k === "share_text" ? (
                  <input value={value(k)} onChange={(e) => set(k, e.target.value)} disabled={readOnly} maxLength={k.startsWith("btn_") ? 64 : 300} />
                ) : (
                  <textarea
                    value={value(k)}
                    onChange={(e) => set(k, e.target.value)}
                    rows={Math.min(8, Math.max(2, value(k).split("\n").length + 1))}
                    disabled={readOnly}
                  />
                )}
                {KEY_INFO[k] && <span className="field-hint">{KEY_INFO[k]}</span>}
              </div>
            ))}
            <p className="muted small">
              Formatting: <code>&lt;b&gt;bold&lt;/b&gt;</code> <code>&lt;i&gt;italic&lt;/i&gt;</code>{" "}
              <code>&lt;a href="https://…"&gt;link&lt;/a&gt;</code>. Placeholders in braces are filled in by the bot.
            </p>
          </div>
          <div className="preview-col">
            <div className="muted small preview-label">
              <Icon name="eye" size={14} /> Preview · {LOCALE_LABEL[locale]}
            </div>
            <TelegramPreview text={preview.text} buttons={preview.buttons} photo={preview.photo} botName={bot} />
            {preview.extra && (
              <div className="preview-extra">
                <TelegramPreview text={preview.extra.text} buttons={preview.extra.buttons} botName={bot} />
              </div>
            )}
          </div>
        </div>
        {!readOnly && (
          <div className="sticky-save">
            <span className="muted small">{dirty ? "Unsaved changes" : "All changes saved"}</span>
            <Button variant="primary" onClick={save} busy={busy} disabled={!dirty}>
              Save messages
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function buildPreview(
  screen: string,
  t: (k: string) => string,
  contest: Contest,
  sponsors: Sponsor[],
  photo: string | null,
): { text: string; buttons: PreviewButton[][]; photo?: string | null; extra?: { text: string; buttons: PreviewButton[][] } } {
  const required = Math.max(contest.required_invites, 1);
  const count = Math.min(required - 1, Math.ceil(required * 0.6));
  const sample = {
    title: contest.title,
    btn_check: t("btn_check"),
    count,
    required: contest.required_invites,
    left: Math.max(contest.required_invites - count, 0),
    bar: bar(count, contest.required_invites),
    link: "https://t.me/bot?start=Ab3dE9",
    channels: sponsors.map((s) => s.title).join(", ") || "Channel",
    bot_link: "https://t.me/bot",
    rank: 4,
    total: 7,
    n: 3,
  };
  const names = sponsors.length > 0 ? sponsors.map((s) => s.title) : ["Sponsor channel 1", "Sponsor channel 2"];
  const statusButtons: PreviewButton[][] = [
    [{ text: t("btn_share"), url: "x" }, { text: t("btn_copy") }],
    [{ text: t("btn_top") }, { text: t("btn_friends") }],
    [{ text: t("btn_progress") }, { text: t("btn_lang") }],
  ];
  const back = [[{ text: t("btn_back") }]];

  switch (screen) {
    case "welcome": {
      const list = names.map((n, i) => `${i + 1}. ${i === names.length - 1 ? "❌" : "✅"} ${esc(n)}`).join("\n");
      return {
        text: `${fillSample(t("gate"), sample)}\n\n${list}\n\n${fillSample(t("gate_missing"), sample)}`,
        buttons: [[{ text: `➕ ${names[names.length - 1]}`, url: "x" }], [{ text: t("btn_check") }], [{ text: t("btn_lang") }]],
        photo,
      };
    }
    case "progress":
      return { text: fillSample(t("status"), sample), buttons: statusButtons, photo };
    case "qualified":
      return {
        text: fillSample(t("status_qualified"), { ...sample, count: contest.required_invites, bar: bar(1, 1) }),
        buttons: [[{ text: t("btn_prize"), url: "x" }], ...statusButtons],
        photo,
        extra: { text: fillSample(t("qualified"), sample), buttons: [[{ text: t("btn_prize"), url: "x" }]] },
      };
    case "leaderboard":
      return {
        text: `${t("top_title")}\n\n🥇 Aziza — <b>24</b>\n🥈 Bekzod — <b>19</b>\n🥉 Dilnoza — <b>15</b>\n<b>4.</b> Jasur — <b>12</b>\n\n${fillSample(t("top_you"), sample)}`,
        buttons: back,
      };
    case "friends":
      return {
        text: `${fillSample(t("friends_title"), sample)}\n\n✅ Aziza\n✅ Bekzod\n⏳ Kamola\n${fillSample(t("friends_more"), sample)}\n\n<i>${t("friends_legend")}</i>`,
        buttons: back,
      };
    default:
      return {
        text: fillSample(t("notice"), sample),
        buttons: [],
        extra: { text: fillSample(t("declined"), sample), buttons: [] },
      };
  }
}

const bar = (count: number, required: number) => {
  const width = Math.min(Math.max(required, 1), 10);
  const filled = required <= 0 ? width : Math.min(width, Math.floor((count / required) * width));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ---- 5. launch ----

interface AuditRow {
  id: number;
  user_id: number;
  username: string | null;
  first_name: string | null;
  invite_count: number;
  prize_joined_at: string | null;
  self_left: boolean;
  invitees_left: number;
}

function Launch({
  detail,
  done,
  onChanged,
}: {
  detail: ContestDetail;
  done: Record<StepId, boolean>;
  onChanged: () => Promise<void>;
}) {
  const { contest, sponsors } = detail;
  const { contests } = useApp();
  const { run, confirm } = useUi();
  const [busy, setBusy] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const otherActive = contests.find((c) => c.status === "active" && c.id !== contest.id);

  const checks = [
    { ok: sponsors.length > 0, label: "At least one sponsor channel", hint: "Without sponsors anyone qualifies just by starting the bot.", step: "sponsors", soft: true },
    { ok: sponsors.every((s) => s.health === "ok"), label: "The bot is an admin in every sponsor channel", step: "sponsors" },
    { ok: done.prize, label: "Prize chat connected", step: "prize" },
    { ok: contest.banner_file_id !== null, label: "Banner picture", hint: "Optional", step: "messages", soft: true },
  ];
  const blocking = checks.filter((c) => !c.ok && !c.soft);

  const act = async (what: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(what);
    const r = await run(fn, success);
    setBusy(null);
    if (r !== undefined) await onChanged();
    return r;
  };

  const activate = async () => {
    const ok = await confirm({
      title: `Launch “${contest.title}”?`,
      body: (
        <div className="stack-sm">
          <p>Users who start the bot from now on take part in this contest.</p>
          {otherActive && (
            <Note tone="warn">
              <b>{otherActive.title}</b> is live now and will be finished.
            </Note>
          )}
        </div>
      ),
      confirm: "Launch",
    });
    if (ok) await act("activate", () => api(`/contests/${contest.id}/activate`, { body: {} }), "Contest is live");
  };

  const finish = async () => {
    const ok = await confirm({
      title: `Finish “${contest.title}”?`,
      body: "The bot stops accepting participants. Qualified users can still be approved into the prize chat. This cannot be undone.",
      confirm: "Finish contest",
      danger: true,
    });
    if (ok) await act("finish", () => api(`/contests/${contest.id}/finish`, { body: {} }), "Contest finished");
  };

  const recount = () =>
    act(
      "recount",
      () =>
        api<{ changed: number; unqualified: number; newly_qualified: number }>(`/contests/${contest.id}/recount`, { body: {} }).then((r) => {
          return r;
        }),
      "Invites recounted",
    );

  const loadAudit = async () => {
    setBusy("audit");
    const r = await run(() => api<AuditRow[]>(`/contests/${contest.id}/audit`));
    setBusy(null);
    if (r) setAudit(r);
  };

  return (
    <div className="stack">
      {contest.status === "draft" && (
        <Card title="Ready to launch?" subtitle="Everything below should be green before you announce the contest.">
          <ul className="checklist">
            {checks.map((c) => (
              <li key={c.label} className={c.ok ? "ok" : c.soft ? "soft" : "bad"}>
                <span className="check-icon">
                  <Icon name={c.ok ? "check" : c.soft ? "info" : "x"} size={14} />
                </span>
                <div className="grow">
                  <div>{c.label}</div>
                  {!c.ok && c.hint && <div className="muted small">{c.hint}</div>}
                </div>
                {!c.ok && (
                  <a className="small" href={`#/contests/${contest.id}/${c.step}`}>
                    Fix →
                  </a>
                )}
              </li>
            ))}
          </ul>
          <div className="row end">
            <Button variant="success" icon="play" onClick={activate} busy={busy === "activate"} disabled={blocking.length > 0}>
              Launch contest
            </Button>
          </div>
        </Card>
      )}

      {contest.status !== "draft" && (
        <Card title={contest.status === "active" ? "Contest is live" : "Contest is finished"} subtitle={contest.status === "active" ? `Since ${fmtDate(contest.started_at)}` : `Finished ${fmtDate(contest.finished_at)}`}>
          <div className="stats-grid compact">
            <div className="mini-stat">
              <b>{fmtNum(detail.stats.total)}</b>
              <span>participants</span>
            </div>
            <div className="mini-stat">
              <b>{fmtNum(detail.stats.verified)}</b>
              <span>subscribed</span>
            </div>
            <div className="mini-stat">
              <b>{fmtNum(detail.stats.qualified)}</b>
              <span>qualified</span>
            </div>
            <div className="mini-stat">
              <b>{fmtNum(detail.stats.joined_prize)}</b>
              <span>in prize chat</span>
            </div>
          </div>
          <div className="row wrap">
            <a className="btn btn-secondary" href={`/admin/api/contests/${contest.id}/export.csv`}>
              <Icon name="download" size={16} /> Export CSV
            </a>
            <Button icon="refresh" onClick={() => void recount()} busy={busy === "recount"}>
              Recount invites
            </Button>
            <Button icon="shield" onClick={loadAudit} busy={busy === "audit"}>
              Final audit
            </Button>
            {contest.status === "active" && (
              <Button variant="danger" icon="stop" onClick={finish} busy={busy === "finish"}>
                Finish contest
              </Button>
            )}
          </div>
          <p className="muted small">
            Before awarding prizes: disqualify fake accounts on the Participants page, press <b>Recount invites</b>, then
            look at the audit.
          </p>
        </Card>
      )}

      {audit && (
        <Card title="Final audit" subtitle="Qualified participants, with how many of their invitees have since left a sponsor channel.">
          {audit.length === 0 ? (
            <p className="muted">Nobody has qualified.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Participant</th>
                    <th className="num">Invites</th>
                    <th className="num">Invitees who left</th>
                    <th>Left a sponsor</th>
                    <th>Prize chat</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id} className={a.self_left || a.invitees_left > 0 ? "row-warn" : ""}>
                      <td>{a.first_name ?? a.username ?? a.user_id}</td>
                      <td className="num">{a.invite_count}</td>
                      <td className="num">{a.invitees_left > 0 ? <Badge tone="amber">{a.invitees_left}</Badge> : 0}</td>
                      <td>{a.self_left ? <Badge tone="red">yes</Badge> : "no"}</td>
                      <td>{a.prize_joined_at ? <Badge tone="green">joined</Badge> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
