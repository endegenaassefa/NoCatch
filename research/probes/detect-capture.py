# Polls the SAME CoreGraphics APIs LockDown Browser uses for capture detection
# (per static recon: _CGDisplayIsCaptured, _CGDisplayIsInMirrorSet) while a
# separate SCK capture process holds a live stream.
# Answers: does LDB's detector SEE a ScreenCaptureKit session?
import ctypes
import subprocess
import time

cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")

CGDisplayIsCaptured = cg.CGDisplayIsCaptured
CGDisplayIsCaptured.restype = ctypes.c_bool
CGDisplayIsCaptured.argtypes = [ctypes.c_uint32]

CGDisplayIsInMirrorSet = cg.CGDisplayIsInMirrorSet
CGDisplayIsInMirrorSet.restype = ctypes.c_bool
CGDisplayIsInMirrorSet.argtypes = [ctypes.c_uint32]

CGMainDisplayID = cg.CGMainDisplayID
CGMainDisplayID.restype = ctypes.c_uint32

d = CGMainDisplayID()

def poll(label):
    cap = CGDisplayIsCaptured(d)
    mir = CGDisplayIsInMirrorSet(d)
    print(f"{label} captured={cap} mirror={mir}")

print("=== baseline (no capture) ===")
for _ in range(4):
    poll("BASE")
    time.sleep(0.25)

print("=== launching SCK hold stream ===")
proc = subprocess.Popen(["./research/probes/sck-hold"], stdout=subprocess.PIPE, text=True, bufsize=1)
t0 = time.time()
seen_frame = False
while time.time() - t0 < 12:
    line = proc.stdout.readline() if proc.poll() is None else ""
    if line:
        line = line.strip()
        print(f"[sck-hold] {line}")
        if "HOLD_FRAME" in line:
            seen_frame = True
    poll(f"t={time.time()-t0:5.1f}s")
    time.sleep(0.25)
    if proc.poll() is not None and time.time() - t0 > 3 and seen_frame:
        # process exited on its own (10s elapsed)
        pass

print("=== after capture ends ===")
for _ in range(4):
    poll("POST")
    time.sleep(0.25)
