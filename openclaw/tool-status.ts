// Status reads a bundled CLI on the gateway. See README.md, "What could break between OpenClaw releases".
import { execFile } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/** What an account was signed in for, as gog recorded it: its services, and whether every scope it holds is read-only. */
type GoogleAccess = { services: string[]; readOnly: boolean };
type GoogleStatus = { installed: boolean; accounts?: string[]; access?: Record<string, GoogleAccess> };

// Scopes that only name the account, which every sign-in holds.
const identityScopes = new Set([
  "email", "openid", "profile",
  "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile",
]);

// gog leaves services and scopes out of an account whose token it couldn't read.
function accountAccess(account: unknown): GoogleAccess | undefined {
  if (!account || typeof account !== "object") return undefined;
  const { services, scopes } = account as { services?: unknown; scopes?: unknown };
  if (!Array.isArray(services) || services.length === 0 || services.length > 40 ||
      !services.every((service): service is string => typeof service === "string" && /^[a-z][a-z0-9_-]{0,39}$/u.test(service)) ||
      !Array.isArray(scopes) || !scopes.every((scope): scope is string => typeof scope === "string")) {
    return undefined;
  }
  const granted = scopes.filter((scope) => !identityScopes.has(scope));
  return { services, readOnly: granted.length > 0 && granted.every((scope) => scope.endsWith(".readonly")) };
}

function gog(args: string[], env = process.env): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "gog",
      ["auth", ...args, "--json", "--no-input", "--color=never"],
      { env, timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, shell: false },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      },
    );
    child.stdin?.end();
  });
}

async function googleStatus(): Promise<GoogleStatus> {
  let keyring: unknown;
  try {
    keyring = await gog(["keyring"]);
  } catch (error) {
    return { installed: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
  // Reading the setting doesn't open the store. Auto or Keychain can open an OS prompt even
  // with --no-input. Force file for the second command too, so a concurrent config edit can't
  // switch its backend between the two commands.
  if (!keyring || typeof keyring !== "object" ||
      !("keyring_backend" in keyring) || keyring.keyring_backend !== "file") {
    return { installed: true };
  }
  try {
    const result = await gog(["list"], { ...process.env, GOG_KEYRING_BACKEND: "file" });
    if (result && typeof result === "object" && "accounts" in result && Array.isArray(result.accounts)) {
      const accounts = result.accounts.map((account) => account?.email);
      if (accounts.every((email): email is string =>
        typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+$/u.test(email))) {
        // One email can hold several sign-ins (one per OAuth client): its access is all of them.
        const access: Record<string, GoogleAccess> = {};
        result.accounts.forEach((account: unknown, index) => {
          const found = accountAccess(account);
          if (!found) return;
          const email = accounts[index];
          const known = access[email];
          access[email] = known
            ? { services: [...new Set([...known.services, ...found.services])], readOnly: known.readOnly && found.readOnly }
            : found;
        });
        return {
          installed: true,
          accounts: [...new Set(accounts)].sort(),
          ...(Object.keys(access).length > 0 ? { access } : {}),
        };
      }
    }
  } catch {
    // An unreadable keyring is an unknown state. Never return the CLI's output or error.
  }
  return { installed: true };
}

export function registerToolStatus(api: Pick<OpenClawPluginApi, "registerGatewayMethod">): void {
  let pending: Promise<GoogleStatus> | undefined;
  api.registerGatewayMethod("moonstone.tools.status", async ({ client, respond }) => {
    if (!client?.connect?.scopes?.includes("operator.admin")) {
      return respond(false, undefined, { code: "FORBIDDEN", message: "needs operator.admin" });
    }
    pending ??= googleStatus().finally(() => { pending = undefined; });
    respond(true, { gog: await pending });
  }, { scope: "operator.admin" });
}
