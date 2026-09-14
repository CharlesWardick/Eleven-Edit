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
; The installer NO LONGER checks or prompts for the VC++ runtime. The redist is
; still BUNDLED on disk (vcredist-x64.dat, via package.json extraResources); the
; app handles the runtime entirely: it's checked ONLY when the user enables the
; built-in audio engine (first-run prompt, or the Audio Setup switch), and the
; one-click install is offered from there. This keeps the whole decision in one
; place, gated on a single condition (the user actually wants audio), instead of
; firing at install time regardless of intent.
!macro customInstall
!macroend
