; ============================================================
;  AeroNav AI — Custom Installer Branding
;
;  Only text/copy overrides are set here.
;  electron-builder's assistedInstaller.nsh owns all
;  MUI_FINISHPAGE_RUN*, MUI_ICON, MUI_UNICON, and the
;  sidebar bitmap defines — do NOT touch those here.
; ============================================================

; LogicLib provides ${If}/${EndIf} etc. — must be included before
; any function body that uses them.
!include "LogicLib.nsh"

; ---------- Header image -----------------------------------------
; electron-builder does not set this, so it is safe to define here.
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\header.bmp"

; ---------- Detect existing install → swap Install/Update text ------
; $IsUpdate is set in .onInit (via customInit) by reading the registry
; key that electron-builder writes on first install. WelcomePagePre
; runs just before the welcome page is shown and rewrites the text.

; Top-level Var so it is visible before any function body is compiled.
Var IsUpdate

Function WelcomePagePre
  ${If} $IsUpdate == "1"
    SendMessage $mui.WelcomePage.Title ${WM_SETTEXT} 0 \
      "STR:Update AeroNav AI"
    SendMessage $mui.WelcomePage.Text ${WM_SETTEXT} 0 \
      "STR:AeroNav AI is already installed on this computer.$\r$\n$\r$\nThis wizard will update it to v${VERSION}.$\r$\n$\r$\nClose AeroNav AI before continuing, then click Next."
  ${EndIf}
FunctionEnd

Function FinishPagePre
  ${If} $IsUpdate == "1"
    SendMessage $mui.FinishPage.Title ${WM_SETTEXT} 0 \
      "STR:AeroNav AI Updated"
    SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 \
      "STR:AeroNav AI has been successfully updated to v${VERSION}.$\r$\n$\r$\nClick Finish to close this wizard."
  ${EndIf}
FunctionEnd

; Hook WelcomePagePre into the MUI welcome page via customWelcomePage.
; electron-builder's assistedInstaller.nsh calls this macro if defined
; (via !ifmacrodef), so defining it here overrides the default.
!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_PRE WelcomePagePre
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Hook FinishPagePre into the MUI finish page via customFinishPage.
!macro customFinishPage
  !define MUI_PAGE_CUSTOMFUNCTION_PRE FinishPagePre
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customHeader
  ; Var IsUpdate is declared at file scope above.
!macroend

!macro customInit
  ; Check HKLM first (all-users install), then HKCU (per-user install).
  ReadRegStr $0 HKLM \
    "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.aeronav.ai" \
    "DisplayVersion"
  ${If} $0 == ""
    ReadRegStr $0 HKCU \
      "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.aeronav.ai" \
      "DisplayVersion"
  ${EndIf}
  ${If} $0 != ""
    StrCpy $IsUpdate "1"
  ${Else}
    StrCpy $IsUpdate "0"
  ${EndIf}
!macroend

; ---------- Welcome page copy (shown for fresh installs) ----------
!define MUI_WELCOMEPAGE_TITLE "Welcome to AeroNav AI"
!define MUI_WELCOMEPAGE_TEXT "AeroNav AI is your intelligent waypoint mission and flight planning assistant — powered by AI.$\r$\n$\r$\nThis wizard will guide you through installing AeroNav AI v${VERSION}.$\r$\n$\r$\nClose other applications before continuing, then click Next."

; ---------- Finish page copy (shown for fresh installs) -----------
!define MUI_FINISHPAGE_TITLE "AeroNav AI is Ready"
!define MUI_FINISHPAGE_TEXT "AeroNav AI has been successfully installed.$\r$\n$\r$\nClick Finish to close this wizard."
