import base64
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("clawy_test_plugin", ROOT / "__init__.py",
                                             submodule_search_locations=[str(ROOT)])
plugin = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = plugin
SPEC.loader.exec_module(plugin)
from clawy_test_plugin.delivery import Devices, Delivery, registration
from clawy_test_plugin.seal import encode, seal


def unbase(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def open_record(raw, private, auth):
    """Independent RFC 8291 receiver, deliberately no sender HKDF/padding helpers."""
    def extract(salt, ikm):
        return hmac.new(salt, ikm, hashlib.sha256).digest()

    def expand(prk, info, size):
        return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:size]

    salt, rs, keylen = struct.unpack("!16sIB", raw[:21])
    assert rs == 4096 and keylen == 65 and len(raw) == 2150
    sender = raw[21:86]
    receiver = private.public_key().public_bytes(serialization.Encoding.X962,
                                                serialization.PublicFormat.UncompressedPoint)
    shared = private.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), sender))
    ikm = expand(extract(auth, shared), b"WebPush: info\0" + receiver + sender, 32)
    prk = extract(salt, ikm)
    key = expand(prk, b"Content-Encoding: aes128gcm\0", 16)
    nonce = expand(prk, b"Content-Encoding: nonce\0", 12)
    padded = AESGCM(key).decrypt(nonce, raw[86:], None)
    assert len(padded) == 2048
    json_bytes, delimiter = padded.rstrip(b"\0")[:-1], padded.rstrip(b"\0")[-1]
    assert delimiter == 2
    return json.loads(json_bytes)


def recipient(origin="http://127.0.0.1:1"):
    os.environ["CLAWY_FORWARDER_ORIGIN"] = origin
    url = f"{origin}/v1/forward/test-device"
    private = ec.generate_private_key(ec.SECP256R1())
    public = private.public_key().public_bytes(serialization.Encoding.X962,
                                              serialization.PublicFormat.UncompressedPoint)
    device = dict(v=2, id="test-device", name="Test", forwarder=url, token="throwaway",
                  p256dh=encode(public), auth=encode(bytes(range(16))), text=True)
    return private, device


class SealTests(unittest.TestCase):
    def test_receiver_and_padding_and_privacy(self):
        private, device = recipient()
        alert = dict(v=2, kind="reply", sessionKey="agent:default:ios-native-test", agentId="default",
                     body=('Hello 👋 "\\\n' * 400))
        raw = seal(alert, device)
        opened = open_record(raw, private, unbase(device["auth"]))
        self.assertTrue(opened["body"].endswith("…"))
        self.assertTrue(alert["body"].startswith(opened["body"][:-1]))
        self.assertEqual(len(raw), 2150)
        self.assertEqual(len(encode(raw)), 2867)
        self.assertNotEqual(raw, seal(alert, device))
        device["text"] = False
        self.assertNotIn("body", open_record(seal(alert, device), private, unbase(device["auth"])))
        with self.assertRaises(ValueError):
            seal(dict(alert, sessionKey="x" * 2500), device)

    def test_shared_vector(self):
        sample = json.loads((ROOT.parent / "test-vectors/hermes.json").read_text())
        private = ec.derive_private_key(int.from_bytes(unbase(sample["privateKey"]), "big"), ec.SECP256R1())
        self.assertEqual(open_record(unbase(sample["sealed"]), private, unbase(sample["auth"])), sample["plaintext"])
        public = private.public_key().public_bytes(serialization.Encoding.X962,
                                                  serialization.PublicFormat.UncompressedPoint)
        self.assertEqual(encode(public), sample["p256dh"])


class RoutingTests(unittest.TestCase):
    def test_turns_and_human_input(self):
        with patch.object(plugin, "Delivery") as delivery:
            ctx = SimpleNamespace(profile_name="default", current_cron_execution=lambda: None)
            observer = plugin.Notifications(ctx, None)
            submit = delivery.return_value.submit
            observer.capture(session_id="ios-native-test", turn_id="t", assistant_response="The reply")
            observer.ended(session_id="ios-native-test", turn_id="t", completed=True)
            self.assertEqual(submit.call_args.args[0]["body"], "The reply")
            submit.reset_mock()
            observer.capture(session_id="ios-native-test", assistant_response="Stopped")
            observer.ended(session_id="ios-native-test", completed=True, interrupted=True)
            submit.assert_not_called()
            for sid in ("main", "x:heartbeat", "cron:job:run", "subagent:x", "cron_job_time"):
                observer.ended(session_id=sid, completed=True)
            submit.assert_not_called()
            observer.ended(session_id="telegram:123", completed=True)
            self.assertEqual(submit.call_args.args[0]["kind"], "refresh")
            observer.ended(session_id="dashboard:test", completed=True)
            self.assertEqual(submit.call_args.args[0]["kind"], "refresh")
            observer.capture(session_id="20261108_server", turn_id="t2", assistant_response="Dashboard reply", platform="clawy")
            observer.ended(session_id="20261108_server", turn_id="t2", completed=True, platform="clawy")
            self.assertEqual(submit.call_args.args[0]["kind"], "reply")
            self.assertEqual(submit.call_args.args[0]["body"], "Dashboard reply")
            observer.ended(session_id="20261108_other", completed=True, platform="telegram")
            self.assertEqual(submit.call_args.args[0]["kind"], "refresh")
            observer.ended(session_id="ios-native-test", failed=True)
            self.assertEqual(submit.call_args.args[0]["kind"], "reply")
            observer.human(kind="approval", request_id="a", session_id="other", prompt="echo safe")
            self.assertEqual(submit.call_args.args[0]["approvalId"], "hermes:a")
            observer.human(kind="clarify", request_id="q", session_id="other", prompt="Which?")
            self.assertEqual(submit.call_args.args[0]["questionId"], "hermes:q")
            before = submit.call_count
            observer.human(kind="sudo", request_id="s", session_id="other", prompt="Secret")
            self.assertEqual(submit.call_count, before)
            ctx.current_cron_execution = lambda: SimpleNamespace(job_id="job-1")
            observer.ended(session_id="ses-opaque", completed=True)
            self.assertEqual(submit.call_count, before)
            observer.ended(session_id="ses-opaque", failed=True)
            self.assertEqual(submit.call_args.args[0]["jobId"], "job-1")


class RegistrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_auth_chunked_input_and_unload(self):
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer
        with tempfile.TemporaryDirectory() as home, patch.object(plugin, "Delivery"):
            observer = plugin.Notifications(SimpleNamespace(profile_name="default"), Devices(home))
            adapter = SimpleNamespace(
                _expected_api_key=lambda: "test-profile-key",
                _check_auth=lambda req: None if req.headers.get("Authorization") == "Bearer test-profile-key"
                else web.json_response({"error": "unauthorized"}, status=401))
            app = web.Application()
            observer.wire(app, adapter)
            async with TestClient(TestServer(app)) as client:
                endpoint = "/v1/clawy/devices"
                _, device = recipient()
                self.assertEqual((await client.post(endpoint, json=device)).status, 401)
                headers = {"Authorization": "Bearer test-profile-key"}
                self.assertEqual((await client.post(endpoint, json={"v": 9}, headers=headers)).status, 400)
                self.assertEqual((await client.post(endpoint, data=b"x" * 8193, headers=headers)).status, 413)
                raw = json.dumps(device).encode()
                async def chunks():
                    yield raw[:15]
                    await __import__("asyncio").sleep(0.01)
                    yield raw[15:]
                response = await client.post(endpoint, data=chunks(), headers=headers)
                self.assertEqual(response.status, 200)
                self.assertEqual(observer.devices.all(), [device])
                self.assertEqual(observer.devices.file.stat().st_mode & 0o777, 0o600)
                observer.close()
                self.assertEqual((await client.post(endpoint, json=device, headers=headers)).status, 503)


class DashboardRegistrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_dashboard_routes_share_live_observer_and_bound_input(self):
        try:
            from fastapi import FastAPI
            import httpx
        except ImportError:
            self.skipTest("Dashboard route tests need Hermes's FastAPI and httpx")
        spec = importlib.util.spec_from_file_location("clawy_dashboard_test", ROOT / "dashboard/plugin_api.py")
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        with tempfile.TemporaryDirectory() as home, patch.object(plugin, "Delivery"):
            service = plugin.Notifications(SimpleNamespace(profile_name="research"), Devices(home))
            with patch.object(api, "observer", return_value=service):
                app = FastAPI()
                app.include_router(api.router)
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                    _, device = recipient()
                    self.assertEqual((await client.post("/devices", json=device)).status_code, 200)
                    service.delivery.deliveries = {device["id"]: {"seq": 42, "status": 200, "at": 123}}
                    result = (await client.get("/status")).json()
                    self.assertEqual(result["devices"][0]["delivery"]["seq"], 42)
                    self.assertEqual((await client.post("/devices", content=b"x" * 8193)).status_code, 413)
                    self.assertEqual((await client.post("/devices", json=[])).status_code, 400)
                    self.assertEqual((await client.post("/devices", json={"v": 99})).status_code, 400)
                    self.assertEqual((await client.delete("/devices/" + device["id"])).status_code, 200)
                    self.assertEqual(service.devices.all(), [])
            service.close()


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.devices = Devices(self.temp.name)
        self.received, self.statuses = [], []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                owner.received.append((self.headers.get("Authorization"), json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(owner.statuses.pop(0) if owner.statuses else 200)
                self.send_header("Retry-After", "120")
                self.send_header("Location", "/redirect-must-not-receive-token")
                self.end_headers()

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.private, self.device = recipient(f"http://127.0.0.1:{self.server.server_port}")
        self.devices.change(device=self.device)
        self.delivery = Delivery(self.devices)
        self.alert = dict(v=2, kind="reply", body="Private reply", agentId="default", sessionKey="agent:default:ios-native-test")

    def tearDown(self):
        self.delivery.close()
        self.delivery.worker.join(2)
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def test_statuses_and_no_plaintext(self):
        for status in (200, 302, 400, 413, 429, 401, 404, 410):
            self.devices.change(device=self.device)
            self.statuses[:] = [status]
            before = len(self.received)
            self.delivery.send(self.device, self.alert)
            self.assertEqual(len(self.received) - before, 1)
            self.assertEqual(bool(self.devices.all()), status not in (401, 410))
        self.devices.change(device=self.device)
        self.statuses[:] = [502, 502]
        before = len(self.received)
        self.delivery.send(self.device, self.alert)
        self.assertEqual(len(self.received) - before, 2)
        self.assertEqual(self.received[-2], self.received[-1])
        auth, envelope = self.received[-1]
        self.assertEqual(auth, "Bearer throwaway")
        self.assertEqual(set(envelope), {"kind", "sealed"})
        opened = open_record(unbase(envelope["sealed"]), self.private, unbase(self.device["auth"]))
        self.assertEqual(self.delivery.deliveries[self.device["id"]]["seq"], opened.pop("seq"))
        self.assertEqual(self.delivery.deliveries[self.device["id"]]["status"], 502)
        self.assertEqual(opened, self.alert)
        self.device["text"] = False
        self.devices.change(device=self.device)
        self.delivery.send(self.device, dict(self.alert, kind="refresh"))
        envelope = self.received[-1][1]
        self.assertEqual(envelope["kind"], "silent")
        self.assertNotIn("body", open_record(unbase(envelope["sealed"]), self.private, unbase(self.device["auth"])))

    def test_a_sequence_only_goes_up_past_a_clock_set_back_and_across_restarts(self):
        first = self.devices.next_seq()
        self.devices.sequence.write_text(str(first + 10_000_000), encoding="ascii")
        self.assertEqual(self.devices.next_seq(), first + 10_000_001)
        self.assertEqual(Devices(self.temp.name).next_seq(), first + 10_000_002)
        self.assertEqual(self.devices.sequence.stat().st_mode & 0o777, 0o600)

    def test_profiles_share_one_replay_sequence_even_in_the_same_millisecond(self):
        from concurrent.futures import ThreadPoolExecutor
        home = Path(self.temp.name)
        (home / "a").mkdir()
        (home / "b").mkdir()
        profiles = [Devices(home / "a", sequence_home=home), Devices(home / "b", sequence_home=home)]
        with patch("time.time", return_value=1234), ThreadPoolExecutor(2) as pool:
            values = list(pool.map(lambda i: profiles[i % 2].next_seq(), range(20)))
        self.assertEqual(len(set(values)), 20)
        self.assertEqual(sorted(values), list(range(1234000, 1234020)))

    def test_replacement_is_private_and_late_failure_preserves_new_device(self):
        newer = dict(self.device, token="new-token", text=False)
        self.devices.change(device=newer)
        self.devices.change(remove=self.device)
        self.assertEqual(self.devices.all(), [newer])
        self.assertEqual(self.devices.file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(Devices(self.temp.name).all(), [newer])
        for bad in (dict(newer, forwarder="http://example.com/forward"),
                    dict(newer, forwarder="https://evil.example/v1/forward/test-device"),
                    dict(newer, forwarder=newer["forwarder"].replace("test-device", "someone-else")),
                    dict(newer, auth="bad"),
                    dict(newer, text="false"), dict(newer, token="bad\nheader")):
            with self.assertRaises(ValueError):
                registration(bad)

    def test_delivery_health_is_shared_across_workers_and_ignores_late_answers(self):
        first = {"seq": 100, "status": 200, "at": 1}
        self.devices.note_delivery(self.device, first)
        sibling = Devices(self.temp.name)
        self.assertEqual(sibling.deliveries()[self.device["id"]], first)
        sibling.note_delivery(self.device, {"seq": 99, "status": 502, "at": 2})
        self.assertEqual(self.devices.deliveries()[self.device["id"]], first)
        self.assertEqual(self.devices.health.stat().st_mode & 0o777, 0o600)
        newer = dict(self.device, token="replacement")
        self.devices.change(device=newer)
        sibling.note_delivery(self.device, {"seq": 101, "status": 502, "at": 3})
        self.assertEqual(self.devices.deliveries(), {})
        self.devices.change(remove=newer)
        self.assertEqual(sibling.deliveries(), {})

    def test_hook_submission_does_not_wait_for_network(self):
        entered, release = threading.Event(), threading.Event()
        def slow(*_):
            entered.set()
            release.wait(2)
        with patch.object(self.delivery, "send", slow):
            start = time.monotonic()
            self.delivery.submit(self.alert)
            self.assertLess(time.monotonic() - start, 0.1)
            self.assertTrue(entered.wait(1))
            release.set()
            self.delivery.pending.join()


if __name__ == "__main__":
    unittest.main()
