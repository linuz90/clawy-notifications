import assert from "node:assert/strict";
import { mock as nodeMock, test } from "node:test";
import { createECDH, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import { Activities, forwardActivity, parseActivities, parseActivity, type ActivityEvent } from "../activity.ts";
import { DeviceFile, parseDevice, type Device } from "../devices.ts";

const trackingID = "7b34eddb-598a-41e0-946e-fd7d0090a124";
function device(overrides = {}): Device {
  const key = createECDH("prime256v1"); key.generateKeys();
  return { v: 2, id: "one", forwarder: "https://openclaw-client-relay.linuz90.workers.dev/v1/forward/one", token: "fake", p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16).toString("base64url"), activities: [{ trackingID, sessionKey: "agent:a:ios-native-one", mode: "long", backgrounded: true, eligible: false, ...overrides }] };
}
/** Older tests keep the time rule alone (20 s, no settle, no window); `timing` sets the rest. */
function fixture(timing: { threshold?: number; settle?: number; quick?: number; window?: number } = {}) {
  let now = 1000, seq = 0;
  const scheduled = new Set<any>(), sent: ActivityEvent[] = [];
  const time = { now: () => now, threshold: 20, settle: 0, quick: 0, window: Infinity, ...timing, cap: 8 * 3600, grace: 60,
    later: ((fn: () => void, delay: number) => { const token = { fn, due: now + delay / 1000, unref() {} }; scheduled.add(token); return token; }) as any,
    cancel: ((token: any) => scheduled.delete(token)) as any };
  const activities = new Activities(() => ++seq, async (_, e) => { sent.push(e); return true; }, time);
  return { activities, sent, scheduled, async tick(seconds = 0) { now += seconds; for (const token of [...scheduled]) if (token.due <= now) { scheduled.delete(token); token.fn(); } await new Promise(setImmediate); } };
}

test("strict activity registration survives persistence and does not change protocol 2", () => {
  const d = device(); assert.deepEqual(parseDevice(d)?.activities, d.activities);
  for (const bad of [{ ...d.activities![0], backgrounded: "yes" }, { ...d.activities![0], extra: "text" }, { ...d.activities![0], trackingID: "x" }, { ...d.activities![0], currentRun: { id: "run", startedAt: NaN } }, { ...d.activities![0], currentRun: null }]) assert.equal(parseActivity(bad), false);
  assert.equal(parseActivity(null), undefined);
  const follow = d.activities![0], other = { ...follow, trackingID: "8b34eddb-598a-41e0-946e-fd7d0090a124" };
  assert.equal(parseActivities([follow, follow]), false);
  assert.equal(parseActivities(Array.from({ length: 5 }, (_, i) => ({ ...follow, trackingID: `${i}b34eddb-598a-41e0-946e-fd7d0090a124` }))), false);
  assert.equal(parseActivities(follow), false);
  assert.deepEqual(parseActivities([follow, other]), [follow, other]);
  assert.equal(parseDevice({ ...d, activities: [follow, { ...other, mode: "sometimes" }] }), null);
  const folder = mkdtempSync(join(tmpdir(), "clawy-activity-"));
  try { const file = new DeviceFile(join(folder, "devices")); file.add(parseDevice(d)!); assert.deepEqual(file.list()[0].activities, d.activities); } finally { rmSync(folder, { recursive: true }); }
});

test("long mode ignores quick, unrelated and foreground runs; background registration qualifies an observed run", async () => {
  const f = fixture(), d = device(), key = d.activities![0].sessionKey;
  f.activities.register(d); f.activities.start("agent:a:cron:job", "other"); await f.tick(30); assert.equal(f.sent.length, 0);
  f.activities.start(key, "quick"); f.activities.end(key, "quick", "replied"); await f.tick(30); assert.equal(f.sent.length, 0);
  f.activities.register({ ...d, activities: [{ ...d.activities![0], backgrounded: false }] });
  f.activities.start(key, "slow"); await f.tick(30); assert.equal(f.sent.length, 0);
  f.activities.register(d); await f.tick(); assert.equal(f.sent[0].event, "start");
  assert.equal(f.sent[0].runID, createHash("sha256").update("slow").digest("hex"));
  f.activities.end(key, "slow", "replied"); await f.tick(); assert.equal(f.sent.at(-1)?.phase, "replied"); assert.equal(f.scheduled.size, 0);
  f.activities.start(key, "disabled"); const stale = [...f.scheduled][0];
  f.activities.register({ ...d, activities: undefined }); const count = f.sent.length; stale.fn(); await f.tick(30); assert.equal(f.sent.length, count); assert.equal(f.scheduled.size, 0); f.activities.close();
});

const timing = { threshold: 60, settle: 15, quick: 5, window: 120 };
const away = (d: Device, backgrounded: boolean, extra = {}) => ({ ...d, activities: [{ ...d.activities![0], backgrounded, ...extra }] });

test("long mode shows a run still working a while after the person left, never an ordinary turn they leave near its end", async () => {
  const f = fixture(timing), d = device(), key = d.activities![0].sessionKey;
  f.activities.register(away(d, false)); f.activities.start(key, "ordinary"); await f.tick(50);
  f.activities.register(away(d, true)); await f.tick(5);
  assert.equal(f.sent.length, 0, "a turn already past the threshold waits for the person to have been away a while");
  f.activities.end(key, "ordinary", "replied"); await f.tick(30); assert.equal(f.sent.length, 0, "it ended first: its reply's notification is enough");
  f.activities.start(key, "long"); await f.tick(59); assert.equal(f.sent.length, 0, "a minute of work makes a run long");
  await f.tick(1); assert.deepEqual([f.sent.at(-1)?.event, f.sent.at(-1)?.phase], ["start", "working"]);
  f.activities.end(key, "long", "replied"); await f.tick();

  // Watched in the app for minutes, it shows once the person has been away for the settle time.
  f.activities.register(away(d, false)); f.activities.start(key, "watched"); await f.tick(300);
  f.activities.register(away(d, true)); await f.tick(14); assert.equal(f.sent.at(-1)?.phase, "replied");
  await f.tick(1); assert.deepEqual([f.sent.at(-1)?.event, f.sent.at(-1)?.runID], ["start", createHash("sha256").update("watched").digest("hex")]);
  f.activities.close(); assert.equal(f.scheduled.size, 0);
});

