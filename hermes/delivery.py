"""Private device file and bounded, off-hook forwarding. No Hermes or Clawy imports."""

import contextlib
import fcntl
import json
import logging
import os
from pathlib import Path
import queue
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives.asymmetric import ec
from .seal import decode, encode, seal

LOG = logging.getLogger("clawy.notifications")


def forwarder_origin():
    """The one host this plugin posts to, so a registration can't aim your Hermes elsewhere.
    Set CLAWY_FORWARDER_ORIGIN only to test against a forwarder of your own."""
    return os.environ.get("CLAWY_FORWARDER_ORIGIN", "https://openclaw-client-relay.linuz90.workers.dev")


def registration(value):
    if not isinstance(value, dict) or type(value.get("v")) is not int or value["v"] != 2:
        raise ValueError("Unsupported registration")
    for key, limit in (("id", 256), ("name", 256), ("forwarder", 2048), ("token", 2048),
                       ("p256dh", 87), ("auth", 22)):
        item = value.get(key)
        if not isinstance(item, str) or not item or len(item) > limit or any(ord(c) < 32 for c in item):
            raise ValueError("Invalid registration field")
    if type(value.get("text")) is not bool:
        raise ValueError("Expected text preference")
    if value["forwarder"] != f'{forwarder_origin()}/v1/forward/{urllib.parse.quote(value["id"], safe="")}':
        raise ValueError("Forwarder must be this device's route on the pinned host")
    value["token"].encode("ascii")
    public, auth = decode(value["p256dh"]), decode(value["auth"])
    if len(public) != 65 or public[0] != 4 or len(auth) != 16:
        raise ValueError("Invalid recipient keys")
    ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), public)
    return {key: value[key] for key in ("v", "id", "name", "forwarder", "token", "p256dh", "auth", "text")}


