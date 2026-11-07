@echo off
title PhonePad server
cd /d "%~dp0"
".venv\Scripts\python.exe" server\server.py
pause
