"""
MILESTONE 1 — Create a virtual Xbox 360 controller and drive it from code.

Run:   .venv\\Scripts\\python server\\m1_virtual_pad.py
Watch: press Win+R, type  joy.cpl  , press Enter -> select the controller -> Properties.
       You'll see buttons light up and the stick move by itself.
"""

import math   # for sin/cos to move the stick in a circle
import time   # for sleep() so we can pace the demo

import vgamepad as vg   # Python wrapper around the ViGEmBus driver

# ---------------------------------------------------------------------------
# CONCEPT 1: Creating the device
# This single line asks the ViGEmBus driver to "plug in" a fake Xbox 360 pad.
# Windows plays the USB-connect sound and every game now sees a controller.
# When this Python program exits, the controller is "unplugged" automatically.
# ---------------------------------------------------------------------------
pad = vg.VX360Gamepad()
print("Virtual Xbox 360 controller connected! Open joy.cpl to watch it.")
time.sleep(2)  # give Windows a moment to finish recognising the device

# ---------------------------------------------------------------------------
# CONCEPT 2: Buttons are bits
# Inside XInput, all 14 digital buttons are packed into ONE 16-bit number.
# Each button owns one bit:  A = 0x1000, B = 0x2000, X = 0x4000, Y = 0x8000 ...
# Pressing A means "set bit 0x1000 to 1". That's why press/release are cheap.
#
# CONCEPT 3: Nothing happens until update()
# press_button() only changes the *report* stored in Python memory.
# update() sends that whole report to the driver in one go.
# This "batch then send" pattern means A+B pressed together arrive together.
# ---------------------------------------------------------------------------
for name, btn in [("A", vg.XUSB_BUTTON.XUSB_GAMEPAD_A),
                  ("B", vg.XUSB_BUTTON.XUSB_GAMEPAD_B),
                  ("X", vg.XUSB_BUTTON.XUSB_GAMEPAD_X),
                  ("Y", vg.XUSB_BUTTON.XUSB_GAMEPAD_Y)]:
    print(f"Pressing {name}")
    pad.press_button(button=btn)
    pad.update()
    time.sleep(0.5)
    pad.release_button(button=btn)
    pad.update()
    time.sleep(0.2)

# ---------------------------------------------------------------------------
# CONCEPT 4: Analog values
#  - Triggers (LT/RT): 0.0 = released, 1.0 = fully pressed.
#    (Internally a byte 0..255 -> 256 levels of throttle.)
#  - Sticks: X and Y each from -1.0 to +1.0, centre is 0.0.
#    (Internally a signed 16-bit int -32768..32767 -> very fine steering.)
# We use the *_float helpers so we can think in nice -1..1 ranges.
# ---------------------------------------------------------------------------
print("Squeezing right trigger (throttle) from 0% to 100%")
for i in range(0, 101, 5):
    pad.right_trigger_float(value_float=i / 100)
    pad.update()
    time.sleep(0.05)
pad.right_trigger_float(value_float=0.0)
pad.update()

print("Spinning left stick in a circle (unit circle: x=cos, y=sin)")
for step in range(120):                  # 120 steps ~ 3 seconds
    angle = step / 120 * 2 * math.pi * 2  # two full turns
    pad.left_joystick_float(x_value_float=math.cos(angle),
                            y_value_float=math.sin(angle))
    pad.update()
    time.sleep(0.025)                    # 40 updates per second

pad.reset()    # everything back to neutral
pad.update()
print("Done. Controller will disconnect when you press Enter.")
input()
