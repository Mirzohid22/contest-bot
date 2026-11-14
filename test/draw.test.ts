import { describe, expect, it } from "vitest";
import { drawWinners, newSeed, ticketRandom } from "../src/contest/draw.js";

describe("weighted draw", () => {
  it("is reproducible from its seed", () => {
    const seed = "a".repeat(64);
    const c = [1, 2, 3, 4, 5].map((i) => ({ participant_id: i, tickets: i }));
    expect(drawWinners(seed, c, 3)).toEqual(drawWinners(seed, [...c].reverse(), 3));
    expect(ticketRandom(seed, 1)).toBeGreaterThan(0);
    expect(ticketRandom(seed, 1)).toBeLessThanOrEqual(1);
  });

  it("gives each ticket the same chance", () => {
    // 1 ticket vs 3 tickets: the second should win first place about 75% of the time.
    const c = [
      { participant_id: 1, tickets: 1 },
      { participant_id: 2, tickets: 3 },
    ];
    let second = 0;
    const runs = 20_000;
    for (let i = 0; i < runs; i++) if (drawWinners(newSeed(), c, 1)[0]!.participant_id === 2) second++;
    expect(second / runs).toBeGreaterThan(0.73);
    expect(second / runs).toBeLessThan(0.77);
  });

  it("never picks anyone twice or anyone without tickets", () => {
    const c = [
      { participant_id: 1, tickets: 0 },
      { participant_id: 2, tickets: 5 },
      { participant_id: 3, tickets: 1 },
    ];
    const won = drawWinners(newSeed(), c, 5);
    expect(won.map((w) => w.participant_id).sort()).toEqual([2, 3]);
  });
});
