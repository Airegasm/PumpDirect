"""
Kasa Device Controller
High-level interface for controlling TP-Link Kasa smart devices
Supports single-outlet devices and multi-outlet power strips (HS300, KP303, etc.)
"""

from tplink_protocol import send_command


class KasaDevice:
    """Represents a TP-Link Kasa smart device"""

    def __init__(self, ip, port=9999, child_id=None):
        """
        Initialize a Kasa device.

        Args:
            ip (str): Device IP address
            port (int): Device port (default 9999)
            child_id (str): Optional child ID for multi-outlet devices (HS300, etc.)
        """
        self.ip = ip
        self.port = port
        self.child_id = child_id

    def _wrap_command(self, command):
        """Wrap command with context for multi-outlet devices"""
        if self.child_id:
            return {"context": {"child_ids": [self.child_id]}, **command}
        return command

    def turn_on(self):
        """Turn the device (or specific outlet) on"""
        command = self._wrap_command({"system": {"set_relay_state": {"state": 1}}})
        return send_command(self.ip, self.port, command)

    def turn_off(self):
        """Turn the device (or specific outlet) off"""
        command = self._wrap_command({"system": {"set_relay_state": {"state": 0}}})
        return send_command(self.ip, self.port, command)

    def get_info(self):
        """Get device information and current state"""
        command = {"system": {"get_sysinfo": {}}}
        return send_command(self.ip, self.port, command)

    def get_state(self):
        """Get current relay state (on/off)"""
        info = self.get_info()
        if "error" in info:
            return info
        try:
            sysinfo = info["system"]["get_sysinfo"]

            # Check if this is a multi-outlet device with children
            if "children" in sysinfo:
                children = sysinfo["children"]

                # If we have a specific child_id, return that outlet's state
                if self.child_id:
                    for child in children:
                        if child.get("id") == self.child_id:
                            state = child.get("state", 0)
                            return {
                                "state": "on" if state == 1 else "off",
                                "relay_state": state,
                                "outlet_id": self.child_id,
                                "outlet_alias": child.get("alias", "")
                            }
                    return {"error": f"Child ID {self.child_id} not found"}

                # No specific child_id - return all outlet states
                outlet_states = []
                for child in children:
                    state = child.get("state", 0)
                    outlet_states.append({
                        "id": child.get("id"),
                        "alias": child.get("alias", f"Outlet {len(outlet_states)+1}"),
                        "state": "on" if state == 1 else "off",
                        "relay_state": state
                    })
                return {
                    "is_strip": True,
                    "outlet_count": len(children),
                    "outlets": outlet_states,
                    "model": sysinfo.get("model", ""),
                    "alias": sysinfo.get("alias", "")
                }

            # Single outlet device
            relay_state = sysinfo["relay_state"]
            return {"state": "on" if relay_state == 1 else "off", "relay_state": relay_state}
        except KeyError:
            return {"error": "Could not parse relay state from response"}

    def get_children(self):
        """Get list of child outlets for multi-outlet devices"""
        info = self.get_info()
        if "error" in info:
            return info
        try:
            sysinfo = info["system"]["get_sysinfo"]
            if "children" not in sysinfo:
                return {"is_strip": False, "children": []}

            children = []
            for idx, child in enumerate(sysinfo["children"]):
                children.append({
                    "id": child.get("id"),
                    "index": idx,
                    "alias": child.get("alias", f"Outlet {idx+1}"),
                    "state": "on" if child.get("state", 0) == 1 else "off",
                    "relay_state": child.get("state", 0)
                })
            return {
                "is_strip": True,
                "model": sysinfo.get("model", ""),
                "alias": sysinfo.get("alias", ""),
                "child_num": sysinfo.get("child_num", len(children)),
                "children": children
            }
        except KeyError:
            return {"error": "Could not parse children from response"}

    def get_emeter_realtime(self):
        """Get real-time energy meter data (HS110/KP115 only)"""
        command = {"emeter": {"get_realtime": {}}}
        return send_command(self.ip, self.port, command)

    def set_led(self, state):
        """
        Set LED state (nightlight mode).

        Args:
            state (bool): True for on, False for off
        """
        command = {"system": {"set_led_off": {"off": 0 if state else 1}}}
        return send_command(self.ip, self.port, command)

    def reboot(self, delay=1):
        """
        Reboot the device.

        Args:
            delay (int): Delay in seconds before reboot
        """
        command = {"system": {"reboot": {"delay": delay}}}
        return send_command(self.ip, self.port, command)

    def get_cloud_info(self):
        """Get cloud connectivity information"""
        command = {"cnCloud": {"get_info": {}}}
        return send_command(self.ip, self.port, command)

    def scan_wifi(self):
        """Scan for available WiFi networks"""
        command = {"netif": {"get_scaninfo": {"refresh": 1}}}
        return send_command(self.ip, self.port, command)


def discover_devices(timeout=10):
    """
    Discover Kasa devices on the local network via broadcast.

    Args:
        timeout (int): Discovery timeout in seconds (default: 10)

    Returns:
        list: List of discovered device IPs or dict with error
    """
    import socket
    import time

    # Discovery command
    command = '{"system":{"get_sysinfo":{}}}'
    from tplink_protocol import encrypt

    encrypted = encrypt(command)
    discovered = set()  # Use set to avoid duplicates

    try:
        # Create UDP socket for broadcast
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

        # Bind to port 9999 to receive responses from devices
        try:
            sock.bind(('', 9999))
        except OSError:
            # If port 9999 is busy, use any available port
            sock.bind(('', 0))

        sock.settimeout(1.0)  # 1 second timeout for recv

        # Try multiple broadcast addresses including common subnets
        broadcast_addresses = [
            '255.255.255.255',  # Global broadcast
            '192.168.1.255',    # Common home router default
            '192.168.0.255',    # Another common default
            '192.168.255.255',  # /16 for 192.168.x.x
            '10.0.255.255',     # /16 for 10.0.x.x
            '10.255.255.255',   # /8 for 10.x.x.x
            '172.16.255.255',   # /12 for 172.16-31.x.x
            '100.64.255.255',   # CGNAT range
        ]

        # Send broadcast packets multiple times to increase chance of discovery
        for i in range(5):  # Send 5 times over the timeout period
            for broadcast_addr in broadcast_addresses:
                try:
                    sock.sendto(encrypted, (broadcast_addr, 9999))
                except Exception:
                    continue  # Try next address if this one fails
            time.sleep(0.2)  # Wait 200ms between sends

        # Collect responses for the specified timeout
        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                data, addr = sock.recvfrom(4096)

                # Filter out echo responses - real device responses are much longer
                # Our command is ~33 bytes, real responses are 200+ bytes
                if len(data) > 50:
                    discovered.add(addr[0])

            except socket.timeout:
                continue  # Keep trying until total timeout
            except Exception:
                break

        sock.close()
    except Exception as e:
        return {"error": f"Discovery failed: {str(e)}"}

    return list(discovered)
