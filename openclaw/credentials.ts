// Reads SecretRef locations, the 1Password plugin's rules, and 1Password vault and item metadata for
// Moonstone's Credentials page: what `config.get` hides from a client (it redacts SecretRef ids, and the
// whole `onepassword` entry, whose name matches its /password/ rule) and what no gateway method lists.
// It never resolves a SecretRef or reads an item value. See README.md, What could break between OpenClaw releases.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type Runtime = OpenClawPluginApi["runtime"];
type Config = ReturnType<Runtime["config"]["current"]>;
type SecretRef = { path: string; source: "env" | "file" | "exec" | "store"; provider?: string; id?: string; agentId?: string };
type Vault = { id: string; name: string };
type Item = { id: string; title: string; category: string; vault: string; hint?: string; sites?: string[]; updatedAt?: string };
type CommandFailure = "auth-failed" | "rate-limited" | "timeout" | "error";
type Status = CommandFailure | "ready" | "no-token" | "no-op" | "unsafe-op";
/** OpenClaw's own check that an executable is safe to hand a credential: owned by this user or
 * root, and nothing on its path writable by anyone else. Throws ENOENT or ENOTDIR when it's absent. */
export type TrustedResolver = (candidate: string) => Promise<string>;
/** `tokenFile` is where the bundled plugin reads its service-account token, for the command the app
 * shows to connect one; `op` says what's wrong with 1Password's command line when there's no token yet. */
type OnePassword = { status: Status; vaults: Vault[]; items: Item[]; tokenFile: string; op?: "missing" | "unsafe"; checkedAt: number };
type Policy = "auto" | "approve" | "deny";
type Rule = { slug: string; item: string; vault?: string; field?: string; policy: Policy; description?: string };
/** `blocked`: the gateway's own plugin settings keep it from running, whatever its entry says. */
type Rules = { enabled: boolean; blocked?: true; vault?: string; rules: Rule[] };

const CACHE_MS = 60_000;
const MAX_REFS = 200;
const MAX_DEPTH = 32;
const MAX_ITEMS = 500;
const MAX_RULES = 32;
/** OpenClaw's grammar for an `env` SecretRef's id and a store entry's name (`ref-contract`,
 * `SecretStoreNameSchema`), for its provider aliases, and for agent ids. */
const NAME_ID = /^[A-Z][A-Z0-9_]{0,127}$/u;
const PROVIDER = /^[a-z][a-z0-9_-]{0,63}$/u;
const AGENT_ID = /^[a-z0-9_][a-z0-9_-]{0,63}$/iu;
/** A service-account token is a few hundred bytes; anything far past that isn't one. */
const MAX_TOKEN_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A SecretRef exactly as OpenClaw's contract has it, `{source, provider?, id}` and nothing else, with
 * a store or env id in its name grammar; anything else that happens to carry `source` and `id` is
 * plain config and is walked like any other object. */
function secretRef(value: Record<string, unknown>, path: string, agentId: string | undefined): SecretRef | undefined {
  const { source, provider, id } = value;
  if (source !== "env" && source !== "file" && source !== "exec" && source !== "store") return;
  if (typeof id !== "string" || !id.trim()) return;
  if (Object.keys(value).some(key => key !== "source" && key !== "provider" && key !== "id")) return;
  if (provider !== undefined && (typeof provider !== "string" || !PROVIDER.test(provider))) return;
  if ((source === "env" || source === "store") && !NAME_ID.test(id)) return;
  const ref: SecretRef = { path, source };
  if (typeof provider === "string") ref.provider = provider;
  if (source === "env" || source === "store") ref.id = id;
  if (agentId) ref.agentId = agentId;
  return ref;
}

/** Every SecretRef in the config, with the agent it belongs to when it sits under one
 * (`agents.entries.<id>` or `agents.list[n]`). A ref under an agent whose id can't be read has no
 * `agentId`, and the app counts it for no agent. */
