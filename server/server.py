"""
PhonePad server — turns phones into Xbox 360 controllers.

    .venv\\Scripts\\python server\\server.py

Connection modes
  USB  (lowest latency): phone opens  http://localhost:8080
       adb reverse tunnels the phone's localhost:8080 through the cable to us.
  Wi-Fi (PC hotspot):    phone opens  https://192.168.137.1:8443
       HTTPS is needed so Chrome allows tilt steering (motion sensors).

Binary protocol (little-endian, see web/app.js for the other side)
  phone -> PC  0x01 STATE  <B B H B B h h h h>  type, seq, buttons, LT, RT, LX, LY, RX, RY  (14 bytes)
  phone -> PC  0x02 PING   <B d>                type, phone timestamp (echoed back untouched)
  PC -> phone  0x03 RUMBLE <B B B B>            type, large motor, small motor, player LED
"""

from __future__ import annotations

import asyncio
import datetime as dt
import ipaddress
import shutil
import socket
import ssl
import struct
import sys
import time
from pathlib import Path

from aiohttp import web, WSMsgType
import vgamepad as vg

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
CERT_DIR = ROOT / "certs"
ADB = ROOT / "tools" / "platform-tools" / "adb.exe"

HTTP_PORT = 8080
HTTPS_PORT = 8443
HOTSPOT_IP = "192.168.137.1"
WATCHDOG_S = 0.5      # no packet for this long -> neutralise the pad (stuck-throttle safety)
MAX_PLAYERS = 4

STATE = struct.Struct("<BBHBBhhhh")
PING = struct.Struct("<Bd")
RUMBLE = struct.Struct("<BBBB")
T_STATE, T_PING, T_RUMBLE = 1, 2, 3


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ─────────────────────────────── players ────────────────────────────────────
class Player:
    """One phone == one virtual Xbox 360 controller."""

    def __init__(self, ws: web.WebSocketResponse, loop: asyncio.AbstractEventLoop, label: str):
        self.ws, self.loop, self.label = ws, loop, label
        self.pad = vg.VX360Gamepad()
        self.last_packet = time.monotonic()
        self.neutral = True
        self.led = 0
        # Rumble arrives on a ViGEm driver thread, NOT our asyncio thread.
        # call_soon_threadsafe hands it over safely to the event loop.
        self.pad.register_notification(callback_function=self._on_rumble)

    def _on_rumble(self, client, target, large_motor, small_motor, led_number, user_data):
        self.led = led_number
        data = RUMBLE.pack(T_RUMBLE, large_motor, small_motor, led_number)
        self.loop.call_soon_threadsafe(self._send, data)

    def _send(self, data: bytes) -> None:
        if not self.ws.closed:
            asyncio.ensure_future(self.ws.send_bytes(data))

    def apply(self, buttons, lt, rt, lx, ly, rx, ry) -> None:
        r = self.pad.report            # write straight into the XInput report struct
        r.wButtons = buttons
        r.bLeftTrigger, r.bRightTrigger = lt, rt
        r.sThumbLX, r.sThumbLY, r.sThumbRX, r.sThumbRY = lx, ly, rx, ry
        self.pad.update()
        self.neutral = False

    def neutralise(self) -> None:
        if not self.neutral:
            self.pad.reset()
            self.pad.update()
            self.neutral = True

    def close(self) -> None:
        self.neutralise()
        try:
            self.pad.unregister_notification()
        except Exception:
            pass
        self.pad.cmp_func = None
        del self.pad                   # unplugs the virtual controller


players: set[Player] = set()


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=None, max_msg_size=1024, compress=False)
    if len(players) >= MAX_PLAYERS:
        await ws.prepare(request)
        await ws.close(message=b"full")
        return ws
    await ws.prepare(request)

    # Disable Nagle's algorithm: send small packets immediately instead of
    # waiting to bundle them (bundling saves bandwidth but costs latency).
    sock = request.transport.get_extra_info("socket") if request.transport else None
    if sock is not None:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    host = request.host.split(":")[0]
    mode = "USB" if host in ("localhost", "127.0.0.1") else "Wi-Fi"
    player = Player(ws, asyncio.get_running_loop(), f"{mode} {request.remote}")
    players.add(player)
    log(f"🎮 Controller connected  ({player.label})  — {len(players)} active")

    try:
        async for msg in ws:
            if msg.type != WSMsgType.BINARY or not msg.data:
                continue
            data = msg.data
            player.last_packet = time.monotonic()
            kind = data[0]
            if kind == T_STATE and len(data) == STATE.size:
                _, _seq, *values = STATE.unpack(data)
                player.apply(*values)
            elif kind == T_PING and len(data) == PING.size:
                await ws.send_bytes(data)          # echo for round-trip measurement
    finally:
        players.discard(player)
        player.close()
        log(f"📴 Controller disconnected ({player.label}) — {len(players)} active")
    return ws


