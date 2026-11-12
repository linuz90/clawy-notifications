import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

# Reuse the suite's recipient and independent sealed-message opener.
from test_notifications import plugin, recipient
from clawy_test_plugin.activity import Activities, activities_registration, activity_registration
from clawy_test_plugin.delivery import Devices, Delivery, registration

TRACKING = "7b34eddb-598a-41e0-946e-fd7d0090a124"
SESSION = "agent:default:ios-native-test"


def follow(**fields):
    return dict(trackingID=TRACKING, sessionKey=SESSION, mode="long", backgrounded=True, eligible=False, **fields)


class Timers:
    def __init__(self):
        self.now, self.timers = 1000, []

    def timer(self, delay, callback):
        owner = self
        class Timer:
            daemon = False
            canceled = False
            def start(self):
                self.due, self.callback = owner.now + delay, callback
                owner.timers.append(self)
            def cancel(self):
                self.canceled = True
        return Timer()

    def tick(self, seconds=0):
        self.now += seconds
        for timer in list(self.timers):
            if not timer.canceled and timer.due <= self.now:
                timer.cancel()
                timer.callback()

    def pending(self):
        return [timer for timer in self.timers if not timer.canceled]


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.devices = Devices(self.home.name)
        _, self.device = recipient()
        self.device["activities"] = [follow()]
        self.devices.change(device=self.device)
        self.clock, self.events = Timers(), []
        def submit(device, event, callback):
            self.events.append(event)
            callback(True)
        self.activities = Activities(self.devices, SimpleNamespace(submit_activity=submit), now=lambda: self.clock.now, timer=self.clock.timer)
        self.activities.observing = True
        self.activities.sync()

    def tearDown(self):
        self.activities.close()
        self.assertEqual(self.clock.pending(), [])
        self.home.cleanup()

    def test_strict_registration_persistence(self):
        self.assertEqual(Devices(self.home.name).all()[0]["activities"], [follow()])
        for bad in (dict(follow(), backgrounded="yes"), dict(follow(), trackingID="bad"), dict(follow(), extra="private"), dict(follow(), currentRun=None), dict(follow(), currentRun={"id": "x", "startedAt": float("nan")})):
            with self.assertRaises(ValueError):
                activity_registration(bad)
        self.assertIsNone(activity_registration(None))
        self.assertIsNone(activities_registration(None))
        follows = [{**follow(), "trackingID": f"{i}b34eddb-598a-41e0-946e-fd7d0090a124"} for i in range(5)]
        self.assertEqual(activities_registration(follows[:4]), follows[:4])
        self.devices.change(device={**self.device, "activities": follows[:4]})
        self.assertEqual(Devices(self.home.name).all()[0]["activities"], follows[:4])
        for bad in (follow(), "invalid", follows, [follow(), follow()],
                    [follow(), {**follow(), "trackingID": TRACKING.upper()}],
                    [follow(), None], [follow(), {**follows[1], "mode": "sometimes"}]):
            with self.subTest(activities=bad), self.assertRaises(ValueError):
                self.devices.change(device={**self.device, "activities": bad})
            self.assertEqual(self.devices.all()[0]["activities"], follows[:4])
        for empty in (None, []):
            self.assertNotIn("activities", registration({**self.device, "activities": empty}))
        self.assertNotIn("activities", registration({key: value for key, value in self.device.items() if key != "activities"}))

    def test_one_device_follows_several_chats_independently(self):
        first = self.device["activities"][0]
        second = {**first, "trackingID": "8b34eddb-598a-41e0-946e-fd7d0090a124", "sessionKey": "agent:other:ios-native-two"}
        self.device["activities"] = [first, second]
        self.devices.change(device=self.device)
        self.activities.start(first["sessionKey"], "one")
        self.activities.start(second["sessionKey"], "two")
        self.clock.tick(25)
        self.assertEqual([(event["trackingID"], event["event"]) for event in self.events],
                         [(first["trackingID"], "start"), (second["trackingID"], "start")])
        self.activities.human(second["sessionKey"], "question:1")
        self.assertEqual((self.events[-1]["trackingID"], self.events[-1]["phase"]), (second["trackingID"], "needsYou"))
        alert = {"kind": "question", "sessionKey": second["sessionKey"]}
        self.assertTrue(self.activities.handles(self.device, alert))
        self.assertTrue(self.activities.handles(self.device, {"kind": "question", "questionId": "hermes:question:1"}))
        self.assertFalse(self.activities.handles({"id": "another-device"}, alert))
        self.assertFalse(self.activities.handles(self.device, {**alert, "sessionKey": first["sessionKey"]}))
        self.assertFalse(self.activities.handles(self.device, {**alert, "kind": "reply"}))
        self.activities.end(first["sessionKey"], "one", "replied")
        self.assertEqual((self.events[-1]["trackingID"], self.events[-1]["phase"]), (first["trackingID"], "replied"))
        self.assertTrue(self.activities.handles(self.device, alert))
        self.device["activities"] = [first]
        self.devices.change(device=self.device)
        self.activities.sync()
        self.assertEqual((self.events[-1]["trackingID"], self.events[-1]["phase"]), (second["trackingID"], "stopped"))
        self.assertFalse(self.activities.handles(self.device, alert))
        count = len(self.events)
        self.activities.start(second["sessionKey"], "three")
        self.clock.tick(30)
        self.assertEqual(len(self.events), count)
        self.activities.start(first["sessionKey"], "four")
        self.clock.tick(25)
        self.assertEqual((self.events[-1]["trackingID"], self.events[-1]["event"]), (first["trackingID"], "start"))
        self.devices.change(remove=self.device)
        self.activities.sync()
        self.assertEqual(self.events[-1]["phase"], "stopped")
        self.assertEqual(self.activities.targets, {})

    def test_session_replacement_rejects_stale_timer_and_device_removal_ends_all_rows(self):
        first = self.device["activities"][0]
        second = {**first, "trackingID": "8b34eddb-598a-41e0-946e-fd7d0090a124", "sessionKey": "agent:other:ios-native-two"}
        self.device["activities"] = [first, second]
        self.devices.change(device=self.device)
        self.activities.start(first["sessionKey"], "one")
        stale = next(timer for timer in self.clock.pending() if timer is not self.activities.refresh)
        self.activities.start(second["sessionKey"], "two")
        self.clock.tick(25)
        replacement = {**first, "sessionKey": "agent:other:ios-native-replacement"}
        self.device["activities"] = [replacement, second]
        self.devices.change(device=self.device)
        self.activities.sync()
        self.assertEqual((self.events[-1]["trackingID"], self.events[-1]["phase"]), (first["trackingID"], "stopped"))
        count = len(self.events)
        stale.callback()
        self.activities.human(first["sessionKey"], "old-session")
        self.assertEqual(len(self.events), count)
        self.activities.start(replacement["sessionKey"], "replacement")
        self.clock.tick(25)
        self.assertEqual((self.events[-1]["trackingID"], self.events[-1]["event"]), (first["trackingID"], "start"))
        count = len(self.events)
        self.devices.change(remove=self.device)
        self.activities.sync()
        self.assertEqual({(event["trackingID"], event["phase"]) for event in self.events[count:]},
                         {(first["trackingID"], "stopped"), (second["trackingID"], "stopped")})
        self.assertEqual(len(self.events[count:]), 2)
        self.assertEqual(self.activities.targets, {})

    def test_quick_unrelated_foreground_and_registration_after_background(self):
        self.activities.start("agent:default:cron:other", "unrelated")
        self.clock.tick(30)
        self.assertEqual(self.events, [])
        self.activities.start(SESSION, "quick")
        self.activities.end(SESSION, "quick", "replied")
        self.clock.tick(30)
        self.assertEqual(self.events, [])
        self.device["activities"][0]["backgrounded"] = False
        self.devices.change(device=self.device)
        self.activities.start(SESSION, "long")
        self.clock.tick(30)
        self.assertEqual(self.events, [])
        self.device["activities"][0]["backgrounded"] = True
        self.devices.change(device=self.device)
        self.activities.sync()
        self.assertEqual(self.events[-1]["event"], "start")
        self.assertEqual(self.events[-1]["runID"], hashlib.sha256(b"long").hexdigest())
        self.activities.end(SESSION, "long", "replied")
        self.assertEqual(self.events[-1]["phase"], "replied")
        self.assertEqual([timer for timer in self.clock.pending() if timer is not self.activities.refresh], [])

    def test_prefollow_wait_seeds_needs_you_survives_replacement_and_resolves(self):
        self.device.pop("activities")
        self.devices.change(device=self.device)
        self.activities.sync()
        self.activities.human(SESSION, "before-follow")
        self.device["activities"] = [{**follow(), "mode": "manual", "backgrounded": False,
                                    "currentRun": {"id": "native", "startedAt": self.clock.now}}]
        self.devices.change(device=self.device)
        self.activities.sync()
        self.assertEqual(self.events[-1]["phase"], "needsYou")
        self.assertEqual(self.events[-1]["needsYou"], 1)
        self.device["activities"][0]["trackingID"] = "8b34eddb-598a-41e0-946e-fd7d0090a124"
        self.devices.change(device=self.device)
        self.activities.sync()
        self.assertEqual(self.events[-1]["phase"], "needsYou")
        self.activities.human("", "before-follow", resolved=True)
        self.assertEqual(self.events[-1]["phase"], "working")

    def test_prefollow_wait_clears_on_terminal_and_expires_without_a_target(self):
        self.device.pop("activities")
        self.devices.change(device=self.device)
        self.activities.sync()
        self.activities.human(SESSION, "ended-before-follow")
        self.activities.end(SESSION, "native", "stopped")
        self.activities.human(SESSION, "expires-before-follow")
        self.clock.tick(8 * 3600 + 1)
        self.device["activities"] = [{**follow(), "mode": "manual", "currentRun": {"id": "fresh", "startedAt": self.clock.now}}]
        self.devices.change(device=self.device)
        self.activities.sync()
        self.assertEqual(self.events[-1]["phase"], "working")
        self.assertEqual(self.events[-1]["needsYou"], 0)

    def test_terminal_matches_unique_native_turn_across_compression(self):
        self.device["activities"][0].update(mode="manual", currentRun={"id": "stable-turn", "startedAt": self.clock.now})
        self.devices.change(device=self.device)
        self.activities.start(SESSION, "stable-turn")
        self.assertEqual(self.events[-1]["event"], "start")
        self.activities.end("agent:default:new-compression-segment", "stable-turn", "replied")
        self.assertEqual(self.events[-1]["event"], "end")
        self.assertEqual(self.events[-1]["phase"], "replied")

    def test_terminal_never_guesses_an_ambiguous_native_turn(self):
        self.device["activities"][0].update(mode="manual", currentRun={"id": "ambiguous", "startedAt": self.clock.now})
        self.devices.change(device=self.device)
        self.activities.start(SESSION, "ambiguous")
        self.activities.start("agent:default:unrelated", "ambiguous")
        count = len(self.events)
        self.activities.end("agent:default:new-segment", "ambiguous", "replied")
        self.assertEqual(len(self.events), count)

    def test_disabled_target_cancels_pending_start(self):
        self.activities.start(SESSION, "disabled")
        stale = next(timer for timer in self.clock.pending() if timer is not self.activities.refresh)
        self.device.pop("activities")
        self.devices.change(device=self.device)
        self.activities.sync()
        stale.callback()
        self.clock.tick(30)
        self.assertEqual(self.events, [])

    def test_shared_registration_refresh_and_dashboard_host_does_not_duplicate(self):
        self.device["activities"][0]["backgrounded"] = False
        self.devices.change(device=self.device)
        self.activities.start(SESSION, "run")
        self.clock.tick(30)
        self.assertEqual(self.events, [])
        self.device["activities"][0].update(backgrounded=True, eligible=True)
        # A separate dashboard host updates the file, without a callback in this process.
        Devices(self.home.name).change(device=self.device)
        dashboard = Activities(self.devices, self.activities.delivery, now=lambda: self.clock.now, timer=self.clock.timer)
        dashboard.sync()
        self.assertEqual(self.events, [])
        self.clock.tick(1)
        self.assertEqual(self.events[-1]["event"], "start")
        self.assertEqual(dashboard.targets, {})
        dashboard.close()

    def test_manual_only_seeded_run_wait_counts_resume_and_abort(self):
        self.device["activities"][0].update(mode="manual", backgrounded=False, currentRun={"id": "native", "startedAt": 1000})
        self.devices.change(device=self.device)
        self.activities.sync()
        self.assertEqual(self.events[-1]["event"], "start")
        self.activities.human(SESSION, "a")
        self.activities.human(SESSION, "q")
        self.assertEqual(self.events[-1]["needsYou"], 2)
        self.assertTrue(self.activities.handles(self.device, {"kind": "approval", "sessionKey": SESSION}))
        self.activities.human("", "a", resolved=True)
        self.assertEqual(self.events[-1]["needsYou"], 1)
        self.activities.human("", "q", resolved=True)
        self.assertEqual(self.events[-1]["phase"], "working")
        self.activities.end(SESSION, "native", "stopped")
        count = len(self.events)
        self.activities.start(SESSION, "native")
        self.activities.start(SESSION, "next")
        self.clock.tick(30)
        self.assertEqual(len(self.events), count)

    def test_time_qualification_replacement_stale_timer_and_cap(self):
        self.activities.start(SESSION, "run")
        self.device["activities"][0]["eligible"] = True
        self.devices.change(device=self.device)
        self.activities.sync()
        self.clock.tick(19)
        self.assertEqual(self.events, [], "Hermes ignores early-eligibility hints and waits twenty seconds")
        self.clock.tick(1)
        self.assertEqual(self.events[-1]["event"], "start")
        stale = self.clock.pending()[0]
        self.device["activities"][0]["trackingID"] = "8b34eddb-598a-41e0-946e-fd7d0090a124"
        self.device["activities"][0]["currentRun"] = {"id": "next", "startedAt": self.clock.now}
        self.devices.change(device=self.device)
        self.activities.sync()
        self.activities.start(SESSION, "next")
        stale.callback()
        self.clock.tick(20)
        self.assertEqual(self.events[-1]["event"], "start")
        self.clock.tick(8 * 3600)
        self.assertEqual(self.events[-1]["phase"], "stillWorking")
        self.assertEqual([timer for timer in self.clock.pending() if timer is not self.activities.refresh], [])


