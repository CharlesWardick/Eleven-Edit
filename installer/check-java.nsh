; ════════════════════════════════════════════════════════════════════
; check-java.nsh — installer-time Java presence/version heads-up.
;
; Runs `java -version` during install (via the customInit hook, which
; fires early — before any files are copied). This is deliberately a
; HEADS-UP, not a hard gate: NSIS string parsing to pull out an exact
; major version number and compare it numerically is easy to get subtly
; wrong (and hard to test without a real Windows install).
;
; 2026-09-05, corrected after live testing: the ORIGINAL version of this
; also popped an "OK only" informational box on the SUCCESS path (Java
; found), showing the raw version text with conditional wording like "if
; this is below 25, please update" even when Java was already fine — an
; unnecessary interruption for the common case where nothing is wrong.
; Charlie's own read: "this seems like a gate event we should just pass
; through without intervention." Fixed — the success path is now
; completely silent, no dialog at all. Only the MISSING-Java path still
; shows a box, since that's the one case where there's an actual decision
; to make (continue anyway, or cancel and install Java first).
;
; The REAL, authoritative gate is main.js's checkJavaVersionThenLaunch()
; (see Tech Ref ENVIRONMENT / Change Log 2026-09-05), which runs every
; time the app launches and refuses to start the bridge against a known-
; bad JRE, INCLUDING a too-old-but-present Java — this installer check
; can't and doesn't try to catch that case (see above on why not), so the
; runtime gate is what actually protects a too-old-Java install; this is
; only ever a courtesy for the "no Java found at all" case.
; ════════════════════════════════════════════════════════════════════

!macro customInit
  nsExec::ExecToStack '"java" -version'
  Pop $0   ; exit code (nsExec return code — non-"0" usually means java wasn't found/runnable)
  Pop $1   ; combined stdout+stderr text from the command (unused on the
           ; success path now — kept in case a future pass adds real
           ; version parsing)

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
