





// OpenClaw 2026.10.7's node.list retains these handshake fields, but RuntimeNodeListResult
// omits them. See node-catalog-read.ts and server-plugins-node-runtime.ts upstream.


const families           = ["iPhone", "iPad", "Mac"];
const day = "A day (2026-11-06) or a local date and time (2026-11-06T10:00), in the user's time zone.";
const reach = (family        ) => family === "Mac"
  ? "Reaches the user's Mac through the Clawy app, whenever Clawy is running there, automations included. The user may be asked to allow each request, and nobody may be at the Mac to answer."
  : `Reaches the user's ${family} through the Clawy app, so it works only while Clawy is open or was just used; it fails when the ${family} is locked or Clawy is closed, so don't rely on it in automations. The user may be asked to allow each request.`;
const object = (properties        , required           = [])         => ({ type: "object", properties, required, additionalProperties: false });
const string = (description         )         => ({ type: "string", ...description ? { description } : {} });

// The public plugin owns the agent-facing catalog; App/Node/{PhoneTools,DisplayTools}.swift
// owns device-side validation and execution. Keep functional parameters aligned with those handlers.
// A fixed catalog avoids claude-cli replacing its resumed session when a device disconnects (#276).
const definitions               = [
  {
    suffix: "health", command: "clawy.health.query", mobileOnly: true,
    description: f => `Reads the user's Apple Health data, summed up per day on their ${f}: steps, walking and running distance, active energy, exercise minutes, resting heart rate, heart rate variability, sleep (time asleep, stages, when they fell asleep and woke up), weight, mindful minutes, and workouts. Use it when the user asks about their activity, sleep, fitness or health trends. ${reach(f)}`,
    parameters: object({
      start: string(`First day, inclusive. ${day} Defaults to 6 days before end.`),
      end: string("Last day, inclusive. Defaults to today. At most 92 days in all."),
      metrics: { type: "array", items: { type: "string", enum: ["steps", "distance", "activeEnergy", "exercise", "restingHeartRate", "heartRateVariability", "sleep", "weight", "mindfulness", "workouts"] }, description: "Only these. Defaults to all." },
    }),
  },
  {
    suffix: "location", command: "clawy.location.current", mobileOnly: true,
    description: f => `Gets where the user's ${f} is right now, with the area's name, and the place and street address when precise. Use it when the user asks about something near them, how far something is, or where they are. ${reach(f)}`,
    parameters: object({ precise: { type: "boolean", description: "Street-level position and address. Defaults to false: the city or neighborhood, about 1 km." } }),
  },
  {
    suffix: "calendar_events", command: "clawy.calendar.events",
    description: f => `Lists events from every calendar on the user's ${f} (iCloud, Google, Exchange and others), with times, location, notes and attendees. Use it for questions about their schedule or free time. ${reach(f)}`,
    parameters: object({
      start: string(`From. ${day} Defaults to the start of today.`),
      end: string("Until; a day alone includes that whole day. Defaults to 7 days after start. At most a year."),
      query: string("Only events whose title, location or notes contain this."),
    }),
  },
  {
    suffix: "calendar_add", command: "clawy.calendar.add",
    description: f => `Adds an event to the user's calendar on their ${f}. Use it when the user asks you to put something on their calendar. ${reach(f)}`,
    parameters: object({
      title: string(), start: string(`${day} A day alone makes an all-day event.`),
      end: string("Defaults to an hour after start. For all-day events, the last day, inclusive, as the events tool reports it; defaults to the start day."),
      allDay: { type: "boolean" }, location: string(), notes: string(), calendar: string("Calendar name. Defaults to the user's default calendar."),
    }, ["title", "start"]),
  },
  {
    suffix: "reminders", command: "clawy.reminders.list",
    description: f => `Lists the user's reminders from the Reminders app on their ${f}, with due dates, notes, priority and list, and the names of their lists. Use it when the user asks what's on their to-do list. ${reach(f)}`,
    parameters: object({
      status: { type: "string", enum: ["incomplete", "completed", "all"], description: "Defaults to incomplete." },
      list: string("Only this list."), query: string("Only reminders whose title or notes contain this."),
      limit: { type: "integer", description: "Defaults to 100, at most 300." },
    }),
  },
  {
    suffix: "reminders_add", command: "clawy.reminders.add",
    description: f => `Adds a reminder to the Reminders app on the user's ${f}. A due time makes it alert then. Use it when the user asks to be reminded of something. ${reach(f)}`,
    parameters: object({
      title: string(), due: string(`${day} With a time, the reminder alerts then.`), notes: string(), list: string("List name. Defaults to the user's default list."),
      priority: { type: "string", enum: ["low", "medium", "high"] },
    }, ["title"]),
  },
  {
    suffix: "contacts", command: "clawy.contacts.search",
    description: f => `Searches the user's contacts on their ${f} by name, nickname, company, email or phone number, and returns each match's phone numbers, emails, postal addresses, birthday, job and related people ("mother", "partner"). Use it when the user asks for someone's details, or when you need a number, email or address for someone they name. ${reach(f)}`,
    parameters: object({ query: string('Words from the name or company ("luca rossi", "dentist"), an email, or part of a phone number.'), limit: { type: "integer", description: "Defaults to 10, at most 25." } }, ["query"]),
  },
  {
    suffix: "chats", command: "clawy.topics.list",
    description: f => `Lists the chats in the user's Clawy app, exactly as its chat list shows them, for every agent: open ones in list order, snoozed ones, and how many are archived. It's the only way to see this list: the gateway's sessions hold much that isn't in it and can't show what the user added to it. Use it when the user asks what chats they have or what's in Clawy. ${reach(f)}`,
    parameters: object({ archived: { type: "boolean", description: "Also list archived chats. Defaults to false." } }),
  },
  {
    suffix: "chats_update", command: "clawy.chats.update",
    description: f => `Archives, unarchives, snoozes, wakes or renames chats in the user's Clawy chat list, by the keys the chats tool lists. Use it when the user asks you to tidy or change their chat list. The user confirms each call on their ${f}, so put every chat for one action in one call. Chats an automation posts into aren't archived: the user does that in Clawy. Reaches the user's ${f} through the Clawy app, only while it's open.`,
    parameters: object({
      action: { type: "string", enum: ["archive", "unarchive", "snooze", "wake", "rename"] },
      chats: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50, description: "The chats' keys, as the chats tool lists them." },
      until: string(`Snooze only: when it comes back. ${day} A day alone wakes in the morning.`), title: string("Rename only: the new title, for one chat."),
    }, ["action", "chats"]),
  },
  {
    suffix: "places", command: "clawy.places.show",
    description: () => "Shows places on a map in the user's Clawy chat, with a numbered row for each; tapping one opens it in Apple Maps. Use it whenever your answer suggests real places to go (restaurants, cafés, sights, shops, venues), then write your reply around it without listing them again. Clawy finds each place in Maps by its name and address, so give the address with its city. The map shows on every device the chat is open on, so call only one device's copy, once per set of places. It works only in Clawy chats: elsewhere it fails, and you write the places as text.",
    parameters: object({ places: { type: "array", minItems: 1, maxItems: 20, items: object({
      name: string("The place's own name, as Maps would list it."), address: string("Street address with the city, or at least the neighborhood and city."), note: string("One short line on why it's worth going."),
    }, ["name", "address"]) } }, ["places"]),
  },
];