class HookTests(unittest.TestCase):
    def test_actual_register_hooks_observe_turn_and_never_return_tool_directives(self):
        with tempfile.TemporaryDirectory() as home:
            hooks, unload = {}, []
            ctx = SimpleNamespace(profile_name="default", current_cron_execution=lambda: None,
                                  register_hook=lambda name, callback: hooks.__setitem__(name, callback),
                                  register_platform_handler=lambda *_: None, register_platform=lambda *_, **kw: None, on_unload=unload.append,
                                  register_cli_command=lambda *_: None)
            constants = SimpleNamespace(get_hermes_home=lambda: home, get_default_hermes_root=lambda **_: home)
            with patch.dict(sys.modules, {"hermes_constants": constants, "gateway.platforms.send_targets": SimpleNamespace(StandaloneSendPolicy=lambda **kwargs: kwargs)}), patch.object(Delivery, "_activity_post", return_value=True) as post, patch.object(Delivery, "send", return_value=200) as ordinary:
                plugin.register(ctx)
                service = plugin._notifications
                _, device = recipient()
                device["activities"] = [{**follow(), "mode": "manual"}]
                service.devices.change(device=device)
                for turn, terminal, expected in (("silent", {"completed": True}, "replied"), ("abort", {"interrupted": True}, "stopped"), ("error", {"failed": True}, "failed")):
                    device["activities"][0]["currentRun"] = {"id": turn, "startedAt": __import__("time").time()}
                    service.devices.change(device=device)
                    self.assertIsNone(hooks["pre_llm_call"](session_id="ios-native-test", turn_id=turn))
                    self.assertIsNone(hooks["pre_tool_call"](tool_name="terminal", args={"command": "echo safe"}), "ordinary tools cannot bypass the Hermes time threshold")
                    service.delivery.pending.join()
                    self.assertEqual(post.call_args.args[1]["event"], "start")
                    hooks["on_human_input_request"](kind="approval", session_id="new-compression-segment", session_key="ios-native-test", request_id="approval", prompt="private command")
                    service.delivery.pending.join()
                    self.assertEqual(post.call_args.args[1]["phase"], "needsYou")
                    self.assertEqual(ordinary.call_count, 0)
                    hooks["on_human_input_resolved"](session_id="ios-native-test", request_id="approval")
                    service.delivery.pending.join()
                    self.assertEqual(post.call_args.args[1]["phase"], "working")
                    hooks["on_session_end"](session_id="new-compression-segment" if turn == "silent" else "ios-native-test", turn_id=turn, **terminal)
                    service.delivery.pending.join()
                    self.assertEqual(post.call_args.args[1]["phase"], expected)
                    ordinary.reset_mock()
                device["activities"][0]["currentRun"] = {"id": "fallback", "startedAt": __import__("time").time()}
                service.devices.change(device=device)
                hooks["pre_llm_call"](session_id="ios-native-test", turn_id="fallback")
                service.delivery.pending.join()
                post.return_value = False
                hooks["on_human_input_request"](kind="clarify", session_id="ios-native-test", request_id="failed", prompt="private")
                service.delivery.pending.join()
                self.assertEqual(ordinary.call_count, 1, "failed Needs you forwarding keeps ordinary alert")
                for call in post.call_args_list:
                    self.assertNotIn("private", json.dumps(call.args[1]))
                service.devices.change(remove=device)
                service.activities.sync()
                hooks["pre_llm_call"](session_id="ios-native-test", turn_id="before-registration")
                hooks["on_human_input_request"](kind="clarify", session_id="ios-native-test", request_id="before-registration", prompt="Synthetic")
                service.delivery.pending.join()
                device["activities"][0].update(mode="manual", currentRun={"id": "before-registration", "startedAt": __import__("time").time()})
                post.return_value = True
                service.devices.change(device=device)
                service.activities.sync()
                service.delivery.pending.join()
                self.assertEqual(post.call_args.args[1]["event"], "start")
                self.assertEqual(post.call_args.args[1]["phase"], "needsYou")
                hooks["on_human_input_resolved"](session_id="ios-native-test", request_id="before-registration")
                service.delivery.pending.join()
                self.assertEqual(post.call_args.args[1]["phase"], "working")
                unload[0]()
                service.delivery.worker.join(2)

    def test_activity_retries_are_bounded_and_410_preserves_ordinary_registration(self):
        with tempfile.TemporaryDirectory() as home:
            devices = Devices(home)
            _, device = recipient()
            devices.change(device=device)
            delivery = Delivery(devices)
            event = {"v": 1, "trackingID": TRACKING, "runID": "a" * 64, "seq": 5, "event": "end", "startedAt": 1000, "phase": "stopped", "needsYou": 0, "endedAt": 1020}
            import urllib.error
            responses = [urllib.error.HTTPError(device["forwarder"], code, "test", {}, None) for code in (502, 502, 410)]
            with patch.object(delivery.http, "open", side_effect=responses) as request:
                self.assertFalse(delivery._activity_post(device, event))
                self.assertEqual(request.call_count, 3)
                self.assertEqual(len({call.args[0].data for call in request.call_args_list}), 1)
                self.assertTrue(all("/v1/activity/" in call.args[0].full_url for call in request.call_args_list))
            self.assertEqual(devices.all(), [device])
            delivery.close()
            delivery.worker.join(2)
