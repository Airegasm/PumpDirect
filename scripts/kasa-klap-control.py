#!/usr/bin/env python3
"""
Kasa 1.1.x+ Device Control Script
Uses the 'python-kasa' library for KLAP-protocol TP-Link Kasa devices.

This is for Kasa devices running firmware 1.1.x and newer, where TP-Link
disabled the legacy unauthenticated port-9999 protocol in favour of the
authenticated KLAP protocol. Older devices/firmware that still speak the
legacy XOR protocol are handled by the "Kasa Legacy" service instead.

Usage:
  python kasa-klap-control.py <command> <arg> <email> <password>

Commands:
  on        - Turn device on          (arg = device IP)
  off       - Turn device off         (arg = device IP)
  state     - Get device power state  (arg = device IP)
  info      - Get device info (JSON)  (arg = device IP)
  discover  - Discover devices        (arg = timeout in seconds)
"""

import sys
import json
import asyncio

# python-kasa exposes KLAP/AES handshake handling behind Discover + Credentials
try:
    from kasa import Discover, Credentials
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "python-kasa library not installed. Try: pip install python-kasa"
    }))
    sys.exit(1)


async def _connect(ip, email, password):
    """Discover and authenticate a single Kasa device (handles KLAP/AES)."""
    dev = await Discover.discover_single(
        ip,
        credentials=Credentials(email, password),
    )
    await dev.update()
    return dev


def _device_info(dev):
    """Extract a JSON-safe info dict from a python-kasa device."""
    hw = getattr(dev, "hw_info", {}) or {}
    return {
        "alias": getattr(dev, "alias", None),
        "model": getattr(dev, "model", None),
        "device_type": str(getattr(dev, "device_type", "")),
        "mac": getattr(dev, "mac", None),
        "host": getattr(dev, "host", None),
        "is_on": getattr(dev, "is_on", None),
        "rssi": getattr(dev, "rssi", None),
        "hw_ver": hw.get("hw_ver"),
        "sw_ver": hw.get("sw_ver"),
    }


async def turn_on(ip, email, password):
    try:
        dev = await _connect(ip, email, password)
        await dev.turn_on()
        await dev.update()
        return {"success": True, "state": "on" if dev.is_on else "off"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def turn_off(ip, email, password):
    try:
        dev = await _connect(ip, email, password)
        await dev.turn_off()
        await dev.update()
        return {"success": True, "state": "off" if not dev.is_on else "on"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def get_state(ip, email, password):
    try:
        dev = await _connect(ip, email, password)
        return {"success": True, "state": "on" if dev.is_on else "off"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def get_info(ip, email, password):
    try:
        dev = await _connect(ip, email, password)
        return {"success": True, "info": _device_info(dev)}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def discover(timeout, email, password):
    try:
        try:
            timeout = int(float(timeout))
        except (TypeError, ValueError):
            timeout = 5
        found = await Discover.discover(
            credentials=Credentials(email, password),
            discovery_timeout=timeout,
        )
        devices = []
        for ip, dev in found.items():
            try:
                await dev.update()
                info = _device_info(dev)
                info["ip"] = ip
                devices.append(info)
            except Exception as e:
                devices.append({"ip": ip, "alias": ip, "model": "Unknown", "error": str(e)})
        return {"success": True, "devices": devices}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def main():
    if len(sys.argv) < 5:
        print(json.dumps({
            "success": False,
            "error": "Usage: kasa-klap-control.py <command> <arg> <email> <password>"
        }))
        sys.exit(1)

    command = sys.argv[1].lower()
    arg = sys.argv[2]
    email = sys.argv[3]
    password = sys.argv[4]

    if command == "on":
        result = await turn_on(arg, email, password)
    elif command == "off":
        result = await turn_off(arg, email, password)
    elif command == "state":
        result = await get_state(arg, email, password)
    elif command == "info":
        result = await get_info(arg, email, password)
    elif command == "discover":
        result = await discover(arg, email, password)
    else:
        result = {"success": False, "error": f"Unknown command: {command}"}

    print(json.dumps(result))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Script error: {type(e).__name__}: {e}"}))
        sys.exit(1)
