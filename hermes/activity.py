"""Public run state, scoped to explicitly followed sessions. Hooks never wait for HTTP."""

import hashlib
import math
import threading
import time
import uuid


def activity_registration(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {"trackingID", "sessionKey", "mode", "backgrounded", "eligible", "currentRun"}:
        raise ValueError("Invalid activity")
    tracking = value.get("trackingID")
    if not isinstance(tracking, str) or str(uuid.UUID(tracking)) != tracking.lower():
        raise ValueError("Invalid tracking identity")
    session = value.get("sessionKey")
    if not isinstance(session, str) or not session or len(session) > 1024 or any(ord(c) < 32 for c in session):
        raise ValueError("Invalid session")
    if value.get("mode") not in ("long", "manual") or type(value.get("backgrounded")) is not bool or type(value.get("eligible")) is not bool:
        raise ValueError("Invalid activity mode")
    run = value.get("currentRun")
    if "currentRun" in value:
        if (not isinstance(run, dict) or set(run) != {"id", "startedAt"}
                or not isinstance(run["id"], str) or not run["id"] or len(run["id"]) > 1024
                or type(run["startedAt"]) not in (int, float) or not math.isfinite(run["startedAt"])
                or not 0 < run["startedAt"] <= time.time() + 300):
            raise ValueError("Invalid current run")
    return {**value, "trackingID": tracking.lower()}


def activities_registration(value):
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > 4:
        raise ValueError("Invalid activities")
    follows = [activity_registration(entry) for entry in value]
    if any(follow is None for follow in follows) or len({follow["trackingID"] for follow in follows}) != len(follows):
        raise ValueError("Invalid activities")
    return follows


class Activities:
    def __init__(self, devices, delivery, now=time.time, timer=threading.Timer, threshold=20, cap=8 * 3600):
        self.devices, self.delivery = devices, delivery
        self.now, self.timer, self.threshold, self.cap = now, timer, threshold, cap
        self.targets, self.runs, self.waits = {}, {}, {}
        self.lock = threading.RLock()
        self.closed = False
        self.observing = False
        self.refresh = None

    def sync(self):
        with self.lock:
            # Dashboard-only plugin hosts write registrations but never own native run events.
            # Only a lifecycle observer starts activities; it refreshes the shared registration file.
            if not self.observing:
                return
            records = {device["id"] + "\n" + follow["trackingID"]: (device, follow)
                       for device in self.devices.all() for follow in device.get("activities", [])}
            for identity in list(self.targets):
                target = self.targets[identity]
                follow = records[identity][1] if identity in records else None
                if not follow or follow["sessionKey"] != target["follow"]["sessionKey"]:
                    self._clear(target)
                    if target["announced"]:
                        self._emit(target, "end", "stopped")
                    del self.targets[identity]
            sessions = {follow["sessionKey"] for _, follow in records.values()}
            self.runs = {key: run for key, run in self.runs.items() if key in sessions or (not run["ended"] and self.now() - run["startedAt"] < self.cap)}
            for identity, (device, follow) in records.items():
                if self.closed:
                    continue
                target = self.targets.setdefault(identity, {"key": identity, "device": device, "follow": follow, "run": None, "announced": False, "delivered": False, "needs_delivered": False, "needs_seq": None, "timers": []})
                target["device"] = device
                target["follow"] = follow
                run = self.runs.get(follow["sessionKey"])
                seed = follow.get("currentRun")
                if seed and (run is None or (run["ended"] and run["id"] != seed["id"] and seed["startedAt"] >= run["startedAt"])):
                    run = self._run(**seed, session=follow["sessionKey"])
                    self.runs[follow["sessionKey"]] = run
                target["run"] = run
                self._qualify(target)
            if any(not run["ended"] and self.now() - run["startedAt"] < self.cap for run in self.runs.values()):
                self._watch()

    def _run(self, id, startedAt, session):
        return {"id": id, "startedAt": startedAt, "pending": self.waits.get(session, {}).get("ids", set()), "ended": False}

    def start(self, session, identity):
        if not session or not identity:
            return
        if self.devices is None:
            return
        with self.lock:
            self.observing = True
        self.sync()
        with self.lock:
            if self.closed:
                return
            previous = self.runs.get(session)
            if previous and previous["id"] == identity:
                return
            if previous:
                self._forget_waits(session)
            if len(self.runs) >= 256 and session not in self.runs:
                # Bound unrelated observer state; followed sessions retain their native identity.
                discard = next((key for key in self.runs if not any(t["follow"]["sessionKey"] == key for t in self.targets.values())), None)
                if discard is not None:
                    self.runs.pop(discard)
                else:
                    return
            run = self.runs[session] = self._run(identity, self.now(), session)
            self._watch()
            for target in self.targets.values():
                if target["follow"]["sessionKey"] != session:
                    continue
                self._clear(target)
                if target["announced"]:
                    self._emit(target, "end", "stopped")
                target.update(run=run, announced=False, delivered=False, needs_delivered=False)
                self._qualify(target)

    def _watch(self):
        if self.refresh is not None or self.closed:
            return
        def refresh():
            with self.lock:
                self.refresh = None
                if self.closed:
                    return
            try:
                self.sync()
            except (OSError, ValueError):
                pass  # Registration storage failures must not affect a turn.
            with self.lock:
                if any(not run["ended"] and self.now() - run["startedAt"] < self.cap for run in self.runs.values()):
                    self._watch()
        self.refresh = self.timer(1, refresh)
        self.refresh.daemon = True
        self.refresh.start()

    def human(self, session, request, resolved=False):
        if self.devices is None:
            return
        self.sync()
        with self.lock:
            if self.closed or not request:
                return
            changed = set()
            if resolved:
                for key, waits in list(self.waits.items()):
                    if request in waits["ids"]:
                        waits["ids"].remove(request)
                        changed.add(key)
                        if not waits["ids"]:
                            self._forget_waits(key)
            elif session:
                waits = self.waits.get(session)
                if waits is None:
                    if len(self.waits) >= 256:
                        self._forget_waits(next(iter(self.waits)))
                    ids = set()
                    def expire():
                        with self.lock:
                            if self.waits.get(session, {}).get("ids") is ids:
                                self._forget_waits(session)
                    timer = self.timer(self.cap, expire)
                    timer.daemon = True
                    waits = self.waits[session] = {"ids": ids, "timer": timer}
                    timer.start()
                waits["ids"].add(request)
                if len(waits["ids"]) > 999:
                    waits["ids"].pop()
                changed.add(session)
            for key in changed:
                run = self.runs.get(key)
                if run and not run["ended"]:
                    run["pending"] = self.waits.get(key, {}).get("ids", set())
            for target in self.targets.values():
                if not target["run"] or target["run"]["ended"] or target["follow"]["sessionKey"] not in changed:
                    continue
                if target["announced"]:
                    self._emit(target, "update", "needsYou" if target["run"]["pending"] else "working")
                else:
                    self._qualify(target)

    def handles(self, device, alert):
        with self.lock:
            return alert["kind"] in ("approval", "question") and any(
                        target["device"]["id"] == device["id"] and target["announced"]
                        and target["delivered"] and target["needs_delivered"] and target["run"]["pending"]
                        and (target["follow"]["sessionKey"] == alert.get("sessionKey")
                             or (alert.get("approvalId") or alert.get("questionId") or "").removeprefix("hermes:") in target["run"]["pending"])
                        for target in self.targets.values())

    def end(self, session, identity, phase):
        if self.devices is None:
            return
        self.sync()
        with self.lock:
            # Compression rotates agent.session_id mid-turn. Native turn identity is stable;
            # use it only when this profile has exactly one matching tracked run.
            matches = [(key, run) for key, run in self.runs.items() if run["id"] == identity]
            if len(matches) > 1:
                return
            if not matches:
                self._forget_waits(session)
                return
            matched_session, run = matches[0]
            self._forget_waits(matched_session)
            if run["ended"]:
                return
            run["ended"] = True
            for target in self.targets.values():
                if target["run"] is run:
                    self._clear(target)
                    if target["announced"]:
                        self._emit(target, "end", phase)
                    target["announced"] = False

    def _later(self, target, delay, callback):
        run = target["run"]
        def fire():
            with self.lock:
                if self.closed or self.targets.get(target["key"]) is not target or target["run"] is not run:
                    return
                callback()
        timer = self.timer(max(0, delay), fire)
        timer.daemon = True
        target["timers"].append(timer)
        timer.start()

    def _qualify(self, target):
        run, follow = target["run"], target["follow"]
        if self.closed or not run or run["ended"] or target["announced"]:
            return
        self._clear(target)
        age = self.now() - run["startedAt"]
        if age >= self.cap:
            return
        manual = follow["mode"] == "manual" and follow.get("currentRun", {}).get("id") == run["id"]
        if follow["mode"] == "manual" and not manual:
            return
        if not manual and not follow["backgrounded"]:
            return
        if not manual and age < self.threshold:
            self._later(target, self.threshold - age, lambda: self._qualify(target))
            return
        target["announced"] = True
        self._emit(target, "start", "needsYou" if run["pending"] else "working")
        def cap():
            if target["announced"]:
                self._emit(target, "end", "stillWorking")
                target["announced"] = False
                self._clear(target)
        self._later(target, self.cap - age, cap)

    def _emit(self, target, event, phase):
        run, device = target["run"], target["device"]
        message = {"v": 1, "trackingID": target["follow"]["trackingID"],
                   "runID": hashlib.sha256(run["id"].encode()).hexdigest(), "seq": self.devices.next_seq(),
                   "event": event, "startedAt": run["startedAt"], "phase": phase,
                   "needsYou": min(999, len(run["pending"])) if phase == "needsYou" else 0}
        if event == "end":
            message["endedAt"] = self.now()
        target["needs_delivered"] = False
        target["needs_seq"] = message["seq"]
        def delivered(ok):
            with self.lock:
                if target["run"] is run:
                    if event == "start":
                        target["delivered"] = ok
                    if target["needs_seq"] == message["seq"]:
                        target["needs_delivered"] = phase == "needsYou" and ok
        self.delivery.submit_activity(device, message, delivered)

    def _forget_waits(self, session):
        waits = self.waits.pop(session, None)
        if waits:
            waits["timer"].cancel()
            waits["ids"].clear()

    @staticmethod
    def _clear(target):
        for timer in target["timers"]:
            timer.cancel()
        target["timers"].clear()

    def close(self):
        with self.lock:
            self.closed = True
            if self.refresh is not None:
                self.refresh.cancel()
                self.refresh = None
            for target in self.targets.values():
                self._clear(target)
            self.targets.clear()
            self.runs.clear()
            for key in list(self.waits):
                self._forget_waits(key)
