; ============================================================
;  AeroNav AI — Custom Installer Branding
;
;  Only text/copy overrides are set here.
;  electron-builder's assistedInstaller.nsh owns all
;  MUI_FINISHPAGE_RUN*, MUI_ICON, MUI_UNICON, and the
;  sidebar bitmap defines — do NOT touch those here.
; ============================================================

; ---------- Header image -----------------------------------------
; electron-builder does not set this, so it is safe to define here.
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\header.bmp"

; ---------- Welcome page copy ------------------------------------
!define MUI_WELCOMEPAGE_TITLE "Welcome to AeroNav AI"
!define MUI_WELCOMEPAGE_TEXT "AeroNav AI is your intelligent waypoint mission and flight planning assistant — powered by AI.$\r$\n$\r$\nThis wizard will guide you through installing AeroNav AI v${VERSION}.$\r$\n$\r$\nClose other applications before continuing, then click Next."

; ---------- Finish page copy -------------------------------------
!define MUI_FINISHPAGE_TITLE "AeroNav AI is Ready"
!define MUI_FINISHPAGE_TEXT "AeroNav AI has been successfully installed.$\r$\n$\r$\nClick Finish to close this wizard."
