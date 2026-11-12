# Security

Please report a vulnerability privately, through GitHub's [private reporting](https://github.com/linuz90/clawy-notifications/security/advisories/new) on this repository. Don't open a public issue. You'll hear back within a few days.

## In scope

- Reading an alert without the device's key.
- Showing an old alert again, or making an approval's Allow answer anything other than the command the alert shows.
- Making a gateway post to a host other than the one fixed in the plugin.
- A plugin leaking message text, commands, keys or tokens into logs or anywhere else.
- An unauthenticated caller reaching a plugin's methods or routes.

## Known limits

These are known, and need no report:

- Whoever can send pushes for Clawy can drop or delay them, and can send a notification the app never processes. iOS shows that one with whatever text it carries. The app ignores it otherwise: a tap opens nothing and Allow approves nothing. Blocking it outright needs an Apple entitlement Clawy doesn't have.
- A client with `operator.approvals` and `operator.questions` on your gateway can register a device, and that device then gets every alert.
- Optional Live Activities expose generic phase, pending-input count, run timing, a tracking UUID and a SHA256 run id to the forwarder and Apple. They contain no conversation text or session key. Delivery after process death is best effort.
- The Clawy app is closed source.

[`PROTOCOL.md`](PROTOCOL.md) has the details: what's sealed, how a device rejects replays, and what the forwarder accepts.

Clawy's own code isn't in this repository. Report problems with the app or the relay the same way.