class Devices:
    def __init__(self, home, sequence_home=None):
        self.file = Path(home) / "clawy-notifications.json"
        # One recipient is registered in several profiles. Their sequences must never collide.
        self.sequence = Path(sequence_home or home) / "clawy-notifications.sequence"
        self.health = Path(home) / "clawy-notifications.deliveries"

    @contextlib.contextmanager
    def locked(self, file=None):
        # CLI registration and the gateway's worker are separate processes.
        fd = os.open(str(file or self.file) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "r+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def next_seq(self):
        """The number sealed into every message: a device opens each number once and never one far
        behind the newest, so nobody who keeps a sealed body can show it again. It runs on the clock
        so a lost file costs nothing, and on the file so a clock set back can't repeat a number."""
        with self.locked(self.sequence.parent / "clawy-notifications.json"):
            try:
                last = int(self.sequence.read_text(encoding="ascii"))
            except (OSError, ValueError):
                last = 0
            value = max(int(time.time() * 1000), last + 1)
            fd, temp = tempfile.mkstemp(prefix=".clawy-", dir=self.sequence.parent)
            try:
                with os.fdopen(fd, "w", encoding="ascii") as out:
                    out.write(str(value))
                os.replace(temp, self.sequence)
            finally:
                if os.path.exists(temp):
                    os.unlink(temp)
            return value

    def _read(self):
        if not self.file.exists():
            return []
        if self.file.is_symlink():
            raise ValueError("Device file cannot be a symlink")
        return json.loads(self.file.read_text(encoding="utf-8"))

    def all(self):
        with self.locked():
            return [registration(item) for item in self._read()]

    def _deliveries(self):
        try:
            value = json.loads(self.health.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def deliveries(self):
        # Dashboard sibling-profile routes run in a plugin host, apart from the turn's worker.
        with self.locked():
            ids = {d["id"] for d in self._read()}
            return {key: value for key, value in self._deliveries().items() if key in ids}

    def note_delivery(self, device, value):
        with self.locked():
            records = self._read()
            if device not in records:
                return  # A late answer belongs to a removed or replaced registration.
            ids = {d["id"] for d in records}
            values = {key: item for key, item in self._deliveries().items() if key in ids}
            if values.get(device["id"], {}).get("seq", 0) >= value["seq"]:
                return
            values[device["id"]] = value
            self._save_health(values)

    def _save_health(self, values):
        fd, temp = tempfile.mkstemp(prefix=".clawy-", dir=self.health.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                json.dump(values, out, separators=(",", ":"))
            os.replace(temp, self.health)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)

    def change(self, device=None, remove=None):
        with self.locked():
            records = self._read()
            if device is not None:
                device = registration(device)
                if device not in records:
                    health = self._deliveries()
                    if health.pop(device["id"], None) is not None:
                        self._save_health(health)
                records = [d for d in records if d["id"] != device["id"]] + [device]
            if remove is not None:
                # A late 410 must not erase a freshly re-registered device with the same id.
                records = [d for d in records if d != remove]
            fd, temp = tempfile.mkstemp(prefix=".clawy-", dir=self.file.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as out:
                    json.dump(records, out, ensure_ascii=False, separators=(",", ":"))
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(temp, self.file)  # mkstemp is always 0600.
            finally:
                if os.path.exists(temp):
                    os.unlink(temp)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # Never send a forward token to another URL.


class Delivery:
    def __init__(self, devices):
        self.devices = devices
        self.pending = queue.Queue(maxsize=64)
        self.stopping = threading.Event()
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.worker = threading.Thread(target=self._work, name="clawy-push", daemon=True)
        self.worker.start()

    def submit(self, alert):
        if self.stopping.is_set():
            return
        try:
            self.pending.put_nowait(alert)
        except queue.Full:
            LOG.warning("Clawy push queue full; dropped notification")

    def _work(self):
        while not self.stopping.is_set() or not self.pending.empty():
            try:
                alert = self.pending.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                for device in self.devices.all():
                    try:
                        self.send(device, alert)
                    except Exception:
                        LOG.warning("Clawy push failed")  # Exception text can contain secrets.
            except Exception:
                LOG.warning("Clawy device file unavailable")
            finally:
                self.pending.task_done()

    def close(self):
        # Best effort only: no durable outbox, and unload never waits on the network.
        self.stopping.set()

    @property
    def deliveries(self):
        # Only the latest alert counts; iOS may drop silent refreshes freely.
        return self.devices.deliveries()

    def note(self, device, alert, seq, code):
        if alert["kind"] != "refresh":
            self.devices.note_delivery(device, {"seq": seq, "status": code, "at": int(time.time() * 1000)})

    def send(self, device, alert):
        seq = self.devices.next_seq()
        try:
            code = self._post(device, {**alert, "seq": seq})
        except Exception:
            self.note(device, alert, seq, 0)
            raise
        self.note(device, alert, seq, code)
        return code

    def _post(self, device, alert):
        body = json.dumps({"kind": "silent" if alert["kind"] == "refresh" else "alert",
                           "sealed": encode(seal(alert, device))}, separators=(",", ":")).encode()
        for attempt in range(2):
            request = urllib.request.Request(device["forwarder"], data=body, headers={
                "Authorization": "Bearer " + device["token"], "Content-Type": "application/json"})
            try:
                with self.http.open(request, timeout=5) as response:
                    code = response.status
            except urllib.error.HTTPError as error:
                code = error.code
                error.close()
            # 404 stays: that's a forwarder without this route, which says nothing about the device.
            if code in (401, 410):
                self.devices.change(remove=device)
            elif code in (400, 413):
                LOG.warning("Clawy forwarder rejected malformed push (%d)", code)
            elif code == 502 and attempt == 0:
                continue
            elif code not in (200, 202):
                LOG.warning("Clawy forwarder dropped push (%d)", code)
            return code  # 429 is dropped; no retry, so no Retry-After wait is needed.
