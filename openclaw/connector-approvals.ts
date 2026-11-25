import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

const PLUGIN_ID = "clawy-notifications";
const CONFIG_PATH = `plugins.entries.${PLUGIN_ID}.config.connectorAsks`;

type Config = ReturnType<OpenClawPluginApi["runtime"]["config"]["current"]>;
type LoadInventories = (config: Config, agent?: string) => Promise<string[][]>;

async function loadInventories(cfg: Config, agent?: string): Promise<string[][]> {
  const [{ loadAgentHarnessMcpConfig }, scope] = await Promise.all([
    import("openclaw/plugin-sdk/agent-harness-runtime"),
    import("openclaw/plugin-sdk/agent-runtime"),
  ]);
  const agents = agent ? [agent] : scope.listAgentIds(cfg);
  const workspaces = new Set(agents.map(id => scope.resolveAgentWorkspaceDir(cfg, id)));
  // Also cover disabled config entries: an individual session can enable one or omit a server,
  // changing which server gets the unsuffixed name.
  const mcpServers = Object.fromEntries(Object.keys(cfg.mcp?.servers ?? {}).map(id => [id, true]));
  return Promise.all([...workspaces].map(async workspaceDir => {
    const loaded = await loadAgentHarnessMcpConfig({ cfg, workspaceDir, toolOverrides: { mcpServers } });
    if (loaded.diagnostics.length > 0) throw new Error("Incomplete MCP inventory");
    return [...Object.keys(loaded.config.mcpServers), ...loaded.requesterScopedServerNames];
  }));
}

function asks(config: Config, agent: string): Record<string, string> | undefined {
  const entries = config.plugins?.entries?.[PLUGIN_ID]?.config?.connectorAsks as Record<string, Record<string, string>> | undefined;
  return entries && Object.hasOwn(entries, agent) ? entries[agent] : undefined;
}

/** See README.md, "What could break between OpenClaw releases". */
function baseNamespace(server: string): string {
  const cleaned = server.trim().replace(/[^A-Za-z0-9_-]/g, "-") || "mcp";
  return (/^[A-Za-z]/.test(cleaned) ? cleaned : `mcp-${cleaned}`).slice(0, 30).toLowerCase();
}

function possibleNamespaces(servers: string[]): Map<string, Set<string>> {
  const groups = Map.groupBy(servers, baseNamespace);
  const candidates = new Map([...groups.keys()].map(base => [base, new Set([base])]));
  // The SDK returns sorted names, but the runtime assigns suffixes in declaration order.
  // A collision can also push a server whose own base is a suffix of the first collision.
  // Allow one extra suffix because truncation can make a candidate equal its own base.
  const occupied = new Set<string>();
  const colliding = new Set<string>();
  do {
    const previous = occupied.size;
    for (const [base, group] of groups) {
      if (colliding.has(base) || (group.length === 1 && !occupied.has(base))) continue;
      colliding.add(base);
      for (let n = 2; n <= servers.length + 1; n += 1) {
        const suffix = `-${n}`;
        const name = base.slice(0, 30 - suffix.length) + suffix;
        candidates.get(base)!.add(name);
        occupied.add(name);
      }
    }
    if (occupied.size === previous) break;
  } while (true);
  return new Map(servers.map(server => [server, candidates.get(baseNamespace(server))!]));
}

function overlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + "__") || b.startsWith(a + "__");
}

function stableNamespaces(inventories: string[][]): Record<string, string> {
  const byWorkspace = inventories.map(possibleNamespaces);
  return Object.fromEntries([...(byWorkspace[0] ?? [])].flatMap(([server, names]) => {
    if (names.size !== 1) return [];
    const [name] = names;
    if (overlap(name, "mcp") || overlap(name, "openclaw")) return [];
    const stable = byWorkspace.every(workspace => workspace.get(server)?.size === 1
      && [...workspace].every(([other, candidates]) => other === server || ![...candidates].some(candidate => overlap(name, candidate))));
    return stable ? [[server, name]] : [];
  }));
}

