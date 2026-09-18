# Probe: does CGDisplayStream still function on macOS 26 (obsoleted in SDK 15.0)?
# And does it route through replayd/tccd (observable signature)?
import ctypes
import time

cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")

if not hasattr(cg, "CGDisplayStreamCreate"):
    print("CGDS_SYMBOL_MISSING")
    raise SystemExit(1)
print("CGDS_SYMBOL_PRESENT")

HANDLER = ctypes.CFUNCTYPE(None, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_void_p)
frames = []

@HANDLER
def h(status, t, surf, upd):
    frames.append((status, t))

CGDisplayStreamCreate = cg.CGDisplayStreamCreate
CGDisplayStreamCreate.restype = ctypes.c_void_p
CGDisplayStreamCreate.argtypes = [ctypes.c_uint32, ctypes.c_size_t, ctypes.c_size_t, ctypes.c_int32, ctypes.c_void_p, HANDLER]
CGDisplayStreamStart = cg.CGDisplayStreamStart
CGDisplayStreamStart.argtypes = [ctypes.c_void_p]
CGDisplayStreamStop = cg.CGDisplayStreamStop
CGDisplayStreamStop.argtypes = [ctypes.c_void_p]
CGMainDisplayID = cg.CGMainDisplayID
CGMainDisplayID.restype = ctypes.c_uint32

d = CGMainDisplayID()
s = CGDisplayStreamCreate(d, 640, 360, 1111970369, None, h)  # 'BGRA'
print("CGDS_CREATE", "stream_ok" if s else "NULL")
if not s:
    raise SystemExit(2)
CGDisplayStreamStart(s)
time.sleep(4)
print("CGDS_FRAMES", len(frames), frames[:2] if frames else "none")
CGDisplayStreamStop(s)
raise SystemExit(0 if frames else 3)
