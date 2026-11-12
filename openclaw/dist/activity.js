// Generic public lifecycle state only. Session keys and native IDs never leave this process.
import { createHash } from "node:crypto";
import { forwarderOrigin,             } from "./devices.js";



const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function parseActivity(value     )                                     {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !["trackingID", "sessionKey", "mode", "backgrounded", "eligible", "currentRun"].includes(k))) return false;
  if (!uuid.test(value.trackingID) || typeof value.sessionKey !== "string" || !value.sessionKey || value.sessionKey.length > 1024 || /[\u0000-\u001f]/u.test(value.sessionKey) || !["long", "manual"].includes(value.mode) || typeof value.backgrounded !== "boolean" || typeof value.eligible !== "boolean") return false;
  const run = value.currentRun;
  if (run !== undefined && (!run || typeof run !== "object" || Array.isArray(run) || Object.keys(run).some(k => !["id", "startedAt"].includes(k)) || typeof run.id !== "string" || !run.id || run.id.length > 1024 || !Number.isFinite(run.startedAt) || run.startedAt <= 0 || run.startedAt > Date.now() / 1000 + 300)) return false;
  return { ...value, trackingID: value.trackingID.toLowerCase(), ...(run ? { currentRun: { ...run } } : {}) };
}
/** The chats a device follows, at most four, each its own row on the device's one card. */
export const maxFollows = 4;
export function parseActivities(value     )                                       {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > maxFollows) return false;
  const follows = value.map(parseActivity);
  if (follows.some(follow => !follow)) return false;
  const valid = follows                    ;
  return new Set(valid.map(follow => follow.trackingID)).size === valid.length ? valid : false;
}
/** A chat's row. `id` names the row on the wire; `native` is the turn it follows now, and `turns`
 * every turn it has covered. A turn that ends with the chat's helpers still working, or yielded to
 * them, leaves the row `held`, and the chat's next turn (the helpers' announce) carries it on under
 * the same `id`. */



/** `grace`: how long a held row waits, after its chat's last helper ends, for the announce turn. */
const clock        = { now: () => Date.now() / 1000, later: setTimeout, cancel: clearTimeout, threshold: 20, cap: 8 * 3600, grace: 60 };

export class Activities {
          targets = new Map                ();
          runs = new Map             ();
          waits = new Map                                                                    ();
  /** Helper sessions still working, by the session that spawned them. */
          helpers = new Map                                                                    ();
          closed = false;
          next              ;
          post                                                   ;
          time       ;
  constructor(next              , post = forwardActivity, time        = clock) { this.next = next; this.post = post; this.time = time; }

