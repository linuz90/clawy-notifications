import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { existsSync, readFileSync } from "node:fs";
import { isClawyNode } from "./device-tools.ts";

// What agents read when the person asks what they can do in Clawy: plugins/guide.md, shipped with
// the plugin so it changes with each build that installs it, not with app code. Two candidates,
// since this file runs from openclaw/ in tests and from openclaw/dist/ once installed; both point
// at the plugin's root. Read on each call, so an edit on a dev gateway shows without a restart.
const candidates = [new URL("../guide.md", import.meta.url), new URL("../../guide.md", import.meta.url)];

export const guideToolName = "clawy_guide";

export const guideDescription = "What the person can do with you in Clawy, the iPhone, iPad and Mac app they are chatting with you in, and how to set each thing up. Call it when they ask what you can do here or how Clawy works, and when they want you to use a service you have no tools for yet, before answering.";

export function readGuide(): string {
  const file = candidates.find(url => existsSync(url));
  if (!file) throw new Error("The Clawy guide is missing from this plugin. Reinstall the Clawy Plugin.");
  return readFileSync(file, "utf8");
}

/** The guide, then what's true on this gateway right now: which Clawy devices share with agents. */
export function registerGuideTool(api: Pick<OpenClawPluginApi, "registerTool" | "runtime">, version: string): void {
  api.registerTool(() => [{
    name: guideToolName, label: guideToolName, description: guideDescription,
    parameters: { type: "object", properties: {}, additionalProperties: false } as AnyAgentTool["parameters"],
    async execute() {
      const lines = [`- OpenClaw, with the Clawy Plugin ${version}.`];
      try {
        const { nodes } = await api.runtime.nodes.list({ connected: true });
        const sharing = nodes.filter(node => isClawyNode(node as Parameters<typeof isClawyNode>[0]))
          .map(node => (node as { deviceFamily?: string }).deviceFamily ?? node.displayName ?? "a device");
        lines.push(sharing.length ? `- Sharing with agents right now: ${sharing.join(", ")}.` : "- No Clawy device is sharing with agents right now.");
      } catch {
        // The guide still answers without the live line.
      }
      const text = `${readGuide().trimEnd()}\n\n## On this gateway\n\n${lines.join("\n")}\n`;
      return { content: [{ type: "text", text }], details: { version } };
    },
  }], { names: [guideToolName] });
}