test("the app's early hint covers the run it was sent with, not the chat's later runs", async () => {
  const f = fixture(timing), d = device(), key = d.activities![0].sessionKey;
  f.activities.register(away(d, true, { eligible: true, currentRun: { id: "helped", startedAt: 1000 } })); await f.tick(4);
  assert.equal(f.sent.length, 0, "even a run known to be long waits a moment, in case it ends as the person leaves");
  await f.tick(1); assert.equal(f.sent.at(-1)?.event, "start", "a run with a helper or progress card shows almost at once");
  f.activities.end(key, "helped", "replied"); await f.tick();
  f.activities.start(key, "later"); await f.tick(30);
  assert.equal(f.sent.at(-1)?.phase, "replied", "a later run of the chat waits for the time rule");
  await f.tick(30); assert.deepEqual([f.sent.at(-1)?.event, f.sent.at(-1)?.runID], ["start", createHash("sha256").update("later").digest("hex")]);
  f.activities.end(key, "later", "replied"); await f.tick();
  // A registration naming an earlier run, late, doesn't hand its hint to the run going now.
  f.activities.start(key, "ordinary"); f.activities.register(away(d, true, { eligible: true, currentRun: { id: "helped", startedAt: 1000 } })); await f.tick(30);
  assert.equal(f.sent.at(-1)?.phase, "replied");
  f.activities.close(); assert.equal(f.scheduled.size, 0);
});

test("helpers that finish as the person leaves leave no card, unless their announce turn works", async () => {
  const f = fixture(timing), d = device(), key = d.activities![0].sessionKey;
  f.activities.register(away(d, true)); f.activities.start(key, "quiet"); f.activities.helper(key, "agent:a:subagent:one", true);
  await f.tick(1); f.activities.end(key, "quiet", "replied");
  await f.tick(1); f.activities.helper(key, "agent:a:subagent:one", false);
  await f.tick(60); assert.equal(f.sent.length, 0, "nothing worked once the helper finished, and no announce came");
  // Back in the app and away again: this time the announce turn runs.
  f.activities.register(away(d, false)); f.activities.register(away(d, true));
  f.activities.start(key, "told"); f.activities.helper(key, "agent:a:subagent:two", true);
  await f.tick(1); f.activities.end(key, "told", "replied");
  await f.tick(1); f.activities.helper(key, "agent:a:subagent:two", false);
  await f.tick(3); assert.equal(f.sent.length, 0, "held, waiting on the announce turn");
  f.activities.start(key, "told-announce"); await f.tick(); assert.deepEqual([f.sent.at(-1)?.event, f.sent.at(-1)?.phase], ["start", "working"]);
  f.activities.end(key, "told-announce", "replied"); await f.tick(); assert.deepEqual([f.sent.at(-1)?.event, f.sent.at(-1)?.phase], ["end", "replied"]);
  f.activities.close(); assert.equal(f.scheduled.size, 0);
});

test("a run starting long after the person left takes no row until they come back and leave again", async () => {
  const f = fixture(timing), d = device(), key = d.activities![0].sessionKey;
  f.activities.register(away(d, true)); await f.tick(600);
  // A follow replaced while the phone stays away keeps the time it left.
  f.activities.register(away(d, true, { trackingID: "8b34eddb-598a-41e0-946e-fd7d0090a124" }));
  f.activities.start(key, "from-another-device"); await f.tick(120);
  assert.equal(f.sent.length, 0, "a turn begun elsewhere while the phone was away isn't one they left running");
  const replaced = { trackingID: "8b34eddb-598a-41e0-946e-fd7d0090a124" };
  f.activities.register(away(d, false, replaced)); await f.tick(5); f.activities.register(away(d, true, replaced)); await f.tick(14);
  assert.equal(f.sent.length, 0);
  await f.tick(1); assert.equal(f.sent.at(-1)?.event, "start", "seen in the app, it is theirs");
  f.activities.close(); assert.equal(f.scheduled.size, 0);
});

test("manual targets only the seeded run; wait counts resume and terminal state cannot resurrect", async () => {
  const f = fixture(), d = device({ mode: "manual", backgrounded: false, currentRun: { id: "native", startedAt: 1000 } });
  f.activities.register(d); await f.tick(); assert.equal(f.sent[0].event, "start");
  assert.ok((await f.activities.human(d.activities![0].sessionKey, "approval:1")).has(d.id));
  await f.activities.human(d.activities![0].sessionKey, "question:2"); assert.equal(f.sent.at(-1)?.needsYou, 2);
  await f.activities.human(undefined, "approval:1", true); assert.equal(f.sent.at(-1)?.needsYou, 1);
  await f.activities.human(undefined, "question:2", true); assert.equal(f.sent.at(-1)?.phase, "working");
  f.activities.end(d.activities![0].sessionKey, "native", "stopped"); await f.tick(); const count = f.sent.length;
  f.activities.start(d.activities![0].sessionKey, "native"); await f.tick(); assert.equal(f.sent.length, count);
  f.activities.start(d.activities![0].sessionKey, "next"); await f.tick(30); assert.equal(f.sent.length, count); f.activities.close(); assert.equal(f.scheduled.size, 0);
});

