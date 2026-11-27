// Moonstone notifications for OpenClaw. It watches this gateway for what needs a person (replies,
// automation posts, approvals, questions, failed scheduled tasks), seals each to the devices
// registered here, and posts the ciphertext to Moonstone's forwarder, which holds Apple's push key and
// nothing that opens it. It reads no conversation history and needs no `allowConversationAccess`. See README.md.
import { createOperatorApprovalsGatewayClient, GatewayClient, resolveGatewayAuth } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { join } from "node:path";
import { canRegister, DeviceFile, parseDevice, Sequence,             } from "./devices.js";
import { approvalMessage, automationPostMessage, failedJobMessage, forDevice, hostKey, injectedMessage, inUseElsewhere, questionMessage, replyMessage, requestHoldMs, whileInUseElsewhere,                                  } from "./route.js";
import { fit, seal } from "./seal.js";
import { Activities } from "./activity.js";
import { HeldFailures, repairBrief, repairsFailures } from "./failures.js";
import { registerDeviceTools } from "./device-tools.js";
import { registerConnectorApprovals } from "./connector-approvals.js";
import { registerCredentials } from "./credentials.js";
import { registerGuideTool } from "./guide.js";
import { registerToolStatus } from "./tool-status.js";

const VERSION = "0.6.0";
/** How long a reply quieted for a device waits before it's looked at again: the two minutes another
 * device counts as in use after its last stamp, plus a beat. */
const RECHECK_MS = 150_000;
/** Bumped whenever a device needs something new from this plugin. PROTOCOL.md. */
const PROTOCOL = 2;

/** The last alert sent to a device: enough for its app to tell a working route from a broken one. */


/** The gateway's presence list, read on a connection that lasts one request: a backend connection
 * adds no presence entry of its own and is sent no events. Undefined when it can't be read within
 * 2 s, and then every device alerts, as before. */
function readPresence(url        , auth                                       )                                       {
  return askGateway(url, auth, (client) => client.request("system-presence")).then(presenceList);
}

/** Only the entries that are objects: a list read off the wire is checked before it's judged. */
const presenceList = (list         )                              =>
  Array.isArray(list) ? list.filter((entry) => entry && typeof entry === "object") : undefined;

/** Whatever `ask` reads, on a backend connection that lasts that long and no more, or undefined
 * when it can't be read within 2 s. */
function askGateway   (url        , auth                                       , ask                             )                         {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value               ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.stop();
      resolve(value);
    };
    const client = new GatewayClient({
      url,
      token: auth.token,
      password: auth.password,
      clientName: "gateway-client",
      clientDisplayName: "Moonstone notifications",
      mode: "backend",
      scopes: ["operator.read"],
      onHelloOk: () => { ask(client).then(finish, () => finish(undefined)); },
    });
    const timer = setTimeout(() => finish(undefined), 2_000);
    client.start();
  });
}

