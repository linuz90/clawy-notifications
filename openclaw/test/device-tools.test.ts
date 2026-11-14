import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { registerDeviceTools } from "../device-tools.ts";

const sessionKey = "agent:juno:ios-native-chat";
const commands = ["clawy.health.query", "clawy.location.current", "clawy.calendar.events", "clawy.calendar.add", "clawy.reminders.list", "clawy.reminders.add", "clawy.contacts.search", "clawy.topics.list", "clawy.chats.update", "clawy.places.show"];
const device = (nodeId = "phone-1", deviceFamily = "iPhone", overrides = {}) => ({ nodeId, deviceFamily, displayName: nodeId, clientId: "openclaw-ios", clientMode: "node", connected: true, commands, ...overrides });

function harness() {
  let inventory: ReturnType<typeof device>[] = [];
  let lists = 0;
  let factory: any;
  let names: string[] = [];
  let status: any;
  const invocations: any[] = [];
  let list: () => Promise<any> = async () => ({ nodes: inventory });
  let invoke: (params: any) => Promise<unknown> = async () => ({ ok: true, payload: { value: "device result" } });
  registerDeviceTools({
    registerTool: (registered: any, options: any) => { factory = registered; names = options.names; },
    registerGatewayMethod: (name: string, handler: any, options: any) => { status = { name, handler, options }; },
    runtime: { nodes: {
      list: async (params: any) => { lists++; assert.deepEqual(params, { connected: true }); return list(); },
      invoke: async (params: any) => { invocations.push(params); return invoke(params); },
    } },
  } as any);
  return {
    tools: (context: any = { sessionKey }) => factory(context),
    tool: (name = "clawy_iphone_chats", context: any = { sessionKey }) => factory(context).find((tool: any) => tool.name === name),
    set nodes(value: ReturnType<typeof device>[]) { inventory = value; },
    set list(value: typeof list) { list = value; },
    set invoke(value: typeof invoke) { invoke = value; },
    get lists() { return lists; }, invocations, names, status,
  };
}

test("the fixed catalog survives no devices, connection, disconnection and sharing changes", async () => {
  const h = harness();
  const snapshot = () => h.tools().map(({ name, description, parameters }: any) => ({ name, description, parameters }));
  const offline = snapshot();
  assert.equal(offline.length, 28);
  for (const [family, count] of [["iphone", 10], ["ipad", 10], ["mac", 8]] as const) assert.equal(offline.filter(({ name }: any) => name.startsWith(`clawy_${family}_`)).length, count);
  assert.equal(offline.some(({ name }: any) => /^clawy_mac_(health|location)$/.test(name)), false);
  h.nodes = [device()];
  assert.deepEqual(snapshot(), offline);
  h.nodes = [device("phone-1", "iPhone", { commands: [] })];
  assert.deepEqual(snapshot(), offline);
  h.nodes = [device("phone-1", "iPhone", { connected: false })];
  assert.deepEqual(snapshot(), offline);
  assert.equal(h.lists, 0, "neither registration nor the tool factory reads inventory");
  const manifest = JSON.parse(readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.contracts.tools, h.names);
});

test("device capability status is explicit and read-only", () => {
  const { status } = harness();
  assert.equal(status.name, "clawy.devices.status");
  assert.deepEqual(status.options, { scope: "operator.read" });
  let reply;
  status.handler({ respond: (...args: unknown[]) => { reply = args; } });
  assert.deepEqual(reply, [true, { protocol: 2 }]);
});

test("an offline tool tells the agent to open the named family without invoking another device", async () => {
  const h = harness();
  h.nodes = [device("mac-1", "Mac"), device("phone-1", "iPhone", { connected: false })];
  await assert.rejects(h.tool().execute("call-1", {}), /Open Clawy on the iPhone/);
  assert.equal(h.invocations.length, 0);
});

test("routes each family and command using the host session and cancellation signal", async () => {
  const h = harness();
  h.nodes = [device("phone-1"), device("tablet-1", "iPad"), device("mac-1", "Mac")];
  const controller = new AbortController();
  let guarded = 0;
  const result = await h.tool("clawy_ipad_calendar_add", { sessionKey, assertInvocationCurrent: () => { guarded++; } }).execute("call-1", { title: "Lunch", start: "2026-11-12T13:00" }, controller.signal);
  assert.deepEqual(h.invocations, [{ nodeId: "tablet-1", command: "clawy.calendar.add", params: { title: "Lunch", start: "2026-11-12T13:00" }, timeoutMs: 30_000, sessionKey, idempotencyKey: "call-1", signal: controller.signal }]);
  assert.equal(guarded, 1);
  assert.deepEqual(JSON.parse(result.content[0].text), { value: "device result" });
});

