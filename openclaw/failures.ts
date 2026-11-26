// A failed scheduled task's alert, held while OpenClaw hands the failure to an agent. From 2026.11.10
// a job an agent made in a chat gets a turn there when it fails ("Automation repair request from the
// scheduler…"), and the agent's reply, which alerts as a reply, is the person's notice. The failed
// alert waits for that turn and goes only where its reply doesn't alert: the agent stayed silent, the
// turn never came, or the chat is muted on that device. The turn's prompt row isn't a promise of
// OpenClaw's: README.md, "What could break between OpenClaw releases".
import type { Message } from "./route.ts";

/** The first OpenClaw that hands a failure to the agent of the chat the job was made in. */
const REPAIR_VERSION = [2026, 11, 10];

/** Whether this OpenClaw hands failures to agents, from its `runtime.version` (`2026.11.10`, maybe
 * with a suffix). Unknown is no: its alerts go at once, as before. */
export function repairsFailures(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const parts = version.match(/^(\d+)\.(\d+)\.(\d+)/u)?.slice(1).map(Number);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) if (parts[i] !== REPAIR_VERSION[i]) return parts[i] > REPAIR_VERSION[i];
  return true;
}

/** The repair turn's prompt, from `onSessionTranscriptUpdate`: a `user` row the scheduler wrote
 * (`provenance.sourceTool: cron_failure_repair`) naming the job as "(id <job>)", in the chat the
 * agent will answer in, with the run that answers it when the row says (`__openclaw.runId`). */
export function repairBrief(update: { target?: { sessionKey?: string }; message?: any }): Brief | null {
  const message = update.message;
  const sessionKey = update.target?.sessionKey;
  if (message?.role !== "user" || message.provenance?.sourceTool !== "cron_failure_repair" || !sessionKey) return null;
  const text = typeof message.content === "string" ? message.content
    : Array.isArray(message.content) ? message.content.map((block: any) => typeof block?.text === "string" ? block.text : "").join("\n") : "";
  const jobId = text.match(/\(id ([^\s)]+)\)/u)?.[1];
  const runId = typeof message.__openclaw?.runId === "string" ? message.__openclaw.runId : undefined;
  return jobId ? { jobId, sessionKey, ...(runId ? { runId } : {}) } : null;
}

type Brief = { jobId: string; sessionKey: string; runId?: string };

type Timer = ReturnType<typeof setTimeout>;
type Clock = { later: typeof setTimeout; cancel: typeof clearTimeout; briefMs: number; runMs: number };
/** The turn's prompt lands seconds after the failure (5 s on 2026.11.10), later behind a run already
 * going in that chat; the turn itself is the agent's to finish, within OpenClaw's own limit. */
const clock: Clock = { later: setTimeout, cancel: clearTimeout, briefMs: 90_000, runMs: 15 * 60_000 };

/** `send(message, toldIn)`: `toldIn` is the chat whose reply already told the person, for the
 * devices that alert that reply to skip it. */
export class HeldFailures {
  /** By job. `briefed` orders the turns begun in one chat, which run one after another there. */
  private held = new Map<string, { message: Message; timer: Timer; sessionKey?: string; runId?: string; briefed?: number }>();
  private briefs = 0;
  private send: (message: Message, toldIn?: string) => void;
  private time: Clock;

  constructor(send: (message: Message, toldIn?: string) => void, time: Clock = clock) { this.send = send; this.time = time; }

  /** A job failed: its alert waits for the turn that hands it to an agent. A newer failure of the
   * same job replaces it. */
  failed(jobId: string, message: Message) {
    const old = this.held.get(jobId);
    if (old) this.time.cancel(old.timer);
    this.held.set(jobId, { message, timer: this.wait(jobId, this.time.briefMs) });
  }

  /** The turn began in `sessionKey`: the alert waits for that chat's run to end. */
  brief({ jobId, sessionKey, runId }: Brief) {
    const held = this.held.get(jobId);
    if (!held || held.sessionKey) return;
    this.time.cancel(held.timer);
    Object.assign(held, { sessionKey, runId, briefed: ++this.briefs, timer: this.wait(jobId, this.time.runMs) });
  }

  /** A run ended in `sessionKey`. `replied`: with a reply that alerts as one (an app chat's). It
   * answers one job: the one whose prompt named this run, else the first begun in that chat. */
  ended(sessionKey: string, replied: boolean, runId?: string) {
    const waiting = [...this.held].filter(([, held]) => held.sessionKey === sessionKey);
    const [jobId, held] = waiting.find(([, held]) => runId && held.runId === runId)
      ?? waiting.sort(([, a], [, b]) => a.briefed! - b.briefed!)[0] ?? [];
    if (!jobId || !held) return;
    this.time.cancel(held.timer);
    this.held.delete(jobId);
    this.send(held.message, replied ? sessionKey : undefined);
  }

  /** Stopping: what's held goes now rather than never. */
  close() {
    for (const jobId of [...this.held.keys()]) this.release(jobId);
  }

  private wait(jobId: string, ms: number): Timer {
    const timer = this.time.later(() => this.release(jobId), ms);
    timer.unref?.();
    return timer;
  }

  private release(jobId: string) {
    const held = this.held.get(jobId);
    if (!held) return;
    this.time.cancel(held.timer);
    this.held.delete(jobId);
    this.send(held.message);
  }
}
