import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canRegister, forwarderOrigin, maxMuted, parseDevice, Sequence } from "../devices.ts";
import { approvalMessage, automationPostMessage, failedJobMessage, injectedMessage, inUseElsewhere, questionMessage, replyMessage, requestHoldMs, forDevice, whileInUseElsewhere } from "../route.ts";
import { fit, PADDED_LENGTH, seal } from "../seal.ts";

// An independent opener, written from RFC 8291, so the test doesn't check seal.ts against itself.
function open(sealed: string, device: ReturnType<typeof createECDH>, auth: Buffer): string {
  const raw = Buffer.from(sealed, "base64url");
  const salt = raw.subarray(0, 16);
  assert.equal(raw.readUInt32BE(16), 4096);
  assert.equal(raw[20], 65);
  const sender = raw.subarray(21, 86);
  const secret = device.computeSecret(sender);
  const kdf = (s: Buffer, k: Buffer, info: Buffer, n: number) => Buffer.from(hkdfSync("sha256", k, s, info, n));
  const ikm = kdf(auth, secret, Buffer.concat([Buffer.from("WebPush: info\0"), device.getPublicKey(), sender]), 32);
  const key = kdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = kdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const body = raw.subarray(86);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(body.subarray(body.length - 16));
  const padded = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  assert.equal(padded.length, PADDED_LENGTH);
  return padded.subarray(0, padded.lastIndexOf(2)).toString();
}

function keys() {
  const device = createECDH("prime256v1");
  device.generateKeys();
  const auth = randomBytes(16);
  return { device, auth, p256dh: device.getPublicKey().toString("base64url"), authText: auth.toString("base64url") };
}

test("a sealed message opens with the device's key and always has the same size", () => {
  const { device, auth, p256dh, authText } = keys();
  const short = seal(JSON.stringify({ v: 2, kind: "refresh" }), p256dh, authText);
  const long = seal(fit({ v: 2, kind: "reply", body: "é".repeat(5000) }), p256dh, authText);
  assert.equal(JSON.parse(open(short, device, auth)).kind, "refresh");
  const opened = JSON.parse(open(long, device, auth));
  assert.ok(opened.body.endsWith("…"));
  assert.equal(opened.truncated, true);
  assert.equal(Buffer.from(short, "base64url").length, 2150);
  assert.equal(long.length, short.length);
  assert.equal(short.length, 2867);
});

test("sealing twice never repeats, and another key can't open it", () => {
  const { p256dh, authText, auth } = keys();
  const stranger = keys();
  const message = JSON.stringify({ v: 2, kind: "reply", body: "hello" });
  assert.notEqual(seal(message, p256dh, authText), seal(message, p256dh, authText));
  assert.throws(() => open(seal(message, p256dh, authText), stranger.device, auth));
});

test("shortening cuts between characters, emoji included", () => {
  const fitted = fit({ v: 2, kind: "reply", body: "🦞".repeat(3000) });
  assert.ok(Buffer.byteLength(fitted) <= PADDED_LENGTH - 1);
  assert.ok(!JSON.parse(fitted).body.includes("�"));
});

const end = (sessionKey: string, data: object = {}) => ({ sessionKey, data: { phase: "end", terminalReply: { disposition: "visible", text: "done" }, ...data } });

test("replies route like the relay's rules", () => {
  assert.equal(replyMessage(end("agent:juno:ios-native-1"))?.kind, "reply");
  assert.equal(replyMessage(end("agent:juno:ios-native-1"))?.body, "done");
  assert.equal(replyMessage(end("agent:juno:ios-native-1"))?.agentId, "juno");
  assert.equal(replyMessage(end("agent:juno:dashboard:ce93"))?.kind, "reply");
  assert.equal(replyMessage(end("agent:main:telegram:direct:1:thread:1:7"))?.kind, "refresh");
  assert.equal(replyMessage(end("agent:main:telegram:direct:1:thread:1:7"))?.body, undefined);
  for (const key of ["agent:juno:main", "agent:main:main:heartbeat", "agent:main:telegram:direct:1:heartbeat", "agent:juno:cron:d7e0", "agent:juno:subagent:0982"]) {
    assert.equal(replyMessage(end(key)), null, key);
  }
});

