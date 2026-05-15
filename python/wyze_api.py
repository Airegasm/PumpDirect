#!/usr/bin/env python3
"""
Wyze API Wrapper for SwellDreams
Command-line interface for controlling Wyze devices from JavaScript
Uses the wyze-sdk library
"""

import sys
import os
import json

# Add wyze-sdk to path
WYZE_SDK_PATH = os.path.expanduser('~/Projects/wyze-sdk')
if os.path.exists(WYZE_SDK_PATH):
    sys.path.insert(0, WYZE_SDK_PATH)

try:
    from wyze_sdk import Client
    from wyze_sdk.errors import WyzeApiError, WyzeClientConfigurationError
    WYZE_SDK_AVAILABLE = True
except ImportError as e:
    WYZE_SDK_AVAILABLE = False
    IMPORT_ERROR = str(e)


def output(data):
    """Output JSON result"""
    print(json.dumps(data))


def login(email, password, key_id, api_key, totp_key=None):
    """
    Login to Wyze and return access token
    """
    if not WYZE_SDK_AVAILABLE:
        return {"error": f"wyze-sdk not available: {IMPORT_ERROR}"}

    try:
        client = Client()

        login_args = {
            "email": email,
            "password": password,
            "key_id": key_id,
            "api_key": api_key
        }

        if totp_key:
            login_args["totp_key"] = totp_key

        response = client.login(**login_args)

        return {
            "success": True,
            "access_token": response.get("access_token"),
            "refresh_token": response.get("refresh_token"),
            "user_id": response.get("user_id")
        }
    except WyzeApiError as e:
        return {"error": f"Wyze API error: {str(e)}"}
    except Exception as e:
        return {"error": f"Login failed: {str(e)}"}


def list_plugs(access_token):
    """
    List all Wyze plugs
    """
    if not WYZE_SDK_AVAILABLE:
        return {"error": f"wyze-sdk not available: {IMPORT_ERROR}"}

    try:
        client = Client(token=access_token)
        plugs = client.plugs.list()

        devices = []
        for plug in plugs:
            devices.append({
                "mac": plug.mac,
                "nickname": plug.nickname,
                "model": plug.product.model if plug.product else "Unknown",
                "is_online": plug.is_online,
                "is_on": plug.is_on
            })

        return {"success": True, "devices": devices}
    except WyzeApiError as e:
        return {"error": f"Wyze API error: {str(e)}"}
    except Exception as e:
        return {"error": f"List plugs failed: {str(e)}"}


def get_plug_info(access_token, device_mac):
    """
    Get detailed info for a specific plug
    """
    if not WYZE_SDK_AVAILABLE:
        return {"error": f"wyze-sdk not available: {IMPORT_ERROR}"}

    try:
        client = Client(token=access_token)
        plug = client.plugs.info(device_mac=device_mac)

        return {
            "success": True,
            "mac": plug.mac,
            "nickname": plug.nickname,
            "model": plug.product.model if plug.product else "Unknown",
            "is_online": plug.is_online,
            "is_on": plug.is_on,
            "rssi": getattr(plug, 'rssi', None)
        }
    except WyzeApiError as e:
        return {"error": f"Wyze API error: {str(e)}"}
    except Exception as e:
        return {"error": f"Get plug info failed: {str(e)}"}


def get_state(access_token, device_mac):
    """
    Get current power state of a plug
    """
    if not WYZE_SDK_AVAILABLE:
        return {"error": f"wyze-sdk not available: {IMPORT_ERROR}"}

    try:
        client = Client(token=access_token)
        plug = client.plugs.info(device_mac=device_mac)

        return {
            "success": True,
            "state": "on" if plug.is_on else "off",
            "relay_state": 1 if plug.is_on else 0,
            "is_online": plug.is_online
        }
    except WyzeApiError as e:
        return {"error": f"Wyze API error: {str(e)}"}
    except Exception as e:
        return {"error": f"Get state failed: {str(e)}"}


