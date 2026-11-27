import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerToolStatus } from "../tool-status.ts";

test("tool status is owner-only and reads accounts from an explicit file keyring without prompting", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "moonstone-gog-"));
  const path = process.env.PATH;
  const backend = process.env.MOONSTONE_TEST_KEYRING;
  process.env.PATH = directory;
  t.after(() => {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    if (backend === undefined) delete process.env.MOONSTONE_TEST_KEYRING;
    else process.env.MOONSTONE_TEST_KEYRING = backend;
    rmSync(directory, { recursive: true, force: true });
  });

  type Register = OpenClawPluginApi["registerGatewayMethod"];
  let handler: Parameters<Register>[1];
  registerToolStatus({
    registerGatewayMethod(name, registered, options) {
      assert.equal(name, "moonstone.tools.status");
      assert.deepEqual(options, { scope: "operator.admin" });
      handler = registered;
    },
  });

  function read(scopes: string[]) {
    return new Promise((resolve) => {
      void handler({
        client: { connect: { scopes } },
        params: { command: "ignored-caller-input" },
        respond: (...args: unknown[]) => resolve(args),
      } as Parameters<typeof handler>[0]);
    });
  }

  const owner = ["operator.admin"];
  assert.deepEqual(await read(owner), [true, { gog: { installed: false } }]);
  const executable = join(directory, "gog");
  writeFileSync(executable, `#!${process.execPath}
const [auth, subcommand, ...flags] = process.argv.slice(2);
if (auth !== "auth" || flags.join(" ") !== "--json --no-input --color=never") process.exit(1);
if (subcommand === "keyring") console.log(JSON.stringify({ keyring_backend: process.env.MOONSTONE_TEST_KEYRING }));
else if (subcommand === "list" && process.env.GOG_KEYRING_BACKEND === "file") {
  if (process.env.MOONSTONE_TEST_KEYRING !== "file") process.exit(1);
  console.log(JSON.stringify({ accounts: [
    { email: "juno@example.com", token: "never returned", services: ["gmail", "calendar"],
      scopes: ["email", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar"] },
    { email: "atlas@example.com", services: ["youtube"],
      scopes: ["email", "openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/youtube.readonly"] },
    { email: "juno@example.com", error: "read token: never returned" },
    { email: "nova@example.com", services: ["Gmail; rm -rf"], scopes: [] }
  ] }));
} else process.exit(1);
`, { mode: 0o755 });
  assert.deepEqual(await read(["operator.read"]), [false, undefined, { code: "FORBIDDEN", message: "needs operator.admin" }]);
  process.env.MOONSTONE_TEST_KEYRING = "auto";
  assert.deepEqual(await read(owner), [true, { gog: { installed: true } }]);
  process.env.MOONSTONE_TEST_KEYRING = "file";
  // Access only where gog read the sign-in, and nothing of a token, an error or a malformed service.
  assert.deepEqual(await read(owner), [true, { gog: {
    installed: true,
    accounts: ["atlas@example.com", "juno@example.com", "nova@example.com"],
    access: {
      "juno@example.com": { services: ["gmail", "calendar"], readOnly: false },
      "atlas@example.com": { services: ["youtube"], readOnly: true },
    },
  } }]);
});

test("tool status bounds a stalled CLI and never returns error output", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "moonstone-gog-timeout-"));
  const path = process.env.PATH;
  process.env.PATH = directory;
  t.after(() => {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(join(directory, "gog"), `#!${process.execPath}
console.error("private text");
setTimeout(() => process.exit(1), 60000);
`, { mode: 0o755 });
  const reply = await new Promise((resolve) => registerToolStatus({
    registerGatewayMethod(_name, handler) {
      void handler({
        client: { connect: { scopes: ["operator.admin"] } },
        respond: (...args: unknown[]) => resolve(args),
      } as Parameters<typeof handler>[0]);
    },
  }));
  assert.deepEqual(reply, [true, { gog: { installed: true } }]);
});
