@echo off
chcp 65001 > nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo 처음 실행이라 필요한 패키지를 설치합니다...
  python -m venv .venv || goto :error
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :error
)

".venv\Scripts\python.exe" app.py %*
goto :eof

:error
echo 설치에 실패했어요. Python 3.10 이상이 설치돼 있는지 확인해 주세요.
pause
