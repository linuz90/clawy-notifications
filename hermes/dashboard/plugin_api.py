"""Device registration behind the dashboard's host-wide authentication gate.

Hermes loads this file separately from the agent plugin. Resolve its *current* profile-scoped
observer on every request, so unload/reload cannot leave a stale delivery worker reachable.
"""

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()
LOG = logging.getLogger("clawy.notifications")


def observer():
    from hermes_cli.plugins import discover_plugins, get_plugin_manager
    discover_plugins()
    # Hermes has no public accessor for an agent plugin's instance. This private lookup is
    # checked against the pinned Hermes; never create a second worker with separate health.
    loaded = get_plugin_manager()._plugins.get("clawy-notifications")
    service = getattr(getattr(loaded, "module", None), "_notifications", None)
    if not getattr(loaded, "enabled", False) or service is None or not service.active:
        raise HTTPException(503, "Restart Hermes to load the Clawy notification observers")
    return service


async def body(request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 8192:
            raise HTTPException(413, "Registration too large")
    try:
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, TypeError, UnicodeError):
        raise HTTPException(400, "Invalid registration") from None


@router.get("/status")
async def status():
    service = await asyncio.to_thread(observer)
    devices = await asyncio.to_thread(service.devices.all)
    deliveries = await asyncio.to_thread(lambda: service.delivery.deliveries)
    return {"version": "0.3.0", "protocol": 2, "devices": [
        {"id": d["id"], "name": d["name"], "text": d["text"],
         "delivery": deliveries.get(d["id"])} for d in devices]}


@router.post("/devices")
async def add(request: Request):
    value = await body(request)
    service = await asyncio.to_thread(observer)
    try:
        await asyncio.to_thread(service.devices.change, device=value)
    except (ValueError, TypeError, KeyError):
        raise HTTPException(400, "Invalid registration") from None
    except OSError:
        raise HTTPException(503, "Device file unavailable") from None
    return {"ok": True}


@router.delete("/devices/{device_id}")
async def remove(device_id: str):
    service = await asyncio.to_thread(observer)
    found = next((d for d in await asyncio.to_thread(service.devices.all) if d["id"] == device_id), None)
    if found is not None:
        await asyncio.to_thread(service.devices.change, remove=found)
    return {"removed": found is not None}


@router.post("/devices/{device_id}/test")
async def test(device_id: str, request: Request):
    value = await body(request)
    service = await asyncio.to_thread(observer)
    found = next((d for d in await asyncio.to_thread(service.devices.all) if d["id"] == device_id), None)
    if found is None:
        raise HTTPException(404, "Unknown device")
    alert = {"v": 2, "kind": "reply", "title": "Clawy notifications",
             "body": "Sealed on your Hermes, opened on this device."}
    if isinstance(value.get("test"), str):
        alert["test"] = value["test"][:64]
    try:
        code = await asyncio.to_thread(service.delivery.send, found, alert)
    except Exception:
        LOG.warning("Clawy push failed")  # Exception text can contain secrets.
        code = 0
    return {"status": code}
