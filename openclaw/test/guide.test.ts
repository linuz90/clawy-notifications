import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { guideToolName, registerGuideTool } from "../guide.ts";

function harness(list: () => Promise<any>) {
  let factory: any;
  let names: string[] = [];
  registerGuideTool({ registerTool: (registered: any, options: any) => { factory = registered; names = options.names; }, runtime: { nodes: { list } } } as any, "9.9.9");
  return { names, tool: () => factory({ sessionKey: "agent:juno:ios-native-chat" })[0] };
}

test("the guide tool returns the guide, then which Clawy devices share right now", async () => {
  const h = harness(async () => ({ nodes: [
    { nodeId: "mac-1", clientId: "openclaw-macos", clientMode: "node", deviceFamily: "Mac", connected: true, commands: ["clawy.places.show"] },
    { nodeId: "openclaw-app", clientId: "openclaw-ios", clientMode: "node", deviceFamily: "iPhone", connected: true, commands: ["canvas.present"] },
    { nodeId: "other", clientId: "some-other-node", deviceFamily: "Linux", connected: true },
  ] }));
  assert.deepEqual(h.names, [guideToolName]);
  const text = (await h.tool().execute("call-1", {})).content[0].text;
  assert.ok(text.startsWith(readFileSync(new URL("../../guide.md", import.meta.url), "utf8").trimEnd()));
  assert.match(text, /Clawy Plugin 9\.9\.9/);
  // Only Clawy's own node: OpenClaw's app shares its client id, and other nodes aren't devices.
  assert.match(text, /Sharing with agents right now: Mac\.\n/);
});

test("without a node inventory the guide still answers", async () => {
  const text = (await harness(async () => { throw new Error("no nodes"); }).tool().execute("call-1", {})).content[0].text;
  assert.match(text, /## How this guide works/);
  assert.doesNotMatch(text, /Sharing with agents/);
});

test("Hermes ships the same guide, and the manifest declares the tool", () => {
  const guide = readFileSync(new URL("../../guide.md", import.meta.url), "utf8");
  assert.equal(readFileSync(new URL("../../hermes/guide.md", import.meta.url), "utf8"), guide, "run `npm run build` to copy plugins/guide.md into hermes/");
  const manifest = JSON.parse(readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"));
  assert.ok(manifest.contracts.tools.includes(guideToolName));
});
