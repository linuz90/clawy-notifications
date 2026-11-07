// Encrypts a notification to one device with Web Push's `aes128gcm` (RFC 8291 over RFC 8188).
// Node's own crypto only. Only the device holds the private key that opens the result.
import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

/** Every message pads to this, so its size says nothing about its text. */
export const PADDED_LENGTH = 2048;
const RECORD_SIZE = 4096;

const hkdf = (salt        , ikm        , info                 , length        ) =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/** Shortens `body` until the message fits, cutting between characters, and says so: the app
 * won't offer Allow on a command it can't show whole. */
export function fit(message                         )         {
  let json = JSON.stringify(message);
  if (typeof message.body !== "string") return json;
  let body = Array.from(message.body);
  while (Buffer.byteLength(json) > PADDED_LENGTH - 1 && body.length > 0) {
    const excess = Buffer.byteLength(json) - (PADDED_LENGTH - 1);
    body = body.slice(0, Math.max(0, body.length - Math.max(1, Math.ceil(excess / 4))));
    json = JSON.stringify({ ...message, body: `${body.join("")}…`, truncated: true });
  }
  return json;
}

/** Returns the sealed message as base64url. `p256dh` and `auth` are the device's, in base64url. */
export function seal(json        , p256dh        , auth        )         {
  const plain = Buffer.from(json);
  if (plain.length > PADDED_LENGTH - 1) throw new Error("message too long to seal");
  const devicePublic = Buffer.from(p256dh, "base64url");

  const ephemeral = createECDH("prime256v1");
  const senderPublic = ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(devicePublic);

  const salt = randomBytes(16);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), devicePublic, senderPublic]);
  const ikm = hkdf(Buffer.from(auth, "base64url"), shared, info, 32);
  const key = hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);

  const padded = Buffer.alloc(PADDED_LENGTH);
  plain.copy(padded);
  padded[plain.length] = 2; // RFC 8188: the last record's delimiter, then zeros.

  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = senderPublic.length;
  return Buffer.concat([header, senderPublic, body]).toString("base64url");
}
