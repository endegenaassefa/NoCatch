# Probe: does CGWindowListCreateImage still exist/function on macOS 26 via dlsym/ctypes?
# The SDK marks it obsoleted in macOS 15.0, but the symbol may remain in the
# dyld shared cache. This probe bypasses the compiler availability marker.
import ctypes
import ctypes.util
import time

lib = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
fn = getattr(lib, "CGWindowListCreateImage", None)
if fn is None:
    print("CGWINDOW_SYMBOL_MISSING")
    raise SystemExit(1)

print("CGWINDOW_SYMBOL_PRESENT")

# typedefs
CGWindowID = ctypes.c_uint32
CGRect = ctypes.c_double * 4  # x, y, w, h (struct but layout matches)
fn.restype = ctypes.c_void_p
fn.argtypes = [CGRect, ctypes.c_uint32, CGWindowID, ctypes.c_uint32]

CGImageGetWidth = lib.CGImageGetWidth
CGImageGetHeight = lib.CGImageGetHeight
CGImageGetWidth.restype = ctypes.c_size_t
CGImageGetWidth.argtypes = [ctypes.c_void_p]
CGImageGetHeight.restype = ctypes.c_size_t
CGImageGetHeight.argtypes = [ctypes.c_void_p]
CGImageRelease = lib.CGImageRelease
CGImageRelease.argtypes = [ctypes.c_void_p]

# CGWindowListOption: kCGWindowListOptionOnScreenOnly = 1 << 0
# kCGNullWindowID = 0
# CGWindowImageOption: kCGWindowImageBoundsIgnoreFraming = 1 << 0, kCGWindowImageBestResolution = 1 << 3
NEG_INF = float("-inf")
POS_INF = float("inf")
t0 = time.time()
# CGRect.infinite = origin(-inf,-inf), size(inf,inf)
img = fn(CGRect(NEG_INF, NEG_INF, POS_INF, POS_INF), 1, 0, (1 << 0) | (1 << 3))
elapsed = time.time() - t0
if img:
    w = CGImageGetWidth(img)
    h = CGImageGetHeight(img)
    print(f"CGWINDOW_OK {w}x{h} elapsed={elapsed:.3f}s")
    CGImageRelease(img)
else:
    print(f"CGWINDOW_NIL elapsed={elapsed:.3f}s")
