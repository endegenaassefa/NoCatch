// SystemLauncher.cs — launch a process at SYSTEM integrity on the interactive
// desktop (WinSta0\Default of the invoking session).
//
// Meant to run AS a temporary Windows service (LocalSystem): it duplicates its
// own primary token, stamps it with the invoking session id, builds a Unicode
// environment block (guaranteeing SystemRoot), and CreateProcessAsUser's the
// target. It then writes a result file and exits (SCM reports 1053 because no
// StartServiceCtrlDispatcher is called — the caller must poll the result file,
// never sc start's exit code).
//
// Parameters JSON (UTF-8): {
//   "exe": "<full path>", "args": "<argument string>",
//   "env": { "K": "V", ... },          // overlay onto the SYSTEM environment
//   "session": "<invoking Windows session ID>",
//   "result": "<file>",                // written: ok|pid=NNN|session=N
//   "cwd": "<dir>"                     // optional
// }
//
// Build (Windows ships the compiler):
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /platform:x64 /target:exe /optimize+ /r:System.Web.Extensions.dll /out:SystemLauncher.exe SystemLauncher.cs

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

public static class SystemLauncher
{
    const uint TOKEN_ALL_ACCESS = 0xF01FF;
    const int TOKEN_TYPE_PRIMARY = 1;
    const int SECURITY_IMPERSONATION = 2;
    const int TokenSessionId = 12;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attrs, int level, int type, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, ref int info, int len);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmdLine, IntPtr procAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    static string JsonString(Dictionary<string, object> values, string key)
    {
        object value;
        return values.TryGetValue(key, out value) ? value as string : null;
    }

    static Dictionary<string, string> JsonEnv(Dictionary<string, object> values)
    {
        var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        object raw;
        if (!values.TryGetValue("env", out raw)) return env;
        var entries = raw as Dictionary<string, object>;
        if (entries == null) throw new Exception("Invalid environment object.");
        foreach (var entry in entries) {
            if (!(entry.Value is string) || entry.Key.IndexOfAny(new char[] {'=', '\0'}) >= 0 ||
                ((string)entry.Value).IndexOf('\0') >= 0) throw new Exception("Invalid environment entry.");
            env[entry.Key] = (string)entry.Value;
        }
        return env;
    }

    static void WriteResult(string path, string text)
    {
        try { File.WriteAllText(path, text, new UTF8Encoding(false)); }
        catch { }
    }

    static int Main(string[] args)
    {
        string paramsPath = null;
        for (int a = 0; a + 1 < args.Length; a++)
        {
            if (args[a] == "-params") paramsPath = args[a + 1];
        }
        if (paramsPath == null || !File.Exists(paramsPath))
        {
            WriteResult(Environment.ExpandEnvironmentVariables(@"%TEMP%\SystemLauncher-error.txt"), "error|missing params");
            return 1;
        }
        var json = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(paramsPath, Encoding.UTF8));
        string exe = JsonString(json, "exe");
        string argString = JsonString(json, "args") ?? "";
        string resultPath = JsonString(json, "result") ?? @"C:\ProgramData\CluelyRoot\system-launch-result.txt";
        string cwd = JsonString(json, "cwd");
        var envOverlay = JsonEnv(json);

        try
        {
            // 1. Duplicate our own (SYSTEM) token into a primary token.
            IntPtr raw = IntPtr.Zero, primary = IntPtr.Zero;
            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out raw))
                throw new Exception("OpenProcessToken failed: " + Marshal.GetLastWin32Error());
            try
            {
                if (!DuplicateTokenEx(raw, TOKEN_ALL_ACCESS, IntPtr.Zero, SECURITY_IMPERSONATION, TOKEN_TYPE_PRIMARY, out primary))
                    throw new Exception("DuplicateTokenEx failed: " + Marshal.GetLastWin32Error());
            }
            finally { CloseHandle(raw); }

            try
            {
                // 2. Stamp the invoking session so the child lands on the
                //    user's desktop instead of session 0.
                int session;
                if (!int.TryParse(JsonString(json, "session"), out session) || session < 1)
                    throw new Exception("The invoking Windows session is required.");
                if (!SetTokenInformation(primary, TokenSessionId, ref session, 4))
                    throw new Exception("SetTokenInformation failed: " + Marshal.GetLastWin32Error());

                // 3. Environment block: our own environment (guaranteed to
                //    contain SystemRoot) + the caller's overlay, double-null
                //    terminated Unicode.
                var vars = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables())
                {
                    if (e.Key != null && e.Value != null) vars[(string)e.Key] = (string)e.Value;
                }
                foreach (var kv in envOverlay) vars[kv.Key] = kv.Value;
                var block = new StringBuilder();
                foreach (var kv in vars) block.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
                block.Append('\0');
                byte[] envBytes = Encoding.Unicode.GetBytes(block.ToString());
                IntPtr envPtr = Marshal.AllocHGlobal(envBytes.Length);
                try
                {
                    Marshal.Copy(envBytes, 0, envPtr, envBytes.Length);

                    // Handles cannot be inherited from service session 0 into
                    // another Windows session. Readiness is verified through
                    // the app's session pipe; do not supply invalid std handles.
                    var si = new STARTUPINFO();
                    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                    si.lpDesktop = @"winsta0\default";
                    si.dwFlags = 0;

                    var cmdLine = new StringBuilder("\"" + exe + "\" " + argString, 32768);
                    var pi = new PROCESS_INFORMATION();
                    bool ok = CreateProcessAsUser(primary, exe, cmdLine, IntPtr.Zero, IntPtr.Zero, false,
                        CREATE_UNICODE_ENVIRONMENT, envPtr, cwd, ref si, out pi);
                    int err = Marshal.GetLastWin32Error();
                    if (!ok) throw new Exception("CreateProcessAsUser failed: " + err);

                    CloseHandle(pi.hThread);
                    CloseHandle(pi.hProcess);
                    WriteResult(resultPath, "ok|pid=" + pi.dwProcessId + "|session=" + session);
                    return 0;
                }
                finally { Marshal.FreeHGlobal(envPtr); }
            }
            finally { CloseHandle(primary); }
        }
        catch (Exception ex)
        {
            WriteResult(resultPath, "error|" + ex.Message);
            return 1;
        }
    }
}
