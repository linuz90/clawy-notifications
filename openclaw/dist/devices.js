// The devices this gateway alerts: their public keys and where to send, in one file only the
// gateway's user can read. Nothing here can open a sealed message.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseActivities,                     } from "./activity.js";
















const base64url = /^[A-Za-z0-9_-]+$/u;

/** The one host this plugin ever posts to. A client that can register a device can't point it
 * anywhere else, so it can't make your gateway send a request of its choosing. Set
 * CLAWY_FORWARDER_ORIGIN only to test against a forwarder of your own. */
export const forwarderOrigin = () => process.env.CLAWY_FORWARDER_ORIGIN ?? "https://openclaw-client-relay.linuz90.workers.dev";

/** A device gets every approval and every question, so adding one takes the right to see them. */
export const canRegister = (scopes           = []) =>
  scopes.includes("operator.admin") || (scopes.includes("operator.approvals") && scopes.includes("operator.questions"));

/** What a client sent, checked, or null. */
export function parseDevice(input     )                {
  if (!input || typeof input !== "object") return null;
  const { id, name, forwarder, token, p256dh, auth, text } = input;
  const activities = parseActivities(input.activities);
  if (activities === false) return null;
  if (typeof id !== "string" || !base64url.test(id) || typeof token !== "string" || !token) return null;
  if (typeof p256dh !== "string" || !base64url.test(p256dh) || Buffer.from(p256dh, "base64url").length !== 65) return null;
  if (typeof auth !== "string" || !base64url.test(auth) || Buffer.from(auth, "base64url").length !== 16) return null;
  let url     ;
  try {
    url = new URL(forwarder);
  } catch {
    return null;
  }
  if (url.origin !== forwarderOrigin() || url.pathname !== `/v1/forward/${id}` || url.search || url.hash) return null;
  return { v: 2, id, name: typeof name === "string" ? name.slice(0, 80) : undefined, forwarder, token, p256dh, auth, text: text !== false, ...(activities?.length ? { activities } : {}) };
}

export class DeviceFile {
                   path        ;

  constructor(path        ) {
    this.path = path;
  }

  list()           {
    try {
      const values = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(values) ? values.map(parseDevice).filter((device)                   => device !== null) : [];
    } catch {
      return [];
    }
  }

          write(devices          ) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(devices, null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  add(device        ) {
    this.write([...this.list().filter((d) => d.id !== device.id), device]);
  }

  remove(id        )          {
    const devices = this.list();
    const kept = devices.filter((d) => d.id !== id);
    this.write(kept);
    return kept.length !== devices.length;
  }
}

/** The number sealed into every message: a device opens each number once and never one far behind
 * the newest, so nobody who keeps a sealed body can show it again. It runs on the clock so a lost
 * file costs nothing, and on the file so a clock set back can't repeat a number. */
export class Sequence {
                   path        ;
          last = 0;

  constructor(path        ) {
    this.path = path;
    try {
      this.last = Number(readFileSync(path, "utf8")) || 0;
    } catch {}
  }

  next(now = Date.now())         {
    this.last = Math.max(now, this.last + 1);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, String(this.last), { mode: 0o600 });
    renameSync(temporary, this.path);
    return this.last;
  }
}
