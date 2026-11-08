"""Hermes observers and authenticated registration for Clawy sealed notifications."""

import asyncio
import json
import logging
import sys
import threading

from .delivery import Delivery, Devices

LOG = logging.getLogger("clawy.notifications")
VERSION = "0.3.0"
PROTOCOL = 2  # Bumped whenever a device needs something new from this plugin. PROTOCOL.md.


def reply_kind(session, platform=""):
    if platform == "clawy" or session.startswith("ios-native-"):
        return "reply"
    if (session == "main" or session.endswith(":heartbeat")
            or session.startswith(("cron:", "subagent:", "cron_"))):
        return None
    return "refresh"


class Notifications:
    def __init__(self, ctx, devices):
        self.ctx = ctx
        self.devices = devices
        self.delivery = Delivery(devices)
        self.replies = {}
        self.lock = threading.Lock()
        self.profile = ctx.profile_name or "default"
        self.active = True

    def close(self):
        self.active = False
        self.delivery.close()

    def route(self, kind, session, **fields):
        if not isinstance(session, str) or not session:
            return
        alert = {"v": 2, "kind": kind, "agentId": self.profile,
                 "sessionKey": f"agent:{self.profile}:{session}", **fields}
        self.delivery.submit(alert)

    def capture(self, session_id="", turn_id=None, assistant_response="", platform="", **_):
        if (isinstance(assistant_response, str) and isinstance(session_id, str)
                and reply_kind(session_id, platform) == "reply"):
            with self.lock:
                # Keep only text needed by the fixed-size record, never history or prompts.
                self.replies[(session_id, turn_id)] = assistant_response[:2048]
                while len(self.replies) > 128:
                    self.replies.pop(next(iter(self.replies)))

    def ended(self, session_id="", turn_id=None, completed=False, failed=False, interrupted=False, platform="", **_):
        with self.lock:
            body = self.replies.pop((session_id, turn_id), None)
        if not isinstance(session_id, str) or not session_id or interrupted or not (completed or failed):
            return
        cron = self.ctx.current_cron_execution()
        if cron is not None:
            if failed:
                self.route("task-failed", session_id, title="Scheduled task failed", jobId=cron.job_id)
            return
        kind = reply_kind(session_id, platform)
        if kind:
            fields = {"title": "New reply"} if kind == "reply" else {}
            if kind == "reply" and body:
                fields["body"] = body
            self.route(kind, session_id, **fields)

    def human(self, kind="", request_id="", session_id="", prompt="", **_):
        if not request_id:
            return
        if kind == "approval":
            self.route("approval", session_id, title="Approval needed", body=prompt,
                       approvalId="hermes:" + request_id)
        elif kind == "clarify":
            self.route("question", session_id, title="A question for you", body=prompt,
                       questionId="hermes:" + request_id)

    def wire(self, app, adapter):
        from aiohttp import web  # Already part of Hermes's API server.

        def guarded(handler):
            async def run(request):
                if not self.active:
                    return web.json_response({"error": "Plugin unloaded; restart required"}, status=503)
                # Custom routes have NO automatic auth gate. Use the server's profile-key check.
                denied = adapter._check_auth(request)
                if denied is not None:
                    return denied
                if not adapter._expected_api_key():
                    return web.json_response({"error": "API key required"}, status=401)
                return await handler(request)
            return run

        def device(request):
            return next((d for d in self.devices.all() if d["id"] == request.match_info["id"]), None)

        async def status(request):
            devices = await asyncio.to_thread(self.devices.all)
            deliveries = await asyncio.to_thread(lambda: self.delivery.deliveries)
            return web.json_response({"version": VERSION, "protocol": PROTOCOL, "devices": [
                {"id": d["id"], "name": d["name"], "text": d["text"],
                 "delivery": deliveries.get(d["id"])} for d in devices]})

        async def add(request):
            if request.content_length is not None and request.content_length > 8192:
                return web.json_response({"error": "Registration too large"}, status=413)
            raw = bytearray()
            async for chunk in request.content.iter_chunked(8192):
                raw.extend(chunk)
                if len(raw) > 8192:
                    return web.json_response({"error": "Registration too large"}, status=413)
            try:
                value = json.loads(raw)
                await asyncio.to_thread(self.devices.change, device=value)
            except (ValueError, TypeError, KeyError, UnicodeError):
                return web.json_response({"error": "Invalid registration"}, status=400)
            except OSError:
                LOG.warning("Clawy device file unavailable")
                return web.json_response({"error": "Device file unavailable"}, status=503)
            return web.json_response({"ok": True})

        async def remove(request):
            found = await asyncio.to_thread(device, request)
            if found is not None:
                await asyncio.to_thread(self.devices.change, remove=found)
            return web.json_response({"removed": found is not None})

        async def test(request):
            found = await asyncio.to_thread(device, request)
            if found is None:
                return web.json_response({"error": "Unknown device"}, status=404)
            alert = {"v": 2, "kind": "reply", "title": "Clawy notifications",
                     "body": "Sealed on your Hermes, opened on this device."}
            # The app's own nonce: a test passes on this alert, not on any alert that shows up.
            sent = await request.json() if request.can_read_body else {}
            if isinstance(sent, dict) and isinstance(sent.get("test"), str):
                alert["test"] = sent["test"][:64]
            try:
                code = await asyncio.to_thread(self.delivery.send, found, alert)
            except Exception:
                LOG.warning("Clawy push failed")  # Exception text can contain secrets.
                code = 0
            return web.json_response({"status": code})

        # Hermes's earlier /p/{profile} catch-all shadows custom mirrored routes in v0.22.7.
        # These belong to the listener's own profile; use CLI for multiplexed siblings.
        try:
            app.router.add_get("/v1/clawy/status", guarded(status))
            app.router.add_post("/v1/clawy/devices", guarded(add))
            app.router.add_delete("/v1/clawy/devices/{id}", guarded(remove))
            app.router.add_post("/v1/clawy/devices/{id}/test", guarded(test))
        except RuntimeError:  # aiohttp's router is frozen once the server runs.
            LOG.warning("Clawy plugin enabled while Hermes runs: restart Hermes to add its routes")


def register(ctx):
    from hermes_constants import get_hermes_home, get_default_hermes_root

    home = get_hermes_home()
    devices = Devices(home, sequence_home=get_default_hermes_root(home=home))
    global _notifications
    notifications = _notifications = Notifications(ctx, devices)
    ctx.register_hook("post_llm_call", notifications.capture)
    ctx.register_hook("on_session_end", notifications.ended)
    ctx.register_hook("on_human_input_request", notifications.human)
    # Resolutions deliberately produce no push and require no retained state.
    ctx.register_platform_handler("api_server", notifications.wire)
    ctx.on_unload(notifications.close)

    def setup(parser):
        parser.add_argument("action", choices=["add"])
        parser.add_argument("registration", nargs="?", help="Registration JSON; omit to read stdin")

    def command(args):
        try:
            raw = args.registration if args.registration is not None else sys.stdin.read(8193)
            if len(raw.encode()) > 8192:
                raise ValueError("Too large")
            devices.change(device=json.loads(raw))
        except (ValueError, TypeError, KeyError, OSError, UnicodeError):
            print("Invalid registration or unavailable device file", file=sys.stderr)
            raise SystemExit(1) from None
        print("Clawy device registered")

    ctx.register_cli_command("clawy-notifications", "Register a Clawy device", setup, command)
