#!/usr/bin/env python3
"""
Kasa API Wrapper for SwellDreams
Command-line interface for controlling Kasa devices from JavaScript
Supports single-outlet and multi-outlet (power strip) devices
"""

import sys
import json
from kasa_controller import KasaDevice, discover_devices


def main():
    """Main entry point for CLI commands"""
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "No command specified",
            "usage": "kasa_api.py <command> [args...]",
            "commands": {
                "discover": "Discover devices on network",
                "info": "Get device info (requires ip)",
                "state": "Get device state (requires ip, optional child_id for strips)",
                "children": "Get child outlets for power strips (requires ip)",
                "on": "Turn device on (requires ip, optional child_id for strips)",
                "off": "Turn device off (requires ip, optional child_id for strips)",
                "toggle": "Toggle device state (requires ip, optional child_id)",
                "emeter": "Get energy meter data (requires ip)",
                "led": "Set LED state (requires ip, state)",
                "reboot": "Reboot device (requires ip)"
            }
        }))
        sys.exit(1)

    command = sys.argv[1].lower()

    try:
        if command == "discover":
            # Discover devices on network
            timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 3
            devices = discover_devices(timeout)
            print(json.dumps({"devices": devices}))

        elif command == "info":
            # Get device info
            if len(sys.argv) < 3:
                print(json.dumps({"error": "IP address required"}))
                sys.exit(1)
            ip = sys.argv[2]
            device = KasaDevice(ip)
            result = device.get_info()
            print(json.dumps(result))

        elif command == "children":
            # Get child outlets for power strips
            if len(sys.argv) < 3:
                print(json.dumps({"error": "IP address required"}))
                sys.exit(1)
            ip = sys.argv[2]
            device = KasaDevice(ip)
            result = device.get_children()
            print(json.dumps(result))

        elif command == "state":
            # Get device state (supports optional child_id for power strips)
            if len(sys.argv) < 3:
                print(json.dumps({"error": "IP address required"}))
                sys.exit(1)
            ip = sys.argv[2]
            child_id = sys.argv[3] if len(sys.argv) > 3 else None
            device = KasaDevice(ip, child_id=child_id)
            result = device.get_state()
            print(json.dumps(result))

        elif command == "on":
            # Turn device on (supports optional child_id for power strips)
            if len(sys.argv) < 3:
                print(json.dumps({"error": "IP address required"}))
                sys.exit(1)
            ip = sys.argv[2]
            child_id = sys.argv[3] if len(sys.argv) > 3 else None
            device = KasaDevice(ip, child_id=child_id)
            result = device.turn_on()
            # Get updated state
            state = device.get_state()
            print(json.dumps({"result": result, "state": state}))

        elif command == "off":
            # Turn device off (supports optional child_id for power strips)
            if len(sys.argv) < 3:
                print(json.dumps({"error": "IP address required"}))
                sys.exit(1)
            ip = sys.argv[2]
            child_id = sys.argv[3] if len(sys.argv) > 3 else None
            device = KasaDevice(ip, child_id=child_id)
            result = device.turn_off()
            # Get updated state
            state = device.get_state()
            print(json.dumps({"result": result, "state": state}))

        elif command == "toggle":
            # Toggle device state (supports optional child_id for power strips)
            if len(sys.argv) < 3:
                print(json.dumps({"error": "IP address required"}))
                sys.exit(1)
            ip = sys.argv[2]
            child_id = sys.argv[3] if len(sys.argv) > 3 else None
            device = KasaDevice(ip, child_id=child_id)
            # Get current state
            current = device.get_state()
            if "error" in current:
                print(json.dumps(current))
                sys.exit(1)
            # Toggle
            if current.get("relay_state") == 1:
                result = device.turn_off()
            else:
                result = device.turn_on()
            # Get updated state
            state = device.get_state()
            print(json.dumps({"result": result, "state": state}))

        elif command == "emeter":
            # Get energy meter data
            if len(sys.argv) < 3:
                print(json.dumps({"error": "IP address required"}))
                sys.exit(1)
            ip = sys.argv[2]
            device = KasaDevice(ip)
            result = device.get_emeter_realtime()
            print(json.dumps(result))

        elif command == "led":
            # Set LED state
            if len(sys.argv) < 4:
                print(json.dumps({"error": "IP address and state (on/off) required"}))
                sys.exit(1)
            ip = sys.argv[2]
            state = sys.argv[3].lower() in ["on", "1", "true"]
            device = KasaDevice(ip)
            result = device.set_led(state)
            print(json.dumps(result))

        elif command == "reboot":
            # Reboot device
            if len(sys.argv) < 3:
                print(json.dumps({"error": "IP address required"}))
                sys.exit(1)
            ip = sys.argv[2]
            delay = int(sys.argv[3]) if len(sys.argv) > 3 else 1
            device = KasaDevice(ip)
            result = device.reboot(delay)
            print(json.dumps(result))

        else:
            print(json.dumps({"error": f"Unknown command: {command}"}))
            sys.exit(1)

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
