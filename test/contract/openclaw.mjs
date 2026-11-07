// Installs this checkout from git on a fresh OpenClaw, as a person would, and checks what the
// plugin depends on still holds: the SDK's exports, signing in with a password, and each signal
// reaching a forwarder sealed. It needs no model, so a run's reply is checked from the SDK's types.
//
//   node test/contract/openclaw.mjs [version]        (default: latest)
//
// It installs this checkout's committed state, or CLAWY_INSTALL_SOURCE, such as the published
// `git:linuz90/clawy-notifications#v0.2.0`.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { startForwarder } from "./forwarder.mjs";

const version = process.argv[2] ?? "latest";
const repo = resolve(import.meta.dirname, "../..");
const root = mkdtempSync(join(tmpdir(), "clawy-contract-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const password = randomBytes(18).toString("base64url");
const forwarder = await startForwarder();
const env = {
  PATH: process.env.PATH,
  HOME: root,
  OPENCLAW_HOME: join(root, "home"),
  OPENCLAW_STATE_DIR: join(root, "state"),
  OPENCLAW_CONFIG_PATH: join(root, "state/openclaw.json"),
  OPENCLAW_PROFILE: "contract",
  OPENCLAW_GATEWAY_PASSWORD: password,
  CLAWY_FORWARDER_ORIGIN: forwarder.origin,
};
const binary = join(root, "runtime/node_modules/.bin/openclaw");
const openclaw = (...args) => execFileSync(binary, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
// Not the sync form: the forwarder answers on this process's event loop.
const call = async (method, params = {}) => {
  const { stdout } = await promisify(execFile)(binary, ["gateway", "call", method, "--port", String(port), "--params", JSON.stringify(params), "--json", "--timeout", "60000"], { env });
  return JSON.parse(stdout);
};

let gateway;
try {
  execFileSync("npm", ["install", "--prefix", join(root, "runtime"), "--no-audit", "--no-fund", `openclaw@${version}`], { stdio: "ignore" });
  const installed = JSON.parse(readFileSync(join(root, "runtime/node_modules/openclaw/package.json"), "utf8")).version;
  console.log(`OpenClaw ${installed}`);

  // Not a promise of OpenClaw's: where the reply text comes from. Fails loudly if it's renamed.
  const types = join(root, "runtime/node_modules/openclaw/dist");
  const declared = readdirSync(types, { recursive: true }).filter((file) => String(file).endsWith(".d.ts"));
  assert.ok(declared.some((file) => readFileSync(join(types, String(file)), "utf8").includes("terminalReply")), "terminalReply left the SDK's types");

  openclaw("onboard", "--non-interactive", "--accept-risk", "--mode", "local", "--auth-choice", "skip", "--gateway-bind", "loopback", "--gateway-port", String(port),
    "--gateway-auth", "password", "--gateway-password", password, "--secret-input-mode", "ref", "--tailscale", "off", "--skip-channels", "--skip-daemon",
    "--skip-skills", "--skip-search", "--skip-hooks", "--skip-ui", "--skip-health", "--workspace", join(root, "workspace"), "--suppress-gateway-token-output", "--json");

  gateway = spawn(binary, ["gateway", "run", "--port", String(port), "--bind", "loopback"], { env, stdio: "ignore" });
  for (let i = 0; ; i++) {
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)) break;
    assert.ok(i < 120, "the gateway never answered");
    await new Promise((done) => setTimeout(done, 1000));
  }

  openclaw("plugins", "install", process.env.CLAWY_INSTALL_SOURCE ?? `git:file://${repo}`, "--force", "--accept-capabilities");
  openclaw("plugins", "enable", "clawy-notifications");

  let status;
  for (let i = 0; ; i++) {
    status = await call("clawy.notifications.status").catch(() => null);
    if (status?.listening?.approvals && status.listening.questions) break;
    assert.ok(i < 60, `the plugin never signed in: ${JSON.stringify(status)}`);
    await new Promise((done) => setTimeout(done, 1000));
  }
  assert.equal(status.protocol, 2);
  console.log(`plugin ${status.version} installed from ${process.env.CLAWY_INSTALL_SOURCE ?? "this checkout"}, approvals and questions signed in with a password`);

  await call("clawy.notifications.register", forwarder.device);
  assert.equal((await call("clawy.notifications.test", { id: forwarder.device.id, test: "nonce-1" })).status, 200);
  const test = await forwarder.waitFor((m) => m.title === "Clawy notifications", "test alert");
  assert.equal(test.kind, "reply");
  assert.equal(test.test, "nonce-1");
  assert.ok(Number.isSafeInteger(test.seq));
  console.log("test alert sealed, posted and opened");

  const questionId = `ask_${randomBytes(16).toString("hex")}`;
  await call("question.request", { id: questionId, questions: [{ questionId: "q1", header: "Contract", question: "Red or blue?", options: [{ label: "Red", value: "red" }, { label: "Blue", value: "blue" }] }], agentId: "main", sessionKey: "agent:main:ios-native-contract", timeoutMs: 60000 });
  const question = await forwarder.waitFor((m) => m.questionId === questionId, "question");
  assert.equal(question.body, "Red or blue?");
  assert.ok(question.seq > test.seq);
  console.log("question sealed from a live event");

  const delivery = (await call("clawy.notifications.status")).devices.find((d) => d.id === forwarder.device.id)?.delivery;
  assert.equal(delivery?.status, 200);
  assert.equal(delivery?.seq, question.seq);
  console.log("status reports the last delivery");
  console.log("OK");
} finally {
  gateway?.kill();
  forwarder.close();
  await new Promise((done) => setTimeout(done, 1500));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
