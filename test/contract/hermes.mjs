// Installs this checkout from git on a fresh Hermes Agent, as a person would, and checks what the
// plugin depends on still holds: the hooks it registers, the API server's private auth helpers, its
// routes behind a key, and a sealed alert reaching a forwarder. It needs no model.
//
//   node test/contract/hermes.mjs [tag]        (default: the newest release)
//
// Needs git and uv. It installs this checkout's committed state, or CLAWY_INSTALL_SOURCE, such as
// the published `linuz90/clawy-notifications#hermes`.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startForwarder } from "./forwarder.mjs";

const repo = resolve(import.meta.dirname, "../..");
const tag = process.argv[2] ?? (await (await fetch("https://api.github.com/repos/NousResearch/hermes-agent/releases/latest")).json()).tag_name;
const root = mkdtempSync(join(tmpdir(), "clawy-contract-"));
const source = join(root, "hermes-agent");
const home = join(root, "home");
const port = 20000 + Math.floor(Math.random() * 20000);
const key = randomBytes(24).toString("hex");
const forwarder = await startForwarder();
const env = { PATH: process.env.PATH, HOME: root, HERMES_HOME: home, CLAWY_FORWARDER_ORIGIN: forwarder.origin };
const hermes = join(source, ".venv/bin/hermes");
const api = (method, path, body, token = key) => fetch(`http://127.0.0.1:${port}${path}`, {
  method,
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body && JSON.stringify(body),
});

let gateway;
try {
  console.log(`Hermes ${tag}`);
  execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", tag, "https://github.com/NousResearch/hermes-agent.git", source], { stdio: "ignore" });
  execFileSync("uv", ["venv", "--quiet", "--python", "3.14", ".venv"], { cwd: source, stdio: "ignore" });
  execFileSync("uv", ["pip", "install", "--quiet", "--python", ".venv/bin/python", "-e", ".[messaging,web]"], { cwd: source, stdio: "ignore" });

  // Neither is a promise of Hermes's. The plugin's routes refuse everything if these go.
  execFileSync(join(source, ".venv/bin/python"), ["-c", `
from gateway.platforms.api_server import APIServerAdapter as A
assert hasattr(A, "_check_auth") and hasattr(A, "_expected_api_key")
from hermes_cli.plugins import VALID_HOOKS as H
assert {"post_llm_call", "on_session_end", "on_human_input_request"} <= set(H), H
`], { cwd: source, env, stdio: "inherit" });

  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".env"), `API_SERVER_ENABLED=true\nAPI_SERVER_HOST=127.0.0.1\nAPI_SERVER_PORT=${port}\nAPI_SERVER_KEY=${key}\n`, { mode: 0o600 });
  execFileSync(hermes, ["plugins", "install", process.env.CLAWY_INSTALL_SOURCE ?? `file://${repo}#hermes`, "--enable"], { env, stdio: "ignore" });
  // Enabling a plugin moves a source install onto Hermes's managed environment, which starts with
  // no extras, so the API server's have to be chosen there.
  execFileSync(join(source, ".venv/bin/python"), ["-c", 'from pm.client import sync_venv; sync_venv(["messaging", "web"], explicit=True)'], { cwd: source, env, stdio: "ignore" });

  const log = openSync(join(root, "gateway.log"), "w");
  gateway = spawn(hermes, ["gateway", "run"], { env, stdio: ["ignore", log, log] });
  for (let i = 0; ; i++) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) break;
    assert.ok(i < 120, "the API server never answered");
    await new Promise((done) => setTimeout(done, 1000));
  }

  assert.equal((await api("GET", "/v1/clawy/status", undefined, "wrong-key")).status, 401);
  const status = await (await api("GET", "/v1/clawy/status")).json();
  assert.equal(status.protocol, 2);
  console.log(`plugin ${status.version} installed from ${process.env.CLAWY_INSTALL_SOURCE ?? "this checkout"}, its routes refuse a wrong key`);

  assert.equal((await api("POST", "/v1/clawy/devices", forwarder.device)).status, 200);
  const answer = await (await api("POST", `/v1/clawy/devices/${forwarder.device.id}/test`, { test: "nonce-1" })).json();
  assert.equal(answer.status, 200);
  const test = await forwarder.waitFor((m) => m.title === "Clawy notifications", "test alert");
  assert.ok(Number.isSafeInteger(test.seq));
  assert.equal(test.test, "nonce-1");
  console.log("test alert sealed, posted and opened");

  const after = await (await api("GET", "/v1/clawy/status")).json();
  assert.equal(after.devices.find((d) => d.id === forwarder.device.id)?.delivery?.seq, test.seq);
  console.log("status reports the last delivery");
  console.log("OK");
} catch (error) {
  try {
    console.error(readFileSync(join(root, "gateway.log"), "utf8").split("\n").slice(-30).join("\n"));
  } catch {}
  throw error;
} finally {
  gateway?.kill();
  forwarder.close();
  await new Promise((done) => setTimeout(done, 1500));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
