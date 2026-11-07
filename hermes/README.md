# Clawy notifications for Hermes

A standalone Hermes Agent plugin that chooses alerts locally, seals each to a device's P-256 key, and sends ciphertext to that device's forwarder. Tested against Hermes `v0.22.7` and `v0.23.0`. MIT licensed. Uses Hermes's pinned `cryptography`, Python's standard library, and the API server's existing `aiohttp`; adds no dependencies.

## Audit it

- `__init__.py` registers three observers, four authenticated HTTP routes under `/v1/clawy/` (status, register, unregister, test) and one CLI command. It receives final reply text, turn outcomes and redacted approval/question prompts. It neither reads transcript files nor registers an LLM tool. `post_llm_call` also supplies history and the user prompt, which this plugin ignores.
- `seal.py` implements RFC 8291 `aes128gcm`. Every padded plaintext is exactly 2048 bytes, including the final-record delimiter; every sealed body is 2150 bytes (2867 unpadded base64url characters). Oversize bodies are shortened on character boundaries with `…`. Oversize routing metadata is dropped, never truncated into a different route.
- `delivery.py` stores registrations at `$HERMES_HOME/clawy-notifications.json` and the last sequence number at `$HERMES_HOME/clawy-notifications.sequence`, both atomically replaced with mode `0600`, under a cross-process lock. A registration replaces its id. The file contains the forward URL/token, public key, auth secret, display name and text preference. It contains no device private key or notification history.
- Only `{"kind":"alert|silent","sealed":"…"}` and a bearer token leave for the registered URL. The forwarder learns a device, timing and alert versus silent. `text: false` removes `body` before sealing. TLS is required except for numeric loopback addresses used by tests. Redirects and environment proxies are disabled.
- One daemon worker posts outside hooks: a 64-event memory queue, five-second HTTP timeout, one retry for `502`, no other retries. `401` and `410` remove that exact registration, preserving a later replacement. A `404` says nothing about the device, so it stays. `400`/`413` log a generic bug warning; `429` drops without retry. Logs never include content, commands, URLs, tokens, keys or exception text.

Delivery is best effort. Queue overflow, process exit, offline delivery and timeouts can lose a notification. There is no durable outbox or replay after restart. Devices persist until replaced or rejected by the forwarder. App reply text waits in memory for its turn-end hook, at most 128 turns and 2048 characters each. The daemon attempts to finish queued work on normal unload; process exit need not drain it.

## Routing and Hermes limits

`post_llm_call` captures `assistant_response`; canonical `on_session_end` decides whether the turn completed, failed or was interrupted. Interrupted turns and reduced legacy exit events send nothing. Session keys are `agent:<profile>:<session_id>`, default profile `default`.

App sessions (`ios-native-`, `dashboard:`) alert with their reply. `main`, heartbeat, `cron:`, legacy `cron_` and `subagent:` replies send nothing. Other sessions produce silent `refresh`. Clawy shows only `api_server` topics on Hermes, so nothing uses these refreshes yet.

`on_human_input_request` alerts for `approval` and `clarify`, from any session, with `hermes:<request_id>` ids. Sudo prompts are ignored. `on_human_input_resolved` and `post_approval_response` exist; resolved requests send nothing, so this plugin does not subscribe. `pre_approval_request` is not used because the human-input hook also covers questions and provides consistently redacted prompts.

**The human-input hook's request id differs from the `/v1/runs` control id.** A client must resolve the current pending control in that session; it cannot send the sealed id verbatim to the approval/clarify REST endpoint. This is the same limitation as Hermes's plaintext outbound webhook.

For cron agent turns, `on_session_end(failed=True)` plus `ctx.current_cron_execution().job_id` produces `task-failed`. Success is silent. There is no general scheduler-failure hook: failures before agent construction, script-only (`no_agent`) jobs, delivery errors, and a worker killed before finalization cannot reliably alert. The plugin does not poll the jobs database or monkeypatch the scheduler.

## Register without a model seeing secrets

On the API listener's own profile, Clawy POSTs the protocol's registration JSON directly to `/v1/clawy/devices`, with `Authorization: Bearer <profile-api-key>`. Success is `200 {"ok":true}`; invalid registrations are `400`, oversized ones `413`, missing or invalid API keys `401`. The route explicitly calls the API adapter's authentication check, as custom routes aren't authenticated automatically. No registration secret reaches a chat, tool result or log. Protect the device-to-Hermes connection with HTTPS outside loopback.

Hermes `v0.22.7` places its `/p/{profile}/…` catch-all before custom plugin routes, so this endpoint is unavailable to multiplexed sibling profiles. Run the CLI in that profile's home instead:

```sh
hermes clawy-notifications add < /secure/path/device-registration.json
```

Passing the JSON as an argument also works, but it exposes the token and auth secret to shell history.

## Install

See the [README](../README.md#install). Use Hermes's default `plugins.isolation: in_process`: hosted plugins can't register native platform handlers, and the HTTP route depends on that API. Enabling may live-reload hooks, but a restart is required to mount the route before aiohttp freezes its router. Hermes refuses a restart during live turns, so restart after they finish.

## Test

In an environment with `cryptography` and `aiohttp`, from this directory:

```sh
python -m unittest
```

The tests open a loopback HTTP server. The receiver is a separate HMAC/HKDF implementation that checks all 2048 padded bytes and the 2150-byte envelope, truncation, fresh sender randomness, text opt-out, routing, response handling, private storage and stale-removal races. `test/contract/hermes.mjs` at the repository root installs this plugin on a real Hermes.

## What could break between Hermes releases

The contract test runs nightly against the newest release and checks the hook names, the private adapter methods and the routes. A turn needs a model, so it can't check the rest. On a failure, or a new release, reread `agent/turn_finalizer.py`, `tools/human_input_hooks.py`, `hermes_cli/plugins_dispatch.py`, `gateway/platforms/api_server.py` and `cron/execution_identity.py`. This plugin depends on the hook kwargs, their order and copied cron context, `ctx.profile_name`, `ctx.current_cron_execution()`, platform-handler wiring and CLI argument setup. Its route uses the private adapter methods `_check_auth` and `_expected_api_key`, and a rename must fail closed. Hook dispatch waits for callbacks, which is why nothing here does network work inside a hook.
