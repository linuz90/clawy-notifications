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
