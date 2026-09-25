"""Explicit-window Windows exploratory QA using screenshot/click/type actions.

Controls only a named HWND belonging to an explicit PID. No app launch/termination,
global hotkeys, credential handling, or OS-setting changes are implemented here.
Requires an interactive Windows desktop and installed Pillow/PyAutoGUI.
"""
from __future__ import annotations
import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import time


def _point(rect, x, y):
    if any(isinstance(v, bool) or not isinstance(v, int) for v in (x, y)):
        raise ValueError('Coordinates must be integer window-relative pixels')
    left, top, right, bottom = rect
    if not (0 <= x < right-left and 0 <= y < bottom-top):
        raise ValueError('Point is outside the target window')
    return left+x, top+y


def _api():
    if os.name != 'nt':
        raise RuntimeError('Native desktop driver requires Windows; web/Electron can use agent-browser')
    user = ctypes.WinDLL('user32', use_last_error=True)
    user.SetProcessDPIAware()
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.IsWindow.argtypes = [wintypes.HWND]
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.IsIconic.argtypes = [wintypes.HWND]
    user.SetForegroundWindow.argtypes = [wintypes.HWND]
    user.GetForegroundWindow.restype = wintypes.HWND
    user.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
    user.GetAncestor.restype = wintypes.HWND
    user.WindowFromPoint.argtypes = [wintypes.POINT]
    user.WindowFromPoint.restype = wintypes.HWND
    return user


def window_info(user, handle, pid):
    if pid <= 0 or handle <= 0 or not user.IsWindow(handle):
        raise ValueError('Target window does not exist')
    actual = wintypes.DWORD()
    user.GetWindowThreadProcessId(handle, ctypes.byref(actual))
    if actual.value != pid:
        raise ValueError('Target window PID does not match')
    if not user.IsWindowVisible(handle) or user.IsIconic(handle):
        raise ValueError('Target window must be visible and not minimized')
    rect = wintypes.RECT()
    if not user.GetWindowRect(handle, ctypes.byref(rect)):
        raise RuntimeError('Cannot read target window bounds')
    title = ctypes.create_unicode_buffer(user.GetWindowTextLengthW(handle)+1)
    user.GetWindowTextW(handle, title, len(title))
    return {'handle': int(handle), 'pid': pid, 'title': title.value,
            'rect': [rect.left, rect.top, rect.right, rect.bottom]}


def windows(pid):
    if pid <= 0:
        raise ValueError('An explicit positive PID is required')
    user = _api()
    result = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(handle, _):
        try:
            result.append(window_info(user, handle, pid))
        except (ValueError, RuntimeError):
            pass
        return True
    callback = callback_type(visit)
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.EnumWindows(callback, 0)
    return result


def act(args):
    user = _api()
    info = window_info(user, args.handle, args.pid)
    if args.command == 'click':
        _point(info['rect'], args.x, args.y)  # Validate before changing focus.
    import pyautogui
    pyautogui.FAILSAFE = True
    user.SetForegroundWindow(args.handle)
    time.sleep(.15)
    if user.GetForegroundWindow() != args.handle:
        raise RuntimeError('Target did not become foreground; no input sent')
    info = window_info(user, args.handle, args.pid)
    if args.command == 'screenshot':
        from PIL import ImageGrab
        output = Path(args.output).resolve()
        if output.suffix.lower() != '.png':
            raise ValueError('Screenshot output must end in .png')
        output.parent.mkdir(parents=True, exist_ok=True)
        ImageGrab.grab(bbox=tuple(info['rect']), all_screens=True).save(output)
        return {**info, 'screenshot': str(output)}
    if args.command == 'click':
        x, y = _point(info['rect'], args.x, args.y)
        hit = user.WindowFromPoint(wintypes.POINT(x, y))
        if user.GetAncestor(hit, 2) != args.handle:
            raise RuntimeError('Point is obscured by another window; no click sent')
        pyautogui.click(x, y)
    elif args.command == 'press':
        if args.key not in ('tab', 'enter', 'escape', 'space', 'backspace', 'delete', 'left', 'right', 'up', 'down', 'home', 'end'):
            raise ValueError('Only local navigation/editing keys are supported')
        pyautogui.press(args.key)
    elif args.command == 'type':
        if len(args.text) > 2000 or any(ord(c) < 32 or ord(c) > 126 for c in args.text):
            raise ValueError('Desktop typing supports at most 2000 printable ASCII characters; use semantic app tools for Unicode')
        pyautogui.write(args.text, interval=.015)
    return {**info, 'action': args.command, 'sent': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    listing = commands.add_parser('windows')
    listing.add_argument('--pid', type=int, required=True)
    for name in ('screenshot', 'click', 'press', 'type'):
        command = commands.add_parser(name)
        command.add_argument('--pid', type=int, required=True)
        command.add_argument('--handle', type=int, required=True)
        if name == 'screenshot':
            command.add_argument('--output', required=True)
        elif name == 'click':
            command.add_argument('--x', type=int, required=True)
            command.add_argument('--y', type=int, required=True)
        elif name == 'press':
            command.add_argument('--key', required=True)
        else:
            command.add_argument('--text', required=True)
    args = parser.parse_args()
    try:
        result = windows(args.pid) if args.command == 'windows' else act(args)
        print(json.dumps(result))
        return 0
    except (ValueError, RuntimeError, OSError, ImportError) as exc:
        print(json.dumps({'error': str(exc)}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
