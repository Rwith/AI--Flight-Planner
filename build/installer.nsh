; ============================================================
;  AeroNav AI — Custom Installer Branding
; ============================================================

; ---------- Header image -----------------------------------------
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\header.bmp"

; electron-builder v25 multiuser template defines welcomePagePre but omits the
; MUI_PAGE_CUSTOMFUNCTION_PRE reference, so NSIS 3.x warns "function not
; referenced" and exits with code 1.  Setting it here (file scope, before any
; page macros run) lets MUI2 wire it up during MUI_PAGE_WELCOME and then
; !undef it automatically, so the uninstaller pages never see it.
!define MUI_PAGE_CUSTOMFUNCTION_PRE welcomePagePre