test("a run with nothing to say sends nothing", () => {
  assert.equal(replyMessage(end("agent:juno:ios-native-1", { aborted: true })), null);
  assert.equal(replyMessage(end("agent:juno:ios-native-1", { yielded: true })), null);
  assert.equal(replyMessage(end("agent:juno:ios-native-1", { terminalReply: { disposition: "silent" } })), null);
  assert.equal(replyMessage(end("agent:juno:ios-native-1", { phase: "error" })), null);
});

test("an automation's post into a chat routes like a reply, and other transcript writes send nothing", () => {
  // As OpenClaw's commitBackgroundResultToSession writes it and publishTranscriptTurnUpdate projects it.
  const post = (sessionKey: string, message: Record<string, any> = {}) => ({
    target: { agentId: sessionKey.split(":")[1], sessionId: "s1", sessionKey },
    messageId: "m1",
    message: { role: "assistant", content: [{ type: "text", text: "Price dropped to €1,890" }], openclawAutomation: { kind: "cron", jobId: "j1" }, ...message },
  });
  assert.deepEqual(automationPostMessage(post("agent:juno:ios-native-1")), { v: 2, kind: "reply", body: "Price dropped to €1,890", sessionKey: "agent:juno:ios-native-1", agentId: "juno" });
  assert.equal(automationPostMessage(post("agent:juno:dashboard:ce93"))?.kind, "reply");
  assert.deepEqual(automationPostMessage(post("agent:main:telegram:direct:1:thread:1:7")), { v: 2, kind: "refresh", sessionKey: "agent:main:telegram:direct:1:thread:1:7", agentId: "main" });
  for (const key of ["agent:main:main", "agent:main:cron:j1", "agent:main:subagent:x", "main"]) {
    assert.equal(automationPostMessage(post(key)), null, key);
  }
  // A post with no text (a widget alone) still alerts; the device fills it in from the chat.
  assert.equal(automationPostMessage(post("agent:juno:ios-native-1", { content: [{ type: "image" }] }))?.body, undefined);
  // An ordinary reply, the person's own message, or an update with no message: the run's end covers those.
  assert.equal(automationPostMessage(post("agent:juno:ios-native-1", { openclawAutomation: undefined })), null);
  assert.equal(automationPostMessage(post("agent:juno:ios-native-1", { role: "user" })), null);
  assert.equal(automationPostMessage({ target: { sessionKey: "agent:juno:ios-native-1" } }), null);
});

test("a message posted with chat.inject routes like a reply, and the gateway's other injected rows send nothing", () => {
  // As OpenClaw 2026.10.7's chat.inject writes it (appendInjectedAssistantMessageToTranscript): no run, no send key.
  const injected = (sessionKey: string, message: Record<string, any> = {}) => ({
    target: { agentId: sessionKey.split(":")[1], sessionId: "s1", sessionKey },
    messageId: "m2",
    message: { role: "assistant", content: [{ type: "text", text: "Your build finished." }], provider: "openclaw", model: "gateway-injected", ...message },
  });
  assert.deepEqual(injectedMessage(injected("agent:juno:ios-native-1")), { v: 2, kind: "reply", body: "Your build finished.", sessionKey: "agent:juno:ios-native-1", agentId: "juno" });
  assert.equal(injectedMessage(injected("agent:main:telegram:direct:1"))?.kind, "refresh");
  assert.equal(injectedMessage(injected("agent:main:main")), null);
  // A slash command's reply and a run's mirrored reply carry their send's key; a stopped reply's
  // partial carries openclawAbort. Their run's end, or the person's own send, covers those.
  assert.equal(injectedMessage(injected("agent:juno:ios-native-1", { idempotencyKey: "run-1" })), null);
  assert.equal(injectedMessage(injected("agent:juno:ios-native-1", { openclawAbort: { aborted: true, origin: "rpc", runId: "run-1" } })), null);
  // A model's reply, and a delivery copy, aren't injected.
  assert.equal(injectedMessage(injected("agent:juno:ios-native-1", { provider: "anthropic", model: "claude-opus-5-5" })), null);
  assert.equal(injectedMessage(injected("agent:juno:ios-native-1", { model: "delivery-mirror" })), null);
  assert.equal(injectedMessage(injected("agent:juno:ios-native-1", { role: "user" })), null);
});

