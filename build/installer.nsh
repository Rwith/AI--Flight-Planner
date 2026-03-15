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
  ; electron-builder compiles this script twice: once for the installer and once
  ; for the uninstaller (BUILD_UNINSTALLER is defined in the second pass).
  ; Only wire welcomePagePre in the installer pass — in the uninstaller pass it
  ; is an install-only function and causes a hard NSIS error if referenced from
  ; an uninstaller-context MUI callback.
  !ifndef BUILD_UNINSTALLER
    !define MUI_PAGE_CUSTOMFUNCTION_PRE welcomePagePre
  !endif
  !insertmacro MUI_PAGE_WELCOME
!macroend
