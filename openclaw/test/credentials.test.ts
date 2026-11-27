import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { registerCredentials } from "../credentials.ts";

const vault = { id: "vault1", name: "Work" };
const token = " fake-token-for-credentials-tests ";
const item = { id: "login1", title: "Work sign-in", category: "LOGIN", vault: { id: vault.id } };
type CommandResult = { code: number | null; termination: string; stdout: string; stderr: string };
const success = (data: unknown): CommandResult => ({ code: 0, termination: "exit", stdout: JSON.stringify(data), stderr: "" });

function setEnv(t: TestContext, name: string, value: string | undefined) {
  const previous = process.env[name];
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "moonstone-credentials-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, process.platform === "win32" ? "op.exe" : "op");
  writeFileSync(executable, "", { mode: 0o700 });
  let config: unknown = { plugins: { entries: { onepassword: { config: { opBin: executable } } } } };
  let current = () => config;
  let run = async (argv: string[]) => success(argv[1] === "vault" ? [vault] : [item]);
  let method: any;
  const calls: { argv: string[]; options: any }[] = [];
  const warnings: string[] = [];
  // Stands in for OpenClaw's trust check: a regular executable file passes, and a path in `unsafe` fails it.
  const unsafe = new Set<string>();
  const trusted = async (candidate: string) => {
    if (unsafe.has(candidate)) throw Object.assign(new Error("writable by others"), { code: "EUNSAFE" });
    if (!statSync(candidate, { throwIfNoEntry: false })?.isFile()) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    accessSync(candidate, constants.X_OK);
    return candidate;
  };

  registerCredentials({
    registerGatewayMethod: (name: string, handler: unknown, options: unknown) => { method = { name, handler, options }; },
    runtime: {
      config: { current: () => current() },
      state: { resolveStateDir: () => root },
      system: { runCommandWithTimeout: (argv: string[], options: unknown) => {
        calls.push({ argv, options });
        return run(argv);
      } },
    },
    logger: { warn: (message: string) => warnings.push(message) },
  } as any, { trusted });

  return {
    method, calls, warnings, root, executable, unsafe,
    set config(value: unknown) { config = value; },
    set current(value: typeof current) { current = value; },
    set run(value: typeof run) { run = value; },
    writeToken(value = token + "\r\n") {
      const credentials = join(root, "credentials", "onepassword");
      mkdirSync(credentials, { recursive: true });
      writeFileSync(join(credentials, "service-account-token"), value, { mode: 0o600 });
    },
    async request(params = {}) {
      let reply: any[] = [];
      await method.handler({ params, respond: (...args: unknown[]) => { reply = args; } });
      return reply;
    },
    async status(params = {}) {
      const [ok, result] = await this.request(params);
      assert.equal(ok, true);
      return result;
    },
  };
}

test("registers only an admin-scoped status method", t => {
  const { method } = harness(t);
  assert.equal(method.name, "moonstone.credentials.status");
  assert.deepEqual(method.options, { scope: "operator.admin" });
});

