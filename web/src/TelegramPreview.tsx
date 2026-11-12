import { Fragment, type ReactNode } from "react";

export interface PreviewButton {
  text: string;
  url?: string;
}

/**
 * A Telegram-like chat bubble. The text is Telegram HTML; only the tags Telegram accepts
 * are rendered, everything else is shown as plain text, so nothing here can run script.
 */
export function TelegramPreview({
  text,
  buttons = [],
  photo,
  botName,
}: {
  text: string;
  buttons?: PreviewButton[][];
  photo?: string | null;
  botName?: string;
}) {
  return (
    <div className="tg-phone">
      <div className="tg-top">
        <span className="tg-avatar">{(botName ?? "B")[0]!.toUpperCase()}</span>
        <div>
          <div className="tg-name">{botName ?? "Bot"}</div>
          <div className="tg-sub">bot</div>
        </div>
      </div>
      <div className="tg-chat">
        <div className="tg-msg">
          <div className={`tg-bubble ${photo ? "has-photo" : ""}`}>
            {photo && <img className="tg-photo" src={photo} alt="" />}
            <div className="tg-text">{renderTelegramHtml(text)}</div>
            <span className="tg-time">12:00</span>
          </div>
          {buttons.length > 0 && (
            <div className="tg-keyboard">
              {buttons.map((row, i) => (
                <div key={i} className="tg-row">
                  {row.map((b, j) => (
                    <span key={j} className="tg-btn">
                      {b.text}
                      {b.url && <span className="tg-btn-link">↗</span>}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const ALLOWED: Record<string, string> = {
  b: "strong",
  strong: "strong",
  i: "em",
  em: "em",
  u: "u",
  ins: "u",
  s: "s",
  strike: "s",
  del: "s",
  code: "code",
  pre: "pre",
  a: "a",
  blockquote: "blockquote",
  "tg-spoiler": "span",
};

export function renderTelegramHtml(html: string): ReactNode {
  const doc = new DOMParser().parseFromString(`<body>${html.replace(/\n/g, "<br>")}</body>`, "text/html");
  return Array.from(doc.body.childNodes).map((n, i) => <Fragment key={i}>{walk(n)}</Fragment>);
}

function walk(node: ChildNode): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return linkify(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const kids = Array.from(el.childNodes).map((c, i) => <Fragment key={i}>{walk(c)}</Fragment>);
  if (tag === "br") return <br />;
  const as = ALLOWED[tag];
  if (!as) return <>{kids}</>;
  if (tag === "a") {
    const href = el.getAttribute("href") ?? "";
    return /^(https?:|tg:)/.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {kids}
      </a>
    ) : (
      <>{kids}</>
    );
  }
  if (tag === "tg-spoiler") return <span className="tg-spoiler">{kids}</span>;
  const Tag = as as "strong";
  return <Tag>{kids}</Tag>;
}

function linkify(text: string): ReactNode {
  const parts = text.split(/(https?:\/\/[^\s<]+)/g);
  return parts.map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a key={i} href={p} target="_blank" rel="noreferrer noopener">
        {p}
      </a>
    ) : (
      p
    ),
  );
}

/** Fills {placeholders} with sample values so the preview reads like a real message. */
export function fillSample(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? escape(String(vars[k])) : whole));
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
