# Moonstone notifications for OpenClaw

Decides on your own gateway what should alert you, seals it to a key held on your device, and hands the ciphertext to Moonstone's forwarder. The forwarder holds Apple's push key and nothing that opens your alerts. The wire format is in [`PROTOCOL.md`](../PROTOCOL.md).

## Audit it

No runtime dependencies beyond OpenClaw and Node.

| File | What it does |
| --- | --- |
| `route.ts` | The whole policy: what alerts, what's silent, what sends nothing |
| `seal.ts` | RFC 8291 `aes128gcm`, on Node's own crypto |
| `devices.ts` | The devices registered here, in one `0600` file |
| `index.ts` | Wires those to the gateway's events, and sends |
| `activity.ts` | Generic lifecycle state, target qualification, timers and bounded forwarding |
| `connector-approvals.ts` | Asks before an agent uses a connector set to Ask Every Time |
| `credentials.ts` | Config SecretRef locations, the 1Password plugin's rules, and 1Password vault and item metadata |

`dist/` is `build.mjs`'s output: these same files with the types stripped, line for line.

**What it reads:**

- Native run start/end/error and explicit helper-spawn signals, including the reply's text, from `api.runtime.events.onAgentEvent`.
- Approval requests and resolutions, including the command, over the SDK's approvals client (`operator.approvals`).
- Questions and resolutions, over an operator client signed in with this gateway's own token or password (`operator.questions`), resolved the way the gateway resolves them, secret references included.
- Failed scheduled tasks, from the `cron_changed` hook.
- MCP call names and the calling agent in `before_tool_call`. When a rule asks, the approval shows a short preview of scalar arguments. The preview omits nested objects, fields named like a credential or a code, a link's sign-in and query, and any run that reads as a token.
- An automation's post, from `api.runtime.events.onSessionTranscriptUpdate`: every message committed to a transcript passes through it, and it acts only on one carrying `openclawAutomation`, a scheduled task's result committed into a chat, which no run of that chat announces.
- A message posted with `chat.inject` (a script telling you a job is done, say), from the same listener: an assistant message from `provider: openclaw`, `model: gateway-injected`, with no `idempotencyKey` or `openclawAbort`. Those two mark the gateway's other injected rows (a slash command's reply, a run's mirrored reply, a stopped reply's partial), whose run or send already covers them. No run announces an injected message, and OpenClaw's own Web Push skips it, so without the plugin nothing alerts.

It needs no `allowConversationAccess`, and it reads no transcript history. That grant isn't a sandbox, though: a plugin runs inside your gateway, and this one sees reply text without it. What keeps it honest is that you can read what it does with it.

**What it sends:** `{"kind": "alert" | "silent", "sealed": "…"}` and a bearer token, to one host, fixed in `devices.ts`. A device can't register any other URL, and redirects are refused. Optional Live Activities send only the generic public lifecycle fields defined in [the protocol](../PROTOCOL.md#live-activities-version-2), to the same fixed host's separate activity route. A device that turned off message text gets no `title` or `body`, sealed or not. It logs no text, commands, tokens or keys.

**What it keeps:** the registered devices in `moonstone/devices.json` and the last sequence number in `moonstone/sequence`, both `0600`, in the gateway's state directory. It keeps the last delivery's number, answer and time per device in memory, for `status`. No message text. Activity registrations persist with the device; active lifecycle state and timers stay in memory and end at eight hours.

**What it adds to your gateway:** the methods `moonstone.notifications.status` (`operator.read`) and `.register`, `.unregister`, `.test` (declared at `operator.write`). Registering or removing a device takes `operator.approvals` and `operator.questions`, or `operator.admin`, as a device then gets every alert. That suits a gateway with one owner.

## What could break between OpenClaw releases

`test/contract/openclaw.mjs` runs nightly against the newest release. These aren't promises of OpenClaw's, so they're what to look at when it fails:

- Native lifecycle identities, millisecond startedAt, terminal aborted/yielded flags and error phase; activity tests drive the actual observer wiring without calling a model.
- The reply text, from the `terminalReply` field of a run's `lifecycle` end event. The contract test can only check that it's still in the SDK's types, since a real turn needs a model.
- An automation's post: `onSessionTranscriptUpdate` publishing the committed message with its chat's key and a `messageId`, and `openclawAutomation` marking it. The contract test checks both names are still there; the shape was read from OpenClaw `2026.10.7`'s `commitBackgroundResultToSession` and `publishTranscriptTurnUpdate`.
- A `chat.inject` message: the row `appendInjectedAssistantMessageToTranscript` writes (`model: gateway-injected`, no `idempotencyKey`), as `2026.10.7` and `2026.11.3` write it. If a release starts giving it a send key, injected messages stop alerting.
- `createOperatorApprovalsGatewayClient`, and a backend `GatewayClient` connecting without pairing on loopback.
- The turn OpenClaw 2026.11.10 starts in a chat when a job made there fails: its prompt row, published by `onSessionTranscriptUpdate`, is a `user` message with `provenance.sourceTool: cron_failure_repair` naming the job as "(id <job>)" (`buildCronFailureRepairBrief`), and `runtime.version` says the gateway is that new ([failures.ts](failures.ts)). If a release renames either, a failed task alerts 90 s late, as well as the agent's reply.
- `registerGatewayMethod` and the `cron_changed` hook. The owner-only `moonstone.tools.status` method checks gog with fixed arguments and a short timeout. It reads account names from an explicitly configured file keyring only, with the services each was signed in for and whether its scopes only read, where gog can open the sign-in (`GOG_KEYRING_PASSWORD` in the gateway's environment); never a scope list, token or error. Keychain and auto selection may prompt on the gateway computer, so those configurations leave account status unknown.
- Embedded MCP and Claude's loopback bridge pass `<safe-server>__<tool>` to `before_tool_call`. Direct Claude MCP uses the `mcp__` wrapper. OpenClaw 2026.11.3 keeps ASCII letters, digits, underscores and hyphens in the server prefix, replaces other characters with hyphens, prefixes non-letter starts with `mcp-`, and clips the result to 30 characters. Colliding prefixes get numeric suffixes in declaration order. The SDK's `loadAgentHarnessMcpConfig` enumerates declarations from config and enabled plugins in each workspace. It returns sorted names, so Moonstone offers levels only for prefixes that stay distinct under all possible orders. The hook blocks an ambiguous call when it could match an existing ask rule.
- Hook approvals rely on `requireApproval.onResolution`, the approval owner's ID on the event, and `runtime.config.current` and `mutateConfigFile` for access changes.
- `registerGatewayMethod` and the `cron_changed` hook.
- The bundled 1Password plugin keeps its service account token in `credentials/onepassword/service-account-token` under the gateway's state directory, and checks `op` with `plugin-sdk/secret-ref-runtime`'s `resolveTrustedExecutablePath`. The metadata list uses the JSON fields from `op vault list` and `op item list`, including `additional_information`, `urls[].href` and `updated_at`.
- `config.get` redacts sensitive SecretRef IDs and the whole `plugins.entries.onepassword` entry (its name matches the redactor's `/password/` rule). Credentials reads the gateway's source config snapshot in-process (`plugin-sdk/runtime-config-snapshot`), where the references are still intact before resolution, and the 1Password plugin's `items` registry shape (`{item, vault?, field?, policy?, description?}` per slug), which Moonstone also writes.

## Device tools

The plugin also owns Moonstone's fixed `moonstone_iphone_*`, `moonstone_ipad_*` and `moonstone_mac_*` tools ([device-tools.ts](device-tools.ts)). Their names and schemas stay the same when devices disconnect or sharing changes. Each call resolves a connected Moonstone node in that family, then uses OpenClaw's canonical `node.invoke`: gateway command approval and the device's sharing and per-agent checks still apply. Multiple matching devices require an explicit `nodeId`; calls never retry on another device. No connected device returns an instruction to open Moonstone.

These tools need the updated app on every sharing device. Older apps still publish dynamic node tools, which OpenClaw renames alongside the fixed copies and can still reset a native Claude conversation. The first plugin/app upgrade changes the catalog once; a host that refuses transcript replay may lose native context on that transition. This plugin does not change host authentication or replay configuration. `moonstone.devices.status` (`operator.read`) advertises protocol 2: the fixed catalog routes both native Mac clients and older iOS-tagged Mac clients. Mac sharing requires protocol 2; iPhone and iPad also accept protocol 1.

The catalog contains 28 tools (10 each for iPhone and iPad, eight for Mac), even for device families and sources not in use. This fixed set avoids resets when another device is paired; source grants still decide what each call may read or change. Device tools use plugin policy id `moonstone`, not the dynamic-node `moonstone` id or `gateway.nodes.pluginTools.enabled`.

## Connector approvals

For an agent set to Ask Every Time, the plugin sends an OpenClaw plugin approval before that agent calls the connector. The hook checks `plugins.entries.moonstone.config.connectorAsks` in the current runtime config on each call. The plugin declares that path needs no reload. Allow runs the call once, Deny stops it, and Always Allow removes that agent's matching ask rule so future calls can proceed. Codex uses its own MCP approvals. See [the wire contract](../PROTOCOL.md#connector-approvals-openclaw).
## Credentials

`moonstone.credentials.status` (`operator.admin`) answers what `config.get` hides from a client and no gateway method lists, for Moonstone's Credentials page: which settings use a SecretRef, with IDs for store and environment references (names, not values); the bundled 1Password plugin's rules (each slug's item, vault, field, policy and description, and whether the gateway's own plugin settings block it), since `config.get` redacts that plugin's whole entry, so Moonstone can change a rule with `config.patch`; and, with that plugin's token file, the vaults and item metadata the service account can read (title, category, sites, a login's username, a card's last four digits). It also says where that token file goes, and with no token yet whether `op` is missing or fails the trust check, for Moonstone's steps to connect 1Password. The token goes only to an `op` that passes OpenClaw's own trust check, as the bundled plugin's does (`pluginSecretRefSetup.resolveTrustedExecutablePath`). It never runs `op item get` or `op read` and never returns secret values. The 1Password listing is cached for 60 seconds; pass `refresh: true` to refresh it immediately.
