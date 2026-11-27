// What should reach a device. This is the whole policy, and it runs on your gateway.

/** Sealed for the device. `refresh` is silent: it wakes the app to read a session it follows. */
export type Message = {
  v: 2;
  /** Set when sending: see `Sequence`. */
  seq?: number;
  kind: "reply" | "approval" | "question" | "task-failed" | "refresh";
  title?: string;
  body?: string;
  sessionKey?: string;
  agentId?: string;
  approvalId?: string;
  questionId?: string;
  jobId?: string;
  /** A test alert's nonce, from the device that asked for it. */
  test?: string;
  /** A reply this plugin judged by which device is in use and sent to this device: it alerts as
   * sent, rather than judging again seconds later on different stamps (PROTOCOL.md, In use elsewhere). */
  chosen?: boolean;
};

/** Topics of the app's own: ones it creates, and ones an agent opens from them. */
const APP_TOPIC = /^(?:ios-native-|dashboard:)/u;
/** Sessions nobody follows as a conversation: an agent's main session, heartbeats, jobs, helpers. */
const NEVER_FOLLOWED = /^main$|:heartbeat$|^cron:|^subagent:/u;

/** The end of a run, from the agent event stream's `lifecycle` phase `end`. Only a visible reply
 * counts: an aborted run, a yielded parent still waiting for its children or a silent turn has
 * nothing to say. */
export function replyMessage(event: { sessionKey?: string; agentId?: string; data?: Record<string, any> }): Message | null {
  const { sessionKey, data } = event;
  if (!sessionKey || data?.phase !== "end" || data.aborted === true || data.yielded === true) return null;
  const reply = data.terminalReply;
  if (reply?.disposition !== "visible") return null;
  return routeReply(sessionKey, event.agentId, reply.text);
}

/** A scheduled task's result committed into a chat, from `onSessionTranscriptUpdate`: an assistant
 * message carrying `openclawAutomation`. The job's run ends in its own `cron:` session, which
 * `replyMessage` skips, so this is the only word that the chat has something new. The marker isn't
 * a promise of OpenClaw's: README.md, "What could break between OpenClaw releases". */
export function automationPostMessage(update: { target?: { sessionKey?: string; agentId?: string }; message?: any }): Message | null {
  const message = update.message;
  if (message?.role !== "assistant" || !message.openclawAutomation || !update.target?.sessionKey) return null;
  return routeReply(update.target.sessionKey, update.target.agentId, textOf(message));
}

/** A message posted into a chat with `chat.inject`, such as a script telling the person a job is
 * done, from `onSessionTranscriptUpdate`. It starts no run, so `replyMessage` never hears of it, and
 * the gateway's own Web Push skips it as transcript-only. The gateway writes other
 * `gateway-injected` rows too, which this leaves alone: a slash command's reply and a run's
 * mirrored reply carry their send's `idempotencyKey`, and a stopped reply's partial carries
 * `openclawAbort`. `chat.inject` writes neither. A guess at the row's shape, not a promise of
 * OpenClaw's: README.md, "What could break between OpenClaw releases". */
export function injectedMessage(update: { target?: { sessionKey?: string; agentId?: string }; message?: any }): Message | null {
  const message = update.message;
  if (message?.role !== "assistant" || message.provider !== "openclaw" || message.model !== "gateway-injected") return null;
  if (message.idempotencyKey || message.openclawAbort || !update.target?.sessionKey) return null;
  return routeReply(update.target.sessionKey, update.target.agentId, textOf(message));
}

function textOf(message: any): string | undefined {
  const text = Array.isArray(message.content)
    ? message.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("\n").trim()
    : typeof message.content === "string" ? message.content.trim() : "";
  return text || undefined;
}

/** An app chat alerts with the text, a session someone may follow gets a silent refresh, and the
 * rest send nothing: the relay's rules for a reply. */