test("pre-follow waits seed Needs you, survive target replacement, resolve and expire", async () => {
  const f = fixture(), key = device().activities![0].sessionKey;
  await f.activities.human(key, "before-follow");
  const d = device({ mode: "manual", backgrounded: false, currentRun: { id: "native", startedAt: 1000 } });
  f.activities.register(d); await f.tick(); assert.equal(f.sent[0].phase, "needsYou"); assert.equal(f.sent[0].needsYou, 1);
  f.activities.register({ ...d, activities: [{ ...d.activities![0], trackingID: "8b34eddb-598a-41e0-946e-fd7d0090a124" }] });
  await f.tick(); assert.equal(f.sent.at(-1)?.phase, "needsYou");
  await f.activities.human(undefined, "before-follow", true); assert.equal(f.sent.at(-1)?.phase, "working");
  f.activities.remove(d.id);
  await f.activities.human(key, "terminal-before-follow"); f.activities.end(key, "native", "stopped");
  f.activities.register(d); await f.tick(); assert.equal(f.sent.at(-1)?.phase, "working");
  f.activities.remove(d.id);
  await f.activities.human(key, "expires-before-follow"); await f.tick(8 * 3600 + 1);
  f.activities.register(device({ mode: "manual", currentRun: { id: "fresh", startedAt: 1000 + 8 * 3600 + 1 } })); await f.tick(); assert.equal(f.sent.at(-1)?.phase, "working");
  f.activities.close(); assert.equal(f.scheduled.size, 0);
});

test("eligibility, replacement, unload and eight-hour cap clear their timers", async () => {
  const f = fixture(), d = device(), key = d.activities![0].sessionKey;
  f.activities.register(d); f.activities.start(key, "run"); f.activities.progress(key, "run"); await f.tick(); assert.equal(f.sent[0].phase, "working");
  const stale = [...f.scheduled][0];
  f.activities.register({ ...d, activities: [{ ...d.activities![0], trackingID: "8b34eddb-598a-41e0-946e-fd7d0090a124", currentRun: { id: "run", startedAt: 1000 } }] });
  stale.fn(); await f.tick(20); assert.equal(f.sent.filter(e => e.phase === "stillWorking").length, 0);
  await f.tick(8 * 3600); assert.equal(f.sent.at(-1)?.phase, "stillWorking"); assert.equal(f.scheduled.size, 0); f.activities.close();
});

test("activity forwarding uses fixed route, retries one sequence and never removes ordinary registration", async () => {
  const original = globalThis.fetch, sent: any[] = [];
  globalThis.fetch = (async (url, options) => { sent.push([url, JSON.parse(options!.body as string)]); return new Response(null, { status: sent.length < 3 ? 502 : 410 }); }) as any;
  try {
    const d = device(), e: ActivityEvent = { v: 1, trackingID, runID: "a".repeat(64), seq: 3, event: "end", startedAt: 1000, phase: "stopped", needsYou: 0, endedAt: 1020 };
    assert.equal(await forwardActivity(d, e), false); assert.equal(sent.length, 3); assert.deepEqual(sent[0], sent[2]); assert.match(sent[0][0], /\/v1\/activity\/one$/u);
  } finally { globalThis.fetch = original; }
});

