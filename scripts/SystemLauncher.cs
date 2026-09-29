// SystemLauncher.cs — launch a process at SYSTEM integrity on the interactive
// desktop (WinSta0\Default of the active console session).
//
// Meant to run AS a temporary Windows service (LocalSystem): it duplicates its
// own primary token, stamps it with the console session id, builds a Unicode
// environment block (guaranteeing SystemRoot), and CreateProcessAsUser's the
// target. It then writes a result file and exits (SCM reports 1053 because no
// StartServiceCtrlDispatcher is called — the caller must poll the result file,
// never sc start's exit code).
//
// Parameters JSON (UTF-8): {
//   "exe": "<full path>", "args": "<argument string>",
//   "env": { "K": "V", ... },          // overlay onto the SYSTEM environment
//   "stdout": "<file>", "stderr": "<file>",  // optional console redirects
//   "result": "<file>",                // written: ok|pid=NNN|session=N
//   "cwd": "<dir>"                     // optional
// }
//
// Build (Windows ships the compiler):
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /platform:x64 /target:exe /optimize+ /out:SystemLauncher.exe SystemLauncher.cs

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class SystemLauncher
{
    const uint TOKEN_ALL_ACCESS = 0xF01FF;
    const int TOKEN_TYPE_PRIMARY = 1;
    const int SECURITY_IMPERSONATION = 2;
    const int TokenSessionId = 12;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ = 0x1;
    const uint OPEN_ALWAYS = 4;
    const uint FILE_ATTRIBUTE_NORMAL = 0x80;

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
    [DllImport("kernel32.dll")] static extern int WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attrs, int level, int type, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, ref int info, int len);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmdLine, IntPtr procAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint creation, uint flags, IntPtr template);

    static string JsonString(string json, string key)
    {
        // Minimal extraction for our flat, well-formed params object.
        int i = json.IndexOf("\"" + key + "\"");
        if (i < 0) return null;
        i = json.IndexOf(':', i);
        if (i < 0) return null;
        while (i < json.Length && (json[i] == ':' || json[i] == ' ' || json[i] == '\t' || json[i] == '\r' || json[i] == '\n')) i++;
        if (i >= json.Length) return null;
        if (json[i] == '"')
        {
            i++;
            var sb = new StringBuilder();
            for (; i < json.Length; i++)
            {
                char c = json[i];
                if (c == '\\' && i + 1 < json.Length) { sb.Append(json[++i]); continue; }
                if (c == '"') return sb.ToString();
                sb.Append(c);
            }
            return sb.ToString();
        }
        return null;
    }

    static Dictionary<string, string> JsonEnv(string json)
    {
        var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        int i = json.IndexOf("\"env\"");
        if (i < 0) return env;
        i = json.IndexOf('{', i);
        if (i < 0) return env;
        int end = json.IndexOf('}', i);
        if (end < 0) return env;
        string body = json.Substring(i + 1, end - i - 1);
        // Flat "K":"V",... pairs.
        foreach (var pair in body.Split(','))
        {
            var bits = pair.Split(new[] { ':' }, 2);
            if (bits.Length != 2) continue;
            string k = bits[0].Trim().Trim('"');
            string v = bits[1].Trim().Trim('"');
            if (k.Length > 0) env[k] = v;
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
        string json = File.ReadAllText(paramsPath, Encoding.UTF8);
        string exe = JsonString(json, "exe");
        string argString = JsonString(json, "args") ?? "";
        string stdoutPath = JsonString(json, "stdout");
        string stderrPath = JsonString(json, "stderr");
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
                // 2. Stamp the console session so the child lands on the
                //    user's desktop instead of session 0.
                int session = WTSGetActiveConsoleSessionId();
                if (session < 1) throw new Exception("No active console session (id=" + session + ")");
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

                    // 4. STARTUPINFO: interactive desktop, optional console
                    //    redirects so the app's boot log is observable.
                    var si = new STARTUPINFO();
                    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                    si.lpDesktop = @"winsta0\default";
                    si.dwFlags = 0;
                    IntPtr hOut = IntPtr.Zero, hErr = IntPtr.Zero;
                    if (!string.IsNullOrEmpty(stdoutPath))
                    {
                        hOut = CreateFile(stdoutPath, GENERIC_WRITE, FILE_SHARE_READ, IntPtr.Zero, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
                        if (hOut != new IntPtr(-1)) { si.hStdOutput = hOut; si.dwFlags |= (int)STARTF_USESTDHANDLES; }
                    }
                    if (!string.IsNullOrEmpty(stderrPath))
                    {
                        hErr = CreateFile(stderrPath, GENERIC_WRITE, FILE_SHARE_READ, IntPtr.Zero, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
                        if (hErr != new IntPtr(-1)) { si.hStdError = hErr; si.dwFlags |= (int)STARTF_USESTDHANDLES; }
                    }

                    var cmdLine = new StringBuilder("\"" + exe + "\" " + argString, 32768);
                    var pi = new PROCESS_INFORMATION();
                    bool ok = CreateProcessAsUser(primary, exe, cmdLine, IntPtr.Zero, IntPtr.Zero, false,
                        CREATE_UNICODE_ENVIRONMENT, envPtr, cwd, ref si, out pi);
                    int err = Marshal.GetLastWin32Error();
                    if (hOut != IntPtr.Zero) CloseHandle(hOut);
                    if (hErr != IntPtr.Zero) CloseHandle(hErr);
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
