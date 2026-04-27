@echo off
setlocal EnableDelayedExpansion
REM =============================================================================
REM Claude Code Portable Launcher - Windows (v1.0.7+)
REM
REM Persistence model: plugins, history, projects, sessions all live under
REM data\.claude on the USB drive. Only .credentials.json is transient — wiped
REM at startup AND when claude.exe exits. If the user force-closes the window,
REM the next launch's startup wipe is the safety net.
REM =============================================================================

REM Fix terminal: set buffer large enough to survive maximize/resize
mode con: cols=120 lines=30

set "PORTABLE_ROOT=%~dp0"
set "DATA_DIR=%PORTABLE_ROOT%data"
set "NODE_DIR=%PORTABLE_ROOT%runtime\node"
set "CLAUDE_DIR=%PORTABLE_ROOT%runtime\claude-code"
set "SS_DIR=%PORTABLE_ROOT%runtime\ss"
set "GIT_DIR=%PORTABLE_ROOT%runtime\git"
set "SRC_DIR=%PORTABLE_ROOT%src"

set "PATH=%NODE_DIR%;%GIT_DIR%\cmd;%GIT_DIR%\usr\bin;%GIT_DIR%\mingw64\bin;%PATH%"
set "CLAUDE_PORTABLE_DATA=%DATA_DIR%"
set "CLAUDE_CONFIG_DIR=%DATA_DIR%\.claude"
set "CLAUDE_CODE_GIT_BASH_PATH=%GIT_DIR%\usr\bin\bash.exe"
if not exist "%CLAUDE_CONFIG_DIR%" mkdir "%CLAUDE_CONFIG_DIR%"

set "CREDS_FILE=%CLAUDE_CONFIG_DIR%\.credentials.json"
set "SS_ARGS_FILE=%CLAUDE_CONFIG_DIR%\.ss_args"

REM --- Wipe any leftover credentials (e.g. from a force-closed prior session) ---
del /q "%CREDS_FILE%" >nul 2>&1
del /q "%SS_ARGS_FILE%" >nul 2>&1

REM --- License kill-switch (set by heartbeat on explicit revoke/expire) ---
if exist "%DATA_DIR%\.license_expired" (
    echo.
    echo   License has been revoked or expired. Please contact administrator.
    del /q "%DATA_DIR%\.license_expired" >nul 2>&1
    pause
    exit /b 2
)

REM --- License check + credential sync ---
"%NODE_DIR%\node.exe" "%SRC_DIR%\license-client.js"
if %errorlevel% neq 0 (
    echo.
    echo   License verification failed. Please contact administrator.
    pause
    exit /b 1
)

REM --- Start Shadowsocks proxy (config file deleted right after read) ---
set "SS_BIN=%SS_DIR%\sslocal.exe"
if exist "%SS_BIN%" if exist "%SS_ARGS_FILE%" (
    set /p SS_ARGS=<"%SS_ARGS_FILE%"
    del /q "%SS_ARGS_FILE%" >nul 2>&1
    start /b "" "%SS_BIN%" !SS_ARGS! >nul 2>&1
    timeout /t 2 /nobreak >nul
    set "HTTP_PROXY=http://127.0.0.1:51080"
    set "HTTPS_PROXY=http://127.0.0.1:51080"
)

REM --- Start heartbeat in background ---
start /b "" "%NODE_DIR%\node.exe" "%SRC_DIR%\heartbeat.js" >nul 2>&1

REM --- Launch Claude Code (native binary, v2.x) ---
set "CLAUDE_BIN=%CLAUDE_DIR%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
if not exist "%CLAUDE_BIN%" (
    echo Error: Claude Code not found. Package may be corrupted.
    pause
    exit /b 1
)

"%CLAUDE_BIN%" --system-prompt-file "%SRC_DIR%\portable-claude.md" %*

REM --- Cleanup (runs after claude.exe exits) ---
del /q "%CREDS_FILE%" >nul 2>&1
del /q "%SS_ARGS_FILE%" >nul 2>&1
taskkill /f /im sslocal.exe >nul 2>&1
taskkill /f /im node.exe /fi "WINDOWTITLE eq heartbeat*" >nul 2>&1
