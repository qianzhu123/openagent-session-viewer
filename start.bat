@echo off
REM OpenAgent Session Viewer launcher
REM Usage: start.bat [start^|stop^|restart^|quiet]
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=8092"
set "MODE=%~1"
set "QUIET=0"
if /i "!MODE!"=="" set "MODE=restart"
if /i "!MODE!"=="quiet" (
    set "MODE=restart"
    set "QUIET=1"
)
set "ERRLOG=%~dp0data\start_err.log"
set "PIDFILE=%~dp0data\server.pid"
if not exist "%~dp0data" mkdir "%~dp0data" >nul 2>&1

if /i "!MODE!"=="stop" goto :stop_only
if /i "!MODE!"=="restart" call :stop_server

REM If start was requested while an instance is healthy, reuse it.
if /i "!MODE!"=="start" (
    powershell -NoProfile -Command "try { $r=Invoke-RestMethod -TimeoutSec 2 http://127.0.0.1:%PORT%/api/health; if($r.ok){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 (
        if "!QUIET!"=="0" echo [info] server is already running on port %PORT%.
        start "" http://127.0.0.1:%PORT% >nul 2>&1
        exit /b 0
    )
)

type nul >"%ERRLOG%" 2>nul
set "PY="
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -c "import sys" >nul 2>&1
    if not errorlevel 1 set "PY=.venv\Scripts\python.exe"
)
if not defined PY (where py >nul 2>&1 && set "PY=py")
if not defined PY (where python >nul 2>&1 && set "PY=python")
if not defined PY (if exist "D:\tools\Dev\Runtime\Anaconda\python.exe" set "PY=D:\tools\Dev\Runtime\Anaconda\python.exe")

if not defined PY (
    echo [error] no python found >"%ERRLOG%"
    if "!QUIET!"=="0" (
        echo [error] no Python found. Install Python 3.x or repair .venv.
        pause
    )
    exit /b 1
)

if "!QUIET!"=="0" echo [run] Python: !PY!  port: %PORT%
start "" http://127.0.0.1:%PORT% >nul 2>&1
"!PY!" "%~dp0server.py" --port %PORT% 2>>"%ERRLOG%"
set "EC=!errorlevel!"
if not "!EC!"=="0" (
    if "!QUIET!"=="0" (
        echo [error] server exited with code !EC!. See data\start_err.log
        pause
    )
    exit /b !EC!
)
exit /b 0

:stop_only
call :stop_server
exit /b !errorlevel!

:stop_server
REM Prefer graceful shutdown so serve_forever exits and releases the port cleanly.
powershell -NoProfile -Command "try { Invoke-RestMethod -Method Post -TimeoutSec 2 http://127.0.0.1:%PORT%/api/shutdown | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
    for /l %%I in (1,1,20) do (
        powershell -NoProfile -Command "try { Invoke-RestMethod -TimeoutSec 1 http://127.0.0.1:%PORT%/api/health | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
        if errorlevel 1 goto :stopped
        ping 127.0.0.1 -n 2 >nul
    )
)
REM Fallback for an older/stuck instance: only terminate the PID recorded by this project.
if exist "!PIDFILE!" (
    set /p SERVERPID=<"!PIDFILE!"
    if defined SERVERPID taskkill /PID !SERVERPID! /T /F >nul 2>&1
)
:stopped
if exist "!PIDFILE!" del /q "!PIDFILE!" >nul 2>&1
if "!QUIET!"=="0" echo [info] server stopped.
exit /b 0
