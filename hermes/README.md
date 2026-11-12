# Clawy notifications for Hermes

A standalone Hermes Agent plugin that chooses alerts locally, seals each to a device's P-256 key, and sends ciphertext to that device's forwarder. Tested against Hermes `v0.22.7` and `v0.23.0`. MIT licensed. Uses Hermes's pinned `cryptography`, Python's standard library, the API server's existing `aiohttp`, and the dashboard's existing FastAPI; adds no dependencies.

## Audit it

- `__init__.py` registers lifecycle and human-input observers, four legacy API-server routes under `/v1/clawy/` and one CLI command. `dashboard/plugin_api.py` adds status, register, unregister and test under `/api/plugins/clawy-notifications/`, behind the dashboard's authentication and profile gates. It resolves the current observer through Hermes's private `get_plugin_manager()._plugins` registry, failing closed if it is absent, disabled or unloaded. It receives final reply text, turn outcomes and redacted approval/question prompts. It registers no LLM tool. `cron.py` reads session identity and appends cron completion notes to Hermes's state database. `post_llm_call` also supplies history and the user prompt, which this plugin ignores.
- `seal.py` implements RFC 8291 `aes128gcm`. Every padded plaintext is exactly 2048 bytes, including the final-record delimiter; every sealed body is 2150 bytes (2867 unpadded base64url characters). Oversize bodies are shortened on character boundaries with `…`. Oversize routing metadata is dropped, never truncated into a different route.
- `delivery.py` stores registrations at `$HERMES_HOME/clawy-notifications.json` one sequence file at `<Hermes root>/clawy-notifications.sequence` shared across profiles, and the latest delivery sequence/status/time per device at `$HERMES_HOME/clawy-notifications.deliveries`, atomically replaced with mode `0600`, under a cross-process lock. Delivery health is shared with dashboard routes hosted in another process, survives restart, and ignores late answers for replaced registrations. The root sequence lock prevents two profiles sending the same replay number to one device. A registration replaces its id. The file contains the forward URL/token, public key, auth secret, display name, text preference and optional followed activity registration. It contains no device private key or notification history.
- Ordinary notifications send only `{"kind":"alert|silent","sealed":"…"}` and a bearer token to the registered URL. The forwarder learns a device, timing and alert versus silent. `text: false` removes `body` before sealing. TLS is required except for numeric loopback addresses used by tests. Redirects and environment proxies are disabled.
- One daemon worker posts outside hooks: a 64-event memory queue, five-second HTTP timeout, one retry for ordinary `502` responses. `401` and `410` remove that exact registration, preserving a later replacement. A `404` says nothing about the device, so it stays. `400`/`413` log a generic bug warning; `429` drops without retry. Logs never include content, commands, URLs, tokens, keys or exception text.

Delivery is best effort. Queue overflow, process exit, offline delivery and timeouts can lose a notification. The push queue has no replay after restart; cron transcript delivery has a separate durable inbox. Devices persist until replaced or rejected by the forwarder. App reply text waits in memory for its turn-end hook, at most 128 turns and 2048 characters each. The daemon attempts to finish queued work on normal unload; process exit need not drain it.

## Routing and Hermes limits

`post_llm_call` captures `assistant_response`; canonical `on_session_end` decides whether the turn completed, failed or was interrupted. Interrupted turns and reduced legacy exit events send nothing. Session keys are `agent:<profile>:<session_id>`, default profile `default`.

A session whose hook `platform` is `clawy` alerts with its reply. Hermes derives the agent platform from the stored session source, so this covers server-minted dashboard ids. Legacy `ios-native-` ids still alert. `dashboard:` alone no longer marks a Clawy chat. `main`, heartbeat, `cron:`, legacy `cron_` and `subagent:` replies send nothing. Other sessions produce silent `refresh`, letting Clawy update chats from other surfaces without duplicating their own alerts. Optional activity registrations follow up to four exact sessions per device, a row each; ordinary reply routing stays the same.

`on_human_input_request` alerts for `approval` and `clarify`, from any session, with `hermes:<request_id>` ids. Sudo prompts are ignored. `on_human_input_resolved` updates activity wait counts without an ordinary alert. `pre_approval_request` is not used because the human-input hook also covers questions and provides consistently redacted prompts.

**The human-input hook's request id differs from the `/v1/runs` control id.** A client must resolve the current pending control in that session; it cannot send the sealed id verbatim to the approval/clarify REST endpoint. This is the same limitation as Hermes's plaintext outbound webhook.

A failed job targeting Clawy can produce both its failure-summary note and the existing generic failed-task alert. For cron agent turns, `on_session_end(failed=True)` plus `ctx.current_cron_execution().job_id` produces `task-failed`. Success is silent. There is no general scheduler-failure hook: failures before agent construction, script-only (`no_agent`) jobs, delivery errors, and a worker killed before finalization cannot reliably alert. The plugin does not poll the jobs database or monkeypatch the scheduler.

## Cron results in a Clawy chat

`pre_tool_call` rewrites only `cronjob_manage(action="create")` from source `clawy` with `deliver` omitted or `origin`, to `clawy:<stable session key>`. Explicit `local`, named platforms, mixed targets and jobs from other surfaces stay as requested. Existing jobs are unchanged. Registering this platform also makes Hermes list “Clawy” as connected in agent prompts (including Telegram) and in its delivery-target picker. It has no home channel: an explicit target needs `clawy:<session id>`, and bare `clawy` delivers nowhere. An agent's `send_message` to an explicit Clawy target uses this same note-and-push route, from any surface in the profile. Install and enable this version in each profile that needs chat delivery.

