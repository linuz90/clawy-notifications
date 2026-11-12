// What should reach a device. This is the whole policy, and it runs on your gateway.

/** Sealed for the device. `refresh` is silent: it wakes the app to read a session it follows. */
















/** Topics of the app's own: ones it creates, and ones an agent opens from them. */
const APP_TOPIC = /^(?:ios-native-|dashboard:)/u;
/** Sessions nobody follows as a conversation: an agent's main session, heartbeats, jobs, helpers. */
const NEVER_FOLLOWED = /^main$|:heartbeat$|^cron:|^subagent:/u;

/** The end of a run, from the agent event stream's `lifecycle` phase `end`. Only a visible reply
 * counts: an aborted run, a yielded parent still waiting for its children or a silent turn has
 * nothing to say. */
export function replyMessage(event                                                                       )                 {
  const { sessionKey, data } = event;
  if (!sessionKey || data?.phase !== "end" || data.aborted === true || data.yielded === true) return null;
  const reply = data.terminalReply;
  if (reply?.disposition !== "visible") return null;
  return routeReply(sessionKey, event.agentId, reply.text);
}

/** A scheduled task's result committed into a chat, from `onSessionTranscriptUpdate`: an assistant
 * message carrying `openclawAutomation`. The job's run ends in its own `cron:` session, which
 * `replyMessage` skips, so this is the only word that the chat has something new. */
export function automationPostMessage(update                                                                       )                 {
  const message = update.message;
  if (message?.role !== "assistant" || !message.openclawAutomation || !update.target?.sessionKey) return null;
  const text = Array.isArray(message.content)
    ? message.content.filter((block     ) => block?.type === "text" && typeof block.text === "string").map((block     ) => block.text).join("\n").trim()
    : typeof message.content === "string" ? message.content.trim() : "";
  return routeReply(update.target.sessionKey, update.target.agentId, text || undefined);
}

/** An app chat alerts with the text, a session someone may follow gets a silent refresh, and the
 * rest send nothing: the relay's rules for a reply. */
function routeReply(sessionKey        , agentId                    , text                    )                 {
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent" || parts.length < 3) return null;
  const agent = agentId ?? parts[1];
  const rest = parts.slice(2).join(":");
  if (APP_TOPIC.test(rest)) return { v: 2, kind: "reply", body: text, sessionKey, agentId: agent };
  if (NEVER_FOLLOWED.test(rest)) return null;
  return { v: 2, kind: "refresh", sessionKey, agentId: agent };
}

/** A plugin approval as the app shows it, title and all: Allow answers for the whole of it. */
function pluginApprovalText(request                     )                     {
  const parts = [request.title, request.description].filter((p) => typeof p === "string").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

/** `exec.approval.requested` and `plugin.approval.requested`. Answered ones send nothing. */
export function approvalMessage(event        , payload                     )                 {
  if (event !== "exec.approval.requested" && event !== "plugin.approval.requested") return null;
  const request = payload.request ?? {};
  // The real command, not a preview: the app offers Allow only if this is exactly what's pending.
  const body = event === "exec.approval.requested" ? request.command : pluginApprovalText(request);
  return { v: 2, kind: "approval", approvalId: payload.id, body, sessionKey: request.sessionKey ?? undefined, agentId: request.agentId ?? undefined };
}

/** `question.requested`. Several questions in one request alert as the first. */
export function questionMessage(event        , payload                     )                 {
  if (event !== "question.requested") return null;
  return { v: 2, kind: "question", questionId: payload.id, body: payload.questions?.[0]?.question, sessionKey: payload.sessionKey, agentId: payload.agentId };
}

/** The `cron_changed` hook: a scheduled task that finished with an error. */
export function failedJobMessage(event                                                                                               )                 {
  if (event.action !== "finished" || event.status !== "error") return null;
  return { v: 2, kind: "task-failed", jobId: event.jobId, title: event.job?.name ? `${event.job.name} failed` : "Scheduled task failed", body: event.error };
}
