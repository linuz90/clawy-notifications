// A stand-in for Clawy's forwarder: it holds a device's keys, opens what a plugin posts and keeps
// it, so a contract test can check what really left the gateway. No Apple, no network.
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const hkdf = (salt, ikm, info, length) => Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

export async function startForwarder() {
  const ecdh = createECDH("prime256v1");
  const publicKey = ecdh.generateKeys();
  const auth = randomBytes(16);

  const open = (sealed) => {
    const raw = Buffer.from(sealed, "base64url");
    const salt = raw.subarray(0, 16);
    const sender = raw.subarray(21, 86);
    const body = raw.subarray(86);
    const ikm = hkdf(auth, ecdh.computeSecret(sender), Buffer.concat([Buffer.from("WebPush: info\0"), publicKey, sender]), 32);
    const decipher = createDecipheriv("aes-128-gcm", hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16), hkdf(salt, ikm, "Content-Encoding: nonce\0", 12));
    decipher.setAuthTag(body.subarray(body.length - 16));
    const padded = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
    if (padded.length !== 2048) throw new Error(`padded to ${padded.length}`);
    let end = padded.length - 1;
    while (padded[end] === 0) end--;
    return JSON.parse(padded.subarray(0, end).toString());
  };

  const received = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      const { kind, sealed } = JSON.parse(text);
      if (sealed.length !== 2867) throw new Error(`sealed body of ${sealed.length}`);
      received.push({ kind, ...open(sealed) });
      response.writeHead(200).end();
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));

  const origin = `http://127.0.0.1:${server.address().port}`;
  const id = "contract-device";
  return {
    origin,
    received,
    close: () => server.close(),
    device: { v: 2, id, name: "Contract test", forwarder: `${origin}/v1/forward/${id}`, token: "contract-token", p256dh: publicKey.toString("base64url"), auth: auth.toString("base64url"), text: true },
    async waitFor(test, what) {
      for (let i = 0; i < 60; i++) {
        const found = received.find(test);
        if (found) return found;
        await new Promise((done) => setTimeout(done, 500));
      }
      throw new Error(`no ${what} reached the forwarder`);
    },
  };
}
