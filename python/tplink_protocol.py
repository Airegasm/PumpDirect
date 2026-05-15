"""
TP-Link Smart Home Protocol Encryption/Decryption
Based on reverse-engineered protocol from softScheck/tplink-smartplug
Uses XOR autokey encryption with initial key of 171
"""

import socket
import json
from struct import pack


def encrypt(string):
    """
    Encrypt a string using TP-Link's XOR autokey cipher.

    Args:
        string (str): Plain text string to encrypt

    Returns:
        bytes: Encrypted data
    """
    key = 171
    result = pack(">I", len(string))  # 4-byte big-endian header with payload length
    for char in string:
        a = key ^ ord(char)
        key = a
        result += bytes([a])
    return result


def decrypt(data):
    """
    Decrypt data using TP-Link's XOR autokey cipher.

    Args:
        data (bytes): Encrypted data to decrypt

    Returns:
        str: Decrypted plain text string
    """
    key = 171
    result = ""
    for byte in data:
        a = key ^ byte
        key = byte
        result += chr(a)
    return result


def send_command(ip, port, command):
    """
    Send a command to a TP-Link device and return the response.

    Args:
        ip (str): Device IP address
        port (int): Device port (default 9999)
        command (dict): Command dictionary to send

    Returns:
        dict: Response from device, or error dict
    """
    try:
        from struct import unpack

        # Convert command to JSON string
        json_cmd = json.dumps(command)

        # Encrypt the command
        encrypted = encrypt(json_cmd)

        # Connect to device
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect((ip, port))

        # Send encrypted command
        sock.send(encrypted)

        # Read the 4-byte header first to get the response length
        header = b''
        while len(header) < 4:
            chunk = sock.recv(4 - len(header))
            if not chunk:
                break
            header += chunk

        if len(header) < 4:
            sock.close()
            return {"error": "Incomplete header received"}

        # Parse the length from header (big-endian unsigned int)
        response_length = unpack(">I", header)[0]

        # Read the full response body (up to 64KB to handle large strip responses)
        data = b''
        remaining = min(response_length, 65536)  # Cap at 64KB for safety
        while len(data) < remaining:
            chunk = sock.recv(min(4096, remaining - len(data)))
            if not chunk:
                break
            data += chunk

        sock.close()

        # Decrypt response
        decrypted = decrypt(data)

        # Parse JSON response
        response = json.loads(decrypted)
        return response

    except socket.timeout:
        return {"error": "Connection timeout"}
    except socket.error as e:
        return {"error": f"Socket error: {str(e)}"}
    except json.JSONDecodeError as e:
        return {"error": f"JSON decode error: {str(e)}"}
    except Exception as e:
        return {"error": f"Unexpected error: {str(e)}"}
