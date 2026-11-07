# PhonePad: your Android phone as an Xbox 360 controller

```
phone (Chrome page) ──USB cable / Wi-Fi──► server/server.py ──► ViGEmBus ──► games see an Xbox 360 pad
```

## Run
Double-click `start.bat` (or run `.venv\Scripts\python server\server.py`).

### USB mode (lowest latency)
1. Phone: **Settings → About phone → tap "Build number" 7×**, then **Developer options → USB debugging ON**.
2. Plug in a data USB cable and tap **Allow** (tick "Always allow") on the phone prompt.
3. The server logs `🔌 USB phone … ready`. In Chrome on the phone, open **http://localhost:8080**.
4. Optional: Chrome menu ⋮ → **Add to Home screen** to get a full-screen app icon.

### Wi-Fi mode (PC Mobile Hotspot)
Turn on Windows Mobile Hotspot, join it from the phone, and open **https://192.168.137.1:8443**.
The first time, Chrome warns about the self-signed certificate: tap **Advanced → Proceed**.

## Files
| File | Role |
|---|---|
| `server/server.py` | Web server, WebSocket, virtual pads, rumble, watchdog, adb auto-reverse, HTTPS cert |
| `web/index.html` | Controller markup (one DOM for both layouts) |
| `web/style.css` | Look and layouts (`body[data-layout=racing]` re-arranges the same controls) |
| `web/app.js` | Touch routing, sticks/d-pad/pedals, tilt steering, binary protocol, settings |
| `server/m1_*.py`, `m2_*` | Earlier lesson milestones |

## Protocol (little-endian)
| Dir | Type | Layout | Size |
|---|---|---|---|
| phone→PC | STATE 0x01 | `B seq, H buttons, B LT, B RT, h LX, h LY, h RX, h RY` | 14 B |
| phone→PC | PING 0x02 | `d timestamp` (echoed back) | 9 B |
| PC→phone | RUMBLE 0x03 | `B large, B small, B playerLED` | 4 B |