test("Mac tools reach both native Mac clients and older iOS-tagged Mac clients", async () => {
  for (const clientId of ["openclaw-ios", "openclaw-macos"]) {
    const h = harness();
    h.nodes = [device("mac-1", "Mac", { clientId })];
    await h.tool("clawy_mac_chats").execute("mac-call", {});
    assert.equal(h.invocations[0].nodeId, "mac-1");
  }
});

test("only a connected Clawy node of the exact family declaring the command qualifies", async () => {
  const h = harness();
  h.nodes = [device("wrong-client", "iPhone", { clientId: "openclaw-mac" }), device("wrong-mode", "iPhone", { clientMode: "ui" }), device("missing-family", "", {}), device("other-family", "iPad"), device("no-command", "iPhone", { commands: [] }), device("correct")];
  await h.tool().execute("call-1", {});
  assert.equal(h.invocations[0].nodeId, "correct");
});

test("multiple devices fail closed unless an exact nodeId selects one", async () => {
  const h = harness();
  h.nodes = [device("phone-1"), device("phone-2"), device("mac-1", "Mac")];
  await assert.rejects(h.tool().execute("call-1", {}), /More than one Clawy iPhone.*phone-1.*phone-2/);
  assert.equal(h.invocations.length, 0);
  await h.tool().execute("call-2", { nodeId: "phone-2", archived: true });
  assert.equal(h.invocations[0].nodeId, "phone-2");
  assert.deepEqual(h.invocations[0].params, { archived: true }, "nodeId is routing metadata, not a device parameter");
  await assert.rejects(h.tool().execute("call-3", { nodeId: "mac-1" }), /Open Clawy on the iPhone/);
  await assert.rejects(h.tool().execute("call-4", { nodeId: "unknown" }), /Open Clawy on the iPhone/);
  await assert.rejects(h.tool().execute("call-5", { nodeId: "" }), /nodeId/);
  assert.equal(h.invocations.length, 1);
});

test("a model cannot supply or replace the calling identity", async () => {
  const h = harness();
  h.nodes = [device()];
  for (const key of ["sessionKey", "agentId", "command", "idempotencyKey"]) await assert.rejects(h.tool().execute("call-1", { [key]: "agent:other:chat" }), /Unknown Clawy tool parameter/);
  for (const sessionKey of [undefined, "", "   "]) await assert.rejects(h.tool("clawy_iphone_chats", { sessionKey }).execute("call-2", {}), /current conversation/);
  assert.equal(h.lists, 0);
  assert.equal(h.invocations.length, 0);
});

test("permissions, timeouts and dispatch errors propagate without retry or another device", async () => {
  const h = harness();
  h.nodes = [device("phone-1"), device("phone-2")];
  for (const message of ["UNAUTHORIZED: sharing is disabled", "node invoke timed out", "node command not allowed"]) {
    h.invoke = async () => { throw new Error(message); };
    const before = h.invocations.length;
    await assert.rejects(h.tool().execute(`call-${before}`, { nodeId: "phone-1" }), { message });
    assert.equal(h.invocations.length, before + 1);
    assert.equal(h.invocations.at(-1).nodeId, "phone-1");
  }
});

test("cancellation before or during discovery dispatches nothing", async () => {
  const h = harness();
  h.nodes = [device()];
  const before = new AbortController(); before.abort();
  await assert.rejects(h.tool().execute("call-1", {}, before.signal), { name: "AbortError" });
  assert.equal(h.lists, 0);
  const during = new AbortController();
  h.list = async () => { during.abort(); return { nodes: [device()] }; };
  await assert.rejects(h.tool().execute("call-2", {}, during.signal), { name: "AbortError" });
  assert.equal(h.invocations.length, 0);
});

test("stale host invocation authority refuses before dispatch", async () => {
  const h = harness(); h.nodes = [device()];
  await assert.rejects(h.tool("clawy_iphone_chats", { sessionKey, assertInvocationCurrent: () => { throw new Error("Turn closed"); } }).execute("call-1", {}), /Turn closed/);
  assert.equal(h.invocations.length, 0);
});

test("in-flight cancellation reaches the selected node and never retries", async () => {
  const h = harness(); h.nodes = [device()];
  const controller = new AbortController();
  h.invoke = async ({ signal }) => {
    assert.equal(signal, controller.signal);
    controller.abort(); signal.throwIfAborted();
  };
  await assert.rejects(h.tool().execute("call-1", {}, controller.signal), { name: "AbortError" });
  assert.equal(h.invocations.length, 1);
});
