"""RFC 8291 aes128gcm, one RFC 8188 record with fixed-length padding."""

import base64
import json
import os
import struct

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def encode(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def decode(value):
    raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    if encode(raw) != value:
        raise ValueError("Expected unpadded base64url")
    return raw


def plaintext(alert, include_text=True):
    value = dict(alert)
    if not include_text:
        value.pop("body", None)
        value.pop("title", None)

    def pack():
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    raw = pack()
    if len(raw) > 2047 and "body" in value:
        body = value.pop("body")
        value["body"] = ""
        value["truncated"] = True
        # Binary search characters, because JSON escaping and UTF-8 both change byte length.
        lo, hi = 0, len(body)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            value["body"] = body[:mid] + "…"
            if len(pack()) <= 2047:
                lo = mid
            else:
                hi = mid - 1
        value["body"] = body[:lo] + "…"
        value["truncated"] = True  # The app won't offer Allow on a command it can't show whole.
        raw = pack()
    if len(raw) > 2047:
        raise ValueError("Notification routing fields exceed record size")
    return raw + b"\x02" + bytes(2047 - len(raw))


def seal(alert, device):
    receiver = decode(device["p256dh"])
    peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), receiver)
    sender = ec.generate_private_key(ec.SECP256R1())
    public = sender.public_key().public_bytes(serialization.Encoding.X962,
                                              serialization.PublicFormat.UncompressedPoint)
    shared = sender.exchange(ec.ECDH(), peer)
    ikm = HKDF(hashes.SHA256(), 32, decode(device["auth"]),
               b"WebPush: info\x00" + receiver + public).derive(shared)
    salt = os.urandom(16)
    key = HKDF(hashes.SHA256(), 16, salt, b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, salt, b"Content-Encoding: nonce\x00").derive(ikm)
    padded = plaintext(alert, device["text"])
    return salt + struct.pack("!IB", 4096, len(public)) + public + AESGCM(key).encrypt(nonce, padded, None)
