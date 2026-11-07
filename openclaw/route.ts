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
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent" || parts.length < 3) return null;
  const agentId = event.agentId ?? parts[1];
  const rest = parts.slice(2).join(":");
  if (APP_TOPIC.test(rest)) return { v: 2, kind: "reply", body: reply.text, sessionKey, agentId };
  if (NEVER_FOLLOWED.test(rest)) return null;
  return { v: 2, kind: "refresh", sessionKey, agentId };
}

/** A plugin approval as the app shows it, title and all: Allow answers for the whole of it. */
function pluginApprovalText(request: Record<string, any>): string | undefined {
  const parts = [request.title, request.description].filter((p) => typeof p === "string").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

/** `exec.approval.requested` and `plugin.approval.requested`. Answered ones send nothing. */
export function approvalMessage(event: string, payload: Record<string, any>): Message | null {
  if (event !== "exec.approval.requested" && event !== "plugin.approval.requested") return null;
  const request = payload.request ?? {};
  // The real command, not a preview: the app offers Allow only if this is exactly what's pending.
  const body = event === "exec.approval.requested" ? request.command : pluginApprovalText(request);
  return { v: 2, kind: "approval", approvalId: payload.id, body, sessionKey: request.sessionKey ?? undefined, agentId: request.agentId ?? undefined };
}

/** `question.requested`. Several questions in one request alert as the first. */
export function questionMessage(event: string, payload: Record<string, any>): Message | null {
  if (event !== "question.requested") return null;
  return { v: 2, kind: "question", questionId: payload.id, body: payload.questions?.[0]?.question, sessionKey: payload.sessionKey, agentId: payload.agentId };
}

/** The `cron_changed` hook: a scheduled task that finished with an error. */
export function failedJobMessage(event: { action?: string; status?: string; jobId?: string; job?: { name?: string }; error?: string }): Message | null {
  if (event.action !== "finished" || event.status !== "error") return null;
  return { v: 2, kind: "task-failed", jobId: event.jobId, title: event.job?.name ? `${event.job.name} failed` : "Scheduled task failed", body: event.error };
}