test("approvals and questions alert from any session, answered ones send nothing", () => {
  const exec = approvalMessage("exec.approval.requested", { id: "a1", request: { command: "echo hi", sessionKey: "agent:juno:telegram:direct:1", agentId: "juno" } });
  assert.deepEqual(exec, { v: 2, kind: "approval", approvalId: "a1", body: "echo hi", sessionKey: "agent:juno:telegram:direct:1", agentId: "juno" });
  assert.equal(approvalMessage("plugin.approval.requested", { id: "plugin:1", request: { description: "Post to #beta" } })?.body, "Post to #beta");
  assert.equal(approvalMessage("plugin.approval.requested", { id: "plugin:1", request: { title: " Send email ", description: "To everyone, with the attachment" } })?.body, "Send email\nTo everyone, with the attachment");
  const change = approvalMessage("openclaw.approval.requested", { id: "system-agent:1", request: { title: "OpenClaw change", description: "set config ui.seamColor to #ff8800", command: "set config ui.seamColor to #ff8800", sessionKey: "agent:max:ios-native-1", agentId: "max" } });
  assert.deepEqual(change, { v: 2, kind: "approval", approvalId: "system-agent:1", body: "set config ui.seamColor to #ff8800", sessionKey: "agent:max:ios-native-1", agentId: "max" });
  assert.equal(approvalMessage("exec.approval.resolved", { id: "a1" }), null);
  assert.equal(approvalMessage("openclaw.approval.resolved", { id: "system-agent:1" }), null);
  assert.equal(questionMessage("question.requested", { id: "ask_1", questions: [{ question: "Blue or green?" }], sessionKey: "agent:juno:main", agentId: "juno" })?.body, "Blue or green?");
  assert.equal(questionMessage("question.resolved", { id: "ask_1" }), null);
});

test("only a failed job alerts", () => {
  assert.equal(failedJobMessage({ action: "finished", status: "error", jobId: "j1", job: { name: "Backup" }, error: "disk full" })?.title, "Backup failed");
  // From the agent that runs it: the hook's top-level field, or the job's own.
  assert.equal(failedJobMessage({ action: "finished", status: "error", jobId: "j1", agentId: "juno", job: { name: "Backup" } })?.agentId, "juno");
  assert.equal(failedJobMessage({ action: "finished", status: "error", jobId: "j1", job: { name: "Backup", agentId: "atlas" } })?.agentId, "atlas");
  assert.equal(failedJobMessage({ action: "finished", status: "ok", jobId: "j1" }), null);
  assert.equal(failedJobMessage({ action: "started", jobId: "j1" }), null);
});

test("a device is checked before it's stored", () => {
  const { p256dh, authText } = keys();
  const good = { id: "abc_-1", forwarder: `${forwarderOrigin()}/v1/forward/abc_-1`, token: "t", p256dh, auth: authText };
  assert.equal(parseDevice(good)?.text, true);
  assert.equal(parseDevice({ ...good, text: false })?.text, false);
  for (const forwarder of ["https://evil.example/v1/forward/abc_-1", "http://127.0.0.1:8787/v1/forward/abc_-1",
                           `${forwarderOrigin()}/v1/devices`, `${forwarderOrigin()}/v1/forward/someone-else`, `${forwarderOrigin()}/v1/forward/abc_-1?x=1`]) {
    assert.equal(parseDevice({ ...good, forwarder }), null, forwarder);
  }
  assert.equal(parseDevice({ ...good, p256dh: "short" }), null);
  assert.equal(parseDevice({ ...good, auth: "short" }), null);
  assert.equal(parseDevice(null), null);
});

test("a reply in a chat the device muted goes out silent; what waits on the person still alerts", () => {
  const reply = { v: 2 as const, kind: "reply" as const, body: "Done", sessionKey: "agent:juno:ios-native-1", agentId: "juno" };
  const muted = { "agent:juno:ios-native-1": 0, "agent:juno:ios-native-2": 2_000 };
  assert.deepEqual(forDevice(reply, muted, 1_000), { v: 2, kind: "refresh", sessionKey: "agent:juno:ios-native-1", agentId: "juno" });
  assert.equal(forDevice({ ...reply, sessionKey: "agent:juno:ios-native-2" }, muted, 1_000).kind, "refresh");
  // A mute that's over, another chat, or a device that muted nothing: as ever.
  assert.equal(forDevice({ ...reply, sessionKey: "agent:juno:ios-native-2" }, muted, 2_000).kind, "reply");
  assert.equal(forDevice({ ...reply, sessionKey: "agent:juno:ios-native-3" }, muted, 1_000).kind, "reply");
  // A guest's reply is muted with the chat it was tagged into.
  assert.equal(forDevice({ ...reply, sessionKey: "agent:atlas:ios-native-1-guest-of-juno" }, muted, 1_000).kind, "refresh");
  assert.equal(forDevice(reply, undefined), reply);
  for (const kind of ["approval", "question"] as const) assert.equal(forDevice({ ...reply, kind }, muted, 1_000).kind, kind);
  // A test alert always shows, so Send Test can pass.
  assert.equal(forDevice({ ...reply, test: "n" }, muted, 1_000).kind, "reply");
});

