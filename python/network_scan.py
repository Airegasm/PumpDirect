"""
Network scan for Kasa devices on port 9999
More reliable than UDP broadcast discovery
"""
import socket
import json
import sys
import concurrent.futures
from struct import pack

def encrypt(string):
    """Encrypt using TP-Link protocol"""
    key = 171
    result = pack(">I", len(string))
    for char in string:
        a = key ^ ord(char)
        key = a
        result += bytes([a])
    return result

def decrypt(data):
    """Decrypt using TP-Link protocol"""
    key = 171
    result = ""
    for byte in data:
        a = key ^ byte
        key = byte
        result += chr(a)
    return result

def check_device(ip, port=9999, timeout=1):
    """Check if IP has a Kasa device on port 9999"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((ip, port))

        if result == 0:
            # Port is open, try to get device info
            command = '{"system":{"get_sysinfo":{}}}'
            encrypted = encrypt(command)

            try:
                sock.send(encrypted)
                data = sock.recv(4096)
                sock.close()

                if len(data) > 4:
                    # Got a response, try to parse it
                    try:
                        decrypted = decrypt(data[4:])
                        device_info = json.loads(decrypted)

                        # Extract device name
                        alias = device_info.get('system', {}).get('get_sysinfo', {}).get('alias', f'Device {ip}')

                        return {
                            "ip": ip,
                            "name": alias,
                            "responding": True,
                            "info": device_info
                        }
                    except:
                        return {"ip": ip, "name": f"Device {ip}", "responding": True}
                else:
                    return None
            except:
                sock.close()
                return None
        else:
            sock.close()
            return None
    except:
        return None

def get_local_subnet():
    """Detect local subnet"""
    try:
        # Get local IP by connecting to external address
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()

        # Extract subnet (assume /24)
        if local_ip.startswith("192.168."):
            parts = local_ip.split(".")
            return f"{parts[0]}.{parts[1]}.{parts[2]}"
        elif local_ip.startswith("10."):
            parts = local_ip.split(".")
            return f"{parts[0]}.{parts[1]}.{parts[2]}"
        elif local_ip.startswith("172."):
            parts = local_ip.split(".")
            return f"{parts[0]}.{parts[1]}.{parts[2]}"
        else:
            return "192.168.1"  # Default
    except:
        return "192.168.1"  # Default

def scan_subnet(subnet, start=1, end=255, port=9999, timeout=0.5, max_workers=50):
    """Scan subnet for Kasa devices"""
    found = []

    # Use thread pool for faster scanning
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = []
        for i in range(start, end + 1):
            ip = f"{subnet}.{i}"
            futures.append(executor.submit(check_device, ip, port, timeout))

        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            if result:
                found.append(result)

    return found

# Main execution
if __name__ == "__main__":
    # Get timeout from args if provided
    timeout = int(sys.argv[1]) if len(sys.argv) > 1 else 10

    # Detect subnet
    subnet = get_local_subnet()

    # Scan network (use short timeout per device, but scan all 255)
    found_devices = scan_subnet(subnet, start=1, end=255, port=9999, timeout=0.5)

    # Output JSON result
    result = {
        "subnet": subnet,
        "devices": found_devices
    }

    print(json.dumps(result))