function secretRefs(config: unknown): SecretRef[] {
  const refs: SecretRef[] = [];
  // OpenClaw's roster lowercases agent ids, as the app knows them.
  const agent = (id: unknown) => typeof id === "string" && AGENT_ID.test(id.trim()) ? id.trim().toLowerCase() : undefined;

  function visit(value: unknown, path: string, depth: number, agentId: string | undefined) {
    if (Array.isArray(value)) {
      if (depth === MAX_DEPTH) return;
      for (const [index, child] of value.entries()) {
        const owner = path === "agents.list" && isRecord(child) ? agent(child.id) : agentId;
        visit(child, `${path}[${index}]`, depth + 1, owner);
        if (refs.length === MAX_REFS) break;
      }
      return;
    }
    if (!isRecord(value)) return;
    const ref = secretRef(value, path, agentId);
    if (ref) {
      refs.push(ref);
      return;
    }
    if (depth === MAX_DEPTH) return;
    for (const [key, child] of Object.entries(value)) {
      visit(child, path ? `${path}.${key}` : key, depth + 1, path === "agents.entries" ? agent(key) : agentId);
      if (refs.length === MAX_REFS) break;
    }
  }

  visit(config, "", 0, undefined);
  return refs;
}

/** The bundled `onepassword` plugin's registry: per slug, the item it names and its policy. It runs
 * once it has config unless `enabled: false`, and not when plugins are off, it's denied, or an
 * allowlist leaves it out, as its own loader decides (`resolveEffectiveEnableState`). */
function onePasswordRules(config: unknown): Rules | null {
  const plugins = isRecord(config) && isRecord(config.plugins) ? config.plugins : undefined;
  const entry = plugins && isRecord(plugins.entries) ? plugins.entries.onepassword : undefined;
  // Plugin ids compare case-insensitively, as OpenClaw normalizes them.
  const named = (list: unknown) => Array.isArray(list) && list.some(id => typeof id === "string" && id.trim().toLowerCase() === "onepassword");
  const barred = plugins?.enabled === false || named(plugins?.deny) || (Array.isArray(plugins?.allow) && plugins.allow.length > 0 && !named(plugins.allow));
  // Without an entry, it runs once one is written, unless the gateway's settings bar it.
  if (!isRecord(entry)) return barred ? { enabled: false, blocked: true, rules: [] } : null;
  const settings = isRecord(entry.config) ? entry.config : undefined;
  const policy = (value: unknown, fallback: Policy): Policy => value === "auto" || value === "approve" || value === "deny" ? value : fallback;
  // Trimmed, as the bundled broker trims an item and vault before looking them up.
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
  const defaultPolicy = policy(settings?.defaultPolicy, "approve");
  const vault = text(settings?.vault);
  const rules: Rule[] = [];
  for (const [slug, row] of Object.entries(isRecord(settings?.items) ? settings.items : {})) {
    const item = isRecord(row) ? text(row.item) : undefined;
    if (!isRecord(row) || !item) continue;
    const rule: Rule = { slug: slug.slice(0, 64), item, policy: policy(row.policy, defaultPolicy) };
    const itemVault = text(row.vault) ?? vault;
    if (itemVault) rule.vault = itemVault;
    const field = text(row.field);
    if (field) rule.field = field;
    const description = text(row.description);
    if (description) rule.description = description;
    rules.push(rule);
    if (rules.length === MAX_RULES) break;
  }
  const enabled = !barred && (entry.enabled === true || (entry.enabled !== false && settings !== undefined));
  return { enabled, ...barred ? { blocked: true } : {}, ...vault ? { vault } : {}, rules };
}

/** `op` as the bundled plugin finds it (`opBin`, else `CLAW_1PASSWORD_OP`, else `PATH`), passed through
 * OpenClaw's trust check before the token goes near it: "unsafe" when the only one found isn't safe. */
