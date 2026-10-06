using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace FocusTrace {
 public sealed class Identity : IDisposable {
  public int Pid; public string Name, Path, PathStatus; public uint Session; public long CreatedFileTime; private IntPtr handle;
  public Identity(int pid) {
   Pid=pid; handle=N.OpenProcess(0x101000,false,pid);
   if(handle==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"Target identity unavailable (process handle)");
   try { long exit,k,u; if(!N.GetProcessTimes(handle,out CreatedFileTime,out exit,out k,out u)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Creation identity unavailable");
    if(!N.ProcessIdToSessionId((uint)pid,out Session)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Session identity unavailable");
    Name=Process.GetProcessById(pid).ProcessName; var s=new StringBuilder(32768); uint len=(uint)s.Capacity;
    if(N.QueryFullProcessImageName(handle,0,s,ref len)){Path=s.ToString();PathStatus="available";}else{Path=null;PathStatus="unavailable_win32_"+Marshal.GetLastWin32Error();}
   }catch{Dispose();throw;}
  }
  public bool Alive {get{return handle!=IntPtr.Zero && N.WaitForSingleObject(handle,0)==258;}}
  public void Dispose(){if(handle!=IntPtr.Zero){N.CloseHandle(handle);handle=IntPtr.Zero;}}
 }
 public sealed class Row { public string ReceiptUtc; public long MonotonicTicks; public uint NativeEventMs,EventId,Pid,ThreadId; public long Hwnd; public int ObjectId,ChildId; public bool Exists,Visible,RectAvailable; public int X,Y,Width,Height,RectError; }
 public static class N {
  public delegate bool EnumProc(IntPtr hwnd,IntPtr arg); private delegate void EventProc(IntPtr hook,uint e,IntPtr hwnd,int obj,int child,uint thread,uint time);
  [StructLayout(LayoutKind.Sequential)] public struct RECT{public int L,T,R,B;}
  [StructLayout(LayoutKind.Sequential)] private struct POINT{public int X,Y;}
  [StructLayout(LayoutKind.Sequential)] private struct MSG{public IntPtr Hwnd;public uint Message;public UIntPtr WParam;public IntPtr LParam;public uint Time;public POINT Point;public uint Private;}
  [DllImport("kernel32.dll",SetLastError=true)] internal static extern IntPtr OpenProcess(uint a,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GetProcessTimes(IntPtr h,out long c,out long e,out long k,out long u);
  [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool ProcessIdToSessionId(uint pid,out uint s);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern bool QueryFullProcessImageName(IntPtr h,uint f,StringBuilder b,ref uint l);
  [DllImport("kernel32.dll")] internal static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr h);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb,IntPtr arg);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",SetLastError=true)] private static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll",SetLastError=true)] private static extern IntPtr SetWinEventHook(uint a,uint b,IntPtr module,EventProc cb,uint p,uint t,uint flags);
  [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr h);
  [DllImport("user32.dll")] private static extern bool PeekMessage(out MSG m,IntPtr h,uint a,uint b,uint remove);
  [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG m);
  static List<IntPtr> hooks=new List<IntPtr>(); static Queue<Row> queue=new Queue<Row>(); static EventProc callback; static HashSet<uint> relevant=new HashSet<uint>();
  public static long Dropped; public static long Frequency=Stopwatch.Frequency;
  public static Row Sample(long hwnd){var h=new IntPtr(hwnd); var r=new Row{ReceiptUtc=DateTime.UtcNow.ToString("o"),MonotonicTicks=Stopwatch.GetTimestamp(),Hwnd=hwnd,Exists=IsWindow(h)};uint p;GetWindowThreadProcessId(h,out p);r.Pid=p;r.Visible=IsWindowVisible(h);RECT b;r.RectAvailable=GetWindowRect(h,out b);if(r.RectAvailable){r.X=b.L;r.Y=b.T;r.Width=b.R-b.L;r.Height=b.B-b.T;}else r.RectError=Marshal.GetLastWin32Error();return r;}
  public static Row Foreground(){return Sample(GetForegroundWindow().ToInt64());}
  public static Row[] Windows(){var list=new List<Row>();EnumWindows((h,a)=>{uint p;GetWindowThreadProcessId(h,out p);if(relevant.Contains(p))list.Add(Sample(h.ToInt64()));return true;},IntPtr.Zero);return list.ToArray();}
  public static void Relevant(uint[] p){relevant=new HashSet<uint>(p);}
  public static void Begin(){Dropped=0;queue.Clear();callback=(h,e,w,o,c,t,ms)=>{uint p;GetWindowThreadProcessId(w,out p);if(e!=3 && (!relevant.Contains(p)||o!=0||c!=0))return;var r=Sample(w.ToInt64());r.EventId=e;r.NativeEventMs=ms;r.ObjectId=o;r.ChildId=c;r.ThreadId=t;if(queue.Count>=4096){Dropped++;return;}queue.Enqueue(r);};try{foreach(uint[] range in new uint[][]{new uint[]{3,3},new uint[]{10,11},new uint[]{0x8000,0x8003},new uint[]{0x800B,0x800B}}){IntPtr h=SetWinEventHook(range[0],range[1],IntPtr.Zero,callback,0,0,0);if(h==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"WinEvent registration failed");hooks.Add(h);}}catch{Unregister();throw;}}
  public static Row[] Drain(){MSG m;int count=0;while(count++<8192 && PeekMessage(out m,IntPtr.Zero,0,0,1)){TranslateMessage(ref m);DispatchMessage(ref m);}var r=queue.ToArray();queue.Clear();return r;}
  public static bool LastUnhookSuccess=true;
  public static void Unregister(){bool ok=true;foreach(var h in hooks)ok=UnhookWinEvent(h)&&ok;hooks.Clear();LastUnhookSuccess=ok;}
 }
}