test("a reply goes out silent while Moonstone was used more recently on another of the person's devices", () => {
  const reply = { v: 2 as const, kind: "reply" as const, body: "Done", sessionKey: "agent:juno:ios-native-1", agentId: "juno" };
  const iphone = { gatewayDevice: "iphone", person: "gateway-owner" };
  const now = 1_000_000;
  // As `system-presence` lists an app that said it's in use `secondsAgo` before now (seen on 2026.11.3).
  const used = (deviceId: string, secondsAgo: number, more: Record<string, unknown> = {}) =>
    ({ clientId: "openclaw-macos", deviceId, user: { id: "gateway-owner" }, connectionLastActivityAt: now - secondsAgo * 1000, ...more });
  const quiet = (presence: any[] | undefined, device: { gatewayDevice?: string; person?: string } = iphone, message = reply) =>
    whileInUseElsewhere(message, device, presence, now).kind === "refresh";
  assert.deepEqual(whileInUseElsewhere(reply, iphone, [used("mac", 20)], now), { v: 2, kind: "refresh", sessionKey: "agent:juno:ios-native-1", agentId: "juno" });
  // An iPhone on its chat list declares a chat open on another iPad: that counts too.
  assert.ok(quiet([{ clientId: "openclaw-ios", deviceId: "ipad", watchedSessions: ["agent:juno:ios-native-2"] }]));
  // Walked away, the connection closed, someone else's Mac, a browser tab, or this iPhone's own other entries: it alerts.
  assert.ok(!quiet([used("mac", 150)]));
  assert.ok(!quiet([used("mac", 5, { reason: "disconnect" })]));
  assert.ok(!quiet([used("mac", 5, { user: { id: "frank" } })]));
  assert.ok(!quiet([used("web", 5, { clientId: "openclaw-control-ui" })]));
  assert.ok(!quiet([used("iphone", 100)]));
  // Two in use: the one used most recently by over a beat alerts, and within a beat both do.
  assert.ok(!quiet([used("mac", 5), used("iphone", 3, { clientId: "openclaw-ios" })]));
  assert.ok(!quiet([used("mac", 5), used("iphone", 30, { clientId: "openclaw-ios" })]));
  assert.ok(quiet([used("mac", 5), used("iphone", 50, { clientId: "openclaw-ios" })]));
  // This iPhone left Moonstone a moment ago: still the one used last, so an older Mac doesn't quiet it.
  assert.ok(!quiet([used("mac", 60), used("iphone", 5, { clientId: "openclaw-ios", reason: "disconnect" })]));
  // A tie alerts on both; two apps too old to stamp, each showing a chat, are a tie.
  assert.ok(!quiet([used("mac", 5), used("iphone", 5, { clientId: "openclaw-ios" })]));
  assert.ok(!quiet([{ clientId: "openclaw-ios", deviceId: "iphone", watchedSessions: ["a"] }, { clientId: "openclaw-ios", deviceId: "ipad", watchedSessions: ["b"] }]));
  // A list with junk in it reads past the junk.
  assert.ok(quiet([null, used("mac", 5)]));
  // A reply judged and still sent says so, so the device doesn't judge again on stamps that moved.
  assert.equal(whileInUseElsewhere(reply, iphone, [], now).chosen, true);
  assert.equal(whileInUseElsewhere(reply, {}, [used("mac", 5)], now).chosen, undefined);
  assert.equal(whileInUseElsewhere(reply, iphone, undefined, now).chosen, undefined);
  // A device registered before the plugin knew its gateway id, or a list that couldn't be read.
  assert.ok(!quiet([used("mac", 5)], {}));
  assert.ok(!quiet(undefined));
  // What waits on the person, and a test alert, always alert.
  for (const kind of ["approval", "question", "task-failed"] as const) assert.ok(!quiet([used("mac", 5)], iphone, { ...reply, kind }));
  assert.ok(!quiet([used("mac", 5)], iphone, { ...reply, test: "n" }));
});

