"""Move only the owning app's visible windows without rewriting their size."""

import ctypes
from ctypes import wintypes
import json
import os
import re
import sys
import threading


def main():
    owner_pid = int(sys.argv[1])
    if owner_pid <= 0 or owner_pid > 0xFFFFFFFF:
        raise ValueError("Invalid owner PID")
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int,
                                   ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.SetWindowPos.restype = wintypes.BOOL
    user32.BeginDeferWindowPos.argtypes = [ctypes.c_int]
    user32.BeginDeferWindowPos.restype = wintypes.HANDLE
    user32.DeferWindowPos.argtypes = [wintypes.HANDLE, wintypes.HWND, wintypes.HWND,
                                     ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                     ctypes.c_int, wintypes.UINT]
    user32.DeferWindowPos.restype = wintypes.HANDLE
    user32.EndDeferWindowPos.argtypes = [wintypes.HANDLE]
    user32.EndDeferWindowPos.restype = wintypes.BOOL
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    # Retain a handle to the original owner; PID reuse cannot keep this child alive.
    owner = kernel32.OpenProcess(0x00100000, False, owner_pid)  # SYNCHRONIZE
    if not owner:
        raise RuntimeError("Window owner is unavailable")

    stopping = threading.Event()

    def watch_owner():
        while not stopping.is_set():
            result = kernel32.WaitForSingleObject(owner, 100)
            if result != 0x00000102:  # WAIT_TIMEOUT
                os._exit(0 if result == 0 else 1)

    watcher = threading.Thread(target=watch_owner, daemon=True)
    watcher.start()
    try:
        if not user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4)):
            raise RuntimeError("Per-monitor window coordinates unavailable")
        print(json.dumps({"type": "ready", "ownerPid": owner_pid}), flush=True)
        while True:
            line = sys.stdin.readline(16385)
            if not line:
                break
            if len(line) > 16384 or not line.endswith("\n"):
                raise ValueError("Movement input limit exceeded")
            request = json.loads(line)
            if not isinstance(request, dict) or type(request.get("id")) is not int or request["id"] <= 0:
                raise ValueError("Invalid movement request identity")
            request_id = request["id"]
            try:
                targets = request.get("targets")
                if request.get("type") != "move" or not isinstance(targets, list) or not 1 <= len(targets) <= 2:
                    raise ValueError("Invalid movement request")
                validated = []
                for target in targets:
                    if not isinstance(target, dict):
                        raise ValueError("Invalid movement target")
                    handle = target.get("handle")
                    if not isinstance(handle, str) or not re.fullmatch(r"[1-9][0-9]{0,18}", handle):
                        raise ValueError("Invalid window handle")
                    hwnd = int(handle)
                    if hwnd > 0x7FFFFFFFFFFFFFFF:
                        raise ValueError("Invalid window handle")
                    x, y = target.get("x"), target.get("y")
                    if any(type(value) is not int or not -2147483648 <= value <= 2147483647 for value in (x, y)):
                        raise ValueError("Invalid window coordinates")
                    actual_pid = wintypes.DWORD()
                    if not user32.GetWindowThreadProcessId(hwnd, ctypes.byref(actual_pid)) or actual_pid.value != owner_pid:
                        raise ValueError("Window is not owned by this app")
                    if not user32.IsWindowVisible(hwnd):
                        raise ValueError("Window is not visible")
                    validated.append((hwnd, x, y))
                for hwnd, x, y in validated:
                    # Recheck the complete set before staging any native update.
                    actual_pid = wintypes.DWORD()
                    if not user32.GetWindowThreadProcessId(hwnd, ctypes.byref(actual_pid)) or actual_pid.value != owner_pid:
                        raise ValueError("Window ownership changed")
                    if not user32.IsWindowVisible(hwnd):
                        raise ValueError("Window visibility changed")
                if kernel32.WaitForSingleObject(owner, 0) != 0x00000102:
                    raise RuntimeError("Original window owner has exited")
                # SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE.
                if len(validated) == 1:
                    hwnd, x, y = validated[0]
                    if not user32.SetWindowPos(hwnd, None, x, y, 0, 0, 0x0015):
                        raise RuntimeError("Native window move failed")
                else:
                    batch = user32.BeginDeferWindowPos(len(validated))
                    if not batch:
                        raise RuntimeError("Native window batch could not start")
                    for hwnd, x, y in validated:
                        batch = user32.DeferWindowPos(batch, hwnd, None, x, y, 0, 0, 0x0015)
                        if not batch:
                            # Windows requires abandoning the batch without End
                            # after a failed Defer; no preceding target was applied.
                            raise RuntimeError("Native window batch preparation failed")
                    if not user32.EndDeferWindowPos(batch):
                        # Report failure; do not claim transactional rollback or retry.
                        raise RuntimeError("Native window batch application failed")
                result = {"id": request_id, "ok": True}
            except (ValueError, RuntimeError) as error:
                result = {"id": request_id, "ok": False, "error": str(error)[:160]}
            print(json.dumps(result), flush=True)
    finally:
        # Never close a process handle while another thread is waiting on it.
        stopping.set()
        watcher.join()
        kernel32.CloseHandle(owner)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # No request payload, environment, or traceback is written to logs.
        sys.stderr.write("Windows movement helper stopped\n")
        sys.exit(1)
