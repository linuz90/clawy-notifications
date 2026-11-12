// Clawy notifications for OpenClaw. It watches this gateway for what needs a person (replies,
// automation posts, approvals, questions, failed scheduled tasks), seals each to the devices
// registered here, and posts the ciphertext to Clawy's forwarder, which holds Apple's push key and
// nothing that opens it. It reads no conversation history and needs no `allowConversationAccess`. See README.md.
import { createOperatorApprovalsGatewayClient, GatewayClient, resolveGatewayAuth } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { join } from "node:path";
import { canRegister, DeviceFile, parseDevice, Sequence,             } from "./devices.js";
import { approvalMessage, automationPostMessage, failedJobMessage, questionMessage, replyMessage,              } from "./route.js";
import { fit, seal } from "./seal.js";
import { Activities } from "./activity.js";

const VERSION = "0.3.0";
/** Bumped whenever a device needs something new from this plugin. PROTOCOL.md. */
const PROTOCOL = 2;

/** The last alert sent to a device: enough for its app to tell a working route from a broken one. */


export default definePluginEntry({
  id: "clawy-notifications",
  name: "Clawy notifications",
  description: "Sealed push notifications for Clawy.",
  register(api) {
    const log = api.logger;
    const state = join(api.runtime.state.resolveStateDir(process.env), "clawy-notifications");
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
        signal: AbortSignal.timeout(10_000),
      });
      const note = (status        ) => {
        // Silent pushes may be dropped by iOS as it likes, so only alerts say how the route is doing.
        if (message.kind !== "refresh") deliveries.set(device.id, { seq: stamped.seq, status, at: Date.now() });
      };
      let response          ;
      try {
        response = await post();
        if (response.status === 502) response = await post();
      } catch (error) {
        note(0);
        throw error;
      }
      note(response.status);
      // 404 stays: that's a forwarder without this route, which says nothing about the device.
      if ([401, 410].includes(response.status)) {
        devices.remove(device.id);
        log.warn(`clawy-notifications: removed ${device.id}, the forwarder answered ${response.status}`);
      } else if (response.status !== 200) {
        log.warn(`clawy-notifications: forwarder answered ${response.status}`);
      }
      return response.status;
    }

    function send(message                , handled = new Set        ()) {
      if (!message) return;
      for (const device of devices.list()) {
        if (handled.has(device.id)) continue;
        deliver(device, message).catch((error) => log.warn(`clawy-notifications: send failed: ${error}`));
      }
    }

    // The app registers itself over its own connection, so no key or token is typed anywhere.
    api.registerGatewayMethod("clawy.notifications.status", ({ respond }) => {
      respond(true, {
        version: VERSION,
        protocol: PROTOCOL,
        liveActivities: 2,
        listening,
        devices: devices.list().map(({ id, name, text }) => ({ id, name, text, delivery: deliveries.get(id) })),
      });
    }, { scope: "operator.read" });

    api.registerGatewayMethod("clawy.notifications.register", ({ params, respond, client }) => {
      if (!canRegister(client?.connect?.scopes)) return respond(false, undefined, { code: "FORBIDDEN", message: "needs operator.approvals and operator.questions" });
      const device = parseDevice(params);
      if (!device) return respond(false, undefined, { code: "INVALID_REQUEST", message: "invalid device" });
      devices.add(device);
      activities.register(device);
      respond(true, { ok: true });
    }, { scope: "operator.write" });

    api.registerGatewayMethod("clawy.notifications.unregister", ({ params, respond, client }) => {
      if (!canRegister(client?.connect?.scopes)) return respond(false, undefined, { code: "FORBIDDEN", message: "needs operator.approvals and operator.questions" });
      activities.remove(String(params?.id));
      respond(true, { removed: devices.remove(String(params?.id)) });
    }, { scope: "operator.write" });

    api.registerGatewayMethod("clawy.notifications.test", async ({ params, respond }) => {
      const device = devices.list().find((d) => d.id === params?.id);
      if (!device) return respond(false, undefined, { code: "INVALID_REQUEST", message: "unknown device" });
      // `test` is the app's own nonce: a test passes on this alert, not on any alert that shows up.
      const test = typeof params?.test === "string" ? params.test.slice(0, 64) : undefined;
      const status = await deliver(device, { v: 2, kind: "reply", title: "Clawy notifications", body: "Sealed on your gateway, opened on this device.", test }).catch(() => 0);
      respond(true, { status });
    }, { scope: "operator.write" });

    api.on("cron_changed", (event) => send(failedJobMessage(event)));
    // A helper's start and end, named by the chat that spawned it: that chat's row keeps working
    // through a turn that ends while its helpers do, until their results are announced.
    api.on("subagent_progress", (event, ctx) => activities.helper(ctx?.requesterSessionKey, event?.childSessionKey, event?.phase === "started"));
    api.on("subagent_ended", (event, ctx) => activities.helper(ctx?.requesterSessionKey, event?.targetSessionKey, false));

    const seen = new Set        ();
    const posted = new Set        ();
    let stopAll                    = [];

    api.registerService({
      id: "clawy-notifications",
      async start(ctx) {
        const offEvents = api.runtime.events.onAgentEvent((event) => {
          const { sessionKey, runId, data } = event;
          if (sessionKey && event.stream === "lifecycle") {
            if (data?.phase === "start") activities.start(sessionKey, runId, typeof data.startedAt === "number" ? data.startedAt / 1000 : undefined);
            else if (data?.phase !== "end" && data?.phase !== "error") activities.resume(sessionKey, runId);
            if (data?.phase === "end" || data?.phase === "error") activities.end(sessionKey, runId, data.aborted === true ? "stopped" : data.phase === "error" || data.error ? "failed" : "replied", data.yielded === true);
          }
          if (sessionKey && (event.stream === "subagent" || (event.stream === "tool" && data?.name === "sessions_spawn"))) activities.progress(sessionKey, runId);
          if (event.stream !== "lifecycle" || event.data?.phase !== "end") return;
          // A run's end can be republished: one push per run.
          if (seen.has(event.runId)) return;
          seen.add(event.runId);
          if (seen.size > 500) seen.delete(seen.values().next().value );
          send(replyMessage(event));
        });

        // An automation's post lands in its chat by a transcript commit, not a run of the chat's own.
        // A retried commit can publish the same message again: one push per message.
        const offPosts = api.runtime.events.onSessionTranscriptUpdate((update) => {
          const message = automationPostMessage(update);
          if (!message) return;
          const id = update.messageId;
          if (id) {
            if (posted.has(id)) return;
            posted.add(id);
            if (posted.size > 500) posted.delete(posted.values().next().value );
          }
          send(message);
        });

        // Approvals: the SDK's client for approval channels sees every approval with
        // `operator.approvals` alone.
        const approvals = await createOperatorApprovalsGatewayClient({
          config: ctx.config,
          clientDisplayName: "Clawy notifications",
          onEvent: (frame) => {
            const payload = frame.payload                       ;
            if (!frame.event.startsWith("exec.approval.") && !frame.event.startsWith("plugin.approval.")) return;
            const resolved = frame.event.endsWith(".resolved");
            void activities.human(payload.request?.sessionKey, `${frame.event.split(".")[0]}:${payload.id}`, resolved)
              .then(handled => send(approvalMessage(frame.event, payload), handled))
              .catch(() => send(approvalMessage(frame.event, payload)));
          },
          onHelloOk: () => { listening.approvals = true; },
          onClose: () => { listening.approvals = false; },
        });
        approvals.start();

        // Questions have no such client, so this one signs in like any operator, to this gateway.
        const auth = resolveGatewayAuth({ authConfig: ctx.config.gateway?.auth, env: process.env });
        const scheme = ctx.config.gateway?.tls?.enabled ? "wss" : "ws";
        const questions = new GatewayClient({
          url: `${scheme}://127.0.0.1:${ctx.config.gateway?.port ?? 18789}`,
          token: auth.token,
          password: auth.password,
          clientName: "gateway-client",
          clientDisplayName: "Clawy notifications",
          mode: "backend",
          scopes: ["operator.questions"],
          onEvent: (frame) => {
            if (frame.event !== "question.requested" && frame.event !== "question.resolved") return;
            const payload = frame.payload                       ;
            void activities.human(payload.sessionKey, `question:${payload.id}`, frame.event === "question.resolved")
              .then(handled => send(questionMessage(frame.event, payload), handled))
              .catch(() => send(questionMessage(frame.event, payload)));
          },
          onHelloOk: () => { listening.questions = true; },
          onClose: () => { listening.questions = false; },
        });
        questions.start();

        stopAll = [offEvents, offPosts, () => approvals.stop(), () => questions.stop()];
      },
      stop() {
        for (const stop of stopAll) stop();
        stopAll = [];
        activities.close();
      },
    });
  },
});