async function opBinary(config: Config | undefined, path: string, trusted: TrustedResolver): Promise<string | "unsafe" | undefined> {
  const configured = config?.plugins?.entries?.onepassword?.config?.opBin;
  const override = process.env.CLAW_1PASSWORD_OP;
  const explicit = typeof configured === "string" && isAbsolute(configured) ? configured
    : override && isAbsolute(override) ? override : undefined;
  const executable = process.platform === "win32" ? "op.exe" : "op";
  const candidates = explicit ? [explicit] : path.split(delimiter).filter(Boolean).map(directory => resolve(directory, executable));
  let unsafe = false;
  for (const candidate of candidates) {
    try {
      return await trusted(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      unsafe = true;
    }
  }
  return unsafe ? "unsafe" : undefined;
}

function classifyFailure(result: unknown): CommandFailure {
  if (result === null || typeof result !== "object") return "error";
  const { code, termination, stderr: diagnostic } = result as Record<string, unknown>;
  if (termination === "timeout" || termination === "no-output-timeout" || code === "ETIMEDOUT") return "timeout";
  const stderr = typeof diagnostic === "string" ? diagnostic.toLowerCase() : "";
  if (/\b429\b|rate[ -]?limit|too many requests/u.test(stderr)) return "rate-limited";
  if (/authenticat|unauthori[sz]ed|invalid (?:service account |access )?token|invalid service account|sign[ -]?in|signed in/u.test(stderr)) return "auth-failed";
  return "error";
}

async function list(system: Runtime["system"], op: string, resource: "vault" | "item", env: NodeJS.ProcessEnv): Promise<unknown[] | CommandFailure> {
  try {
    // `baseEnv: {}` keeps the gateway's environment out: op gets only `env`, plus the runner's own
    // OPENCLAW_CLI marker. The token goes in the environment, never in argv.
    const result = await system.runCommandWithTimeout([op, resource, "list", "--format", "json"], {
      baseEnv: {}, env, input: "", timeoutMs: 15_000,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 16 * 1024 },
      terminateOnOutputLimit: true, killProcessTree: true,
    });
    if (result.code !== 0 || (result.termination && result.termination !== "exit")) return classifyFailure(result);
    if (result.outputLimitExceeded || result.stdoutTruncatedBytes) return "error";
    const parsed: unknown = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : "error";
  } catch (error) {
    return classifyFailure(error);
  }
}

function itemMetadata(value: unknown): Item | undefined {
  if (!isRecord(value)) return;
  const { id, title, category, vault, urls, updated_at: updatedAt } = value;
  if (typeof id !== "string" || typeof title !== "string" || typeof category !== "string"
    || !isRecord(vault) || typeof vault.id !== "string") return;
  const item: Item = { id, title: title.slice(0, 200), category, vault: vault.id };
  if (category === "LOGIN" || category === "CREDIT_CARD") {
    const info = value.additional_information;
    if (typeof info === "string" && info) {
      if (category === "LOGIN") item.hint = info;
      else {
        const digits = info.replace(/\D/gu, "");
        if (digits.length >= 4) item.hint = digits.slice(-4);
      }
    }
  }
  if (Array.isArray(urls)) {
    const sites = new Set<string>();
    for (const url of urls) {
      if (!isRecord(url) || typeof url.href !== "string") continue;
      const hostname = URL.parse(url.href)?.hostname;
      if (hostname) sites.add(hostname);
    }
    if (sites.size > 0) item.sites = [...sites];
  }
  if (typeof updatedAt === "string") item.updatedAt = updatedAt;
  return item;
}

/** The token file, read only when it's a regular file of a token's size: never through a symlink,
 * and never blocking on a pipe someone put in its place. */
function readToken(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TOKEN_BYTES) throw Object.assign(new Error("not a token file"), { code: "EINVAL" });
    return readFileSync(fd, "utf8").replace(/(?:\r?\n)+$/u, "");
  } finally {
    closeSync(fd);
  }
}

