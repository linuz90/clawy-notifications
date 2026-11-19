# Clawy notifications, protocol 2

Ordinary notifications are sealed so Clawy's forwarder and Apple cannot read their content. Optional Live Activities use a separate, deliberately public generic lifecycle format. Both plugins implement this contract; sealed notifications remain protocol 2.

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
  "test": "for a test alert, the nonce the device asked with",
  "chosen": "true on a reply the plugin judged by who's using Clawy where (In use elsewhere)"
}
```

The device reads only these fields, and takes the device id from the push it opened with, so a message can't name another gateway. On a gateway using this route it trusts nothing outside the seal: a push that doesn't open shows a bare placeholder and carries no actions. An approval whose text is missing or shortened offers no Allow. For an exec approval the text is the command, for a plugin approval it's the title and description, each trimmed, on two lines, and for a change to the gateway's setup (`openclaw.approval.requested`) it's the request's description as sent: Allow compares it byte for byte with what's pending.

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
| 502 | APNs refused, failed or didn't answer within 4 seconds | Retries once |
| None | A timeout or a dropped connection | Retries once |

A plugin waits at least 5 seconds for an answer. A retry sends the same sealed body and `seq`, so if the first did reach the device, the second can't open there and shows as a bare "Clawy / New notification": a rare extra alert, traded for one that would otherwise be lost.

## Health

A plugin answers its status call (OpenClaw `clawy.notifications.status`, Hermes dashboard `GET /api/plugins/clawy-notifications/status?profile=<profile>`, legacy API server `GET /v1/clawy/status`) with:

```json
{
  "version": "0.3.0",
  "protocol": 2,
  "liveActivities": 2,
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
- On OpenClaw, an automation's post (a message committed with `openclawAutomation`) counts as a reply in the chat it was posted to, by these same rules, once per message.
- A reply anywhere else is a `refresh`, so a device following that session can read it in the background.
- An approval or a question alerts from any session. An answered one sends nothing.
- A failed scheduled task alerts, with `jobId`.


## Muted chats

Plugin version 0.4.6 advertises `mutes: 1` in status. The registration optionally adds `muted`, the chats this device muted: each chat's session key to when its mute ends, in milliseconds since 1970, or `0` for until the person unmutes it. At most 256 chats; omitting it, null or an empty object mutes none. A device sends it only to a plugin that advertises `mutes`, so an older plugin never sees a registration it might refuse.

A guest's session (`agent:<guest>:<rest>-guest-of-<owner>`, where `rest` starts `ios-native-` or `dashboard:`) is muted with its chat, `agent:<owner>:<rest>`. A reply in a muted chat, an automation's post included, is sealed as a `refresh` for that device instead of an alert: its app still reads the reply in the background and marks the chat unread, with no sound or banner. Approvals, questions and failed tasks alert as ever, since they wait on the person. A test alert always alerts. Each device sends its own list, so a chat muted on one device alerts another that hasn't heard yet; the app keeps the lists in step across a person's devices.

## In use elsewhere

From plugin version 0.4.7 on OpenClaw, a reply, an automation's post included, is sealed as a `refresh` instead of an alert for a device while Clawy is in use on another of that person's devices, as in a muted chat. Nothing new is asked of the device, and Hermes, whose gateway has no presence list, alerts as before.

Clawy says it's in use with OpenClaw's own `presence.activity` every 30 s: an iPhone or iPad while Clawy is on screen, a Mac while Clawy runs and someone typed, clicked or scrolled since the last time. The gateway stamps that connection's `connectionLastActivityAt` in its presence list. For each reply the plugin reads the list (`system-presence`, on a connection that lasts that one request) and quiets a device when another Clawy entry (`openclaw-ios`, `openclaw-macos`) whose connection is open:

- belongs to another device: its `deviceId` isn't the one this device registered from, which the plugin takes from the registering connection, never from the registration;
- belongs to the same person, where the gateway tells people apart: its `user.id` is the profile or user this device registered as;
- and was used more recently than this device: stamped in the last two minutes and more than 30 seconds after this device's own app was, or, for an app too old to stamp, showing a chat (`watchedSessions`).

So of two devices in use the one used most recently alerts. A device's own last stamp counts even after its connection closed, so an iPhone left a moment ago isn't quieted for an older Mac. A message posted with `chat.inject`, which Clawy on the Mac doesn't alert for, is never quieted this way.

A reply quieted this way is held, the latest one per device and chat, and looked at again two and a half minutes later, once the other device's use would have lapsed: two minutes after its last stamp, which comes within 30 seconds of its last input. If the chat is still unread (`sessions.describe`) and this device is now the one used most recently, the reply alerts then, as `chosen`. Read by then, or the other device still in use, and nothing more is sent. A reply in a chat already held replaces it under the first deadline, so replies that keep coming can't put it off. A gateway restart drops what's held.

An approval or a question is never turned into a refresh. While another device is the one in use, it isn't sent to this one at once: that device shows it in the app, and this one gets the alert only if the request is still unanswered a minute later, or after a third of the time it has left (`expiresAtMs`) when that's sooner. `*.approval.resolved` or `question.resolved` cancels it, so a request answered where the person is leaves no alert on their other devices. An answer given while the plugin's observer was offline goes unheard, and the alert goes anyway; the app clears it on its next connect. Nothing goes for a request whose time ran out, and a request the gateway sends again alerts each device once. With no device in use, or a presence list that can't be read, it alerts at once, as before. A failed task always alerts at once. A reply the plugin judged and still sent to a device carries `chosen: true`, and the device alerts as sent rather than judging again seconds later on stamps that may have moved. Clawy on the Mac, which takes no pushes, judges by the same stamps and its own last use. Each side judges at its own moment, and the 30-second margin means a stamp landing between them makes both alert, never neither. A device registered before 0.4.7 alerts until its app registers again, which it does on every connect. A presence list that can't be read within two seconds quiets nothing.

## Live Activities, version 2

Plugin version 0.3.0 advertises `liveActivities: 2` in status. The registration optionally adds `activities`, a list of at most four followed chats with distinct tracking ids; omitting it, null or an empty list stops following. Each entry follows one exact backend session, and each becomes one row on the device's single card:

```json
[{
  "trackingID": "7b34eddb-598a-41e0-946e-fd7d0090a124",
  "sessionKey": "agent:default:ios-native-example",
  "mode": "long",
  "backgrounded": true,
  "eligible": false,
  "currentRun": { "id": "native gateway run or turn id", "startedAt": 1794006306.974 }
}]
```

`trackingID` is a UUID; an entry missing from the next registration ends its row as stopped, and a replaced tracking id is a new target. Entries qualify, update and end independently. `currentRun` is optional and seeds an already running native turn. Hermes requires the actual `turn_id`, not its transcript row id. `manual` starts immediately for that explicit current run only. `long` starts while backgrounded once a run has worked 60 seconds and the device has been backgrounded for 15, counted on the gateway's clock from when the plugin first heard any of the device's entries say `backgrounded: true` (an entry added or replaced meanwhile keeps that time); a run the plugin first learned of more than 120 seconds after that never qualifies until the device registers foreground and then backgrounded again. OpenClaw can qualify earlier, skipping the 60 seconds and shortening the 15 to 5 (from 0.4.7; skipping both before), from a native subagent event, an explicit sessions_spawn tool, or the app's `eligible` hint (a working helper, or progress-card steps or a background task from the live run), which applies only to the run its `currentRun` names, or, with none named, to a row held for the session's helpers; never to the session's later runs. Ordinary tools never qualify early. Hermes uses the time rule alone, ignoring early-eligibility hints. Unrelated sessions never qualify. Updating backgrounded or eligible can qualify an observed run. A terminal run stays terminal; a later native run can qualify in long mode.

The plugin derives `runID` as lowercase SHA256 hex of the UTF-8 native id. It forwards to the fixed origin's `/v1/activity/<deviceID>` with the existing forward bearer token, independently of the sealed route:

```json
{
  "v": 1,
  "trackingID": "7b34eddb-598a-41e0-946e-fd7d0090a124",
  "runID": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "seq": 1794006326974,
  "event": "start",
  "startedAt": 1794006306.974,
  "phase": "working",
  "needsYou": 0
}
```

Only these public fields and optional terminal `endedAt` leave the plugin. No chat title, session key, command, question, agent name or message text appears on this route. `event` is start, update or end. Working phases are working and needsYou; terminal phases are replied, failed, stopped and stillWorking. `needsYou` is the pending approval/question count, capped at 999; every other phase has zero. Times are Unix seconds. Sequences use the same monotonic allocator as sealed notifications; retries reuse their sequence and exact body.

OpenClaw observes native lifecycle start/end/error and explicit helper-spawn signals. A run that yields, or replies while helpers it spawned still run (`subagent_progress` started/ended, `subagent_ended`), stays working, and the session's next run continues that activity under the same `runID`; a minute after the last helper ends with no new run, it ends as replied. Hermes observes `pre_llm_call` (the first hook with a native turn id), `on_session_end`, and human-input request/resolution hooks; it registers no pre-tool observer. Unresolved request ids are retained before a device follows, so an explicitly seeded manual activity starts as needsYou when the agent already waits. Registration replacement preserves those waits; resolution, native run replacement and terminal outcome clear them. Retention is capped at 256 sessions and 999 ids per session, with eight-hour expiry. Hermes terminal events match a unique exact native turn id across compression segments; ambiguous matches are ignored. Human waits use Hermes's supplied routing session_key when present, with exact request ids retaining resolution identity. Resolution resumes working when none remain. Silent success, abort, error and interruption end an activity. At eight hours an activity ends with stillWorking. Timers are canceled on replacement, terminal outcome and unload. Hermes refreshes the locked registration file once a second while native runs are active, so a dashboard host's registration change reaches the turn observer; dashboard-only instances never start activities.

A successfully started row handles its followed session's approval/question alert; other devices keep their ordinary alert. Reply alerts remain unchanged and activity ends carry no alert. HTTP 200 marks successful start; muted/ignored 202 does not suppress ordinary alerts. Activity failures never remove the ordinary notification registration, including 401 and 410. Starts and updates make at most two HTTP attempts; terminal events make at most three, retrying network failures and 502 only. The queue and retry state are in memory; a crash can lose terminal delivery. App reconciliation and stale presentation cover this gap, without guaranteeing terminal delivery after process death.

The relay checks bearer authentication before rate limits, respects mute, ignores tracking ids the device does not follow (202), and ignores old sequences (200). Per tracking id, a newer generation can replace the current one only with start and a newer startedAt, and terminal generations cannot be revived. The relay merges the followed rows into one card per device: the first working row push-starts it, later rows and changes update it, and it ends once no row is working. A finished row stays for two minutes after a reply and one minute otherwise; while other rows still work, the relay wakes when that time is up and pushes the card without it; a row whose run ended before any card showed it never appears. A new run after the card ended, or a card nearing iOS's eight-hour limit, dismisses the old card at once and starts a fresh one carrying the finished rows still within their linger. The latest state is retained until the card's token arrives, for at most nine hours. HTTP 200 means the card now shows this row's state. A per-device SQLite Durable Object serializes management and forwarding across regions; activity routes return 503 without that binding. APNs delivery itself is not exactly-once or guaranteed.

The app manages tokens separately with `PUT /v1/activities/<deviceID>` using its management secret, `trackingIDs` (the whole followed set, at most four) with an increasing `revision`, or `revoke` (at most sixteen ids to drop, for a relay the app no longer uses), an optional pushToStartToken, an optional `{cardID,value}` update token, and `card`: the card id the device shows for this relay device, or null for none. Dropped ids are retired for nine hours; a set older than the last applied revision, or naming a retired id, is ignored. A token for a card the relay no longer holds is ignored. Right after a push-start, and at most once a minute while the card's token is missing, the relay sends the device's ordinary APNs token a background push carrying only `{"aps":{"content-available":1},"clawyActivity":1}`, so a suspended app wakes to hand the token over. A started card the device reports missing for more than two minutes was swiped away or ended by iOS: the relay stops updating it, keeps the runs it showed working off later cards, and starts a fresh card for new work. The object wakes itself to move a card still carrying work to a fresh one before iOS ends it at eight hours. Activity APNs uses RunActivityAttributes with the relay's `cardID`, `startedAt` and `device` (the relay device id, so a device following chats on several gateways tells their cards apart), content state `{rows: [{id, run, phase, needsYou, startedAt, endedAt?}]}` (id is the tracking id, run the run hash), priority 10 and the `.push-type.liveactivity` topic. Start alerts say Clawy / Your agent is still working (Your agents are still working with several rows, Your agent needs you when one waits); an update alerts only when the total waiting count rises, and ends are silent. A card whose last row was dropped dismisses immediately; otherwise an ended card stays until its last row's linger.
