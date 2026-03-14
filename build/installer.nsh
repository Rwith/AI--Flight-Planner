; ============================================================
;  AeroNav AI — Custom Installer Theme
;  Modern dark aviation-style UI for NSIS MUI2
;
;  NOTE: MUI_WELCOMEFINISHPAGE_BITMAP / MUI_UNWELCOMEFINISHPAGE_BITMAP
;  are set by electron-builder from the installerSidebar /
;  uninstallerSidebar package.json options — do NOT redefine them here.
; ============================================================

; ---------- Header image (inner pages) ---------------------------
; electron-builder does not set this, so we own it.
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\header.bmp"

; ---------- Welcome page -----------------------------------------
!define MUI_WELCOMEPAGE_TITLE "Welcome to AeroNav AI"
!define MUI_WELCOMEPAGE_TEXT "AeroNav AI is your intelligent waypoint mission and flight planning assistant — powered by AI.$\r$\n$\r$\nThis wizard will guide you through the installation of AeroNav AI v${VERSION}.$\r$\n$\r$\nIt is recommended to close other applications before continuing.$\r$\n$\r$\nClick Next to continue."

; ---------- Finish page ------------------------------------------
!define MUI_FINISHPAGE_TITLE "AeroNav AI is Ready"
!define MUI_FINISHPAGE_TEXT "AeroNav AI has been successfully installed on your computer.$\r$\n$\r$\nClick Finish to close this wizard."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch AeroNav AI"
!define MUI_FINISHPAGE_LINK "Visit AeroNav AI on GitHub"
!define MUI_FINISHPAGE_LINK_LOCATION "https://github.com/Rwith/AI--Flight-Planner"

; ---------- Abort / cancel warning -------------------------------
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_CANCEL_DEFAULT
!define MUI_ABORTWARNING_TEXT "Are you sure you want to cancel the AeroNav AI installation?"

; ---------- Uninstaller ------------------------------------------
!define MUI_UNCONFIRMPAGE_TEXT_TOP "AeroNav AI will be removed from the following folder.$\r$\nClick Uninstall to start the removal."
