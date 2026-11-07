import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canRegister, forwarderOrigin, parseDevice, Sequence } from "../devices.ts";
import { approvalMessage, failedJobMessage, questionMessage, replyMessage } from "../route.ts";
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

test("approvals and questions alert from any session, answered ones send nothing", () => {
  const exec = approvalMessage("exec.approval.requested", { id: "a1", request: { command: "echo hi", sessionKey: "agent:juno:telegram:direct:1", agentId: "juno" } });
  assert.deepEqual(exec, { v: 2, kind: "approval", approvalId: "a1", body: "echo hi", sessionKey: "agent:juno:telegram:direct:1", agentId: "juno" });
  assert.equal(approvalMessage("plugin.approval.requested", { id: "plugin:1", request: { description: "Post to #beta" } })?.body, "Post to #beta");
  assert.equal(approvalMessage("plugin.approval.requested", { id: "plugin:1", request: { title: " Send email ", description: "To everyone, with the attachment" } })?.body, "Send email\nTo everyone, with the attachment");
  assert.equal(approvalMessage("exec.approval.resolved", { id: "a1" }), null);
  assert.equal(questionMessage("question.requested", { id: "ask_1", questions: [{ question: "Blue or green?" }], sessionKey: "agent:juno:main", agentId: "juno" })?.body, "Blue or green?");
  assert.equal(questionMessage("question.resolved", { id: "ask_1" }), null);
});

test("only a failed job alerts", () => {
  assert.equal(failedJobMessage({ action: "finished", status: "error", jobId: "j1", job: { name: "Backup" }, error: "disk full" })?.title, "Backup failed");
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

test("adding a device takes the right to see what it will get", () => {
  assert.equal(canRegister(["operator.read", "operator.write"]), false);
  assert.equal(canRegister(["operator.write", "operator.approvals"]), false);
  assert.equal(canRegister(undefined), false);
  assert.equal(canRegister(["operator.approvals", "operator.questions"]), true);
  assert.equal(canRegister(["operator.admin"]), true);
});

test("a sequence only ever goes up, past a clock set back and across restarts", () => {
  const folder = mkdtempSync(join(tmpdir(), "clawy-"));
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