test("actual plugin registration and lifecycle hooks handle silent, abort, error and yielded parent", async () => {
  const folder = mkdtempSync(join(tmpdir(), "clawy-plugin-hooks-")), methods = new Map(), hooks = new Map(), observers: any[] = [], posts: any[] = [];
  let event: any, transcript: any, service: any;
  const original = globalThis.fetch, realDateNow = Date.now;
  const mock: any = { clients: observers, definePluginEntry: (p: any) => p };
  (globalThis as any).__clawyActivityTest = mock;
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
    .replace(/import .* from "openclaw\/plugin-sdk\/gateway-runtime";/u, 'const { createOperatorApprovalsGatewayClient, GatewayClient, resolveGatewayAuth } = globalThis.__clawyActivityTest;')
    .replace(/import .* from "openclaw\/plugin-sdk\/plugin-entry";/u, 'const { definePluginEntry } = globalThis.__clawyActivityTest;')
    .replace(/from "\.\/([\w-]+)\.ts"/gu, (_, name) => `from "${new URL(`../${name}.ts`, import.meta.url)}"`);
  mock.createOperatorApprovalsGatewayClient = async (options: any) => { observers.push(options); return { start() {}, stop() {} }; };
  mock.GatewayClient = class { constructor(options: any) { observers.push(options); } start() {} stop() {} };
  mock.resolveGatewayAuth = () => ({});
  writeFileSync(join(folder, "plugin.mjs"), stripTypeScriptTypes(source));
  globalThis.fetch = (async (url, options) => { posts.push({ url, body: JSON.parse(options!.body as string) }); return new Response(null, { status: 200 }); }) as any;
  try {
    const plugin = (await import(pathToFileURL(join(folder, "plugin.mjs")).href)).default;
    plugin.register({ registerTool() {}, logger: { warn() {} }, runtime: { state: { resolveStateDir: () => folder }, events: { onAgentEvent: (fn: any) => { event = fn; return () => {}; }, onSessionTranscriptUpdate: (fn: any) => { transcript = fn; return () => {}; } } }, registerGatewayMethod: (name: string, fn: any) => methods.set(name, fn), on: (name: string, fn: any) => hooks.set(name, fn), registerService: (value: any) => service = value });
    let result: any;
    const call = (method: string, params = {}) => methods.get(`clawy.notifications.${method}`)({ params, client: { connect: { scopes: ["operator.admin"] } }, respond: (ok: boolean, value: any) => { assert.ok(ok); result = value; } });
    call("status"); assert.equal(result.liveActivities, 2); assert.equal(result.protocol, 2); assert.equal(result.version, "0.4.7"); assert.equal(result.mutes, 1);
    const d = device(); call("register", d); await service.start({ config: {} });
    // A forward with no answer goes once more, the same sealed body, and the device's health is that answer.
    const forwards: string[] = [], bounds: number[] = [], ordinary = globalThis.fetch, timeout = AbortSignal.timeout;
    let stalls = 1;
    AbortSignal.timeout = ((ms: number) => { bounds.push(ms); const stop = new AbortController(); setImmediate(() => stop.abort(new DOMException("timed out", "TimeoutError"))); return stop.signal; }) as any;
    globalThis.fetch = (async (url, options) => {
      if (!String(url).includes("/v1/forward/")) return new Response(null, { status: 200 });
      forwards.push(options!.body as string);
      const signal = options!.signal!;
      return stalls-- > 0 ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) : new Response(null, { status: 200 });
    }) as any;
    try {
      await call("test", { id: d.id, test: "nonce" });
      assert.equal(result.status, 200); assert.equal(forwards.length, 2); assert.equal(forwards[0], forwards[1]);
      call("status"); assert.equal(result.devices[0].delivery.status, 200);
      // Two tries with no answer still fit the app's 15-second wait on a Send Test, and read as out of reach.
      assert.ok(bounds.length >= 2 && bounds.every((ms) => ms * 2 < 15_000), `${bounds}`);
      stalls = 2; await call("test", { id: d.id, test: "again" });
      assert.equal(result.status, 0);
      call("status"); assert.equal(result.devices[0].delivery.status, 0);
    } finally { globalThis.fetch = ordinary; AbortSignal.timeout = timeout; }
    const fire = async (runId: string, data: any) => { event({ sessionKey: d.activities![0].sessionKey, runId, stream: "lifecycle", data }); await new Promise(setImmediate); };
    // The person has been away past the moment even a run known to be long waits.
    const realNow = Date.now; Date.now = () => realNow() + 10_000;
    await fire("ordinary-tool", { phase: "start", startedAt: Date.now() });
    event({ sessionKey: d.activities![0].sessionKey, runId: "ordinary-tool", stream: "tool", data: { phase: "start", name: "web_fetch" } }); await new Promise(setImmediate);
    assert.equal(posts.length, 0, "an ordinary tool does not bypass the time rule");
    event({ sessionKey: d.activities![0].sessionKey, runId: "ordinary-tool", stream: "tool", data: { phase: "start", name: "sessions_spawn" } }); await new Promise(setImmediate);
    assert.equal(posts.at(-1).body.event, "start", "an explicit helper spawn qualifies early");
    await fire("ordinary-tool", { phase: "end", terminalReply: { disposition: "silent" } }); posts.length = 0;
    // The app's hint arrives with the run it describes, and covers that run alone.
    const hinted = async (runId: string, data: any) => { await fire(runId, data); call("register", { ...d, activities: [{ ...d.activities![0], eligible: true, currentRun: { id: runId, startedAt: Date.now() / 1000 } }] }); await new Promise(setImmediate); };
    await hinted("silent", { phase: "start", startedAt: Date.now() });
    await fire("silent", { phase: "end", yielded: true }); assert.equal(posts.filter(p => p.body.event === "end").length, 0);
    await fire("silent-announce", { phase: "start" }); assert.equal(posts.filter(p => p.body.event === "end").length, 0, "the yielded parent's announce carries its row on");
    await fire("silent-announce", { phase: "end", terminalReply: { disposition: "silent" } }); assert.equal(posts.at(-1).body.phase, "replied");
    const ends = posts.filter(p => p.body.event === "end").length;
    await fire("helper-parent", { phase: "start", startedAt: Date.now() });
    hooks.get("subagent_progress")({ phase: "started", runId: "child-run", childSessionKey: "agent:a:subagent:x" }, { requesterSessionKey: d.activities![0].sessionKey });
    await fire("helper-parent", { phase: "end", terminalReply: { disposition: "silent" } });
    assert.equal(posts.filter(p => p.body.event === "end").length, ends, "a reply with a helper working keeps the row");
    hooks.get("subagent_progress")({ phase: "ended", runId: "child-run", childSessionKey: "agent:a:subagent:x", outcome: "ok" }, { requesterSessionKey: d.activities![0].sessionKey });
    // OpenClaw's announce turn sends no lifecycle start: its first event is `model`.
    await fire("announce:v1:agent:a:subagent:x:child-run", { phase: "model" }); await fire("announce:v1:agent:a:subagent:x:child-run", { phase: "end" });
    assert.equal(posts.filter(p => p.body.event === "end").length, ends + 1); assert.equal(posts.at(-1).body.phase, "replied");
    hooks.get("subagent_ended")({ targetSessionKey: "agent:a:subagent:x" }, { requesterSessionKey: d.activities![0].sessionKey });
    await hinted("abort", { phase: "start" }); await fire("abort", { phase: "end", aborted: true }); assert.equal(posts.at(-1).body.phase, "stopped");
    await hinted("error", { phase: "start" }); await fire("error", { phase: "error" }); assert.equal(posts.at(-1).body.phase, "failed");
    await hinted("wait", { phase: "start" }); observers[0].onEvent({ event: "exec.approval.requested", payload: { id: "a", request: { sessionKey: d.activities![0].sessionKey, command: "private" } } }); await new Promise(setImmediate);
    assert.equal(posts.at(-1).body.phase, "needsYou"); assert.equal(posts.filter(p => p.body.sealed).length, 0);
    observers[0].onEvent({ event: "exec.approval.resolved", payload: { id: "a" } }); await new Promise(setImmediate); assert.equal(posts.at(-1).body.phase, "working");
    const normal = posts.filter(p => p.body.sealed).length;
    globalThis.fetch = (async (url, options) => { const body = JSON.parse(options!.body as string); posts.push({ url, body }); return new Response(null, { status: body.phase === "needsYou" ? 502 : 200 }); }) as any;
    observers[0].onEvent({ event: "exec.approval.requested", payload: { id: "failed-update", request: { sessionKey: d.activities![0].sessionKey, command: "private" } } }); await new Promise(setImmediate);
    assert.equal(posts.filter(p => p.body.sealed).length, normal + 1, "a failed Needs you update retains the ordinary alert");
    await fire("wait", { phase: "end", terminalReply: { disposition: "visible", text: "done" } });
    assert.equal(posts.filter(p => p.body.sealed).length, normal + 2, "visible reply still alerts normally");
    const post = { target: { agentId: "a", sessionId: "s", sessionKey: d.activities![0].sessionKey }, messageId: "post-1", message: { role: "assistant", content: [{ type: "text", text: "posted" }], openclawAutomation: {} } };
    transcript(post); transcript(post); await new Promise(setImmediate);
    assert.equal(posts.filter(p => p.body.sealed).length, normal + 3, "an automation's post alerts once, however often its commit is published");
    assert.equal(posts.at(-1).body.kind, "alert");
    for (const post of posts) assert.ok(!JSON.stringify(post.body).includes("private"));
    call("unregister", { id: d.id });
    observers[0].onEvent({ event: "exec.approval.requested", payload: { id: "before-registration", request: { sessionKey: d.activities![0].sessionKey, command: "synthetic" } } }); await new Promise(setImmediate);
    call("register", { ...d, activities: [{ ...d.activities![0], mode: "manual", currentRun: { id: "before-registration", startedAt: Date.now() / 1000 } }] }); await new Promise(setImmediate);
    assert.equal(posts.at(-1).body.event, "start"); assert.equal(posts.at(-1).body.phase, "needsYou");
    observers[0].onEvent({ event: "exec.approval.resolved", payload: { id: "before-registration" } }); await new Promise(setImmediate); assert.equal(posts.at(-1).body.phase, "working");
    service.stop();
  } finally { globalThis.fetch = original; Date.now = realDateNow; delete (globalThis as any).__clawyActivityTest; rmSync(folder, { recursive: true }); }
});

