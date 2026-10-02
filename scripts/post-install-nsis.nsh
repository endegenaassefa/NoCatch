; OpenCluely shortcuts.
; The app itself sets up its Whisper runtime and .env inside %APPDATA% on
; first launch, so the installer does not bootstrap them.
;
; Friends double-click "OpenCluely" for the normal app, "OpenCluely Exam
; Mode" for the SYSTEM-integrity exam mode (band protection), and "OpenCluely
; Stop" to shut exam mode down. Each elevated shortcut costs exactly ONE UAC
; consent. All shortcuts point at the packaged launcher shim, which resolves
; the installed exe relative to itself.

!macro customInstall
  ; NSIS CreateShortCut cannot point directly at a .cmd file (it writes a
  ; 0-byte .lnk), so the launcher shortcuts target cmd.exe and pass the
  ; packaged launcher as the command line. Icon comes from the app exe.
  CreateShortCut "$SMPROGRAMS\OpenCluely (Admin).lnk" "$SYSDIR\cmd.exe" '/C "$INSTDIR\resources\launcher\cluely-admin.cmd"' "$INSTDIR\screen-reader-util.exe" 0
  CreateShortCut "$DESKTOP\OpenCluely (Admin).lnk" "$SYSDIR\cmd.exe" '/C "$INSTDIR\resources\launcher\cluely-admin.cmd"' "$INSTDIR\screen-reader-util.exe" 0
  CreateShortCut "$SMPROGRAMS\OpenCluely Exam Mode.lnk" "$SYSDIR\cmd.exe" '/C "$INSTDIR\resources\launcher\cluely-admin.cmd" system' "$INSTDIR\screen-reader-util.exe" 0
  CreateShortCut "$DESKTOP\OpenCluely Exam Mode.lnk" "$SYSDIR\cmd.exe" '/C "$INSTDIR\resources\launcher\cluely-admin.cmd" system' "$INSTDIR\screen-reader-util.exe" 0
  CreateShortCut "$SMPROGRAMS\OpenCluely Stop.lnk" "$SYSDIR\cmd.exe" '/C "$INSTDIR\resources\launcher\cluely-admin.cmd" stop' "$INSTDIR\screen-reader-util.exe" 0
  CreateShortCut "$DESKTOP\OpenCluely Stop.lnk" "$SYSDIR\cmd.exe" '/C "$INSTDIR\resources\launcher\cluely-admin.cmd" stop' "$INSTDIR\screen-reader-util.exe" 0
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\OpenCluely (Admin).lnk"
  Delete "$DESKTOP\OpenCluely (Admin).lnk"
  Delete "$SMPROGRAMS\OpenCluely Exam Mode.lnk"
  Delete "$DESKTOP\OpenCluely Exam Mode.lnk"
  Delete "$SMPROGRAMS\OpenCluely Stop.lnk"
  Delete "$DESKTOP\OpenCluely Stop.lnk"
  ; Remove the hardened root-data folder (Administrators/SYSTEM-only) with
  ; ONE elevated cleanup. The install dir is NOT hardened, so the normal
  ; uninstaller deletes it itself -- and reinstall/update no longer races a
  ; concurrent rmdir against the new installer's extraction.
  ExecShell "runas" "cmd.exe" '/C rmdir /S /Q "C:\ProgramData\CluelyRoot"'
!macroend
