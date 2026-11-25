import assert from "node:assert/strict";
import { test } from "node:test";
import { registerConnectorApprovals } from "../connector-approvals.ts";

function fixture(servers?: string[]) {
  const connectorAsks = { juno: { linear: "first", docs: "another" } };
  const config = { mcp: { servers: { linear: {}, doc: {}, docs: {}, "1-notes": {}, "shared.docs": {} } },
    plugins: { entries: { "clawy-notifications": { config: { connectorAsks } } } } };
  const inventory = servers ?? [...Object.keys(config.mcp.servers), "deepwiki", "shared+docs", "shared-docs-2"];
  let hook: any;
  let readNamespaces: any;
  let reload: unknown;
  const available = registerConnectorApprovals({
    runtime: { config: { current: () => config, mutateConfigFile: async ({ mutate }: any) => mutate(config) } },
    registerReload: (registration: unknown) => { reload = registration; },
    registerGatewayMethod: (method: string, handler: unknown) => {
      assert.equal(method, "clawy.connectors.namespaces");
      readNamespaces = handler;
    },
    on: (event: string, listener: unknown) => {
      assert.equal(event, "before_tool_call");
      hook = listener;
    },
  } as any, async () => [inventory]);
  assert.equal(available, true);
  assert.deepEqual(reload, { noopPrefixes: ["plugins.entries.clawy-notifications.config.connectorAsks"] });
  async function before(toolName: string, agentId = "juno", params: Record<string, unknown> = {}) {
    return hook({ toolName, params }, { agentId });
  }
  async function ask(toolName: string, agentId = "juno", params: Record<string, unknown> = {}) {
    return (await before(toolName, agentId, params))?.requireApproval;
  }
  async function namespaces() {
    let result;
    await readNamespaces({ respond(ok: boolean, value: unknown) {
      assert.equal(ok, true);
      result = value;
    } });
    return result;
  }
  return { connectorAsks, ask, before, namespaces };
}

test("an approval's preview leaves out code-like fields and a link's query", async () => {
  const f = fixture();
  const approval = await f.ask("linear__attach_file", "juno", {
    verificationCode: "123456", code: "private", link: "https://user:private@files.example/a.pdf?sig=private#frag", note: "See https://files.example/b?token=private now",
  });
  assert.equal(approval.description, "Attach file\nLink: https://files.example/a.pdf\nNote: See https://files.example/b now");
  const hook = await f.ask("linear__post", "juno", { webhook_url: "https://hooks.example/services/T0123/B0456/a1B2c3D4e5F6g7H8i9J0k1L2", text: "Deploy 2026-11-24 finished" });
  assert.equal(hook.description, "Post\nWebhook url: https://hooks.example/services/T0123/B0456/…\nText: Deploy 2026-11-24 finished");
});

test("connector approvals use the current calling agent and MCP namespace", async () => {
  const f = fixture();
  for (const name of ["linear__create_issue", "mcp__linear__create_issue", "mcp__openclaw__linear__create_issue"]) {
    const approval = await f.ask(name, "juno", { title: "Fix an issue", password: "private", passphrase: "private", pin: "1234", session_id: "private", extra: { nested: "private" } });
    assert.equal(approval.title, "Use Linear?");
    assert.equal(approval.description, "Create issue\nTitle: Fix an issue");
    assert.deepEqual(approval.allowedDecisions, ["allow-once", "allow-always", "deny"]);
  }
  assert.equal(await f.ask("linear__create_issue", "atlas"), undefined);
  assert.equal(await f.ask("doc__read"), undefined);
  assert.equal(await f.ask("clawy_iphone_location"), undefined);
  Object.assign(f.connectorAsks.juno, { "1-notes": "new" });
  assert.ok(await f.ask("mcp-1-notes__read"));
});

test("catalog connectors require approval without an mcp.servers entry", async () => {
  const f = fixture();
  Object.assign(f.connectorAsks.juno, { deepwiki: "revision" });
  const name = "mcp__openclaw__deepwiki__ask_wiki_question";
  const approval = await f.ask(name);
  assert.ok(approval);
  assert.equal(await f.ask(name, "atlas"), undefined);
  await approval.onResolution("allow-always");
  assert.equal(await f.ask(name), undefined);
});

test("a bundle collision hides ambiguous levels and blocks calls an existing ask could cover", async () => {
  const f = fixture();
  Object.assign(f.connectorAsks.juno, { "shared.docs": "revision" });
  assert.deepEqual(await f.namespaces(), { namespaces: {
    linear: "linear", doc: "doc", docs: "docs", "1-notes": "mcp-1-notes", deepwiki: "deepwiki",
  } });
  assert.equal((await f.before("shared-docs-2__read"))?.block, true);
  assert.equal((await f.before("mcp__openclaw__shared-docs-3__read"))?.block, true);
  assert.equal(await f.before("shared-docs-2__read", "atlas"), undefined);
  assert.ok(await f.ask("linear__create_issue"));
});

test("a truncated base ending in -2 can consume suffix 3 with just two servers", async () => {
  const base = "a".repeat(28);
  const server = base + "-2";
  const f = fixture([server, server.toUpperCase()]);
  Object.assign(f.connectorAsks.juno, { [server]: "revision" });
  assert.equal((await f.before(`${base}-3__read`))?.block, true);
});

test("Always Allow clears only the revision approved", async () => {
  const f = fixture();
  const approval = await f.ask("linear__create_issue");
  await approval.onResolution("allow-once");
  await approval.onResolution("deny");
  assert.ok(await f.ask("linear__create_issue"));
  f.connectorAsks.juno.linear = "second";
  await approval.onResolution("allow-always");
  assert.equal(f.connectorAsks.juno.linear, "second");
  await (await f.ask("linear__create_issue")).onResolution("allow-always");
  assert.equal(await f.ask("linear__create_issue"), undefined);
  assert.ok(await f.ask("docs__read"));
});

test("long argument previews fit the gateway approval description", async () => {
  const f = fixture();
  const preview = (await f.ask("linear__create_issue", "juno", {
    title: "😸".repeat(350),
    body: "🫢".repeat(350),
    team: "A".repeat(350),
    label: "B".repeat(350),
  })).description;
  assert.ok(preview.length <= 512);
  assert.doesNotMatch(preview, /\p{Cs}/u);
  assert.match(preview, /…/);
});
