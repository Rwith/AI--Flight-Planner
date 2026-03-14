; ============================================================
;  AeroNav AI — Custom Installer Theme
;  All defines are guarded with !ifndef so electron-builder's
;  own template values are never overwritten.
; ============================================================

; ---------- Header image (inner pages) ---------------------------
!ifndef MUI_HEADERIMAGE
  !define MUI_HEADERIMAGE
!endif
!ifndef MUI_HEADERIMAGE_RIGHT
  !define MUI_HEADERIMAGE_RIGHT
!endif
!ifndef MUI_HEADERIMAGE_BITMAP
  !define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\header.bmp"
!endif

; ---------- Welcome page -----------------------------------------
!ifndef MUI_WELCOMEPAGE_TITLE
  !define MUI_WELCOMEPAGE_TITLE "Welcome to AeroNav AI"
!endif
!ifndef MUI_WELCOMEPAGE_TEXT
  !define MUI_WELCOMEPAGE_TEXT "AeroNav AI is your intelligent waypoint mission and flight planning assistant — powered by AI.$\r$\n$\r$\nThis wizard will guide you through the installation of AeroNav AI v${VERSION}.$\r$\n$\r$\nClick Next to continue."
!endif

; ---------- Finish page ------------------------------------------
!ifndef MUI_FINISHPAGE_TITLE
  !define MUI_FINISHPAGE_TITLE "AeroNav AI is Ready"
!endif
!ifndef MUI_FINISHPAGE_TEXT
  !define MUI_FINISHPAGE_TEXT "AeroNav AI has been successfully installed.$\r$\n$\r$\nClick Finish to close this wizard."
!endif
!ifndef MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!endif
!ifndef MUI_FINISHPAGE_RUN_TEXT
  !define MUI_FINISHPAGE_RUN_TEXT "Launch AeroNav AI"
!endif
!ifndef MUI_FINISHPAGE_LINK
  !define MUI_FINISHPAGE_LINK "Visit AeroNav AI on GitHub"
!endif
!ifndef MUI_FINISHPAGE_LINK_LOCATION
  !define MUI_FINISHPAGE_LINK_LOCATION "https://github.com/Rwith/AI--Flight-Planner"
!endif

; ---------- Abort warning ----------------------------------------
!ifndef MUI_ABORTWARNING
  !define MUI_ABORTWARNING
!endif
!ifndef MUI_ABORTWARNING_TEXT
  !define MUI_ABORTWARNING_TEXT "Are you sure you want to cancel the AeroNav AI installation?"
!endif

; ---------- Uninstaller ------------------------------------------
!ifndef MUI_UNCONFIRMPAGE_TEXT_TOP
  !define MUI_UNCONFIRMPAGE_TEXT_TOP "AeroNav AI will be removed from the following folder.$\r$\nClick Uninstall to start the removal."
!endif