test("reports SecretRef paths and only store and environment IDs", async t => {
  const h = harness(t);
  h.config = {
    models: { providers: { openai: { apiKey: { source: "store", provider: "default", id: "OPENAI_API_KEY" } },
      other: { apiKey: "plaintext-config-key" } } },
    channels: [{ botToken: { source: "exec", provider: "onepassword", id: "op://vault/item/field" } }],
    envRef: { source: "env", id: "CHAT_TOKEN" },
    fileRef: { source: "file", id: "/file/secret-id" },
    invalid: [{ source: "store", id: "" }, { source: "env", id: 2 }, { source: "other", id: "X" }],
    // Shaped like a ref without being one: an extra field, an id outside the name grammar, a bad provider.
    lookalikes: [{ source: "env", id: "SK_LIVE_DECOY_ONE", tag: "x" }, { source: "store", id: "sk-live-decoy-two" },
      { source: "env", provider: "Bad Provider", id: "DECOY_THREE" }, { source: "store", id: "DECOY_FOUR", value: "hidden-store-value" }],
    agents: {
      entries: { juno: { tts: { providers: { elevenlabs: { apiKey: { source: "store", id: "JUNO_VOICE_KEY" } } } } },
        Nova: { memory: { search: { remote: { apiKey: { source: "store", id: "NOVA_MEMORY_KEY" } } } } } },
      list: [{ id: "atlas", memory: { search: { remote: { apiKey: { source: "store", id: "ATLAS_MEMORY_KEY" } } } } },
        { id: "_scratch", tts: { providers: { openai: { apiKey: { source: "store", id: "SCRATCH_KEY" } } } } },
        { id: "has space", tts: { providers: { openai: { apiKey: { source: "store", id: "UNOWNED_KEY" } } } } }],
    },
  };
  const result = await h.status();
  assert.equal(result.protocol, 1);
  assert.deepEqual(result.refs, [
    { path: "models.providers.openai.apiKey", source: "store", provider: "default", id: "OPENAI_API_KEY" },
    { path: "channels[0].botToken", source: "exec", provider: "onepassword" },
    { path: "envRef", source: "env", id: "CHAT_TOKEN" },
    { path: "fileRef", source: "file" },
    { path: "agents.entries.juno.tts.providers.elevenlabs.apiKey", source: "store", id: "JUNO_VOICE_KEY", agentId: "juno" },
    { path: "agents.entries.Nova.memory.search.remote.apiKey", source: "store", id: "NOVA_MEMORY_KEY", agentId: "nova" },
    { path: "agents.list[0].memory.search.remote.apiKey", source: "store", id: "ATLAS_MEMORY_KEY", agentId: "atlas" },
    { path: "agents.list[1].tts.providers.openai.apiKey", source: "store", id: "SCRATCH_KEY", agentId: "_scratch" },
    { path: "agents.list[2].tts.providers.openai.apiKey", source: "store", id: "UNOWNED_KEY" },
  ]);
  for (const secret of ["plaintext-config-key", "hidden-store-value", "op://vault/item/field", "/file/secret-id", "DECOY"]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("reports the 1Password plugin's rules, which config.get hides whole", async t => {
  const h = harness(t);
  h.config = { plugins: { entries: { onepassword: { config: {
    vault: "Test Vault", defaultPolicy: "deny", opBin: "/secret/path",
    items: {
      "acme-shop": { item: " Acme Shop ", field: "password", policy: "approve", description: "Sign in to the shop" },
      "team-visa": { item: "Team Visa", vault: "Cards", field: "number" },
      broken: { field: "credential" },
    },
  } } } } };
  assert.deepEqual((await h.status()).onepasswordRules, {
    enabled: true, vault: "Test Vault",
    rules: [
      { slug: "acme-shop", item: "Acme Shop", vault: "Test Vault", field: "password", policy: "approve", description: "Sign in to the shop" },
      { slug: "team-visa", item: "Team Visa", vault: "Cards", field: "number", policy: "deny" },
    ],
  });
  h.config = { plugins: { entries: { onepassword: { enabled: false, config: { items: {} } } } } };
  assert.equal((await h.status()).onepasswordRules.enabled, false);
  assert.equal("blocked" in (await h.status()).onepasswordRules, false);
  h.config = { plugins: { enabled: false, entries: { onepassword: { enabled: true } } } };
  assert.deepEqual((await h.status()).onepasswordRules, { enabled: false, blocked: true, rules: [] });
  h.config = { plugins: { deny: ["OnePassword"], entries: { onepassword: { enabled: true } } } };
  assert.equal((await h.status()).onepasswordRules.blocked, true);
  h.config = { plugins: { allow: ["moonstone"], entries: { onepassword: { enabled: true } } } };
  assert.equal((await h.status()).onepasswordRules.blocked, true);
  h.config = {};
  assert.equal((await h.status()).onepasswordRules, null);
  // No entry yet, but an allowlist leaves it out: a first rule couldn't turn it on.
  h.config = { plugins: { allow: ["moonstone"] } };
  assert.deepEqual((await h.status()).onepasswordRules, { enabled: false, blocked: true, rules: [] });
});

test("handles missing config and caps refs and traversal depth", async t => {
  const h = harness(t);
  h.config = undefined;
  assert.deepEqual((await h.status()).refs, []);

  const ref = { source: "store", id: "ENTRY" };
  const nest = (value: unknown, depth: number) => {
    for (let level = 0; level < depth; level++) value = { child: value };
    return value;
  };
  h.config = { within: nest(ref, 31), beyond: nest(ref, 32), many: Array.from({ length: 201 }, () => ref) };
  const { refs } = await h.status();
  assert.equal(refs.length, 200);
  assert.equal(refs[0].path, ["within", ...Array(31).fill("child")].join("."));
  assert.equal(refs[1].path, "many[0]");
  assert.equal(refs.at(-1).path, "many[198]");
});

test("reads the token only from a regular file of a token's size", async t => {
  const h = harness(t);
  const credentials = join(h.root, "credentials", "onepassword");
  mkdirSync(credentials, { recursive: true });
  execFileSync("mkfifo", [join(credentials, "service-account-token")]);
  assert.equal((await h.status()).onepassword.status, "error");
  rmSync(join(credentials, "service-account-token"));
  h.writeToken("x".repeat(20 * 1024));
  assert.equal((await h.status({ refresh: true })).onepassword.status, "error");
  assert.deepEqual(h.calls, []);
});

test("skips commands for both missing and empty token files, and says where the token goes", async t => {
  const h = harness(t);
  const tokenFile = join(h.root, "credentials", "onepassword", "service-account-token");
  const missing = (await h.status()).onepassword;
  assert.deepEqual(missing, { status: "no-token", vaults: [], items: [], tokenFile, checkedAt: missing.checkedAt });
  h.writeToken("\r\n");
  assert.equal((await h.status({ refresh: true })).onepassword.status, "no-token");
  assert.deepEqual(h.calls, []);
});

test("says what's wrong with op while no token is connected", async t => {
  const h = harness(t);
  h.unsafe.add(h.executable);
  assert.equal((await h.status()).onepassword.op, "unsafe");
  h.unsafe.clear();
  rmSync(h.executable);
  assert.equal((await h.status({ refresh: true })).onepassword.op, "missing");
  writeFileSync(h.executable, "", { mode: 0o700 });
  assert.equal("op" in (await h.status({ refresh: true })).onepassword, false);
  assert.deepEqual(h.calls, []);
});

test("lists only vault and item metadata using a fresh child environment", async t => {
  const h = harness(t);
  setEnv(t, "MOONSTONE_TEST_GATEWAY_SECRET", "gateway-secret-sentinel");
  setEnv(t, "OP_SERVICE_ACCOUNT_TOKEN", "unrelated-gateway-token");
  h.writeToken();
  h.run = async argv => success(argv[1] === "vault" ? [{ ...vault, secret: "vault-value" }, null] : [
    { ...item, additional_information: "user@example.com", updated_at: "2026-11-19T12:00:00Z", fields: [{ value: "password-value" }],
      urls: [{ href: "https://name:pass@Example.org:9443/login?private=1" }, { href: "https://example.org/other" },
        { href: "http://second.example/path" }, { href: "not a URL" }, { href: "mailto:user@example.net" }] },
    { ...item, id: "card1", title: "Travel card", category: "CREDIT_CARD", additional_information: "4444 **** 4242" },
    { ...item, id: "api1", title: "x".repeat(201), category: "API_CREDENTIAL", additional_information: "api-secret-value" },
    { ...item, vault: { name: "Work" } },
  ]);
  const result = await h.status();
  const { checkedAt } = result.onepassword;
  assert.equal(typeof checkedAt, "number");
  assert.deepEqual(result.onepassword, {
    status: "ready", checkedAt, vaults: [vault], tokenFile: join(h.root, "credentials", "onepassword", "service-account-token"),
    items: [
      { ...item, vault: vault.id, hint: "user@example.com", sites: ["example.org", "second.example"], updatedAt: "2026-11-19T12:00:00Z" },
      { id: "card1", title: "Travel card", category: "CREDIT_CARD", vault: vault.id, hint: "4242" },
      { id: "api1", title: "x".repeat(200), category: "API_CREDENTIAL", vault: vault.id },
    ],
  });
  assert.deepEqual(h.calls.map(call => call.argv), [
    [h.executable, "vault", "list", "--format", "json"],
    [h.executable, "item", "list", "--format", "json"],
  ]);
  for (const { options } of h.calls) {
    assert.deepEqual(options, {
      baseEnv: {}, input: "", timeoutMs: 15_000,
      env: {
        HOME: process.env.HOME ?? homedir(), PATH: process.env.PATH ?? "", OP_SERVICE_ACCOUNT_TOKEN: token,
        OP_LOAD_DESKTOP_APP_SETTINGS: "false", OP_BIOMETRIC_UNLOCK_ENABLED: "false", NO_COLOR: "1",
      },
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 16 * 1024 },
      terminateOnOutputLimit: true, killProcessTree: true,
    });
  }
  assert.equal(JSON.stringify([result, h.warnings, h.calls.map(call => call.argv)]).includes(token), false);
});

test("resolves op from an absolute override or PATH, through the trust check", async t => {
  const h = harness(t);
  h.writeToken();
  h.config = { plugins: { entries: { onepassword: { config: { opBin: "relative" } } } } };
  setEnv(t, "PATH", "");
  setEnv(t, "CLAW_1PASSWORD_OP", h.executable);
  assert.equal((await h.status()).onepassword.status, "ready");
  assert.equal(h.calls[0].argv[0], h.executable);

  process.env.CLAW_1PASSWORD_OP = "relative";
  process.env.PATH = h.root;
  assert.equal((await h.status({ refresh: true })).onepassword.status, "ready");
  assert.equal(h.calls[2].argv[0], h.executable);

  // A copy that fails OpenClaw's trust check never gets the token.
  h.unsafe.add(h.executable);
  assert.equal((await h.status({ refresh: true })).onepassword.status, "unsafe-op");
  assert.equal(h.calls.length, 4);
  h.unsafe.clear();

  rmSync(h.executable);
  mkdirSync(h.executable);
  assert.equal((await h.status({ refresh: true })).onepassword.status, "no-op");
  assert.equal(h.calls.length, 4);
});

test("caps the list at 500 items", async t => {
  const h = harness(t);
  h.writeToken();
  h.run = async argv => success(argv[1] === "vault" ? [vault] :
    Array.from({ length: 501 }, (_, i) => ({ ...item, id: String(i) })));
  const { items } = (await h.status()).onepassword;
  assert.equal(items.length, 500);
  assert.equal(items.at(-1).id, "499");
});

test("classifies command failures and malformed output without leaking diagnostics", async t => {
  const h = harness(t);
  h.writeToken();
  const sensitive = "hidden-stderr-value";
  const cases = [
    { code: 1, termination: "exit", stderr: `UNAUTHORIZED: ${sensitive} ${token}`, stdout: "", status: "auth-failed" },
    { code: 1, termination: "exit", stderr: `Rate limit: ${sensitive}`, stdout: "", status: "rate-limited" },
    { code: null, termination: "timeout", stderr: "", stdout: "", status: "timeout" },
    { code: 0, termination: "exit", stderr: "", stdout: `bad-json-${sensitive}`, status: "error" },
  ];
  for (const { status, ...commandResult } of cases) {
    const before = h.calls.length;
    h.run = async () => commandResult;
    const result = (await h.status({ refresh: true })).onepassword;
    assert.deepEqual(result, { status, vaults: [], items: [], tokenFile: result.tokenFile, checkedAt: result.checkedAt });
    assert.equal(h.calls.length, before + 2, "both lists run together");
    assert.equal(JSON.stringify(result).includes(sensitive), false);
  }
  assert.deepEqual(h.warnings, cases.map(({ status }) => `moonstone.credentials.status: ${status}`));
});

test("caches onePassword for 60 seconds, shares pending work, and always reads refs", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const h = harness(t);
  h.writeToken();
  const [original, concurrent] = await Promise.all([h.status(), h.status()]);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(original, concurrent);
  assert.equal(original.onepassword.checkedAt, 1_000);

  h.config = { ref: { source: "store", id: "NEW" }, plugins: { entries: { onepassword: { config: { opBin: h.executable } } } } };
  t.mock.timers.setTime(60_999);
  const cached = await h.status();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(cached.onepassword, original.onepassword);
  assert.deepEqual(cached.refs, [{ path: "ref", source: "store", id: "NEW" }]);

  t.mock.timers.setTime(61_000);
  assert.equal((await h.status()).onepassword.checkedAt, 61_000);
  assert.equal(h.calls.length, 4);

  t.mock.timers.setTime(61_001);
  assert.equal((await h.status({ refresh: true })).onepassword.checkedAt, 61_001);
  assert.equal(h.calls.length, 6);
});

test("puts only the generic gateway error on unexpected failures", async t => {
  const h = harness(t);
  h.current = () => { throw new Error("private-config-value"); };
  assert.deepEqual(await h.request(), [false, undefined, { code: "UNAVAILABLE", message: "credentials status failed" }]);
  assert.deepEqual(h.warnings, []);
});