function target(nodes        , family        , command        , nodeId         )       {
  const matching = nodes.filter(node => node.connected === true && ["openclaw-ios", "openclaw-macos"].includes(node.clientId ?? "") && node.clientMode === "node"
    && node.deviceFamily === family && node.commands?.includes(command));
  const selected = nodeId === undefined ? matching : matching.filter(node => node.nodeId === nodeId);
  if (selected.length === 0) throw new Error(`Open Clawy on the ${family}${typeof nodeId === "string" ? ` (${nodeId})` : ""} and enable Share with Agents for this gateway, then try again.`);
  if (selected.length > 1) throw new Error(`More than one Clawy ${family} is connected. Ask the user which device to use and pass its nodeId: ${selected.map(node => `${node.displayName ?? family} (${node.nodeId})`).join(", ")}.`);
  return selected[0];
}

/** Registration never reads node inventory or source-sharing choices. Only execution does. */
export function registerDeviceTools(api                                                                               )       {
  const catalog = families.flatMap(family => definitions.filter(tool => family !== "Mac" || !tool.mobileOnly).map(tool => ({ family, tool, name: `clawy_${family.toLowerCase()}_${tool.suffix}` })));
  api.registerTool(ctx => catalog.map(({ family, tool, name })               => ({
    name, label: name, description: tool.description(family),
    parameters: { ...tool.parameters, properties: { ...tool.parameters.properties          , nodeId: string("Only when choosing between multiple Clawy devices of this kind: the exact nodeId to use.") } }                              ,
    async execute(toolCallId, args, signal) {
      // Identity belongs to the host's tool factory, never to arguments supplied by the model.
      if (!ctx.sessionKey?.trim()) throw new Error("Clawy device tools need the current conversation's session key.");
      signal?.throwIfAborted();
      const { nodeId, ...params } = args                           ;
      if (nodeId !== undefined && (typeof nodeId !== "string" || !nodeId.trim())) throw new Error("nodeId must be the exact non-empty device identifier.");
      const allowed = new Set(Object.keys(tool.parameters.properties          ));
      if (Object.keys(params).some(key => !allowed.has(key))) throw new Error("Unknown Clawy tool parameter.");
      const { nodes } = await api.runtime.nodes.list({ connected: true });
      signal?.throwIfAborted();
      const node = target(nodes          , family, tool.command, nodeId);
      ctx.assertInvocationCurrent?.();
      // One selected node and one attempt. Refusal or timeout must never try another device.
      const result = await api.runtime.nodes.invoke({ nodeId: node.nodeId, command: tool.command, params, timeoutMs: 30_000, sessionKey: ctx.sessionKey, idempotencyKey: toolCallId, signal });
      signal?.throwIfAborted();
      const payload = result && typeof result === "object" && "payload" in result ? result.payload : result;
      return { content: [{ type: "text", text: JSON.stringify(payload) ?? "null" }], details: payload };
    },
  })), { names: catalog.map(({ name }) => name) });
  api.registerGatewayMethod("clawy.devices.status", ({ respond }) => respond(true, { protocol: 2 }), { scope: "operator.read" });
}
