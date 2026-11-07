# Security

Please report a vulnerability privately, through GitHub's [private reporting](https://github.com/linuz90/clawy-notifications/security/advisories/new) on this repository. Don't open a public issue. You'll hear back within a few days.

## In scope

- Reading an alert without the device's key.
- Showing an old alert again, or making an approval's Allow answer anything other than the command the alert shows.
- Making a gateway post to a host other than the one fixed in the plugin.
- A plugin leaking message text, commands, keys or tokens into logs or anywhere else.
- An unauthenticated caller reaching a plugin's methods or routes.

## Known limits

[`README.md`](README.md) lists what the plugins don't protect. These are known, and need no report:

- Someone holding Clawy's Apple key can drop or delay pushes, and can show a banner of their own by sending a push that skips the notification extension. Nothing on it works.
- A client with `operator.approvals` and `operator.questions` on your gateway can register a device, and that device then gets every alert.
- The Clawy app is closed source.

Clawy's own code isn't in this repository. Report problems with the app or the relay the same way.