test("one device follows several chats, each its own row that starts and ends on its own", async () => {
  const f = fixture(), d = device(), first = d.activities![0];
  const second = { ...first, trackingID: "8b34eddb-598a-41e0-946e-fd7d0090a124", sessionKey: "agent:b:ios-native-two" };
  f.activities.register({ ...d, activities: [first, second] });
  f.activities.start(first.sessionKey, "one"); f.activities.start(second.sessionKey, "two"); await f.tick(25);
  assert.deepEqual(f.sent.map(e => [e.trackingID, e.event]), [[first.trackingID, "start"], [second.trackingID, "start"]]);
  assert.ok((await f.activities.human(second.sessionKey, "question:1")).has(d.id));
  assert.deepEqual([f.sent.at(-1)?.trackingID, f.sent.at(-1)?.phase], [second.trackingID, "needsYou"]);
  f.activities.end(first.sessionKey, "one", "replied"); await f.tick();
  assert.deepEqual([f.sent.at(-1)?.trackingID, f.sent.at(-1)?.phase], [first.trackingID, "replied"]);
  // Following one chat fewer ends only that chat's row.
  f.activities.register({ ...d, activities: [first] }); await f.tick();
  assert.deepEqual([f.sent.at(-1)?.trackingID, f.sent.at(-1)?.phase], [second.trackingID, "stopped"]);
  const count = f.sent.length;
  f.activities.start(second.sessionKey, "three"); await f.tick(30); assert.equal(f.sent.length, count);
  f.activities.start(first.sessionKey, "four"); await f.tick(25); assert.deepEqual([f.sent.at(-1)?.trackingID, f.sent.at(-1)?.event], [first.trackingID, "start"]);
  f.activities.remove(d.id); await f.tick(); assert.equal(f.sent.at(-1)?.phase, "stopped"); f.activities.close(); assert.equal(f.scheduled.size, 0);
});

test("a turn that ends while its helpers work keeps the row working into the announce turn", async () => {
  const f = fixture(), d = device(), key = d.activities![0].sessionKey, rowID = createHash("sha256").update("parent").digest("hex");
  f.activities.register(d); f.activities.start(key, "parent");
  f.activities.helper(key, "agent:a:subagent:one", true); await f.tick();
  assert.deepEqual([f.sent.at(-1)?.event, f.sent.at(-1)?.phase], ["start", "working"], "a spawned helper qualifies its parent early");
  f.activities.end(key, "parent", "replied"); await f.tick(120); assert.equal(f.sent.length, 1, "the parent's reply leaves the row working");
  f.activities.helper(key, "agent:a:subagent:one", false); await f.tick(5);
  f.activities.start(key, "announce"); await f.tick(); assert.equal(f.sent.length, 1, "the announce turn carries the row on");
  f.activities.end(key, "announce", "replied"); await f.tick();
  assert.deepEqual([f.sent.at(-1)?.event, f.sent.at(-1)?.phase, f.sent.at(-1)?.runID, f.sent.at(-1)?.startedAt], ["end", "replied", rowID, 1000]);
  assert.equal(f.scheduled.size, 0);

  // Two helpers: an announce turn between them holds again; a helper that announces nothing ends the row after the grace.
  f.activities.start(key, "second"); f.activities.helper(key, "agent:a:subagent:two", true); f.activities.helper(key, "agent:a:subagent:three", true); await f.tick();
  assert.equal(f.sent.at(-1)?.event, "start");
  f.activities.end(key, "second", "replied"); f.activities.helper(key, "agent:a:subagent:two", false);
  f.activities.start(key, "announce-two"); f.activities.end(key, "announce-two", "replied"); await f.tick(120);
  assert.equal(f.sent.at(-1)?.event, "start", "a helper still working holds the row through another announce");
  f.activities.helper(key, "agent:a:subagent:three", false); await f.tick(59); assert.equal(f.sent.at(-1)?.event, "start");
  await f.tick(1); assert.deepEqual([f.sent.at(-1)?.event, f.sent.at(-1)?.phase], ["end", "replied"]);

  // A yielded turn holds without a helper the plugin saw; a stop or failure never holds.
  f.activities.start(key, "yield"); f.activities.progress(key, "yield"); f.activities.end(key, "yield", "replied", true); await f.tick(120);
  assert.equal(f.sent.at(-1)?.event, "start");
  f.activities.start(key, "yield-announce"); f.activities.end(key, "yield-announce", "replied"); await f.tick(); assert.equal(f.sent.at(-1)?.phase, "replied");
  f.activities.start(key, "stopped"); f.activities.helper(key, "agent:a:subagent:four", true); f.activities.end(key, "stopped", "stopped"); await f.tick();
  assert.equal(f.sent.at(-1)?.phase, "stopped");
  f.activities.helper(key, "agent:a:subagent:four", false); f.activities.close(); assert.equal(f.scheduled.size, 0);
});