The `clawy` send-only platform receives scheduler output after Hermes's redaction. It accepts only an existing Clawy chat in its own profile. `cron.py` saves each accepted occurrence in `$HERMES_HOME/clawy-cron.db` (mode `0600`), then a worker waits for the target to be idle and appends an `internal_notification` completion note with `display_metadata.clawy_automation: true`. The app renders that user-role model-context row as an automation post. Compression follows the original chat's lineage; a deleted chat is never recreated. Pending text is removed after delivery and survives plugin or process restarts until then.

Each invocation gets a fresh admission ID: recurring jobs with identical output remain separate. Hermes's scheduler queue already prevents replaying a claimed send but does not pass its execution ID to the sender. The saved admission ID makes our own replay after a note write idempotent. A sealed `reply` alert follows the committed note. Each row is removed in its own short transaction; only that remover submits the alert, so competing workers and a later row failing cannot repeat earlier alerts. A crash after the removal can lose its push, never its transcript row. Push remains best effort. Images use Hermes's attachment markers; other attachments name the file saved on the host. The live adapter handles text and media as separate posts; the standalone sender accepts Hermes's `(path, is_voice)` media pairs, including a result with only media.

## Live Activities

`activity.py` holds generic public run state; [`PROTOCOL.md`](../PROTOCOL.md#live-activities-version-2) defines registration, qualification, wait counts, cap and forwarding. `pre_llm_call` supplies the native turn id before model work; `on_session_start` does not. Automatic activity qualification uses the twenty-second time rule alone; the cron tool hook does not affect it, and early-eligibility hints are ignored. A dashboard-only host writes registrations without starting activities; active turn observers refresh the shared file once a second, so background and manual-follow changes cross process boundaries. Terminal activity matching uses a unique exact native turn id within the profile, so a compression segment change cannot strand the original followed activity; ambiguous matches are ignored. Human-input events supply the exact turn-bound session_key separately from the live segment session_id, and activity wait routing uses that supplied alias. New activity traffic contains no conversation text or routing identifiers. Its terminal forwarding makes at most three attempts and never removes ordinary registrations.

## Register without a model seeing secrets

Clawy POSTs the protocol's registration JSON directly to `/api/plugins/clawy-notifications/devices?profile=<profile>`, using its dashboard bearer credential or a local loopback token. Status is `GET /status`, removal `DELETE /devices/<id>`, and Send Test `POST /devices/<id>/test`, under the same prefix and profile query. The dashboard authenticates these routes before plugin dispatch. Success is `200 {"ok":true}`; invalid registrations are `400`, oversized ones `413`, and missing authentication `401`. No registration secret reaches a chat, tool result or log. Protect the connection with HTTPS outside loopback.

Each selected profile owns its registrations and observers. Install and enable the plugin in each selected profile (`hermes -p <profile> plugins install … --enable`), including `default` when selected. Clawy registers the recipient in every selected profile, reads their status and keeps the newest delivery sequence for each device. A missing profile installation means setup is incomplete. Send Test sends once, through the first selected profile.

The old `/v1/clawy/*` routes remain for API-server clients, explicitly checking the listener's profile key. Hermes `v0.22.7` shadows these routes under `/p/<profile>/`; dashboard routes avoid that limitation. CLI registration is also available in the profile's home:

```sh
hermes clawy-notifications add < /secure/path/device-registration.json
```

Passing the JSON as an argument also works, but it exposes the token and auth secret to shell history.

## Install

See the [README](../README.md#install). Use Hermes's default `plugins.isolation: in_process`: hosted plugins can't register native platform handlers, and the legacy HTTP route depends on that API. Dashboard sibling-profile routes may run in Hermes's separate plugin host; their registrations and delivery health use the same locked files as the turn observers. Enabling may live-reload hooks, but a restart is required to mount the route before aiohttp freezes its router. Hermes refuses a restart during live turns, so restart after they finish.

## Test

In an environment with `cryptography` and `aiohttp`, from this directory (FastAPI and httpx, already in Hermes's dashboard environment, also exercise dashboard routes):

```sh
python -m unittest discover -s test
```

Set `CLAWY_HERMES_SOURCE` to a Hermes source checkout and run with its Python environment to include the real scheduler, queued delivery, busy chat, restart and compression contract test. The tests open a loopback HTTP server. The receiver is a separate HMAC/HKDF implementation that checks all 2048 padded bytes and the 2150-byte envelope, truncation, fresh sender randomness, text opt-out, routing, response handling, private storage and stale-removal races. `test/contract/hermes.mjs` at the repository root installs this plugin on a real Hermes.

## What could break between Hermes releases

The contract test runs nightly against the newest release and checks the hook names, the private adapter methods and the legacy API routes. Dashboard registration is also checked live on the launch profile and a sibling; its unit tests cover input bounds and shared delivery health. A turn needs a model, so it can't check the rest. On a failure, or a new release, reread `agent/turn_finalizer.py`, `tools/human_input_hooks.py`, `hermes_cli/plugins_dispatch.py`, `gateway/platforms/api_server.py` and `cron/execution_identity.py`. This plugin depends on the hook kwargs, their order and copied cron context, `ctx.profile_name`, `ctx.current_cron_execution()`, platform-handler wiring and CLI argument setup. The dashboard route also depends on `get_plugin_manager()._plugins`, profile-scoped discovery, and the `LoadedPlugin.module`/`enabled` fields; test authenticated and unauthenticated calls on both the launch profile and a sibling. Its legacy route uses the private adapter methods `_check_auth` and `_expected_api_key`, and a rename must fail closed. Hook dispatch waits for callbacks, which is why nothing here does network work inside a hook.
