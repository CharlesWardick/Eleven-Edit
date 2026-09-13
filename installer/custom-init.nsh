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
; Detect FIRST via the registry; prompt ONLY if it's missing or too old; allow
; SKIP; continue with no error either way. The bundled redist also self-no-ops
; if a newer runtime is already present, so it can never clobber anything.
;
; VCRUNTIME140_1.dll (needed by audify's binary) shipped in VC++ 2015-2022
; build 14.20+, so an OLD redist can read "Installed" yet still lack it —
; hence we also require Minor >= 20, not just Installed = 1.
!macro customInstall
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64" "Installed"
  ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64" "Minor"
  SetRegView lastused

  StrCmp $0 "1" 0 vcPrompt              ; not installed → prompt
  IntCmp $1 20 vcDone vcPrompt vcDone   ; Minor >=20 → done, <20 → prompt

  vcPrompt:
    ; The redist ships as vcredist-x64.dat (a non-.exe name so electron-builder's
    ; exe/signing step doesn't drop it from resources). Copy it out to a real
    ; .exe in the temp plugins dir before running it.
    IfFileExists "$INSTDIR\resources\vcredist-x64.dat" 0 vcDone   ; nothing to run
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Audio Engine Component$\r$\n$\r$\n\
Eleven Edit's built-in audio engine needs the Microsoft Visual C++ \
Redistributable (x64), which doesn't appear to be installed on this PC. \
The editor itself works fine without it — only the built-in audio engine \
needs it.$\r$\n$\r$\n\
Install it now? (You can skip this and install it later; installation will \
continue either way.)" \
      IDNO vcDone
    CopyFiles /SILENT "$INSTDIR\resources\vcredist-x64.dat" "$PLUGINSDIR\vc_redist.x64.exe"
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /passive /norestart' $2

  vcDone:
!macroend
