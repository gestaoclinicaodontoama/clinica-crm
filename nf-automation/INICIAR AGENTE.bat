@echo off
title Agente NF - Clinica AMA
cd /d "%~dp0"
call .venv\Scripts\activate.bat
echo.
echo  ============================================
echo   Agente de Notas Fiscais - Clinica AMA
echo   Rodando em http://localhost:5555
echo   Deixe esta janela aberta!
echo  ============================================
echo.
python agente_local.py
pause