async def watchdog() -> None:
    """If a phone goes silent (Wi-Fi hiccup, phone locked), release everything."""
    while True:
        await asyncio.sleep(0.1)
        now = time.monotonic()
        for p in list(players):
            if now - p.last_packet > WATCHDOG_S:
                p.neutralise()


# ──────────────────────────────── USB / adb ─────────────────────────────────
async def adb(*args: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        str(ADB), *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        creationflags=0x08000000 if sys.platform == "win32" else 0)   # no console window
    out, _ = await proc.communicate()
    return out.decode(errors="replace")


async def adb_monitor() -> None:
    """Every 2 s: find USB-connected phones and set up `adb reverse` for each."""
    adb_path = ADB if ADB.exists() else (shutil.which("adb") and Path(shutil.which("adb")))
    if not adb_path:
        log("⚠️  adb not found — USB mode disabled (Wi-Fi still works)")
        return
    reversed_ok: set[str] = set()
    warned: set[str] = set()
    while True:
        try:
            out = await adb("devices")
            seen = {}
            for line in out.splitlines()[1:]:
                parts = line.split()
                if len(parts) >= 2:
                    seen[parts[0]] = parts[1]
            for serial, state in seen.items():
                if state == "device" and serial not in reversed_ok:
                    res = await adb("-s", serial, "reverse", f"tcp:{HTTP_PORT}", f"tcp:{HTTP_PORT}")
                    if "error" not in res.lower():
                        reversed_ok.add(serial)
                        log(f"🔌 USB phone {serial} ready → open  http://localhost:{HTTP_PORT}  in Chrome on the phone")
                elif state == "unauthorized" and serial not in warned:
                    warned.add(serial)
                    log(f"🔒 Phone {serial}: tap ALLOW on the 'Allow USB debugging?' prompt on your phone")
            reversed_ok &= set(seen)       # forget unplugged phones so replug works
            warned &= set(seen)
        except Exception as e:             # never let adb trouble kill the server
            log(f"adb error: {e}")
        await asyncio.sleep(2)


# ───────────────────────────────── HTTPS cert ───────────────────────────────
def local_ips() -> list[str]:
    ips = {i[4][0] for i in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    return sorted(ips | {"127.0.0.1"})


def ensure_cert() -> ssl.SSLContext:
    """Create (once) a self-signed certificate valid for all of this PC's IPs."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    CERT_DIR.mkdir(exist_ok=True)
    crt, key_file = CERT_DIR / "server.crt", CERT_DIR / "server.key"
    ips = local_ips()
    ip_file = CERT_DIR / "ips.txt"
    if not (crt.exists() and key_file.exists() and ip_file.exists()
            and set(ip_file.read_text().split()) >= set(ips)):
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "PhonePad")])
        now = dt.datetime.now(dt.timezone.utc)
        san = [x509.DNSName("localhost")] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                .public_key(key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - dt.timedelta(days=1))
                .not_valid_after(now + dt.timedelta(days=3650))
                .add_extension(x509.SubjectAlternativeName(san), critical=False)
                .sign(key, hashes.SHA256()))
        crt.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                                               serialization.PrivateFormat.PKCS8,
                                               serialization.NoEncryption()))
        ip_file.write_text("\n".join(ips))
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(crt, key_file)
    return ctx


# ─────────────────────────────────── app ────────────────────────────────────
@web.middleware
async def no_cache(request, handler):
    resp = await handler(request)
    resp.headers["Cache-Control"] = "no-store"     # phone always gets the newest UI
    return resp


async def index(_request):
    return web.FileResponse(WEB_DIR / "index.html")


async def main() -> None:
    app = web.Application(middlewares=[no_cache])
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_static("/", WEB_DIR)

    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    try:
        await web.TCPSite(runner, "0.0.0.0", HTTP_PORT).start()
        await web.TCPSite(runner, "0.0.0.0", HTTPS_PORT, ssl_context=ensure_cert()).start()
    except OSError as e:
        if getattr(e, "winerror", None) == 10048 or e.errno in (98, 10048):
            print(f"\n  ❌ Port {HTTP_PORT}/{HTTPS_PORT} is already in use — PhonePad is probably")
            print("     already running in another window. Close it (Ctrl+C) and try again.\n")
            await runner.cleanup()
            return
        raise

    ips = local_ips()
    wifi_ip = HOTSPOT_IP if HOTSPOT_IP in ips else next(
        (i for i in ips if not i.startswith(("127.", "192.168.88.", "192.168.118."))), ips[0])
    print("\n  ╔══════════════════ PhonePad ══════════════════╗")
    print(f"    USB   : plug in phone → http://localhost:{HTTP_PORT}")
    print(f"    Wi-Fi : https://{wifi_ip}:{HTTPS_PORT}"
          + ("   (PC hotspot)" if wifi_ip == HOTSPOT_IP else ""))
    print("  ╚══════════════════════════════════════════════╝")
    print("    Ctrl+C to stop\n", flush=True)

    await asyncio.gather(watchdog(), adb_monitor())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nBye 👋")
