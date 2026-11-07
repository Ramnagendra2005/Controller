"""
MILESTONE 2 — Phone talks to PC over Wi-Fi.

Run:   .venv\\Scripts\\python server\\m2_server.py
Then open the printed http://<your-ip>:8080 URL in Chrome on your phone
(phone and PC must be on the SAME Wi-Fi network).
"""

import asyncio
import json
import socket
from pathlib import Path

from aiohttp import web, WSMsgType
import vgamepad as vg

PORT = 8080
WEB_DIR = Path(__file__).parent.parent / "web"   # where the phone page lives

pad = vg.VX360Gamepad()


# ---------------------------------------------------------------------------
# CONCEPT 1: IP address = which computer, port = which program on it.
# Your router gives each device a local address like 192.168.1.23.
# Trick to find ours: "connect" a UDP socket to a public address. No packet
# is actually sent, but the OS picks the network card it WOULD use, and
# getsockname() tells us that card's local IP.
# ---------------------------------------------------------------------------
def get_lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


# A PC can have SEVERAL IPs — one per network card (Ethernet, Wi-Fi hotspot,
# VMware virtual adapters...). Windows Mobile Hotspot always gives the PC
# 192.168.137.1, so if we see that, the phone should use it.
HOTSPOT_IP = "192.168.137.1"

def all_ips() -> list[str]:
    infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    return sorted({info[4][0] for info in infos})


# ---------------------------------------------------------------------------
# CONCEPT 2: HTTP vs WebSocket
# HTTP  = phone asks, server answers, done (like sending a letter each time).
#         Great for loading the page once.
# WebSocket = starts as HTTP, then "upgrades" to a permanent two-way pipe
#         (like a phone call that stays open). No reconnect cost per message,
#         so each button press travels in a few milliseconds.
# ---------------------------------------------------------------------------
async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse()
    await ws.prepare(request)            # performs the HTTP -> WebSocket upgrade
    peer = request.remote
    print(f"📱 Phone connected from {peer}")

    # CONCEPT 3: async / await (the event loop)
    # "async for" waits for the next message WITHOUT freezing the program.
    # While we wait, Python can serve other phones or HTTP requests.
    async for msg in ws:
        if msg.type != WSMsgType.TEXT:
            continue
        data = json.loads(msg.data)      # JSON text -> Python dict

        if data["t"] == "ping":
            # CONCEPT 4: measuring latency with an echo.
            # The phone stamps the time it sent the ping; we send it straight
            # back. Phone computes (now - stamp) = round-trip time (RTT).
            # One-way latency is roughly RTT / 2.
            await ws.send_str(msg.data)

        elif data["t"] == "btn":
            if data["down"]:
                pad.press_button(vg.XUSB_BUTTON.XUSB_GAMEPAD_A)
            else:
                pad.release_button(vg.XUSB_BUTTON.XUSB_GAMEPAD_A)
            pad.update()
            print(f"  A {'DOWN' if data['down'] else 'up'}")

    # Loop ends when the socket closes. SAFETY: release everything, otherwise
    # a dropped Wi-Fi connection could leave the throttle stuck at 100%!
    pad.reset()
    pad.update()
    print(f"📴 Phone {peer} disconnected — controller reset to neutral")
    return ws


async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(WEB_DIR / "m2.html")


def main() -> None:
    app = web.Application()
    app.router.add_get("/", index)       # normal HTTP: serves the page
    app.router.add_get("/ws", ws_handler)  # WebSocket endpoint
    ips = all_ips()
    if HOTSPOT_IP in ips:
        print(f"\n  📶 Hotspot detected! On your phone open:  http://{HOTSPOT_IP}:{PORT}\n")
    else:
        print(f"\n  Open this on your phone:  http://{get_lan_ip()}:{PORT}")
        print("  (Mobile Hotspot not on — turn it on if the phone can't connect)\n")
    print("  All PC addresses:", ", ".join(ips), "\n", flush=True)
    web.run_app(app, host="0.0.0.0", port=PORT, print=None)
    # host="0.0.0.0" = listen on ALL network cards, not just localhost.
    # Without it, only the PC itself could connect.


if __name__ == "__main__":
    main()
