# Clawy notifications

Plugins for [OpenClaw](https://github.com/openclaw/openclaw) and [Hermes Agent](https://github.com/NousResearch/hermes-agent) that keep the text of your notifications away from Clawy's server.

Clawy is a closed source iPhone and iPad app for agents you host yourself. Apple only delivers notifications through a server, so by default Clawy's relay receives each alert from your gateway and decides what to show. With one of these plugins, your gateway decides instead. It seals each alert to a key that only your device holds and hands our server a blob it can't open.

```
Relay:   gateway → our server (reads it, decides) → Apple → phone
Plugin:  gateway + plugin (decides, seals) → our server (passes it on) → Apple → phone (opens it)
```

## What this protects

**Our server can't read your notifications.** It gets a fixed-size sealed body and has no key that opens it. Every body is the same 2867 characters, so its length says nothing about its text.

**Apple can't read them either.** It sees the same body, behind the words "New notification".

**Someone who steals our Apple key can't read them, or replay old ones.** Each message carries a number that opens only once. They can't aim your gateway at another server, because the address is fixed in the plugin's source. They can't make Allow approve anything other than the command the alert shows.

## What it doesn't protect

**The app sees your chats.** Clawy is a client for your gateway, and it's closed source, so you're trusting it with everything it shows you. These plugins take our server out of the reading. They do nothing about the app.

**Our server and Apple still see metadata:** your device's push token, its device id, when alerts happen, whether each one is an alert or silent, and your gateway's IP address (our server only).

**Someone with our Apple key can still reach your screen.** They can drop or delay your pushes, and they can send a push of their own. A push the app can't open shows only "New notification", but one sent so that the app never sees it first can show any words they like, and buttons too. None of it does anything: Allow won't work on it, and tapping it opens nothing. The app needs a special permission from Apple to block those outright, and it doesn't have it.

**The plugin sees what your alerts contain.** It runs inside your gateway, with its access. It's under 500 lines per gateway with no dependencies of its own, so you can read it.

**Every registered device gets every alert.** A gateway's per-user access checks don't apply here, so this suits a gateway with one owner.

## Install

### OpenClaw

```sh
openclaw plugins install git:linuz90/clawy-notifications#v0.2.0 --force --accept-capabilities
openclaw plugins enable clawy-notifications
```

`--force` is OpenClaw's confirmation for anything outside ClawHub's review, and `--accept-capabilities` accepts what the plugin declares. Both commands are needed: install can leave the plugin disabled. No restart. If you turned on owner access in Clawy, Settings › Notifications › Delivery can do this for you.

### Hermes Agent

```sh
hermes plugins install linuz90/clawy-notifications#hermes --enable
```

Then restart Hermes. Its routes only mount at startup. To pin a reviewed commit, add `--ref <40-character-sha>`.

### Then, in Clawy

Open Settings › Notifications › Delivery and choose Open source plugins. Clawy finds the plugin and registers this device itself, so you never copy a key. Send Test passes only if this device opened the alert.

If the plugin stops working, Clawy says so on the Topics list. It never moves you back to our relay on its own.

## What's here

| Path | What it is |
| --- | --- |
| [`PROTOCOL.md`](PROTOCOL.md) | The wire format, and what our forwarder does with it |
| [`openclaw/`](openclaw/) | The OpenClaw plugin. `dist/` is the same code with the types stripped |
| [`hermes/`](hermes/) | The Hermes plugin |
| [`test-vectors/`](test-vectors/) | Sealed messages and replay steps both plugins and the app are tested against |
| [`test/contract/`](test/contract/) | Installs a plugin on a real gateway and checks it end to end, nightly against the newest releases |

The repository root is also the OpenClaw package, because OpenClaw's git install takes the root of a repository.

## Test

```sh
npm test                                   # OpenClaw plugin
cd hermes && python -m unittest            # Hermes plugin, in an environment with cryptography and aiohttp
node test/contract/openclaw.mjs [version]  # needs a committed checkout
node test/contract/hermes.mjs [tag]        # also needs uv
```

Tested on OpenClaw `2026.10.7` and `2026.11.1`, and Hermes `v0.22.7` and `v0.23.0`.

## License

MIT. Reporting a security problem: [`SECURITY.md`](SECURITY.md).
