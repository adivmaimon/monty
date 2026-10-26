# Renders Monty's notification ping (menubar/MontyApp/Resources/Ping.wav): a soft bell,
# two partials with a 4 ms attack and an exponential tail. Our own sound, so nothing of
# Apple's is shipped. Rerun after changing a number: python3 scripts/make-ping.py
import math, struct, wave, os

RATE = 44100
LENGTH = 0.6          # seconds; the tail is inaudible well before this
ATTACK = 0.004        # a click-free start
PARTIALS = [(1568.0, 1.0, 0.16), (3136.0, 0.25, 0.07), (4704.0, 0.08, 0.04)]  # G6 and overtones: (Hz, level, decay s)
PEAK = 0.45           # leaves headroom; macOS plays notifications at system volume

out = os.path.join(os.path.dirname(__file__), '..', 'menubar', 'MontyApp', 'Resources', 'Ping.wav')
frames = bytearray()
for i in range(int(RATE * LENGTH)):
    t = i / RATE
    env = min(1.0, t / ATTACK)
    v = sum(level * math.exp(-t / decay) * math.sin(2 * math.pi * hz * t) for hz, level, decay in PARTIALS)
    frames += struct.pack('<h', int(max(-1, min(1, v * env * PEAK)) * 32767))
with wave.open(out, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(bytes(frames))
print(out)
