; ============================================================
;  AeroNav AI — Custom Installer Branding
; ============================================================

; ---------- Header image -----------------------------------------
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\header.bmp"

; Required: electron-builder v25 multiuser template generates welcomePagePre
; but omits the MUI_PAGE_CUSTOMFUNCTION_PRE reference, causing NSIS warning
; 6010 (exit code 1).  This macro provides the missing reference.
!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_PRE welcomePagePre
  !insertmacro MUI_PAGE_WELCOME
!macroend
