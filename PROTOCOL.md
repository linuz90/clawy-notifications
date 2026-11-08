# Clawy sealed push, version 2

What a plugin on someone's own gateway sends so that Clawy's forwarder and Apple can't read a notification. Both plugins implement this. The forwarder's code is private, so this document is its contract.

## Parties

- **Device:** generates a P-256 key pair and a 16-byte auth secret, and keeps the private key in its Keychain. It registers with the forwarder for a device id and a forward token.
- **Plugin:** runs on the gateway. It decides what alerts, seals it to the device's key, and posts the result to the forwarder.
- **Forwarder:** holds Apple's push key. It checks the token and hands the sealed bytes to APNs. It has no key that opens them.

## Device registration

The app gives the plugin one JSON object per device:

```json
{
  "v": 2,
  "id": "relay device id",
  "name": "Clawy on iPhone",
  "forwarder": "https://relay.example/v1/forward/<id>",
  "token": "bearer token for that URL",
  "p256dh": "base64url, 65-byte uncompressed P-256 public key",
  "auth": "base64url, 16 bytes",
  "text": true
}
```

`text: false` means this device asked for no message text: the plugin leaves `title` and `body` out of every alert it seals for it, and the alert stays generic unless the device can reach the gateway.

`forwarder` must be exactly `<origin>/v1/forward/<id>`, where the plugin fixes the origin, so whoever can register a device can't aim the gateway at another host. A test sets `CLAWY_FORWARDER_ORIGIN`.

Registering an `id` again replaces that device. A device gets every approval and every question, so on OpenClaw registering or removing one takes `operator.approvals` and `operator.questions`, or `operator.admin`.

The forwarder hands out the `id`, so a device refuses one it has already seen: it would otherwise overwrite another gateway's key.

## Sealing

The plaintext is UTF-8 JSON:

```json
{
  "v": 2,
  "seq": 1794006306974,
  "kind": "reply | approval | question | task-failed | refresh",
  "title": "optional",
  "body": "optional",
  "sessionKey": "agent:<agent>:<rest>",
  "agentId": "<agent>",
  "approvalId": "for an approval",
  "questionId": "for a question",
  "jobId": "for a failed job",
  "truncated": "true when body was shortened",
  "test": "for a test alert, the nonce the device asked with"
}
```

The device reads only these fields, and takes the device id from the push it opened with, so a message can't name another gateway. On a gateway using this route it trusts nothing outside the seal: a push that doesn't open shows a bare placeholder and carries no actions. An approval whose text is missing or shortened offers no Allow. For an exec approval the text is the command, and for a plugin approval it's the title and description, each trimmed, on two lines: Allow compares it byte for byte with what's pending.

A `refresh` only counts as a silent push, and anything else only as an alert. A device that opens a push writes a receipt beside it, a code only it can make, and from then on acts only on a push with a receipt. So a push that reaches the screen without going through the device's notification extension can show words of its own, but a tap on it does nothing and it offers nothing that works.

It is encrypted with Web Push's `aes128gcm` (RFC 8291 over RFC 8188): a fresh ephemeral P-256 key and 16-byte salt per message, one record, record size 4096, the 65-byte ephemeral public key as the key id.

**Replay:** `seq` stops anyone who kept a sealed body, or who holds Apple's key, from showing it again. It's an integer that only ever goes up across everything a plugin sends: milliseconds since 1970, or the last number plus one if that's higher, kept on disk so a clock set back can't repeat a number. Hermes profiles share one sequence file and lock at the Hermes root because the same recipient can be registered in several profiles. A device remembers the highest `seq` it has opened and every number within ten minutes behind it, starting when it makes its key. It opens a number once, and treats one it has seen, one further behind than that, a message with no `seq`, or a key with no such record, as a push that doesn't open. Ten minutes leaves room for pushes arriving out of order; nothing compares `seq` with the device's clock, so a gateway's wrong clock costs nothing. A retry sends the same sealed body, and the same `seq`.

**Padding:** every message's padded plaintext, the JSON plus the `0x02` delimiter plus zeros, is exactly **2048 bytes**. So every sealed body is 2150 bytes, 2867 in base64url, whatever it says. Shorten `body` until the JSON fits in 2047 bytes, cutting on a character boundary, ending with `…`, and setting `truncated`.

## Forwarding

```
POST <forwarder>
Authorization: Bearer <token>
Content-Type: application/json

{"kind": "alert" | "silent", "sealed": "<base64url>"}
```

`kind` is `silent` for a `refresh`, and `alert` for everything else. That one word is all the forwarder learns about what happened.

The forwarder accepts a sealed body of exactly 2867 base64url characters and nothing else, so nothing a sender writes reaches a screen. It allows 60 pushes a minute per device, counted after the token check, so nobody else can spend a device's allowance. It keeps the token only as a hash. It keeps no record of a delivery: nothing in storage or logs, failures included. It sends an alert to Apple as "Clawy / New notification" with `mutable-content`, and a silent push as a background push at priority 5. The sealed body and device id ride beside them, untouched.

| Answer | Meaning | Plugin does |
| --- | --- | --- |
| 200 | Apple accepted it | Nothing |
| 202 | Taken and not sent: the device muted this gateway, as it isn't the one in use there | Nothing; the device reads no fault into it |
| 401, 410 | Bad token, or the device is gone | Removes the device |
| 404 | No such route on this forwarder | Keeps the device: it says nothing about it |
| 413, 400 | Malformed | Logs it, a bug |
| 429 | Over the device's rate limit | Drops this push, honoring `Retry-After` if it retries |
| 502 | APNs refused or failed | May retry once |

## Health

A plugin answers its status call (OpenClaw `clawy.notifications.status`, Hermes dashboard `GET /api/plugins/clawy-notifications/status?profile=<profile>`, legacy API server `GET /v1/clawy/status`) with:

```json
{
  "version": "0.2.0",
  "protocol": 2,
  "listening": { "approvals": true, "questions": true },
  "devices": [
    { "id": "relay device id", "name": "Clawy on iPhone", "text": true,
      "delivery": { "seq": 1794006306974, "status": 200, "at": 1794006307100 } }
  ]
}
```

`protocol` is the version of this document. A device tells someone to update a plugin older than it needs. `listening` is what the plugin has signed in to, where it signs in to anything: left out, it has nothing that can drop. `delivery` is the last alert (never a `refresh`, which iOS may drop as it likes) sent to that device: its `seq`, the forwarder's answer or 0 for no answer, and when. The device compares that `seq` with the newest alert it has shown to tell one that never arrived. OpenClaw keeps it in memory, so a restart forgets it. Hermes keeps only this latest delivery metadata per device in its locked private files, shared between the turn worker and the dashboard plugin host.

The device says when any of this looks wrong, and it never moves to another route by itself: someone who chose a plugin chose not to trust the relay.

## Routing

A plugin applies these, where `rest` is the session key after `agent:<agent>:`:

- On OpenClaw, a reply in an app topic (`rest` starts `ios-native-` or `dashboard:`) is an alert. On Hermes, the stored session source must be `clawy` (the hooks expose it as `platform`); legacy `ios-native-` ids also alert. Hermes's `dashboard:` prefix alone no longer means a Clawy chat.
- A reply in `main`, or where `rest` ends `:heartbeat` or starts `cron:` or `subagent:`, sends nothing.
- A reply anywhere else is a `refresh`, so a device following that session can read it in the background.
- An approval or a question alerts from any session. An answered one sends nothing.
- A failed scheduled task alerts, with `jobId`.
