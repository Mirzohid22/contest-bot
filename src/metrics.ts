import client from "prom-client";
import type { Deps } from "./deps.js";
import type { Poller } from "./ingest/poller.js";

/** Prometheus metrics. Default metrics include event-loop lag, heap, and CPU. */
export function buildMetrics(d: Deps, poller: Poller): client.Registry {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const lanes = Object.values(d.tg.lanes);

  const gauge = (name: string, help: string, read: (lane: (typeof lanes)[number]) => number) =>
    new client.Gauge({
      name,
      help,
      labelNames: ["lane"],
      registers: [registry],
      collect() {
        for (const lane of lanes) this.set({ lane: lane.name }, read(lane));
      },
    });

  gauge("tg_lane_queue_depth", "Calls waiting in the lane", (l) => l.depth);
  gauge("tg_lane_oldest_age_seconds", "Age of the oldest waiting call", (l) => l.oldestAgeMs / 1000);
  gauge("tg_lane_rate", "Current allowed calls per second", (l) => l.rate);
  gauge("tg_lane_ok_total", "Calls that succeeded", (l) => l.stats.ok);
  gauge("tg_lane_limited_total", "429 responses received", (l) => l.stats.limited);
  gauge("tg_lane_dropped_total", "Calls dropped for waiting too long", (l) => l.stats.dropped);
  gauge("tg_lane_failed_total", "Calls that failed", (l) => l.stats.failed);

  new client.Gauge({
    name: "poller_updates_total",
    help: "Updates handled since start",
    registers: [registry],
    collect() {
      this.set(poller.stats.updates);
    },
  });
  new client.Gauge({
    name: "poller_seconds_since_last_poll",
    help: "Seconds since the last successful getUpdates",
    registers: [registry],
    collect() {
      this.set(poller.stats.lastPollAt ? (Date.now() - poller.stats.lastPollAt) / 1000 : 0);
    },
  });
  return registry;
}