function shorten(value: string, limit: number): string {
  if (value.length <= limit) return value;
  // Do not split a surrogate pair, which the gateway's display sanitizer would escape.
  return value.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

function words(value: string): string {
  const text = value.replace(/[\p{C}\s_-]+/gu, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Argument names whose values never reach a card: credentials by any common name. */
const CREDENTIAL_FIELD = /token|passw|passphrase|passcode|secret|credential|auth|key|cookie|bearer|signature|session|verif|code(?:$|[_-])|(?:^|[_-])(?:otp|pin|pwd|pass)(?:$|[_-])/i;

/** Twenty or more letters and digits mixed, with no word break: a key, a hash or an id, not prose. */
const TOKEN_LIKE = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g;

/** Bounded preview for a card, alert and approval history. Skip nested inputs and credential fields. */
function argumentPreview(params: Record<string, unknown>): string[] {
  const preview: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (!/^[a-z0-9_-]{1,50}$/i.test(key) || CREDENTIAL_FIELD.test(key)) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    // A link shows where it points, never its sign-in or its query, where a signed URL keeps its key.
    const text = String(value).replace(/[\p{C}\s]+/gu, " ").trim()
      .replace(/(\bhttps?:\/\/)[^\s\/@]*@/gi, "$1").replace(/(\bhttps?:\/\/[^\s?#]*)[?#]\S*/gi, "$1")
      // Nor a run that reads as a token wherever it sits, such as a webhook's last path segment.
      .replace(TOKEN_LIKE, "…");
    if (!text) continue;
    preview.push(`${words(key.slice(0, 22))}: ${shorten(text, 80)}`);
    if (preview.length === 4) break;
  }
  return preview;
}

export function registerConnectorApprovals(api: OpenClawPluginApi, load: LoadInventories = loadInventories): boolean {
  const config = api.runtime.config;
  if (typeof config?.current !== "function" || typeof config.mutateConfigFile !== "function") return false;
  api.registerReload?.({ noopPrefixes: [CONFIG_PATH] });
  api.registerGatewayMethod("clawy.connectors.namespaces", async ({ respond }) => {
    const inventories = await load(config.current()).catch(() => []);
    respond(true, { namespaces: stableNamespaces(inventories) });
  }, { scope: "operator.read" });

  api.on("before_tool_call", async (event, ctx) => {
    const rawName = event.toolName;
    if (!rawName.includes("__")) return;
    const current = config.current();
    const entries = current.plugins?.entries?.[PLUGIN_ID]?.config?.connectorAsks ?? {};
    const agent = ctx.agentId ?? /^agent:([^:]+):/.exec(ctx.sessionKey ?? "")?.[1];
    const ask = agent ? asks(current, agent) : undefined;
    const rules = agent ? (ask ? [ask] : []) : Object.values(entries);
    const protectedServers = new Set(rules.flatMap(rule => Object.keys(rule)));
    if (protectedServers.size === 0) return;

    const name = rawName.replace(/^mcp__(?:openclaw__)?/, "");
    const names = [...new Set([rawName, name])].map(value => ({ value, normalized: value.toLowerCase() }));
    const inventories = await load(current, agent).catch(() => []);
    if (inventories.length === 0) {
      if (name.includes("__")) {
        return { block: true, blockReason: "The gateway couldn't identify this tool's connector for approval." };
      }
      return;
    }
    const matches = new Map<string, string>();
    for (const inventory of inventories) {
      for (const [server, candidates] of possibleNamespaces(inventory)) {
        for (const name of names) {
          const prefix = [...candidates].find(candidate => name.normalized.startsWith(candidate + "__"));
          if (prefix) matches.set(server, name.value.slice(prefix.length + 2));
        }
      }
    }
    const server = [...matches.keys()].find(id => protectedServers.has(id));
    if (server === undefined) return;
    if (!agent || !ask) {
      return { block: true, blockReason: "This connector requires approval, but the gateway didn't identify the calling agent." };
    }
    if (matches.size !== 1) {
      return { block: true, blockReason: "This connector requires approval, but its tool name matches more than one server." };
    }

    const revision = ask[server];
    const tool = matches.get(server)!;
    const title = shorten(words(server), 70);
    return {
      requireApproval: {
        title: `Use ${title}?`,
        description: [shorten(words(tool), 80), ...argumentPreview(event.params)].join("\n"),
        severity: "warning",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        timeoutMs: 600_000,
        pluginId: PLUGIN_ID,
        async onResolution(decision) {
          if (decision !== "allow-always" || asks(config.current(), agent)?.[server] !== revision) return;
          await config.mutateConfigFile({
            base: "source",
            afterWrite: { mode: "auto" },
            mutate(draft) {
              // A settings edit or second approval may have won while this card was open.
              const latest = asks(draft, agent);
              if (latest?.[server] === revision) delete latest[server];
            },
          });
        },
      },
    };
  });
  return true;
}
