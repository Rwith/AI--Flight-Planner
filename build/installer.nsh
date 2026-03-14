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

; ---------- Detect existing install → swap Install/Update text ------
; $IsUpdate is set in .onInit (customInit below) by reading the
; uninstall registry key that electron-builder writes on first install.
; The WelcomePagePre and FinishPagePre functions run just before each
; page is shown and overwrite the static text when updating.

!macro customHeader
  Var IsUpdate

  Function WelcomePagePre
    ${If} $IsUpdate == "1"
      SendMessage $mui.WelcomePage.Title ${WM_SETTEXT} 0 \
        "STR:Update AeroNav AI"
      SendMessage $mui.WelcomePage.Text ${WM_SETTEXT} 0 \
        "STR:AeroNav AI is already installed on this computer.$\r$\n$\r$\nThis wizard will update it to v${VERSION}.$\r$\n$\r$\nClose AeroNav AI before continuing, then click Next."
    ${EndIf}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE WelcomePagePre

  Function FinishPagePre
    ${If} $IsUpdate == "1"
      SendMessage $mui.FinishPage.Title ${WM_SETTEXT} 0 \
        "STR:AeroNav AI Updated"
      SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 \
        "STR:AeroNav AI has been successfully updated to v${VERSION}.$\r$\n$\r$\nClick Finish to close this wizard."
    ${EndIf}
  FunctionEnd
!macroend

!macro customInit
  ; Check HKLM first (all-users install), then HKCU (per-user install)
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