export default definePluginEntry({
  id: "moonstone",
  name: "Moonstone notifications",
  description: "Sealed push notifications for Moonstone.",
  register(api) {
    const connectorApprovals = registerConnectorApprovals(api);
    registerDeviceTools(api);
    registerToolStatus(api);
    registerCredentials(api);
    registerGuideTool(api, VERSION);
    const log = api.logger;
    const state = join(api.runtime.state.resolveStateDir(process.env), "moonstone");
    const devices = new DeviceFile(join(state, "devices.json"));
    const sequence = new Sequence(join(state, "sequence"));
    const deliveries = new Map                  ();
    const activities = new Activities(() => sequence.next());
    for (const device of devices.list()) activities.register(device);
    // Whether each client is signed in: one that isn't misses its alerts with nothing else to show for it.
    const listening = { approvals: false, questions: false };

    /** One device's copy: without message text if it asked for that. */
    async function deliver(device        , message         )                  {
      const stamped = { ...message, seq: sequence.next() };
      const { body, title, ...rest } = stamped;
      const sealed = seal(fit(device.text === false ? rest : stamped), device.p256dh, device.auth);
      const post = () => fetch(device.forwarder, {
        method: "POST",
        headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: message.kind === "refresh" ? "silent" : "alert", sealed }),
        redirect: "error", // A forward token never goes to another URL.
        // The relay answers within about 4 s; two tries stay inside the app's 15 s wait on a Send Test.
        signal: AbortSignal.timeout(7_000),
      });
      const note = (status        ) => {
        // Silent pushes may be dropped by iOS as it likes, so only alerts say how the route is doing.
        if (message.kind !== "refresh") deliveries.set(device.id, { seq: stamped.seq, status, at: Date.now() });
      };
      let response          ;
      try {
        // One more try after a 502 (APNs failed) or no answer at all (a timeout, a dropped connection).
        // It's the same sealed body and seq, so the device opens it once even if both arrive.
        const first = await post().catch(() => undefined);
        // Not after a stop: what was asked before it ends with the first try.
        if (stopped && !first) throw new Error("stopped");
        response = first && (first.status !== 502 || stopped) ? first : await post();
      } catch (error) {
        note(0);
        throw error;
      }
      note(response.status);
      // 404 stays: that's a forwarder without this route, which says nothing about the device.
      if ([401, 410].includes(response.status)) {
        devices.remove(device.id);
        log.warn(`moonstone: removed ${device.id}, the forwarder answered ${response.status}`);
      } else if (response.status !== 200) {
        log.warn(`moonstone: forwarder answered ${response.status}`);
      }
      return response.status;
    }

    /** The gateway's presence list, once the service has started (`readPresence`). */
    let presence                                             = async () => undefined;
    /** A chat's read state with the presence list, read together, once the service has started. */
    let readState                                                                                                = async () => undefined;

    /** Replies quieted for a device while another was the one in use, by device and chat: the latest
     * of them, and the timer that looks again (PROTOCOL.md, In use elsewhere). */
    const held = new Map                                                                                        ();
    let stopped = false;

    /** One hold per device and chat: a guest's reply is held with the chat it was tagged into. */
    const holdKey = (deviceId        , sessionKey        ) => `${deviceId}\n${hostKey(sessionKey) ?? sessionKey}`;

    /** Holds a quieted reply until the other device's use would have lapsed: two minutes in use
     * after its last stamp, which follows its last input by up to a beat. The first deadline
     * stands, so replies that keep coming can't put it off. */
    function hold(device        , message         ) {
      const key = holdKey(device.id, message.sessionKey );
      const pending = held.get(key);
      if (pending && !pending.checking) return void (pending.message = message);
      const timer = setTimeout(() => void recheck(key), RECHECK_MS);
      timer.unref?.();
      held.set(key, { message, timer });
    }

    /** A newer alert for that chat reached the device: what was held is old news. */
    function release(deviceId        , sessionKey        ) {
      const key = holdKey(deviceId, sessionKey);
      clearTimeout(held.get(key)?.timer);
      held.delete(key);
    }

    /** A held reply alerts after all if its chat is still unread and this device is now the one
     * used most recently: someone who left the Mac without reading gets it on the phone. Read by
     * this point, or the other device still in use, and it goes no further. */
    async function recheck(key        ) {
      const pending = held.get(key);
      if (!pending) return;
      pending.checking = true;
      try {
        // Read on the reply's own session: a guest's has read state of its own.
        const state = await readState(pending.message.sessionKey ).catch(() => undefined);
        // Released meanwhile by a newer alert, replaced, or the plugin stopped: nothing more here.
        if (held.get(key) !== pending || stopped) return;
        held.delete(key);
        if (state?.unread === false) return;
        // The registration as it is now: removed, muted or given new keys while this waited.
        const device = devices.list().find((d) => d.id === key.split("\n")[0]);
        if (!device) return;
        const out = whileInUseElsewhere(forDevice(pending.message, device.muted), device, state?.presence);
        if (out.kind === "reply") await deliver(device, out);
      } catch (error) {
        log.warn(`moonstone: held reply failed: ${error}`);
      } finally {
        if (held.get(key) === pending) held.delete(key);
      }
    }

    /** Approvals and questions kept from a device while another is the one in use, by device and
     * request: the timer that sends one after all if nobody answered it (PROTOCOL.md, In use elsewhere). */
    const waiting = new Map                                       ();
    const requestId = (message         ) => message.kind === "approval" ? `approval:${message.approvalId}` : `question:${message.questionId}`;
    /** Requests already alerted on each device, by device and request: one the gateway sends again
     * alerts once. */
    const alerted = new Set        ();
    /** Moves on each stop: work begun before it sends nothing after it. */
    let generation = 0;
    const lapsed = (expiresAtMs                    ) => typeof expiresAtMs === "number" && expiresAtMs <= Date.now();

    function unhold(key        ) {
      clearTimeout(waiting.get(key));
      waiting.delete(key);
    }

    /** A request's alert on one device, once: what was held for it there goes with it. */
    function alertRequest(device        , message         , request        ) {
      const key = `${device.id}\n${request}`;
      unhold(key);
      if (alerted.has(key)) return;
      alerted.add(key);
      if (alerted.size > 1000) alerted.delete(alerted.values().next().value );
      deliver(device, message).catch((error) => log.warn(`moonstone: send failed: ${error}`));
    }

    /** The device in use shows a request at once, in the app. The others get it only if it's still
     * unanswered after a wait, so answering it there leaves no stale alert on them. An answer given
     * while an observer was offline goes unheard and the alert goes anyway; the app clears it on its
     * next connect, as it does any alert for a request no longer pending. */
    function holdRequest(device        , message         , ms        , expiresAtMs                    , run        ) {
      const request = requestId(message);
      const key = `${device.id}\n${request}`;
      if (alerted.has(key)) return;
      clearTimeout(waiting.get(key));
      const timer = setTimeout(() => {
        waiting.delete(key);
        if (run !== generation || settled.has(request) || lapsed(expiresAtMs)) return;
        // The registration as it is now.
        const current = devices.list().find((d) => d.id === device.id);
        if (current) alertRequest(current, message, request);
      }, ms);
      timer.unref?.();
      waiting.set(key, timer);
    }

    /** Requests answered lately, for one answered while its alert was still being worked out. */
    const settled = new Set        ();

    /** Answered, on any device: nothing more is sent for it. */
    function answered(request        ) {
      settled.add(request);
      if (settled.size > 500) settled.delete(settled.values().next().value );
      for (const key of waiting.keys()) if (key.endsWith(`\n${request}`)) unhold(key);
    }

    /** `judged` false: a reply the app doesn't alert for (a `chat.inject` message),
     * so no device is quieted for it, and each alerts as sent. `expiresAtMs`: when a request lapses. */
    /** `run`: the `generation` the event arrived in, so one still being worked out at a stop sends nothing. */
    /** `toldIn`: a failed task's alert whose agent already told the person in that chat, for the
     * devices that alert that chat's reply to skip (`HeldFailures`). */
    async function send(message                , handled = new Set        (), { judged = true, expiresAtMs, run = generation, toldIn }                                                                            = {}) {
      if (!message) return;
      try {
        // A reply, an approval and a question wait when the person is using the app on another known device.
        const request = message.kind === "approval" || message.kind === "question" ? requestId(message) : undefined;
        const waits = judged && (message.kind === "reply" || !!request) && !message.test && devices.list().some((device) => device.gatewayDevice);
        const present = waits ? await presence().catch(() => undefined) : undefined;
        // Stopped, answered or lapsed while presence was read: nothing goes out.
        if (run !== generation) return;
        if (request && (settled.has(request) || lapsed(expiresAtMs))) return;
        // Read after the wait: a device removed or changed meanwhile goes as it is now.
        for (const device of devices.list()) {
          if (toldIn && forDevice({ v: 2, kind: "reply", sessionKey: toldIn }, device.muted).kind === "reply") continue;
          if (handled.has(device.id)) {
            // Shown there already: nothing held for it there goes either.
            if (request) unhold(`${device.id}\n${request}`);
            continue;
          }
          if (request && inUseElsewhere(device, present)) {
            const ms = requestHoldMs(expiresAtMs);
            if (ms > 0) { holdRequest(device, message, ms, expiresAtMs, run); continue; }
          }
          const shaped = forDevice(message, device.muted);
          const out = judged ? whileInUseElsewhere(shaped, device, present) : shaped.kind === "reply" ? { ...shaped, chosen: true } : shaped;
          if (request) { alertRequest(device, out, request); continue; }
          if (shaped.kind === "reply" && out.kind === "refresh" && shaped.sessionKey) hold(device, shaped);
          else if (out.kind === "reply" && out.sessionKey) release(device.id, out.sessionKey);
          deliver(device, out).catch((error) => log.warn(`moonstone: send failed: ${error}`));
        }
      } catch (error) {
        log.warn(`moonstone: send failed: ${error}`);
      }
    }

    // The app registers itself over its own connection, so no key or token is typed anywhere.
    api.registerGatewayMethod("moonstone.notifications.status", ({ respond }) => {
      respond(true, {
        version: VERSION,
        protocol: PROTOCOL,
        liveActivities: 2,
        // Devices may send the chats they muted (PROTOCOL.md, Muted chats).
        mutes: 1,
        ...(connectorApprovals ? { connectorApprovals: 1 } : {}),
        listening,
        devices: devices.list().map(({ id, name, text }) => ({ id, name, text, delivery: deliveries.get(id) })),
      });
    }, { scope: "operator.read" });

    api.registerGatewayMethod("moonstone.notifications.register", ({ params, respond, client }) => {
      if (!canRegister(client?.connect?.scopes)) return respond(false, undefined, { code: "FORBIDDEN", message: "needs operator.approvals and operator.questions" });
      const parsed = parseDevice(params);
      if (!parsed) return respond(false, undefined, { code: "INVALID_REQUEST", message: "invalid device" });
      // Which app this is in the presence list, and whose: from the connection, not from what it sent.
      const device = { ...parsed, gatewayDevice: client?.connect?.device?.id, person: client?.authenticatedUserProfile?.profileId ?? client?.authenticatedUserId };
      devices.add(device);
      activities.register(device);
      respond(true, { ok: true });
    }, { scope: "operator.write" });

    api.registerGatewayMethod("moonstone.notifications.unregister", ({ params, respond, client }) => {
      if (!canRegister(client?.connect?.scopes)) return respond(false, undefined, { code: "FORBIDDEN", message: "needs operator.approvals and operator.questions" });
      activities.remove(String(params?.id));
      respond(true, { removed: devices.remove(String(params?.id)) });
    }, { scope: "operator.write" });

    api.registerGatewayMethod("moonstone.notifications.test", async ({ params, respond }) => {
      const device = devices.list().find((d) => d.id === params?.id);
      if (!device) return respond(false, undefined, { code: "INVALID_REQUEST", message: "unknown device" });
      // `test` is the app's own nonce: a test passes on this alert, not on any alert that shows up.
      const test = typeof params?.test === "string" ? params.test.slice(0, 64) : undefined;
      const status = await deliver(device, { v: 2, kind: "reply", title: "Moonstone notifications", body: "Sealed on your gateway, opened on this device.", test }).catch(() => 0);
      respond(true, { status });
    }, { scope: "operator.write" });

    // From 2026.11.10 a failure goes to the agent of the chat the job was made in first: failures.ts.
    const failures = new HeldFailures((message, toldIn) => send(message, undefined, { toldIn }));
    const holdsFailures = repairsFailures(api.runtime?.version);
    api.on("cron_changed", (event) => {
      const message = failedJobMessage(event);
      if (message && holdsFailures && event.jobId) failures.failed(event.jobId, message);
      else send(message);
    });
    // A helper's start and end, named by the chat that spawned it: that chat's row keeps working
    // through a turn that ends while its helpers do, until their results are announced.
    api.on("subagent_progress", (event, ctx) => activities.helper(ctx?.requesterSessionKey, event?.childSessionKey, event?.phase === "started"));
    api.on("subagent_ended", (event, ctx) => activities.helper(ctx?.requesterSessionKey, event?.targetSessionKey, false));

    const seen = new Set        ();
    const posted = new Set        ();
    let stopAll                    = [];

    api.registerService({
      id: "moonstone",
      async start(ctx) {
        stopped = false;
        const offEvents = api.runtime.events.onAgentEvent((event) => {
          const { sessionKey, runId, data } = event;
          if (sessionKey && event.stream === "lifecycle") {
            if (data?.phase === "start") activities.start(sessionKey, runId, typeof data.startedAt === "number" ? data.startedAt / 1000 : undefined);
            else if (data?.phase !== "end" && data?.phase !== "error") activities.resume(sessionKey, runId);
            if (data?.phase === "error") failures.ended(sessionKey, false, runId);
            if (data?.phase === "end" || data?.phase === "error") activities.end(sessionKey, runId, data.aborted === true ? "stopped" : data.phase === "error" || data.error ? "failed" : "replied", data.yielded === true);
          }
          if (sessionKey && (event.stream === "subagent" || (event.stream === "tool" && data?.name === "sessions_spawn"))) activities.progress(sessionKey, runId);
          if (event.stream !== "lifecycle" || event.data?.phase !== "end") return;
          // A run's end can be republished: one push per run.
          if (seen.has(event.runId)) return;
          seen.add(event.runId);
          if (seen.size > 500) seen.delete(seen.values().next().value );
          const reply = replyMessage(event);
          // A yielded run is still waiting on its helpers: its reply comes at its real end.
          if (sessionKey && event.data.yielded !== true) failures.ended(sessionKey, reply?.kind === "reply", runId);
          send(reply);
        });

        // An automation's post, or a message posted with `chat.inject`, lands in its chat by a
        // transcript commit, not a run of the chat's own. A retried commit can publish the same
        // message again: one push per message.
        const offPosts = api.runtime.events.onSessionTranscriptUpdate((update) => {
          const brief = repairBrief(update);
          if (brief) failures.brief(brief);
          const automation = automationPostMessage(update);
          const message = automation ?? injectedMessage(update);
          if (!message) return;
          const id = update.messageId;
          if (id) {
            if (posted.has(id)) return;
            posted.add(id);
            if (posted.size > 500) posted.delete(posted.values().next().value );
          }
          // Moonstone on the Mac alerts for an automation's post but not for a `chat.inject` message.
          send(message, undefined, { judged: !!automation });
        });

        // Approvals: the SDK's client for approval channels sees every approval with
        // `operator.approvals` alone.
        const approvals = await createOperatorApprovalsGatewayClient({
          config: ctx.config,
          clientDisplayName: "Moonstone notifications",
          onEvent: (frame) => {
            const payload = frame.payload                       ;
            // `openclaw.approval.*` is a change to the gateway's own setup an agent asked for.
            if (!["exec.approval.", "plugin.approval.", "openclaw.approval."].some(prefix => frame.event.startsWith(prefix))) return;
            const resolved = frame.event.endsWith(".resolved");
            if (resolved) answered(`approval:${payload.id}`);
            const expiry = { expiresAtMs: typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : undefined, run: generation };
            void activities.human(payload.request?.sessionKey, `${frame.event.split(".")[0]}:${payload.id}`, resolved)
              .then(handled => send(approvalMessage(frame.event, payload), handled, expiry))
              .catch(() => send(approvalMessage(frame.event, payload), undefined, expiry));
          },
          onHelloOk: () => { listening.approvals = true; },
          onClose: () => { listening.approvals = false; },
        });
        approvals.start();

        // Questions have no such client, so this one signs in like any operator, to this gateway.
        const auth = resolveGatewayAuth({ authConfig: ctx.config.gateway?.auth, env: process.env });
        const scheme = ctx.config.gateway?.tls?.enabled ? "wss" : "ws";
        const url = `${scheme}://127.0.0.1:${ctx.config.gateway?.port ?? 18789}`;
        presence = () => readPresence(url, auth);
        // Each read stands on its own: presence showing the other device still in use counts even
        // if the read state didn't come, and a read chat counts even if presence didn't.
        readState = (sessionKey) => askGateway(url, auth, async (client) => {
          const within = (read              ) => Promise.race([read.catch(() => undefined), new Promise           ((done) => setTimeout(done, 1_500).unref?.())]);
          const [list, described] = await Promise.all([within(client.request("system-presence")), within(client.request("sessions.describe", { key: sessionKey }))]);
          return { presence: presenceList(list), unread: described?.session?.unread };
        });
        const questions = new GatewayClient({
          url,
          token: auth.token,
          password: auth.password,
          clientName: "gateway-client",
          clientDisplayName: "Moonstone notifications",
          mode: "backend",
          scopes: ["operator.questions"],
          onEvent: (frame) => {
            if (frame.event !== "question.requested" && frame.event !== "question.resolved") return;
            const payload = frame.payload                       ;
            if (frame.event === "question.resolved") answered(`question:${payload.id}`);
            const expiry = { expiresAtMs: typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : undefined, run: generation };
            void activities.human(payload.sessionKey, `question:${payload.id}`, frame.event === "question.resolved")
              .then(handled => send(questionMessage(frame.event, payload), handled, expiry))
              .catch(() => send(questionMessage(frame.event, payload), undefined, expiry));
          },
          onHelloOk: () => { listening.questions = true; },
          onClose: () => { listening.questions = false; },
        });
        questions.start();

        stopAll = [offEvents, offPosts, () => approvals.stop(), () => questions.stop()];
      },
      stop() {
        failures.close();
        for (const stop of stopAll) stop();
        stopAll = [];
        stopped = true;
        generation++;
        for (const { timer } of held.values()) clearTimeout(timer);
        held.clear();
        for (const timer of waiting.values()) clearTimeout(timer);
        waiting.clear();
        activities.close();
      },
    });
  },
});
