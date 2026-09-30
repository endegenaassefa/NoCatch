using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace NativeTopmostCalibration {
  public sealed class ProcessPin : IDisposable {
    private IntPtr handle;
    public readonly int ProcessId;
    public readonly long CreatedTicks;
    public readonly string ExecutablePath;
    public ProcessPin(int processId) {
      ProcessId = processId;
      handle = Native.OpenProcess(0x101000, false, processId); // QUERY_LIMITED_INFORMATION | SYNCHRONIZE
      if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot pin target process");
      try {
        long created, exited, kernel, user;
        if (!Native.GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
        CreatedTicks = DateTime.FromFileTimeUtc(created).Ticks;
        var path = new StringBuilder(32768); uint size = (uint)path.Capacity;
        if (!Native.QueryFullProcessImageName(handle, 0, path, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        ExecutablePath = path.ToString();
      } catch { Dispose(); throw; }
    }
    public bool IsAlive { get { return handle != IntPtr.Zero && Native.WaitForSingleObject(handle, 0) == 258; } }
    public void Dispose() { if (handle != IntPtr.Zero) { Native.CloseHandle(handle); handle = IntPtr.Zero; } }
  }

  public sealed class WindowState {
    public string Utc;
    public long Hwnd;
    public uint ProcessId;
    public bool Exists, Visible, Topmost, Minimized;
    public int X, Y, Width, Height;
    public long ForegroundHwnd;
    public uint ForegroundProcessId;
  }
  public sealed class ObservedEvent {
    public string Utc;
    public uint EventId;
    public long Hwnd;
    public int ObjectId, ChildId;
  }

  public static class Native {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    private delegate void EventProc(IntPtr hook, uint eventId, IntPtr hwnd, int objectId, int childId, uint threadId, uint time);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct MSG { public IntPtr Hwnd; public uint Message; public UIntPtr WParam; public IntPtr LParam; public uint Time; public POINT Point; public uint Private; }
    [DllImport("kernel32.dll", SetLastError=true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] internal static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder image, ref uint size);
    [DllImport("kernel32.dll")] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] private static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError=true)] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, EventProc callback, uint processId, uint threadId, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out MSG message, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG message);
    private static readonly List<IntPtr> hooks = new List<IntPtr>();
    private static readonly List<ObservedEvent> events = new List<ObservedEvent>();
    private static HashSet<long> targets = new HashSet<long>();
    private static EventProc eventCallback;
    private static uint targetProcess;

    public static WindowState Sample(long hwndValue) {
      IntPtr hwnd = new IntPtr(hwndValue);
      var state = new WindowState { Utc=DateTime.UtcNow.ToString("o"), Hwnd=hwndValue, Exists=IsWindow(hwnd) };
      uint owner; GetWindowThreadProcessId(hwnd, out owner); state.ProcessId=owner;
      state.Visible=state.Exists && IsWindowVisible(hwnd);
      state.Topmost=state.Exists && (GetWindowLong(hwnd, -20) & 8) != 0;
      state.Minimized=state.Exists && IsIconic(hwnd);
      if (state.Exists) {
        RECT rect;
        if (!GetWindowRect(hwnd, out rect)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Window bounds unavailable");
        state.X=rect.Left; state.Y=rect.Top; state.Width=rect.Right-rect.Left; state.Height=rect.Bottom-rect.Top;
      }
      IntPtr foreground=GetForegroundWindow(); state.ForegroundHwnd=foreground.ToInt64();
      GetWindowThreadProcessId(foreground, out owner); state.ForegroundProcessId=owner;
      return state;
    }
    public static WindowState[] VisibleWindows(uint processId) {
      var result=new List<WindowState>();
      EnumWindows((hwnd, unused) => { uint owner; GetWindowThreadProcessId(hwnd, out owner); if (owner==processId && IsWindowVisible(hwnd)) result.Add(Sample(hwnd.ToInt64())); return true; }, IntPtr.Zero);
      return result.ToArray();
    }
    public static void Demote(long hwndValue, uint expectedProcess) {
      var before=Sample(hwndValue);
      if (!before.Exists || before.ProcessId!=expectedProcess || !before.Visible || !before.Topmost || before.Minimized) throw new InvalidOperationException("Window is not the expected visible topmost target");
      // HWND_NOTOPMOST, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE. No hide/show/focus API exists in this helper.
      if (!SetWindowPos(new IntPtr(hwndValue), new IntPtr(-2), 0, 0, 0, 0, 0x13)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Controlled topmost demotion failed");
    }
    public static void RestoreForCleanup(long hwndValue, uint expectedProcess) {
      var state=Sample(hwndValue);
      if (!state.Exists || state.ProcessId!=expectedProcess || !state.Visible || state.Minimized) throw new InvalidOperationException("Cleanup target no longer has the expected ownership/state");
      if (!state.Topmost && !SetWindowPos(new IntPtr(hwndValue), new IntPtr(-1), 0, 0, 0, 0, 0x13)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cleanup restoration failed");
    }
    public static void BeginEvents(uint processId, long[] hwnds) {
      EndEvents(); events.Clear(); targets=new HashSet<long>(hwnds); targetProcess=processId;
      eventCallback=(hook, eventId, hwnd, objectId, childId, threadId, time) => {
        uint owner; GetWindowThreadProcessId(hwnd, out owner);
        bool isTargetWindow=targets.Contains(hwnd.ToInt64());
        bool relevant=(eventId==3) || (eventId==0x8005 && owner==targetProcess) || ((eventId==0x8002 || eventId==0x8003) && isTargetWindow && objectId==0);
        if (relevant) events.Add(new ObservedEvent { Utc=DateTime.UtcNow.ToString("o"), EventId=eventId, Hwnd=hwnd.ToInt64(), ObjectId=objectId, ChildId=childId });
      };
      IntPtr foreground=SetWinEventHook(3, 3, IntPtr.Zero, eventCallback, 0, 0, 0);
      if (foreground==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Foreground event hook unavailable");
      hooks.Add(foreground);
      IntPtr windowEvents=SetWinEventHook(0x8002, 0x8005, IntPtr.Zero, eventCallback, processId, 0, 0);
      if (windowEvents==IntPtr.Zero) { EndEvents(); throw new Win32Exception(Marshal.GetLastWin32Error(), "Window event hook unavailable"); }
      hooks.Add(windowEvents);
    }
    public static void PumpEvents() { MSG message; while(PeekMessage(out message, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref message); DispatchMessage(ref message); } }
    public static ObservedEvent[] ReadEvents() { PumpEvents(); return events.ToArray(); }
    public static void EndEvents() { foreach(IntPtr hook in hooks) UnhookWinEvent(hook); hooks.Clear(); }
  }
}
