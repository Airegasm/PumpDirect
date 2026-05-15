#!/usr/bin/env python3
"""
Tapo Device Control Script
Uses 'tapo' library (Rust-based, more compatible)

Usage:
  python tapo-control.py <command> <ip> <email> <password>

Commands:
  on     - Turn device on
  off    - Turn device off
  state  - Get device power state
  info   - Get device info (JSON)
"""

import sys
import json
import asyncio

# Try to import tapo library
try:
    from tapo import ApiClient
except ImportError as e:
    print(json.dumps({
        "success": False,
        "error": f"tapo library not installed. Try: pip install tapo"
    }))
    sys.exit(1)

async def get_device(ip: str, email: str, password: str):
    """Create authenticated Tapo device connection"""
    client = ApiClient(email, password)
    # Try P100/P105 first (most common), then P110, then P115
    try:
        device = await client.p100(ip)
        return device
    except:
        try:
            device = await client.p110(ip)
            return device
        except:
            try:
                device = await client.p115(ip)
                return device
            except Exception as e:
                raise Exception(f"Could not connect to Tapo device at {ip}: {e}")

async def turn_on(ip: str, email: str, password: str):
    """Turn device on"""
    try:
        device = await get_device(ip, email, password)
        await device.on()
        return {"success": True, "state": "on"}
    except Exception as e:
        return {"success": False, "error": str(e)}

async def turn_off(ip: str, email: str, password: str):
    """Turn device off"""
    try:
        device = await get_device(ip, email, password)
        await device.off()
        return {"success": True, "state": "off"}
    except Exception as e:
        return {"success": False, "error": str(e)}

async def get_state(ip: str, email: str, password: str):
    """Get device power state"""
    try:
        device = await get_device(ip, email, password)
        info = await device.get_device_info()
        device_on = info.device_on if hasattr(info, 'device_on') else False
        return {"success": True, "state": "on" if device_on else "off"}
    except Exception as e:
        return {"success": False, "error": str(e)}

async def get_info(ip: str, email: str, password: str):
    """Get device info"""
    try:
        device = await get_device(ip, email, password)
        info = await device.get_device_info()
        # Convert to dict
        info_dict = {}
        for attr in ['device_id', 'type', 'model', 'nickname', 'device_on', 'on_time',
                     'overheated', 'ip', 'mac', 'hw_ver', 'fw_ver', 'rssi', 'ssid']:
            if hasattr(info, attr):
                val = getattr(info, attr)
                info_dict[attr] = val
        return {"success": True, "info": info_dict}
    except Exception as e:
        return {"success": False, "error": str(e)}

async def main():
    if len(sys.argv) < 5:
        print(json.dumps({"success": False, "error": "Usage: tapo-control.py <command> <ip> <email> <password>"}))
        sys.exit(1)

    command = sys.argv[1].lower()
    ip = sys.argv[2]
    email = sys.argv[3]
    password = sys.argv[4]

    if command == "on":
        result = await turn_on(ip, email, password)
    elif command == "off":
        result = await turn_off(ip, email, password)
    elif command == "state":
        result = await get_state(ip, email, password)
    elif command == "info":
        result = await get_info(ip, email, password)
    else:
        result = {"success": False, "error": f"Unknown command: {command}"}

    print(json.dumps(result))

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Script error: {type(e).__name__}: {e}"}))
        sys.exit(1)