test("a held row the person isn't away for starts once they leave, and unrelated helpers never hold", async () => {
  const f = fixture(), d = device(), key = d.activities![0].sessionKey;
  f.activities.register({ ...d, activities: [{ ...d.activities![0], backgrounded: false }] });
  f.activities.start(key, "parent"); f.activities.helper(key, "agent:a:subagent:one", true);
  f.activities.helper("agent:a:ios-native-other", "agent:a:subagent:other", true);
  f.activities.end(key, "parent", "replied"); await f.tick(30); assert.equal(f.sent.length, 0);
  f.activities.register(d); await f.tick(); assert.deepEqual([f.sent.at(-1)?.event, f.sent.at(-1)?.phase], ["start", "working"]);
  f.activities.helper("agent:a:ios-native-other", "agent:a:subagent:other", false); await f.tick(120); assert.equal(f.sent.length, 1);
  f.activities.close(); assert.equal(f.scheduled.size, 0);
});

test("a carried-on row stays finished, takes a manual follow of its announce turn, and is never resumed past its cap", async () => {
  // A registration still naming the parent turn after the announce finished the row starts nothing.
  const f = fixture(), d = device(), key = d.activities![0].sessionKey;
  f.activities.register(d); f.activities.start(key, "parent"); f.activities.helper(key, "agent:a:subagent:one", true);
  f.activities.end(key, "parent", "replied"); f.activities.helper(key, "agent:a:subagent:one", false);
  f.activities.resume(key, "announce"); f.activities.end(key, "announce", "replied"); await f.tick();
  const count = f.sent.length; assert.equal(f.sent.at(-1)?.phase, "replied");
  f.activities.register({ ...d, activities: [{ ...d.activities![0], currentRun: { id: "parent", startedAt: 1000 } }] }); await f.tick(30);
  assert.equal(f.sent.length, count, "a finished row is never started again");
  f.activities.close();

  // Another device's explicit follow of the announce turn starts its row.
  const g = fixture(), other = { ...device(), id: "two" };
  g.activities.register(d); g.activities.start(key, "parent"); g.activities.helper(key, "agent:a:subagent:one", true);
  g.activities.end(key, "parent", "replied"); g.activities.resume(key, "announce"); await g.tick();
  g.activities.register({ ...other, activities: [{ ...d.activities![0], mode: "manual", backgrounded: false, currentRun: { id: "announce", startedAt: 1050 } }] }); await g.tick();
  assert.ok(g.sent.some(e => e.event === "start" && e.trackingID === d.activities![0].trackingID && e.phase === "working"));
  assert.equal(g.sent.filter(e => e.event === "start").length, 2, "both devices show the row");
  g.activities.close();

  // A held row whose helper never reports ending ends at the cap, and the next turn gets a row of its own.
  const h = fixture();
  h.activities.register(d); h.activities.start(key, "parent"); h.activities.helper(key, "agent:a:subagent:lost", true);
  h.activities.end(key, "parent", "replied"); await h.tick(8 * 3600);
  assert.equal(h.sent.at(-1)?.phase, "stillWorking");
  h.activities.start(key, "fresh"); await h.tick(25);
  assert.deepEqual([h.sent.at(-1)?.event, h.sent.at(-1)?.runID], ["start", createHash("sha256").update("fresh").digest("hex")]);
  h.activities.close(); assert.equal(h.scheduled.size, 0);
});

test("a chat followed afresh while only its helpers work gets a working row once the person leaves", async () => {
  // The app follows the chat on screen under a new tracking id each time it opens, so a turn that
  // ended with its helpers working before this follow leaves no row of its own to carry on.
  const f = fixture(), d = device(), first = d.activities![0], key = first.sessionKey;
  f.activities.register({ ...d, activities: [{ ...first, backgrounded: false }] });
  f.activities.start(key, "parent"); await f.tick(10); f.activities.helper(key, "agent:a:subagent:one", true);
  f.activities.end(key, "parent", "replied"); await f.tick(5);
  const reopened = { ...first, trackingID: "9b34eddb-598a-41e0-946e-fd7d0090a124", backgrounded: false, eligible: true };
  f.activities.register({ ...d, activities: [reopened] }); await f.tick(30);
  assert.equal(f.sent.length, 0, "nothing shows while the chat is on screen");
  f.activities.register({ ...d, activities: [{ ...reopened, backgrounded: true }] }); await f.tick();
  assert.deepEqual([f.sent.at(-1)?.trackingID, f.sent.at(-1)?.event, f.sent.at(-1)?.phase, f.sent.at(-1)?.startedAt], [reopened.trackingID, "start", "working", 1010]);
  // Its timer runs from the first helper's start; the announce turn carries the row on, and ends it.
  f.activities.helper(key, "agent:a:subagent:one", false); f.activities.resume(key, "announce"); await f.tick(120);
  assert.equal(f.sent.length, 1);
  f.activities.end(key, "announce", "replied"); await f.tick();
  assert.deepEqual([f.sent.at(-1)?.event, f.sent.at(-1)?.phase], ["end", "replied"]);
  f.activities.close(); assert.equal(f.scheduled.size, 0);

  // A chat first followed while a helper works, with no turn of its own seen, does the same; one
  // with no helper working stays off the card.
  const g = fixture();
  g.activities.helper(key, "agent:a:subagent:two", true); await g.tick(40);
  g.activities.register({ ...d, activities: [{ ...first, eligible: true }] }); await g.tick();
  assert.deepEqual([g.sent.at(-1)?.event, g.sent.at(-1)?.phase, g.sent.at(-1)?.startedAt], ["start", "working", 1000]);
  g.activities.helper(key, "agent:a:subagent:two", false); await g.tick(60);
  assert.deepEqual([g.sent.at(-1)?.event, g.sent.at(-1)?.phase], ["end", "replied"], "a helper that announces nothing ends the row after the grace");
  g.activities.register({ ...d, activities: [{ ...first, trackingID: reopened.trackingID }] }); await g.tick(30);
  assert.equal(g.sent.filter(e => e.event === "start").length, 1);
  g.activities.close(); assert.equal(g.scheduled.size, 0);
});

