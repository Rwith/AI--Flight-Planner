; ============================================================
;  AeroNav AI — Custom Installer Branding
; ============================================================

!include "LogicLib.nsh"

; ---------- Header image -----------------------------------------
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\header.bmp"

; ---------- Detect existing install → swap Install/Update text ------
Var IsUpdate

; Changes the installer window title bar to "Update" when upgrading.
Function WelcomePagePre
  ${If} $IsUpdate == "1"
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:AeroNav AI — Update to v${VERSION}"
  ${EndIf}
FunctionEnd

!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_PRE WelcomePagePre
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customHeader
  ; Var IsUpdate declared at file scope above.
!macroend

!macro customInit
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

; ---------- Welcome page copy ------------------------------------
!define MUI_WELCOMEPAGE_TITLE "Welcome to AeroNav AI"
!define MUI_WELCOMEPAGE_TEXT "AeroNav AI is your intelligent waypoint mission and flight planning assistant — powered by AI.$\r$\n$\r$\nThis wizard will install or update AeroNav AI v${VERSION} on your computer.$\r$\n$\r$\nClose AeroNav AI if it is already running, then click Next."

; ---------- Finish page copy -------------------------------------
!define MUI_FINISHPAGE_TITLE "AeroNav AI is Ready"
!define MUI_FINISHPAGE_TEXT "AeroNav AI v${VERSION} has been set up successfully.$\r$\n$\r$\nClick Finish to close this wizard."