  /** Each followed chat is a target of its own; a chat the device no longer follows ends its row. */
  register(device        ) {
    const follows = device.activities ?? [];
    for (const target of [...this.targets.values()]) {
      if (target.device.id === device.id && !follows.some(f => f.trackingID === target.follow.trackingID && f.sessionKey === target.follow.sessionKey)) this.drop(target);
    }
    if (this.closed) return;
    for (const follow of follows) {
      const key = `${device.id}\n${follow.trackingID}`;
      const old = this.targets.get(key);
      if (old) {
        old.device = device;
        old.follow = follow;
        if (follow.currentRun && (!old.run || (old.run.ended && !old.run.turns.has(follow.currentRun.id) && follow.currentRun.startedAt >= old.run.startedAt))) {
          this.start(follow.sessionKey, follow.currentRun.id, follow.currentRun.startedAt);
        }
        this.qualify(old);
        continue;
      }
      const target         = { key, device, follow, announced: false, delivered: false, needsDelivered: false, queue: Promise.resolve() };
      this.targets.set(key, target);
      let run = this.runs.get(follow.sessionKey);
      if (!run && follow.currentRun) {
        run = { ...follow.currentRun, native: follow.currentRun.id, turns: new Set([follow.currentRun.id]), eligible: false, pending: this.waits.get(follow.sessionKey)?.ids ?? new Set(), ended: false, held: false };
        this.runs.set(follow.sessionKey, run);
      }
      target.run = run;
      this.qualify(target);
    }
  }
  remove(id        ) {
    for (const target of [...this.targets.values()]) if (target.device.id === id) this.drop(target);
  }
          drop(target        ) {
    this.clear(target);
    if (target.announced) this.emit(target, "end", "stopped");
    this.targets.delete(target.key);
    const key = target.follow.sessionKey;
    if (![...this.targets.values()].some(t => t.follow.sessionKey === key)) {
      this.time.cancel(this.runs.get(key)?.grace);
      this.runs.delete(key);
    }
  }
  start(session        , id        , startedAt = this.time.now()) {
    if (!session || !id || this.closed || ![...this.targets.values()].some(t => t.follow.sessionKey === session)) return;
    if (this.resume(session, id)) return;
    let run = this.runs.get(session);
    if (run?.turns.has(id)) return;
    if (run) {
      this.forgetWaits(session);
      this.time.cancel(run.grace);
    }
    run = { id, native: id, turns: new Set([id]), startedAt, eligible: false, pending: this.waits.get(session)?.ids ?? new Set(), ended: false, held: false };
    this.runs.set(session, run);
    for (const target of this.targets.values()) if (target.follow.sessionKey === session) {
      this.clear(target);
      if (target.announced) this.emit(target, "end", "stopped");
      target.run = run;
      target.announced = target.delivered = target.needsDelivered = false;
      this.qualify(target);
    }
  }
  /** A turn in a held chat carries its row on. OpenClaw's announce turn sends no lifecycle start,
   * so any of its lifecycle events does. */
  resume(session        , id        )          {
    const run = this.runs.get(session);
    // A row past its eight-hour cap is over: the chat's next turn starts a row of its own.
    if (!id || !run?.held || run.ended || run.turns.has(id) || this.time.now() - run.startedAt >= this.time.cap) return false;
    run.native = id;
    if (run.turns.size < 64) run.turns.add(id);
    run.held = false;
    this.time.cancel(run.grace);
    return true;
  }
  progress(session        , id        ) {
    const run = this.runs.get(session);
    if (!run || run.native !== id || run.ended) return;
    this.eligible(run);
  }
          eligible(run     ) {
    run.eligible = true;
    for (const target of this.targets.values()) if (target.run === run) this.qualify(target);
  }
  /** A helper session spawned by `parent`, starting or ending. Its parent's row works while any remain. */
  helper(parent                    , id                    , running         ) {
    if (!parent || !id || this.closed) return;
    let helpers = this.helpers.get(parent);
    if (running) {
      if (!helpers) {
        if (this.helpers.size >= 256) this.forgetHelpers(this.helpers.keys().next().value );
        const ids = new Set        ();
        const timer = this.time.later(() => { if (this.helpers.get(parent)?.ids === ids) this.forgetHelpers(parent); }, this.time.cap * 1000);
        timer.unref?.();
        helpers = { ids, timer };
        this.helpers.set(parent, helpers);
      }
      if (helpers.ids.size < 999) helpers.ids.add(id);
      const run = this.runs.get(parent);
      if (run && !run.ended) {
        this.time.cancel(run.grace);
        this.eligible(run);
      }
      return;
    }
    if (!helpers?.ids.delete(id)) return;
    if (helpers.ids.size) return;
    this.forgetHelpers(parent);
    const run = this.runs.get(parent);
    if (!run?.held || run.ended) return;
    // The announce turn usually starts within seconds; a helper that announces nothing ends the row.
    this.time.cancel(run.grace);
    run.grace = this.time.later(() => { if (this.runs.get(parent) === run && run.held) this.finish(parent, run, "replied"); }, this.time.grace * 1000);
    run.grace.unref?.();
  }
  async human(session                    , requestID        , resolved = false)                       {
    const handled = new Set        ();
    if (this.closed || !requestID) return handled;
    const changed = new Set        ();
    if (resolved) {
      for (const [key, waits] of this.waits) if (waits.ids.delete(requestID)) {
        changed.add(key);
        if (!waits.ids.size) this.forgetWaits(key);
      }
    } else if (session) {
      let waits = this.waits.get(session);
      if (!waits) {
        if (this.waits.size >= 256) this.forgetWaits(this.waits.keys().next().value );
        const ids = new Set        ();
        const timer = this.time.later(() => { if (this.waits.get(session)?.ids === ids) this.forgetWaits(session); }, this.time.cap * 1000);
        timer.unref?.();
        waits = { ids, timer };
        this.waits.set(session, waits);
      }
      waits.ids.add(requestID);
      if (waits.ids.size > 999) waits.ids.delete(waits.ids.values().next().value );
      changed.add(session);
    }
    for (const key of changed) {
      const run = this.runs.get(key);
      if (run && !run.ended) run.pending = this.waits.get(key)?.ids ?? new Set();
    }
    for (const target of this.targets.values()) {
      const run = target.run;
      if (!run || run.ended || !changed.has(target.follow.sessionKey)) continue;
      if (!target.announced) this.qualify(target);
      else this.emit(target, "update", run.pending.size ? "needsYou" : "working");
      await target.queue;
      if (target.delivered && target.needsDelivered && target.announced && run.pending.size) handled.add(target.device.id);
    }
    return handled;
  }
  /** `yielded`: the turn handed off to its helpers, whose announce turn carries on. */
  end(session        , id        , phase                                  , yielded = false) {
    const run = this.runs.get(session);
    if (run?.native === id && !run.ended && phase === "replied" && (yielded || this.helpers.get(session)?.ids.size)) {
      run.held = true;
      return;
    }
    if (!run || run.native === id) this.forgetWaits(session);
    if (!run || run.native !== id || run.ended) return;
    this.finish(session, run, phase);
  }
          finish(session        , run     , phase                                  ) {
    this.forgetWaits(session);
    this.time.cancel(run.grace);
    run.ended = true;
    run.held = false;
    for (const target of this.targets.values()) if (target.run === run) {
      this.clear(target);
      if (target.announced) this.emit(target, "end", phase);
      target.announced = false;
    }
  }
          qualify(target        ) {
    const follow = target.follow, run = target.run;
    if (!run || run.ended || target.announced || this.closed) return;
    this.time.cancel(target.timer);
    if (this.time.now() - run.startedAt >= this.time.cap) return;
    const manual = follow.mode === "manual" && !!follow.currentRun && run.turns.has(follow.currentRun.id);
    if (follow.mode === "manual" && !manual) return;
    if (!manual && !follow.backgrounded) return;
    const remaining = this.time.threshold - (this.time.now() - run.startedAt);
    if (!manual && !follow.eligible && !run.eligible && remaining > 0) {
      target.timer = this.time.later(() => { if (this.targets.get(target.key) === target && target.run === run) this.qualify(target); }, remaining * 1000);
      target.timer.unref?.();
      return;
    }
    target.announced = true;
    this.emit(target, "start", run.pending.size ? "needsYou" : "working");
    target.cap = this.time.later(() => {
      if (this.targets.get(target.key) !== target || target.run !== run || !target.announced) return;
      this.emit(target, "end", "stillWorking");
      target.announced = false;
      this.clear(target);
    }, (this.time.cap - (this.time.now() - run.startedAt)) * 1000);
    target.cap.unref?.();
  }
          emit(target        , event                        , phase                        ) {
    const run = target.run , device = target.device;
    const message                = { v: 1, trackingID: target.follow.trackingID, runID: createHash("sha256").update(run.id).digest("hex"), seq: this.next(), event, startedAt: run.startedAt, phase, needsYou: phase === "needsYou" ? Math.min(999, run.pending.size) : 0, ...(event === "end" ? { endedAt: this.time.now() } : {}) };
    target.queue = target.queue.catch(() => {}).then(async () => {
      if (this.closed) return;
      const sent = await this.post(device, message).catch(() => false);
      if (target.run === run) {
        if (event === "start") target.delivered = sent;
        target.needsDelivered = phase === "needsYou" && sent;
      }
    });
  }
          forgetWaits(session        ) {
    const waits = this.waits.get(session);
    if (!waits) return;
    this.time.cancel(waits.timer);
    waits.ids.clear();
    this.waits.delete(session);
  }
          clear(target        ) { this.time.cancel(target.timer); this.time.cancel(target.cap); }
          forgetHelpers(session        ) {
    const helpers = this.helpers.get(session);
    if (!helpers) return;
    this.time.cancel(helpers.timer);
    this.helpers.delete(session);
  }
  close() {
    this.closed = true;
    for (const target of this.targets.values()) this.clear(target);
    this.targets.clear();
    for (const run of this.runs.values()) this.time.cancel(run.grace);
    this.runs.clear();
    for (const key of this.waits.keys()) this.forgetWaits(key);
    for (const key of this.helpers.keys()) this.forgetHelpers(key);
  }
}

export async function forwardActivity(device        , event               )                   {
  // Never derive this route from a registration's arbitrary URL, and never retire ordinary tokens.
  for (let attempt = 0; attempt < (event.event === "end" ? 3 : 2); attempt++) {
    try {
      const response = await fetch(`${forwarderOrigin()}/v1/activity/${encodeURIComponent(device.id)}`, { method: "POST", headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: JSON.stringify(event), redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (response.status === 502) continue;
      return response.status === 200;
    } catch { /* A bounded retry reuses exactly the same sequence. No sensitive logging. */ }
  }
  return false;
}
