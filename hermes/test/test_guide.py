import unittest
from pathlib import Path

# The suite loads the plugin as a package of its own (`test_notifications`).
if __package__:
    from . import test_notifications  # noqa: F401
else:
    import test_notifications  # noqa: F401
from moonstone_test_plugin import guide


class Context:
    def __init__(self):
        self.tools = []

    def register_tool(self, **tool):
        self.tools.append(tool)


class GuideTest(unittest.TestCase):
    def test_registers_one_tool_that_answers_with_the_guide(self):
        ctx = Context()
        guide.register(ctx, "9.9.9")
        [tool] = ctx.tools
        self.assertEqual((tool["name"], tool["toolset"], tool["schema"]["name"]), ("moonstone_guide", "moonstone", "moonstone_guide"))
        text = tool["handler"]({})
        self.assertTrue(text.startswith("# Moonstone, for agents"))
        self.assertIn('## How this guide works', text)
        self.assertIn("Moonstone Plugin 9.9.9", text)

    def test_ships_the_same_guide_as_the_openclaw_plugin(self):
        here = Path(guide.__file__).parent
        self.assertEqual((here / "guide.md").read_text(encoding="utf-8"), (here.parent / "guide.md").read_text(encoding="utf-8"),
                         "run `npm run build` in plugins/ to copy guide.md into hermes/")


if __name__ == "__main__":
    unittest.main()
