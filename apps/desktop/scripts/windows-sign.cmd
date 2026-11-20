@echo off
setlocal DisableDelayedExpansion
set "signTool=%ALTOAIH_DESKTOP_WINDOWS_SIGNTOOL%"
set "certificateFile=%ALTOAIH_DESKTOP_WINDOWS_CER_FILE%"
set "tokenPin=%ALTOAIH_DESKTOP_WINDOWS_TOKEN_PIN%"
set "keyContainer=%ALTOAIH_DESKTOP_WINDOWS_KEY_CONTAINER%"
set "targetFile=%ALTOAIH_DESKTOP_WINDOWS_SIGN_TARGET%"
set "appendSignature="
if "%ALTOAIH_DESKTOP_WINDOWS_SIGN_APPEND%"=="1" set "appendSignature=/as"
set "ALTOAIH_DESKTOP_WINDOWS_SIGNTOOL="
set "ALTOAIH_DESKTOP_WINDOWS_CER_FILE="
set "ALTOAIH_DESKTOP_WINDOWS_TOKEN_PIN="
set "ALTOAIH_DESKTOP_WINDOWS_KEY_CONTAINER="
set "ALTOAIH_DESKTOP_WINDOWS_SIGN_TARGET="
set "ALTOAIH_DESKTOP_WINDOWS_SIGN_APPEND="
set "signTool=" & set "certificateFile=" & set "tokenPin=" & set "keyContainer=" & set "targetFile=" & set "appendSignature=" & "%signTool%" sign /v /fd sha256 /f "%certificateFile%" /kc "[{{%tokenPin%}}]=%keyContainer%" /csp "eToken Base Cryptographic Provider" %appendSignature% "%targetFile%"
exit /b %errorlevel%
