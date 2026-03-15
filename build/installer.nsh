; ============================================================
;  AeroNav AI — Custom Installer Branding
; ============================================================

; ---------- Header image -----------------------------------------
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\header.bmp"

; electron-builder v25 compiles the same NSI template twice:
;   pass 1  BUILD_UNINSTALLER defined   — uninstaller stub
;   pass 2  BUILD_UNINSTALLER undefined — main installer
;
; In both passes assistedinstaller.nsh calls MUI_PAGE_WELCOME.  In pass 1
; welcomePagePre does not exist (it is an installer-only function), so we
; must NOT set MUI_PAGE_CUSTOMFUNCTION_PRE there.  In pass 2 the template
; generates welcomePagePre but forgets to reference it (NSIS warning 6010,
; exit code 1).  Setting MUI_PAGE_CUSTOMFUNCTION_PRE here (pass 2 only)
; gives MUI2 the reference it needs; MUI2 !undefs it after MUI_PAGE_WELCOME
; so no later page is affected.
!ifndef BUILD_UNINSTALLER
  !define MUI_PAGE_CUSTOMFUNCTION_PRE welcomePagePre
!endif
