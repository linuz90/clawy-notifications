import assert from "node:assert/strict";
import { test } from "node:test";
import { HeldFailures, repairBrief, repairsFailures } from "../failures.ts";
import type { Message } from "../route.ts";

function fixture() {
  let now = 0;
  const scheduled = new Set<any>(), sent: Array<{ message: Message; toldIn?: string }> = [];
  const time = { briefMs: 90_000, runMs: 900_000,
    later: ((fn: () => void, delay: number) => { const token = { fn, due: now + delay, unref() {} }; scheduled.add(token); return token; }) as any,
    cancel: ((token: any) => scheduled.delete(token)) as any };
  const failures = new HeldFailures((message, toldIn) => sent.push({ message, toldIn }), time);
  return { failures, sent, scheduled, tick(ms: number) { now += ms; for (const token of [...scheduled]) if (token.due <= now) { scheduled.delete(token); token.fn(); } } };
}
const failed: Message = { v: 2, kind: "task-failed", jobId: "j1", title: "Probe daily OK failed", body: "cron: job execution timed out" };
const chat = "agent:nova:ios-native-1";

/** The prompt row as the dev gateway (2026.11.10) stored it, its text cut short. */
const briefRow = { target: { sessionKey: chat, agentId: "nova" }, message: {
  role: "user", provenance: { kind: "internal_system", sourceTool: "cron_failure_repair" },
  content: "Automation repair request from the scheduler, not a user message. Do not relay it; follow the steps below.\nAn automation (id j1), created in this conversation, failed. The user was not alerted; you are their notice.",
  __openclaw: { runId: "5f56dd2a-aa90-4318-b1fa-ca29b1c1998e" } } };

test("repair turns arrive with OpenClaw 2026.11.10", () => {
  for (const version of ["2026.11.10", "2026.11.10-beta.2", "2026.12.1", "2027.1.0"]) assert.equal(repairsFailures(version), true, version);
  for (const version of ["2026.11.3", "2026.10.7", "2026.9.30", "", undefined, 2026]) assert.equal(repairsFailures(version), false, String(version));
});

test("the repair turn's prompt names its job and chat; any other row doesn't", () => {
  const run = "5f56dd2a-aa90-4318-b1fa-ca29b1c1998e";
  assert.deepEqual(repairBrief(briefRow), { jobId: "j1", sessionKey: chat, runId: run });
  assert.deepEqual(repairBrief({ ...briefRow, message: { ...briefRow.message, content: [{ type: "text", text: briefRow.message.content }], __openclaw: {} } }), { jobId: "j1", sessionKey: chat });
  assert.equal(repairBrief({ ...briefRow, message: { ...briefRow.message, provenance: { kind: "external_user" } } }), null);
  assert.equal(repairBrief({ ...briefRow, message: { ...briefRow.message, role: "assistant" } }), null);
  assert.equal(repairBrief({ message: briefRow.message }), null);
});

test("the agent's reply stands in for the failed alert", () => {
  const f = fixture();
  f.failures.failed("j1", failed);
  f.tick(5_000);
  f.failures.brief(repairBrief(briefRow)!);
  f.tick(120_000);
  assert.equal(f.sent.length, 0);
  f.failures.ended("agent:nova:ios-native-other", true);
  assert.equal(f.sent.length, 0);
  f.failures.ended(chat, true);
  assert.deepEqual(f.sent, [{ message: failed, toldIn: chat }]);
  assert.equal(f.scheduled.size, 0);
});

test("the failed alert goes as before when the agent stays silent, no turn comes, or the turn never ends", () => {
  const silent = fixture();
  silent.failures.failed("j1", failed);
  silent.failures.brief({ jobId: "j1", sessionKey: chat });
  silent.failures.ended(chat, false);
  assert.deepEqual(silent.sent, [{ message: failed, toldIn: undefined }]);

  const none = fixture();
  none.failures.failed("j1", failed);
  none.tick(89_000);
  assert.equal(none.sent.length, 0);
  none.tick(1_000);
  assert.deepEqual(none.sent, [{ message: failed, toldIn: undefined }]);
  none.failures.brief({ jobId: "j1", sessionKey: chat });
  none.failures.ended(chat, true);
  assert.equal(none.sent.length, 1);

  const stuck = fixture();
  stuck.failures.failed("j1", failed);
  stuck.failures.brief({ jobId: "j1", sessionKey: chat });
  stuck.tick(900_000);
  assert.deepEqual(stuck.sent, [{ message: failed, toldIn: undefined }]);

  const stopping = fixture();
  stopping.failures.failed("j1", failed);
  stopping.failures.close();
  assert.equal(stopping.sent.length, 1);
  assert.equal(stopping.scheduled.size, 0);
});

test("two jobs failing in one chat are answered one run each", () => {
  const f = fixture();
  const other: Message = { ...failed, jobId: "j2", title: "Backup failed" };
  f.failures.failed("j1", failed);
  f.failures.failed("j2", other);
  f.failures.brief({ jobId: "j1", sessionKey: chat, runId: "r1" });
  f.failures.brief({ jobId: "j2", sessionKey: chat, runId: "r2" });
  // The second job's turn ends first, silent; then the first job's turn replies.
  f.failures.ended(chat, false, "r2");
  assert.deepEqual(f.sent, [{ message: other, toldIn: undefined }]);
  f.failures.ended(chat, true, "r1");
  assert.deepEqual(f.sent.at(-1), { message: failed, toldIn: chat });

  // Without run ids on the rows, each end answers the turn begun first.
  const g = fixture();
  g.failures.failed("j1", failed);
  g.failures.failed("j2", other);
  g.failures.brief({ jobId: "j1", sessionKey: chat });
  g.failures.brief({ jobId: "j2", sessionKey: chat });
  g.failures.ended(chat, true, "x");
  assert.deepEqual(g.sent, [{ message: failed, toldIn: chat }]);
  g.failures.ended(chat, false, "y");
  assert.deepEqual(g.sent.at(-1), { message: other, toldIn: undefined });
});
