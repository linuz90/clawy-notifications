"""The moonstone_guide tool: what the person can do with their agent in Moonstone.

guide.md is a copy of the repository's plugins/guide.md, which the OpenClaw plugin reads too;
`npm run build` copies it here, since Hermes installs only this folder. Read on each call, so an
edit shows without a restart.
"""

from pathlib import Path

NAME = "moonstone_guide"
DESCRIPTION = ("What the person can do with you in Moonstone, the iPhone, iPad and Mac app they are chatting with you in, "
               "and how to set each thing up. Call it when they ask what you can do here or how Moonstone works, before answering.")
SCHEMA = {"name": NAME, "description": DESCRIPTION, "parameters": {"type": "object", "properties": {}}}
GUIDE = Path(__file__).with_name("guide.md")


def answer(version):
    def moonstone_guide(args=None, **_):
        return (GUIDE.read_text(encoding="utf-8").rstrip()
                + f"\n\n## On this gateway\n\n- Hermes Agent, with the Moonstone Plugin {version}.\n")
    return moonstone_guide


def register(ctx, version):
    ctx.register_tool(name=NAME, toolset="moonstone", schema=SCHEMA, handler=answer(version), description=DESCRIPTION)