async function readOnePassword(runtime: Runtime, config: Config | undefined, trusted: TrustedResolver | undefined): Promise<Omit<OnePassword, "checkedAt">> {
  const tokenFile = join(runtime.state.resolveStateDir(process.env), "credentials", "onepassword", "service-account-token");
  const empty = (status: Status) => ({ status, vaults: [], items: [], tokenFile });
  let token = "";
  try {
    token = readToken(tokenFile);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return empty("error");
  }
  if (!trusted) return empty(token ? "error" : "no-token");
  const path = process.env.PATH ?? "";
  const op = await opBinary(config, path, trusted);
  // Without a token, what connecting one also needs: no token goes near `op` here.
  if (!token) return op === "unsafe" ? { ...empty("no-token"), op: "unsafe" } : op ? empty("no-token") : { ...empty("no-token"), op: "missing" };
  if (op === "unsafe") return empty("unsafe-op");
  if (!op) return empty("no-op");
  const env = {
    HOME: process.env.HOME ?? homedir(),
    PATH: path,
    OP_SERVICE_ACCOUNT_TOKEN: token,
    OP_LOAD_DESKTOP_APP_SETTINGS: "false",
    OP_BIOMETRIC_UNLOCK_ENABLED: "false",
    NO_COLOR: "1",
  };
  const [vaultRows, itemRows] = await Promise.all([list(runtime.system, op, "vault", env), list(runtime.system, op, "item", env)]);
  if (!Array.isArray(vaultRows)) return empty(vaultRows);
  if (!Array.isArray(itemRows)) return empty(itemRows);
  const vaults = vaultRows.flatMap(row =>
    isRecord(row) && typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : []);
  const items: Item[] = [];
  for (const row of itemRows) {
    const item = itemMetadata(row);
    if (item) items.push(item);
    if (items.length === MAX_ITEMS) break;
  }
  return { status: "ready", vaults, items, tokenFile };
}

export function registerCredentials(api: Pick<OpenClawPluginApi, "registerGatewayMethod" | "runtime" | "logger">,
  options: { trusted?: TrustedResolver } = {}): void {
  let cached: OnePassword | undefined;
  let pending: Promise<OnePassword> | undefined;
  let sourceReader: Promise<(() => Config | null) | undefined> | undefined;
  // The same check the bundled plugin runs on `op` (`onepassword-op-path.js`), from the public SDK.
  let trustedReader: Promise<TrustedResolver | undefined> | undefined = options.trusted ? Promise.resolve(options.trusted) : undefined;

  function onePassword(config: Config | undefined, refresh: boolean): Promise<OnePassword> {
    if (pending) return pending;
    if (!refresh && cached && Date.now() - cached.checkedAt < CACHE_MS) return Promise.resolve(cached);
    trustedReader ??= import("openclaw/plugin-sdk/secret-ref-runtime")
      .then(sdk => sdk.pluginSecretRefSetup?.resolveTrustedExecutablePath, () => undefined);
    pending = trustedReader.then(trusted => readOnePassword(api.runtime, config, trusted)).then(result => {
      if (result.status !== "ready" && result.status !== "no-token" && result.status !== "no-op") {
        api.logger.warn(`moonstone.credentials.status: ${result.status}`);
      }
      cached = { ...result, checkedAt: Date.now() };
      return cached;
    }).finally(() => { pending = undefined; });
    return pending;
  }

  api.registerGatewayMethod("moonstone.credentials.status", async ({ params, respond }) => {
    try {
      // The runtime config can replace a SecretRef with its resolved value. The source snapshot
      // retains the reference and its id. Older SDKs can still report refs present in current().
      sourceReader ??= import("openclaw/plugin-sdk/runtime-config-snapshot")
        .then(sdk => sdk.getRuntimeConfigSourceSnapshot, () => undefined);
      const readSource = await sourceReader;
      const config = readSource?.() ?? api.runtime.config?.current?.();
      const refs = secretRefs(config);
      const onepasswordRules = onePasswordRules(config);
      const onepassword = await onePassword(config, params?.refresh === true);
      respond(true, { protocol: 1, refs, onepasswordRules, onepassword });
    } catch {
      respond(false, undefined, { code: "UNAVAILABLE", message: "credentials status failed" });
    }
  }, { scope: "operator.admin" });
}
