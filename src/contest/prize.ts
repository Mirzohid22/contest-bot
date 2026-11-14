import { sql } from "kysely";
import type { Contest, Participant } from "../db/types.js";
import type { Deps } from "../deps.js";

/**
 * Returns the participant's own join-request link to the prize chat, creating it the first
 * time. Each qualified participant gets a separate link: the join worker approves a request
 * through it only from the person it was made for, then revokes it, so it works once.
 *
 * Falls back to the contest's shared link when the chat is not set up or Telegram refuses;
 * the shared link still only admits qualified participants.
 */
export async function ensurePrizeLink(
  d: Pick<Deps, "db" | "tg" | "log">,
  contest: Contest,
  p: Pick<Participant, "id" | "prize_invite_link">,
): Promise<string | null> {
  if (p.prize_invite_link) return p.prize_invite_link;
  if (!contest.prize_chat_id) return contest.prize_invite_link;
  try {
    const link = await d.tg.createInviteLink(contest.prize_chat_id, { name: `P${p.id}`, joinRequest: true });
    // Two racing calls may both create a link; the first one stored wins and is the one used.
    const r = await sql<{ prize_invite_link: string }>`
      UPDATE participants SET prize_invite_link = COALESCE(prize_invite_link, ${link.invite_link})
       WHERE id = ${p.id} RETURNING prize_invite_link
    `.execute(d.db);
    return r.rows[0]?.prize_invite_link ?? link.invite_link;
  } catch (err) {
    d.log.warn({ err, participant: p.id }, "could not create a personal prize link; using the shared one");
    return contest.prize_invite_link;
  }
}
