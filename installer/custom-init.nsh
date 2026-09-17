; ════════════════════════════════════════════════════════════════════
; custom-init.nsh — installer-time checks for Eleven Edit.
;
; Two independent hooks:
;   customInit    (fires early, before files are copied) — Java heads-up.
;   customInstall (fires after files are copied)          — VC++ runtime check,
;                  because it runs the bundled vc_redist.x64.exe which only
;                  exists on disk once the app's resources are extracted.
;
; Both are HEADS-UPS with an opt-out, never hard gates: the editor runs fine
; without either dependency (audio just greys out without the VC++ runtime; the
; bridge is re-checked at launch for Java). Nothing here installs blindly.
; ════════════════════════════════════════════════════════════════════

; ---- Java presence heads-up (missing-only; success path stays silent) --------
!macro customInit
  nsExec::ExecToStack '"java" -version'
  Pop $0   ; exit code ("0" = java ran)
  Pop $1   ; version text (unused)

  StrCmp $0 "0" javaCheckDone javaCheckMissing

  javaCheckMissing:
    MessageBox MB_YESNO|MB_ICONEXCLAMATION \
      "Java Runtime Not Detected$\r$\n$\r$\n\
Eleven Edit requires a Java Runtime Environment (JRE), version 25 or \
higher, to run. No usable Java installation was detected on this system.$\r$\n$\r$\n\
You can continue installing Eleven Edit now and install Java afterward \
— Eleven Edit will check again and let you know if Java still isn't \
found when you first run it — or cancel this install and set up Java \
first.$\r$\n$\r$\n\
Continue installing anyway?" \
      IDYES javaCheckDone
    Abort
    Goto javaCheckDone

  javaCheckDone:
!macroend

; ---- Microsoft Visual C++ runtime (needed by the built-in audio engine) ------
; Install the bundled redist at install time, unconditionally and silently —
; the OEM approach. The Microsoft redist self-checks: if a current-or-newer
; version is already present it no-ops in about a second, so there's no need for
; us to detect it first. Running it here GUARANTEES the runtime is present before
; the app ever launches, so the app carries NO runtime-check / install-prompt
; logic anymore (that whole app-side path was torn out 2026-09-17 — it fired only
; on the enable transition and left default-enabled toggles failing silently on a
; machine without the runtime).
;
; The redist ships as vcredist-x64.dat (a non-.exe name — electron-builder's
; exe/signing step silently drops a raw bundled .exe from resources). Copy it to
; a real .exe in the plugins temp dir first, then ExecWait it.
!macro customInstall
  IfFileExists "$INSTDIR\resources\vcredist-x64.dat" 0 vcDone
    DetailPrint "Installing Microsoft Visual C++ runtime (needed by the built-in audio engine)…"
    CopyFiles /SILENT "$INSTDIR\resources\vcredist-x64.dat" "$PLUGINSDIR\vc_redist.x64.exe"
    ; /quiet = no nested UI; /norestart = never reboot mid-install. The redist
    ; exits fast and clean when the runtime is already current.
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /quiet /norestart' $0
    DetailPrint "Visual C++ runtime installer finished (exit code $0)."
  vcDone:
!macroend