test("an approval or a question waits a minute for the device in use, less when it lapses sooner", () => {
  const now = 1_000_000;
  // A command's approval lasts thirty minutes, a question fifteen, a plugin's permission request two.
  assert.equal(requestHoldMs(now + 30 * 60_000, now), 60_000);
  assert.equal(requestHoldMs(now + 120_000, now), 40_000);
  assert.equal(requestHoldMs(undefined, now), 60_000);
  assert.equal(requestHoldMs(now - 1, now), 0);
  // Held only for a device another is ahead of: the same judgment as a reply's.
  const mac = [{ clientId: "openclaw-macos", deviceId: "mac", connectionLastActivityAt: now - 5_000 }];
  assert.equal(inUseElsewhere({ gatewayDevice: "iphone" }, mac, now), true);
  assert.equal(inUseElsewhere({ gatewayDevice: "mac" }, mac, now), false);
  assert.equal(inUseElsewhere({}, mac, now), false);
  assert.equal(inUseElsewhere({ gatewayDevice: "iphone" }, undefined, now), false);
});

test("a device keeps which app registered it, and nothing else of the kind", () => {
  const { p256dh, authText } = keys();
  const good = { id: "abc_-1", forwarder: `${forwarderOrigin()}/v1/forward/abc_-1`, token: "t", p256dh, auth: authText };
  const stored = parseDevice({ ...good, gatewayDevice: "a1b2", person: "gateway-owner" });
  assert.equal(stored?.gatewayDevice, "a1b2");
  assert.equal(stored?.person, "gateway-owner");
  assert.equal(parseDevice({ ...good, gatewayDevice: 7 })?.gatewayDevice, undefined);
  assert.equal(parseDevice({ ...good, gatewayDevice: "x".repeat(300) })?.gatewayDevice, undefined);
});

test("a device's muted chats are checked before they're stored", () => {
  const { p256dh, authText } = keys();
  const good = { id: "abc_-1", forwarder: `${forwarderOrigin()}/v1/forward/abc_-1`, token: "t", p256dh, auth: authText };
  assert.deepEqual(parseDevice({ ...good, muted: { "agent:juno:ios-native-1": 0 } })?.muted, { "agent:juno:ios-native-1": 0 });
  assert.equal(parseDevice({ ...good, muted: {} })?.muted, undefined);
  for (const muted of [[], { "juno:1": 0 }, { "agent:juno:1": -1 }, { "agent:juno:1": "0" },
                       Object.fromEntries(Array.from({ length: maxMuted + 1 }, (_, i) => [`agent:juno:${i}`, 0]))]) {
    assert.equal(parseDevice({ ...good, muted }), null, JSON.stringify(muted).slice(0, 40));
  }
});

test("adding a device takes the right to see what it will get", () => {
  assert.equal(canRegister(["operator.read", "operator.write"]), false);
  assert.equal(canRegister(["operator.write", "operator.approvals"]), false);
  assert.equal(canRegister(undefined), false);
  assert.equal(canRegister(["operator.approvals", "operator.questions"]), true);
  assert.equal(canRegister(["operator.admin"]), true);
});

test("a sequence only ever goes up, past a clock set back and across restarts", () => {
  const folder = mkdtempSync(join(tmpdir(), "moonstone-"));
  const path = join(folder, "state", "sequence");
  const sequence = new Sequence(path);
  assert.equal(sequence.next(1000), 1000);
  assert.equal(sequence.next(1000), 1001);
  assert.equal(sequence.next(5), 1002);
  assert.equal(sequence.next(2000), 2000);
  assert.equal(new Sequence(path).next(5), 2001);
  rmSync(folder, { recursive: true });
});

test("writes a sample for the app's test to open", { skip: !process.env.WRITE_SAMPLE }, () => {
  const { device, p256dh, authText } = keys();
  const plaintext = JSON.stringify({ v: 2, seq: 1794006306974, kind: "reply", body: "Sealed by the OpenClaw plugin 🦞", sessionKey: "agent:juno:ios-native-1", agentId: "juno" });
  writeFileSync(new URL("../../test-vectors/openclaw.json", import.meta.url), JSON.stringify({ p256dh, auth: authText, privateKey: Buffer.concat([Buffer.alloc(32), device.getPrivateKey()]).subarray(-32).toString("base64url"), sealed: seal(plaintext, p256dh, authText), plaintext }, null, 2));
});
