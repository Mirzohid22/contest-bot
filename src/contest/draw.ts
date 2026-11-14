import { createHmac, randomBytes } from "node:crypto";

export interface Candidate {
  participant_id: number;
  tickets: number;
}

/**
 * The random number in (0, 1] that a draw gives a participant: HMAC-SHA256(seed, id), first
 * 52 bits. Kept apart so a stored draw can be recomputed and checked by anyone with the seed.
 */
export function ticketRandom(seed: string, participantId: number): number {
  const h = createHmac("sha256", seed).update(String(participantId)).digest();
  const n = h.readUIntBE(0, 6) * 16 + (h[6]! >> 4); // 52 bits
  return (n + 1) / 2 ** 52;
}

/**
 * Weighted random draw without replacement (Efraimidis–Spirakis): each candidate gets the
 * key u^(1/tickets) and the highest keys win. A candidate with twice the tickets is twice as
 * likely to be picked first. Compared as ln(u)/tickets to stay exact for large counts.
 */
export function drawWinners(seed: string, candidates: Candidate[], count: number): Candidate[] {
  return candidates
    .filter((c) => c.tickets > 0)
    .map((c) => ({ c, key: Math.log(ticketRandom(seed, c.participant_id)) / c.tickets }))
    .sort((x, y) => y.key - x.key || x.c.participant_id - y.c.participant_id)
    .slice(0, count)
    .map((x) => x.c);
}

export const newSeed = () => randomBytes(32).toString("hex");
