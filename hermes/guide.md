# Clawy, for agents

Clawy is the iPhone, iPad and Mac app the person is using to talk to you. This is a reference to what it does, for when they ask what you can do here, how Clawy works, or how to set something up in it.

Clawy is made for working with agents rather than for messaging people. A messaging app such as Telegram, WhatsApp or Slack shows only an agent's final reply. Clawy shows the work as it happens, gives every subject a chat of its own, brings what needs the person to wherever they are, and draws replies as tables, maps, diagrams and cards.

## How this guide works

- **Labels.** Clawy works with two kinds of agent gateway, OpenClaw and Hermes Agent, on iPhone, iPad and Mac, and some features exist only on some of them. A line or heading labeled [OpenClaw] works only on an OpenClaw gateway, [Hermes] only on Hermes, and [iPhone], [iPad] or [Mac] only on those devices. A line without a label works everywhere. The last section, "On this gateway", says which kind of gateway you're on.
- **Links into Clawy.** Each place where something is set up in Clawy has a link below, like [Set it up](clawy://guide/controls). Written the same way in your reply as a Markdown link with its own words, it becomes a link the person can tap to open that place in the app.
- **The setup note.** When the person asks from Clawy's own suggestion in an empty chat, their message comes with a short note from the app on their setup: their device, what they have and haven't set up yet, and how many other agents are on this gateway.
- **Who's asking.** Clawy may be new to someone who has talked to you for a long time somewhere else, such as Telegram. Everything you know about them still applies here.
- **Wording.** The names and examples below describe what Clawy shows, so you can recognize it; they aren't wording to reuse.
- **Overviews.** Asked what Clawy is or what you can do in it, answer in under 150 words: the two or three things most useful to them now, with their links, then an offer to say more. The rest of this guide answers the follow-up questions.

## Ways to reach you

- Voice notes: hold the mic and talk, release to send, when the gateway transcribes audio.
- The Action button [iPhone]: on an iPhone that has one, one press opens a new chat already recording. Control Center and the Lock Screen have the same controls [iPhone, iPad]. [Set it up](clawy://guide/controls)
- The share sheet [iPhone, iPad]: a link, a photo, a file or text from any app goes straight into a chat. [Set it up](clawy://guide/share-sheet)
- On the Mac, ⌘N starts a chat and ⌘K jumps to one, and a chat can have a window of its own.

## Following your work

- Each step you take (a command, a search, a file) shows under your reply while you work, then folds into one line, "Worked for 2m · 6 steps", that opens again. The chat list and your face show that you're working. With the Clawy Plugin, a long run stays on the Lock Screen, and in the Dynamic Island on iPhone [iPhone, iPad].
- Helpers you start appear as cards of their own, live, which open to follow or stop [OpenClaw].
- File changes show under the turn, with a review of each change [OpenClaw]. A pull request you link shows as a card with its checks [OpenClaw].
- From the composer, the person can steer you mid-reply or stop you.
- An approval you need (a command, a plugin asking permission, a change to your setup) or a question with options waits at the foot of the chat and at the top of the chat list, and is answered in place or from its notification, without opening the chat.

## Notifications

- Clawy notifies the person when a reply finishes while they're away, and when you need them. [Notifications](clawy://settings/notifications)
- The Clawy Plugin on the gateway seals notification text so Clawy's server can't read it, and adds Live Activities [iPhone, iPad]. [Notifications](clawy://settings/notifications)

## What replies can show

- Tables, task lists, diagrams (```mermaid), maths and pictures render in the chat.
- Places go on a map with your `clawy_<device>_places` tool [OpenClaw].
- `show_widget` draws small interactive cards, such as a chart, a calculator or a tracker [OpenClaw].
- A Markdown link to another app's URL scheme opens that app, after Clawy asks the person once, such as `[Add to Things](things:///add)`.

## Chats

- Each agent has a main chat, opened from its face at the top of the chat list. A subject of its own gets its own chat, which you can open yourself [OpenClaw: `sessions_spawn` with `visible: true`].
- Chats can be pinned, snoozed and archived. You can't list them unless the person shares the Clawy Chat List.
- Conversations on Telegram, WhatsApp and other channels stay in those apps and don't appear in Clawy's chat list. Your memory carries across, so what you know from them still holds here.
- With more than one agent on the gateway, another agent can be @-tagged into a chat [OpenClaw].

## Automations

- An automation scheduled from a chat posts its results back into that chat, with a card showing when it runs next. The clock on the chat list opens all of them.

## Connectors [OpenClaw]

- Settings › Connectors lists what you can reach on this gateway: services such as Linear, Notion or Sentry, tools on the gateway such as Google through gog, and what their device shares. Each has a level per agent: Never, Ask Every Time or Always Allow. [Connectors](clawy://settings/connectors)
- When they ask for something in a service you have no tools for, or whose tools stopped working because it needs signing in again, send a link to it on a line of its own, such as [Connect Notion](clawy://settings/connectors/notion). Clawy shows it as a card that opens the service, ready to add or sign in, with owner access. Name the service as it's called (`linear`, `todoist`, `google`).

## Their device [OpenClaw, with the Clawy Plugin]

- In Connectors, This iPhone (or This Mac, This iPad) lets you read their calendar, reminders, contacts, location and Health data, and add events and reminders. Access is set per agent: Never, Ask Every Time, Add Only or Always. [This iPhone](clawy://settings/share-with-agents)
- What you read from an iPhone or iPad works only while Clawy is open there. A Mac's works whenever Clawy is running on it, so automations can use it too.
- The first setup takes owner access, or a setup code from the gateway, and Clawy walks through it.

## Making it theirs

- An agent's face: its shape, color, mood and glasses. [Your page](clawy://settings/agent)
- The accent color, typeface, replies in bubbles or plain, and the app icon. [Appearance](clawy://settings/appearance)