function routeReply(sessionKey: string, agentId: string | undefined, text: string | undefined): Message | null {
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent" || parts.length < 3) return null;
  const agent = agentId ?? parts[1];
  const rest = parts.slice(2).join(":");
  if (APP_TOPIC.test(rest)) return { v: 2, kind: "reply", body: text, sessionKey, agentId: agent };
  if (NEVER_FOLLOWED.test(rest)) return null;
  return { v: 2, kind: "refresh", sessionKey, agentId: agent };
}

/** A plugin approval as the app shows it, title and all: Allow answers for the whole of it. */
function pluginApprovalText(request: Record<string, any>): string | undefined {
  const parts = [request.title, request.description].filter((p) => typeof p === "string").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

/** `exec.approval.requested` and `plugin.approval.requested`. Answered ones send nothing. */
export function approvalMessage(event: string, payload: Record<string, any>): Message | null {
  if (event !== "exec.approval.requested" && event !== "plugin.approval.requested" && event !== "openclaw.approval.requested") return null;
  const request = payload.request ?? {};
  // The real command, not a preview: the app offers Allow only if this is exactly what's pending.
  // A setup change's is OpenClaw's own sentence for it, untrimmed, as the app reads it.
  const body = event === "exec.approval.requested" ? request.command
    : event === "openclaw.approval.requested" ? request.description ?? request.command
    : pluginApprovalText(request);
  return { v: 2, kind: "approval", approvalId: payload.id, body, sessionKey: request.sessionKey ?? undefined, agentId: request.agentId ?? undefined };
}

/** `question.requested`. Several questions in one request alert as the first. */
export function questionMessage(event: string, payload: Record<string, any>): Message | null {
  if (event !== "question.requested") return null;
  return { v: 2, kind: "question", questionId: payload.id, body: payload.questions?.[0]?.question, sessionKey: payload.sessionKey, agentId: payload.agentId };
}

/** The `cron_changed` hook: a scheduled task that finished with an error. Its agent, so the alert
 * comes from it: with several agents or gateways, a job's name alone doesn't say whose it is. */
export function failedJobMessage(event: { action?: string; status?: string; jobId?: string; agentId?: string; job?: { name?: string; agentId?: string }; error?: string }): Message | null {
  if (event.action !== "finished" || event.status !== "error") return null;
  return { v: 2, kind: "task-failed", jobId: event.jobId, agentId: event.agentId ?? event.job?.agentId,
           title: event.job?.name ? `${event.job.name} failed` : "Scheduled task failed", body: event.error };
}

/** The chat a guest's session speaks in (`agent:atlas:ios-native-1-guest-of-juno` in
 * `agent:juno:ios-native-1`): a guest's reply is muted with its chat. */
export function hostKey(sessionKey: string): string | undefined {
  const match = sessionKey.match(/^agent:[^:]+:((?:ios-native-|dashboard:).*)-guest-of-([^:]+)$/u);
  return match ? `agent:${match[2]}:${match[1]}` : undefined;
}

/** An app's entry in the gateway's presence list (`system-presence`), as far as alerts go. */
export type PresenceEntry = {
  clientId?: string;
  deviceId?: string;
  reason?: string;
  user?: { id?: string };
  watchedSessions?: string[];
  connectionLastActivityAt?: number;
};

/** Presence entries from the Moonstone app. The Control UI doesn't count: someone in a browser tab may well be elsewhere. */
const MOONSTONE_APPS = new Set(["openclaw-ios", "openclaw-macos"]);
/** An app says it's in use every 30 s (`presence.activity`), and counts as in use for two minutes
 * after. The app quiets its own alerts by the same rule (`AlertQuiet`). */
const IN_USE_MS = 120_000;
/** Another device quiets this one only when used more recently by more than one beat: each side
 * judges at its own moment, and a stamp landing between them then makes two alerts, never none. */
const MARGIN_MS = 30_000;

/** How long an approval or a question waits before it alerts a device, while another is the one in
 * use and shows it first. */
const REQUEST_HOLD_MS = 60_000;

/** Whether Moonstone was used more recently on another of this person's devices (by more than a beat),
 * a Mac being typed on or an iPhone open, in the last two minutes. False for a device registered
 * before the plugin knew its gateway id, and for a list that couldn't be read: both alert as before. */
export function inUseElsewhere(device: { gatewayDevice?: string; person?: string }, presence: PresenceEntry[] | undefined, now = Date.now()): boolean {
  if (!presence || !device.gatewayDevice) return false;
  // A closed connection's entry lingers for minutes, marked `disconnect`.
  const live = presence.filter((entry) => entry && typeof entry === "object" && entry.reason !== "disconnect");
  const stamp = (entry: PresenceEntry) => typeof entry.connectionLastActivityAt === "number" ? entry.connectionLastActivityAt : undefined;
  // An app too old to stamp counts as used now while it shows a chat, here or elsewhere alike.
  const used = (entry: PresenceEntry) => stamp(entry) ?? ((entry.watchedSessions?.length ?? 0) > 0 ? Infinity : -Infinity);
  // This device's own last use counts after its connection closed: an iPhone left a moment ago is
  // still the one used last, and an older Mac, seeing it gone, already stayed quiet.
  const here = Math.max(-Infinity, ...presence.filter((entry) => entry && typeof entry === "object" && entry.deviceId === device.gatewayDevice).map(used));
  const elsewhere = Math.max(-Infinity, ...live.filter((entry) => MOONSTONE_APPS.has(entry.clientId ?? "") && !!entry.deviceId && entry.deviceId !== device.gatewayDevice
    && !(device.person && entry.user?.id && entry.user.id !== device.person)).map(used));
  return elsewhere > now - IN_USE_MS && elsewhere > here + MARGIN_MS;
}

/** What one device gets while another is the one in use: a reply goes out as a silent refresh, as in
 * a muted chat; its app still reads the reply in the background and marks the chat unread. The
 * device used most recently keeps the alert, so of two devices in use, one alerts. Anything but a
 * reply goes as it is: an approval or a question waits instead (`requestHoldMs`), and a failed task
 * alerts as ever. */
export function whileInUseElsewhere(message: Message, device: { gatewayDevice?: string; person?: string }, presence: PresenceEntry[] | undefined, now = Date.now()): Message {
  if (message.kind !== "reply" || message.test || !presence || !device.gatewayDevice) return message;
  return inUseElsewhere(device, presence, now)
    ? { v: 2, kind: "refresh", sessionKey: message.sessionKey, agentId: message.agentId }
    : { ...message, chosen: true };
}

/** How long an approval or a question waits for the device in use to answer it before it alerts
 * the others: a minute, or a third of the time it has left when it expires sooner (a plugin's
 * permission request lasts two minutes, a command's thirty). */
export function requestHoldMs(expiresAtMs: number | undefined, now = Date.now()): number {
  const left = typeof expiresAtMs === "number" ? Math.max(0, expiresAtMs - now) : Infinity;
  return Math.min(REQUEST_HOLD_MS, Math.floor(left / 3));
}

/** What one device gets: a reply in a chat it muted goes out as a silent refresh, so its app still
 * reads the reply and marks the chat unread without a sound or a banner. Approvals, questions and
 * failed tasks alert as ever, since they wait on the person. `muted` maps a session key to when its
 * mute ends, in epoch ms, or 0 for until unmuted. */
export function forDevice(message: Message, muted: Record<string, number> | undefined, now = Date.now()): Message {
  if (message.kind !== "reply" || !message.sessionKey || !muted || message.test) return message;
  const host = hostKey(message.sessionKey);
  const until = muted[message.sessionKey] ?? (host ? muted[host] : undefined);
  if (until === undefined || (until !== 0 && until <= now)) return message;
  return { v: 2, kind: "refresh", sessionKey: message.sessionKey, agentId: message.agentId };
}
