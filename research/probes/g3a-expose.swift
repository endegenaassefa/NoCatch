// g3a-expose.swift — helper exposure probe (run as uid 501, NO sudo).
//
// Answers the design's §8 question: what exactly can LockDown Browser's own
// enumerated checks see of the running ROOT rig? Mirrors the calls found in
// ldb-static-recon.md (killProcessesTimer/checkProcessDeveloperIdTimer):
//   * proc_pidpath(2)        — LDB's _proc_pidpath: binary path of the pid
//   * SecCodeCopyGuestWithAttributes — guest code object from the audit token
//   * SecCodeCopySigningInformation — signing id / team id / status
//   * SecCodeCheckValidityWithErrors / SecStaticCodeCheckValidityWithErrors
//     with "anchor apple generic" — the Developer-ID requirement LDB applies
//     to running processes
//
// This converts design-review-1 F15 speculation ("unenumerated unsigned root
// process = plausible server flag vector") into a measured signature.
//
// Usage: g3a-expose [--pid N] [--log /tmp/g3a-rig.log]
//   pid defaults to the one found in the rig log's G3A_START line.
import Foundation
import Security
import Darwin

// libproc declaration (link with -lproc)
@_silgen_name("proc_pidpath")
func proc_pidpath(_ pid: Int32, _ buffer: UnsafeMutableRawPointer, _ buffersize: UInt32) -> Int32

func out(_ s: String) { print(s); fflush(stdout) }

// ── pid resolution ────────────────────────────────────────────────────────
var pid: Int32 = 0
if let i = CommandLine.arguments.firstIndex(of: "--pid"), i + 1 < CommandLine.arguments.count,
   let v = Int32(CommandLine.arguments[i + 1]) {
    pid = v
} else {
    let logPath: String
    if let i = CommandLine.arguments.firstIndex(of: "--log"), i + 1 < CommandLine.arguments.count {
        logPath = CommandLine.arguments[i + 1]
    } else {
        logPath = "/tmp/g3a-rig.log"
    }
    if let content = try? String(contentsOfFile: logPath, encoding: .utf8) {
        for line in content.split(separator: "\n") {
            if line.hasPrefix("G3A_START"), let r = line.range(of: "pid=") {
                pid = Int32(line[r.upperBound...].prefix(while: { $0.isNumber })) ?? 0
                break
            }
        }
    }
}
guard pid > 0 else { out("EXPOSE_FAIL no rig pid found (run the rig first, or pass --pid)"); exit(1) }

out("EXPOSE_START pid=\(pid) uid=\(getuid()) euid=\(geteuid())")

// ── 1. proc_pidpath (what LDB's _proc_pidpath sees) ───────────────────────
var binaryPath: String? = nil
do {
    var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    let n = proc_pidpath(pid, &buf, UInt32(buf.count))
    if n > 0 {
        binaryPath = String(cString: buf)
        out("EXPOSE_PIDPATH pid=\(pid) path=\(binaryPath!)")
    } else {
        out("EXPOSE_PIDPATH pid=\(pid) path=<none — proc_pidpath returned \(n)>")
    }
}

// ── 2/3. SecCode guest + signing information (Developer-ID checks) ────────
do {
    // Audit token for the guest lookup: pid in val[0], version 2 in val[5]
    // (KERNEL_AUDIT_TOKEN_VERSION) — the fields SecCodeCopyGuestWithAttributes
    // reads. Remaining fields zero.
    var audit = audit_token_t()
    audit.val.0 = UInt32(pid)
    audit.val.5 = 2
    let attrs: [String: Any] = [kSecGuestAttributeAudit as String: withUnsafeBytes(of: audit) { Data($0) }]
    var guest: SecCode?
    let st = SecCodeCopyGuestWithAttributes(nil, attrs as CFDictionary, [], &guest)

    var staticCode: SecStaticCode?
    var dynamicGuest = false
    if st == errSecSuccess, let g = guest {
        dynamicGuest = true
        _ = SecCodeCopyStaticCode(g, SecCSFlags(), &staticCode)
    }
    if staticCode == nil, let p = binaryPath {
        // fallback: static code straight from the executable path
        _ = SecStaticCodeCreateWithPath(URL(fileURLWithPath: p) as CFURL, SecCSFlags(), &staticCode)
    }
    guard let sc = staticCode else {
        out("EXPOSE_SECCODE pid=\(pid) guest_error=\(st) static_error=unavailable")
        out("EXPOSE_DONE")
        exit(2)
    }
    if dynamicGuest {
        out("EXPOSE_SECCODE pid=\(pid) mode=dynamic-guest")
    } else {
        out("EXPOSE_SECCODE pid=\(pid) mode=static-path guest_error=\(st)")
    }

    var info: CFDictionary?
    let si = SecCodeCopySigningInformation(sc, SecCSFlags(), &info)
    if si == errSecSuccess, let d = info as? [String: Any] {
        out("EXPOSE_SIGNING pid=\(pid) identifier=\(d[kSecCodeInfoIdentifier as String] ?? "?") team=\(d[kSecCodeInfoTeamIdentifier as String] ?? "?") status=\(d[kSecCodeInfoStatus as String] ?? "?")")
    } else {
        out("EXPOSE_SIGNING pid=\(pid) error=\(si)")
    }

    // Developer-ID validity against the generic Apple requirement (what
    // checkProcessDeveloperIdTimer does with SecRequirementCreateWithString).
    var req: SecRequirement?
    let rs = SecRequirementCreateWithString("anchor apple generic" as CFString, [], &req)
    guard rs == errSecSuccess, let r = req else {
        out("EXPOSE_DEV_ID pid=\(pid) requirement_error=\(rs)")
        out("EXPOSE_DONE")
        exit(3)
    }
    if dynamicGuest, let g = guest {
        var errs: Unmanaged<CFError>?
        let v = SecCodeCheckValidityWithErrors(g, SecCSFlags(), r, &errs)
        if v == errSecSuccess {
            out("EXPOSE_DEV_ID pid=\(pid) verdict=VALID_APPLE_GENERIC")
        } else {
            out("EXPOSE_DEV_ID pid=\(pid) verdict=INVALID status=\(v) detail=\(errs?.takeRetainedValue().localizedDescription ?? "?")")
        }
    } else {
        var errs: Unmanaged<CFError>?
        let v = SecStaticCodeCheckValidityWithErrors(sc, SecCSFlags(), r, &errs)
        if v == errSecSuccess {
            out("EXPOSE_DEV_ID pid=\(pid) verdict=VALID_APPLE_GENERIC")
        } else {
            out("EXPOSE_DEV_ID pid=\(pid) verdict=INVALID status=\(v) detail=\(errs?.takeRetainedValue().localizedDescription ?? "?")")
        }
    }
}

out("EXPOSE_DONE")
exit(0)
