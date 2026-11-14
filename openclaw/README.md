# Clawy notifications for OpenClaw

Decides on your own gateway what should alert you, seals it to a key held on your device, and hands the ciphertext to Clawy's forwarder. The forwarder holds Apple's push key and nothing that opens your alerts. The wire format is in [`PROTOCOL.md`](../PROTOCOL.md).

## Audit it

No runtime dependencies beyond OpenClaw and Node.

| File | What it does |
| --- | --- |
| `route.ts` | The whole policy: what alerts, what's silent, what sends nothing |
| `seal.ts` | RFC 8291 `aes128gcm`, on Node's own crypto |
| `devices.ts` | The devices registered here, in one `0600` file |
| `index.ts` | Wires those to the gateway's events, and sends |
| `activity.ts` | Generic lifecycle state, target qualification, timers and bounded forwarding |

`dist/` is `build.mjs`'s output: these same files with the types stripped, line for line.

**What it reads:**

- Native run start/end/error and explicit helper-spawn signals, including the reply's text, from `api.runtime.events.onAgentEvent`.
- Approval requests and resolutions, including the command, over the SDK's approvals client (`operator.approvals`).
- Questions and resolutions, over an operator client signed in with this gateway's own token or password (`operator.questions`), resolved the way the gateway resolves them, secret references included.
- Failed scheduled tasks, from the `cron_changed` hook.
- An automation's post, from `api.runtime.events.onSessionTranscriptUpdate`: every message committed to a transcript passes through it, and it acts only on one carrying `openclawAutomation`, a scheduled task's result committed into a chat, which no run of that chat announces.

It needs no `allowConversationAccess`, and it reads no transcript history. That grant isn't a sandbox, though: a plugin runs inside your gateway, and this one sees reply text without it. What keeps it honest is that you can read what it does with it.

**What it sends:** `{"kind": "alert" | "silent", "sealed": "…"}` and a bearer token, to one host, fixed in `devices.ts`. A device can't register any other URL, and redirects are refused. Optional Live Activities send only the generic public lifecycle fields defined in [the protocol](../PROTOCOL.md#live-activities-version-2), to the same fixed host's separate activity route. A device that turned off message text gets no `title` or `body`, sealed or not. It logs no text, commands, tokens or keys.

**What it keeps:** the registered devices in `clawy-notifications/devices.json` and the last sequence number in `clawy-notifications/sequence`, both `0600`, in the gateway's state directory. It keeps the last delivery's number, answer and time per device in memory, for `status`. No message text. Activity registrations persist with the device; active lifecycle state and timers stay in memory and end at eight hours.

**What it adds to your gateway:** the methods `clawy.notifications.status` (`operator.read`) and `.register`, `.unregister`, `.test` (declared at `operator.write`). Registering or removing a device takes `operator.approvals` and `operator.questions`, or `operator.admin`, as a device then gets every alert. That suits a gateway with one owner.

## What could break between OpenClaw releases

`test/contract/openclaw.mjs` runs nightly against the newest release. These aren't promises of OpenClaw's, so they're what to look at when it fails:

- Native lifecycle identities, millisecond startedAt, terminal aborted/yielded flags and error phase; activity tests drive the actual observer wiring without calling a model.
- The reply text, from the `terminalReply` field of a run's `lifecycle` end event. The contract test can only check that it's still in the SDK's types, since a real turn needs a model.
- An automation's post: `onSessionTranscriptUpdate` publishing the committed message with its chat's key and a `messageId`, and `openclawAutomation` marking it. The contract test checks both names are still there; the shape was read from OpenClaw `2026.10.7`'s `commitBackgroundResultToSession` and `publishTranscriptTurnUpdate`.
- `createOperatorApprovalsGatewayClient`, and a backend `GatewayClient` connecting without pairing on loopback.
- `registerGatewayMethod` and the `cron_changed` hook.

## Device tools

The plugin also owns Clawy's fixed `clawy_iphone_*`, `clawy_ipad_*` and `clawy_mac_*` tools ([device-tools.ts](device-tools.ts)). Their names and schemas stay the same when devices disconnect or sharing changes. Each call resolves a connected Clawy node in that family, then uses OpenClaw's canonical `node.invoke`: gateway command approval and the device's sharing and per-agent checks still apply. Multiple matching devices require an explicit `nodeId`; calls never retry on another device. No connected device returns an instruction to open Clawy.

These tools need the updated app on every sharing device. Older apps still publish dynamic node tools, which OpenClaw renames alongside the fixed copies and can still reset a native Claude conversation. The first plugin/app upgrade changes the catalog once; a host that refuses transcript replay may lose native context on that transition. This plugin does not change host authentication or replay configuration. `clawy.devices.status` (`operator.read`) advertises protocol 2: the fixed catalog routes both native Mac clients and older iOS-tagged Mac clients. Mac sharing requires protocol 2; iPhone and iPad also accept protocol 1.

The catalog contains 28 tools (10 each for iPhone and iPad, eight for Mac), even for device families and sources not in use. This fixed set avoids resets when another device is paired; source grants still decide what each call may read or change. Device tools use plugin policy id `clawy-notifications`, not the dynamic-node `clawy` id or `gateway.nodes.pluginTools.enabled`.