def turn_on(access_token, device_mac, device_model):
    """
    Turn on a Wyze plug
    """
    if not WYZE_SDK_AVAILABLE:
        return {"error": f"wyze-sdk not available: {IMPORT_ERROR}"}

    try:
        client = Client(token=access_token)
        client.plugs.turn_on(device_mac=device_mac, device_model=device_model)

        return {"success": True, "state": "on"}
    except WyzeApiError as e:
        return {"error": f"Wyze API error: {str(e)}"}
    except Exception as e:
        return {"error": f"Turn on failed: {str(e)}"}


def turn_off(access_token, device_mac, device_model):
    """
    Turn off a Wyze plug
    """
    if not WYZE_SDK_AVAILABLE:
        return {"error": f"wyze-sdk not available: {IMPORT_ERROR}"}

    try:
        client = Client(token=access_token)
        client.plugs.turn_off(device_mac=device_mac, device_model=device_model)

        return {"success": True, "state": "off"}
    except WyzeApiError as e:
        return {"error": f"Wyze API error: {str(e)}"}
    except Exception as e:
        return {"error": f"Turn off failed: {str(e)}"}


def main():
    """Main entry point for CLI commands"""
    if len(sys.argv) < 2:
        output({
            "error": "No command specified",
            "usage": "wyze_api.py <command> [args...]",
            "commands": {
                "login": "Login and get access token (email, password, key_id, api_key, [totp_key])",
                "list": "List all plugs (access_token)",
                "info": "Get plug info (access_token, device_mac)",
                "state": "Get plug state (access_token, device_mac)",
                "on": "Turn plug on (access_token, device_mac, device_model)",
                "off": "Turn plug off (access_token, device_mac, device_model)"
            }
        })
        sys.exit(1)

    command = sys.argv[1].lower()

    try:
        if command == "login":
            if len(sys.argv) < 6:
                output({"error": "Login requires: email, password, key_id, api_key, [totp_key]"})
                sys.exit(1)
            email = sys.argv[2]
            password = sys.argv[3]
            key_id = sys.argv[4]
            api_key = sys.argv[5]
            totp_key = sys.argv[6] if len(sys.argv) > 6 else None
            result = login(email, password, key_id, api_key, totp_key)
            output(result)

        elif command == "list":
            if len(sys.argv) < 3:
                output({"error": "List requires: access_token"})
                sys.exit(1)
            access_token = sys.argv[2]
            result = list_plugs(access_token)
            output(result)

        elif command == "info":
            if len(sys.argv) < 4:
                output({"error": "Info requires: access_token, device_mac"})
                sys.exit(1)
            access_token = sys.argv[2]
            device_mac = sys.argv[3]
            result = get_plug_info(access_token, device_mac)
            output(result)

        elif command == "state":
            if len(sys.argv) < 4:
                output({"error": "State requires: access_token, device_mac"})
                sys.exit(1)
            access_token = sys.argv[2]
            device_mac = sys.argv[3]
            result = get_state(access_token, device_mac)
            output(result)

        elif command == "on":
            if len(sys.argv) < 5:
                output({"error": "On requires: access_token, device_mac, device_model"})
                sys.exit(1)
            access_token = sys.argv[2]
            device_mac = sys.argv[3]
            device_model = sys.argv[4]
            result = turn_on(access_token, device_mac, device_model)
            output(result)

        elif command == "off":
            if len(sys.argv) < 5:
                output({"error": "Off requires: access_token, device_mac, device_model"})
                sys.exit(1)
            access_token = sys.argv[2]
            device_mac = sys.argv[3]
            device_model = sys.argv[4]
            result = turn_off(access_token, device_mac, device_model)
            output(result)

        else:
            output({"error": f"Unknown command: {command}"})
            sys.exit(1)

    except Exception as e:
        output({"error": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
