
import { existsSync, readFileSync } from "node:fs";
import { isAppNode } from "./device-tools.js";

// What agents read when the person asks what they can do in Moonstone: plugins/guide.md, shipped with
// the plugin so it changes with each build that installs it, not with app code. Two candidates,
// since this file runs from openclaw/ in tests and from openclaw/dist/ once installed; both point
// at the plugin's root. Read on each call, so an edit on a dev gateway shows without a restart.
const candidates = [new URL("../guide.md", import.meta.url), new URL("../../guide.md", import.meta.url)];

export const guideToolName = "moonstone_guide";

export const guideDescription = "What the person can do with you in Moonstone, the iPhone, iPad and Mac app they are chatting with you in, and how to set each thing up. Call it when they ask what you can do here or how Moonstone works, and when they want you to use a service you have no tools for yet, before answering.";

export function readGuide()         {
  const file = candidates.find(url => existsSync(url));
  if (!file) throw new Error("The Moonstone guide is missing from this plugin. Reinstall the Moonstone Plugin.");
  return readFileSync(file, "utf8");
}

/** The guide, then what's true on this gateway right now: which Moonstone devices share with agents. */
export function registerGuideTool(api                                                     , version        )       {
  api.registerTool(() => [{
    name: guideToolName, label: guideToolName, description: guideDescription,
    parameters: { type: "object", properties: {}, additionalProperties: false }                              ,
    async execute() {
      const lines = [`- OpenClaw, with the Moonstone Plugin ${version}.`];
      try {
        const { nodes } = await api.runtime.nodes.list({ connected: true });
        const sharing = nodes.filter(node => isAppNode(node                                   ))
          .map(node => (node                             ).deviceFamily ?? node.displayName ?? "a device");
        lines.push(sharing.length ? `- Sharing with agents right now: ${sharing.join(", ")}.` : "- No Moonstone device is sharing with agents right now.");
      } catch {
        // The guide still answers without the live line.
      }
      const text = `${readGuide().trimEnd()}\n\n## On this gateway\n\n${lines.join("\n")}\n`;
      return { content: [{ type: "text", text }], details: { version } };
    },
  }], { names: [guideToolName] });
}