test("a reply reaches a device silently while the person uses Clawy on another, read from presence for that reply", async () => {
  const folder = mkdtempSync(join(tmpdir(), "clawy-plugin-presence-")), methods = new Map(), forwards: any[] = [], reads: string[] = [];
  let event: any, transcript: any, service: any, presence: any[] = [];
  const original = globalThis.fetch;
  const mock: any = { definePluginEntry: (p: any) => p, resolveGatewayAuth: () => ({}) };
  (globalThis as any).__clawyActivityTest = mock;
  let approvals: any, questions: any, stalls = false, stops = 0, unread = true;
  const described: string[] = [];
  mock.createOperatorApprovalsGatewayClient = async (options: any) => { approvals = options; return { start() {}, stop() {} }; };
  // Each presence read signs in on its own connection and asks once; a stalled gateway never answers.
  mock.GatewayClient = class {
    options: any;
    constructor(options: any) { this.options = options; if (options.onEvent) questions = options; }
    start() { this.options.onHelloOk?.(); }
    stop() { stops++; }
    request(method: string, params?: any) {
      if (method === "sessions.describe") { described.push(params?.key); return Promise.resolve({ session: { unread } }); }
      reads.push(method);
      return stalls ? new Promise(() => {}) : Promise.resolve(presence);
    }
  };
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
    .replace(/import .* from "openclaw\/plugin-sdk\/gateway-runtime";/u, 'const { createOperatorApprovalsGatewayClient, GatewayClient, resolveGatewayAuth } = globalThis.__clawyActivityTest;')
    .replace(/import .* from "openclaw\/plugin-sdk\/plugin-entry";/u, 'const { definePluginEntry } = globalThis.__clawyActivityTest;')
    .replace(/from "\.\/([\w-]+)\.ts"/gu, (_, name) => `from "${new URL(`../${name}.ts`, import.meta.url)}"`);
  writeFileSync(join(folder, "plugin.mjs"), stripTypeScriptTypes(source));
  globalThis.fetch = (async (_url, options) => { forwards.push(JSON.parse(options!.body as string)); return new Response(null, { status: 200 }); }) as any;
  try {
    const plugin = (await import(pathToFileURL(join(folder, "plugin.mjs")).href)).default;
    plugin.register({ registerTool() {}, logger: { warn() {} }, runtime: { state: { resolveStateDir: () => folder }, events: { onAgentEvent: (fn: any) => { event = fn; return () => {}; }, onSessionTranscriptUpdate: (fn: any) => { transcript = fn; return () => {}; } } }, registerGatewayMethod: (name: string, fn: any) => methods.set(name, fn), on() {}, registerService: (value: any) => service = value });
    // The iPhone registers over its own connection; a gatewayDevice it sends itself counts for nothing.
    const iphone = { connect: { scopes: ["operator.admin"], device: { id: "iphone-gw" } }, authenticatedUserProfile: { profileId: "gateway-owner" } };
    methods.get("clawy.notifications.register")({ params: { ...device(), activities: undefined, gatewayDevice: "spoofed" }, client: iphone, respond: (ok: boolean) => assert.ok(ok) });
    assert.deepEqual(JSON.parse(readFileSync(join(folder, "clawy-notifications/devices.json"), "utf8")).map((d: Device) => [d.gatewayDevice, d.person]), [["iphone-gw", "gateway-owner"]]);
    await service.start({ config: {} });
    const reply = async (runId: string, sessionKey = "agent:a:ios-native-one") => {
      event({ sessionKey, runId, stream: "lifecycle", data: { phase: "end", terminalReply: { disposition: "visible", text: "Done" } } });
      for (let i = 0; i < 5; i++) await new Promise(setImmediate);
      return forwards.at(-1)?.kind;
    };
    // The Mac typed on 20 s ago: silent. Nobody elsewhere: an alert.
    presence = [{ clientId: "openclaw-macos", deviceId: "mac-gw", user: { id: "gateway-owner" }, connectionLastActivityAt: Date.now() - 20_000 }];
    assert.equal(await reply("one"), "silent");
    presence = [];
    assert.equal(await reply("two"), "alert");
    assert.deepEqual(reads, ["system-presence", "system-presence"]);
    // A message posted with chat.inject, which Clawy on the Mac doesn't alert for: never quieted, nor read for.
    presence = [{ clientId: "openclaw-macos", deviceId: "mac-gw", user: { id: "gateway-owner" }, connectionLastActivityAt: Date.now() - 5_000 }];
    transcript({ target: { sessionKey: "agent:a:ios-native-one", agentId: "a" }, messageId: "m1", message: { role: "assistant", provider: "openclaw", model: "gateway-injected", content: "Build done" } });
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.equal(forwards.at(-1)?.kind, "alert");
    assert.equal(reads.length, 2);
    // A gateway that doesn't answer: the reply and an approval both alert once their reads give up, and the connections close.
    stalls = true; presence = [{ clientId: "openclaw-macos", deviceId: "mac-gw", connectionLastActivityAt: Date.now() }];
    const before = forwards.length, stopped = stops;
    event({ sessionKey: "agent:a:ios-native-one", runId: "three", stream: "lifecycle", data: { phase: "end", terminalReply: { disposition: "visible", text: "Done" } } });
    approvals.onEvent({ event: "exec.approval.requested", payload: { id: "a1", request: { command: "ls", sessionKey: "agent:a:ios-native-one" } } });
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.equal(forwards.length, before);
    await new Promise((done) => setTimeout(done, 2_100));
    assert.deepEqual(forwards.slice(before).map((f) => f.kind), ["alert", "alert"]);
    assert.equal(stops, stopped + 2);
    // A quieted reply is held and looked at again once the Mac's use would have lapsed.
    stalls = false;
    nodeMock.timers.enable({ apis: ["setTimeout"] });
    try {
      const mac = (secondsAgo: number) => [{ clientId: "openclaw-macos", deviceId: "mac-gw", user: { id: "gateway-owner" }, connectionLastActivityAt: Date.now() - secondsAgo * 1000 }];
      const later = async () => { nodeMock.timers.tick(150_000); for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
      const sent = forwards.length;
      // Left the Mac without reading it: the phone gets it after all. (A chat of its own: a reply in a
      // chat already held joins that hold, whose first deadline stands.)
      presence = mac(10); unread = true;
      assert.equal(await reply("four", "agent:a:ios-native-held"), "silent");
      presence = mac(200); await later();
      assert.deepEqual(forwards.slice(sent).map((f) => f.kind), ["silent", "alert"]);
      // Read meanwhile, or still at the Mac: nothing more.
      presence = mac(10);
      assert.equal(await reply("five", "agent:a:ios-native-held"), "silent");
      unread = false; presence = mac(200); await later();
      unread = true; presence = mac(10);
      assert.equal(await reply("six", "agent:a:ios-native-held"), "silent");
      await later();
      assert.deepEqual(forwards.slice(sent).map((f) => f.kind), ["silent", "alert", "silent", "silent"]);
      assert.ok(described.every((key) => key === "agent:a:ios-native-held"), `${described}`);
      // Two replies held together alert once, at the first one's deadline.
      const pair = forwards.length;
      presence = mac(10);
      await reply("seven", "agent:a:ios-native-held"); await reply("eight", "agent:a:ios-native-held");
      presence = mac(200); await later();
      assert.deepEqual(forwards.slice(pair).map((f) => f.kind), ["silent", "silent", "alert"]);
      // Picked up the phone before the deadline: its newer reply alerts there and then, and what was held goes.
      const picked = forwards.length;
      presence = mac(10);
      await reply("nine", "agent:a:ios-native-held");
      presence = [...mac(40), { clientId: "openclaw-ios", deviceId: "iphone-gw", user: { id: "gateway-owner" }, connectionLastActivityAt: Date.now() }];
      assert.equal(await reply("ten", "agent:a:ios-native-held"), "alert");
      presence = mac(200); await later();
      assert.deepEqual(forwards.slice(picked).map((f) => f.kind), ["silent", "alert"]);
      // An approval or a question while the Mac is in use shows there first: the phone hears only if
      // it's still unanswered a minute on (40 s for a plugin's request, which lasts two minutes).
      const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
      const ask = async (id: string, kind = "exec", more = {}) => { approvals.onEvent({ event: `${kind}.approval.requested`, payload: { id, request: { command: "ls", title: "Use the camera", sessionKey: "agent:a:ios-native-held" }, ...more } }); await settle(); };
      const asked = forwards.length;
      presence = mac(10);
      await ask("unanswered");
      assert.equal(forwards.length, asked, "the phone waits while the Mac shows it");
      nodeMock.timers.tick(59_000); await settle();
      assert.equal(forwards.length, asked);
      nodeMock.timers.tick(1_000); await settle();
      assert.deepEqual(forwards.slice(asked).map((f) => f.kind), ["alert"]);
      // Answered on the Mac: the phone never hears of it.
      await ask("answered");
      approvals.onEvent({ event: "exec.approval.resolved", payload: { id: "answered", decision: "allow-once" } }); await settle();
      nodeMock.timers.tick(60_000); await settle();
      assert.equal(forwards.length, asked + 1);
      // A plugin's permission request, with two minutes to live.
      await ask("short", "plugin", { expiresAtMs: Date.now() + 120_000 });
      nodeMock.timers.tick(39_000); await settle();
      assert.equal(forwards.length, asked + 1);
      nodeMock.timers.tick(1_500); await settle();
      assert.equal(forwards.length, asked + 2);
      // A question the same way, and nobody in use means no wait at all.
      questions.onEvent({ event: "question.requested", payload: { id: "q1", sessionKey: "agent:a:ios-native-held", questions: [{ question: "Red or blue?" }] } }); await settle();
      assert.equal(forwards.length, asked + 2);
      questions.onEvent({ event: "question.resolved", payload: { id: "q1" } }); await settle();
      nodeMock.timers.tick(60_000); await settle();
      assert.equal(forwards.length, asked + 2);
      presence = [];
      await ask("nobody");
      assert.equal(forwards.length, asked + 3);
      // Sent again by the gateway, it alerts once; one sent again once nobody's in use goes at once,
      // and what was held for it goes with it.
      await ask("nobody");
      assert.equal(forwards.length, asked + 3);
      presence = mac(10);
      await ask("twice");
      presence = [];
      await ask("twice");
      nodeMock.timers.tick(60_000); await settle();
      assert.equal(forwards.length, asked + 4);
      // Already lapsed when it's judged: nothing.
      await ask("lapsed", "exec", { expiresAtMs: Date.now() - 1 });
      assert.equal(forwards.length, asked + 4);
      // Stopped while one is held: it never goes.
      presence = mac(10);
      await ask("stopped");
      service.stop();
      nodeMock.timers.tick(60_000); await settle();
      assert.equal(forwards.length, asked + 4);
    } finally { nodeMock.timers.reset(); }
  } finally {
    service?.stop(); globalThis.fetch = original; delete (globalThis as any).__clawyActivityTest; rmSync(folder, { recursive: true }); }
});
