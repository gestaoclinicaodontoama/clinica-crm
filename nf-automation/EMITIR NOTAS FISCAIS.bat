@echo off
title Emissao de Notas Fiscais - Clinica AMA
cd /d "%~dp0"
call .venv\Scripts\activate.bat
pip install anthropic -q
python main.py --auto
echo.
echo Processo concluido. Esta janela fecha em 10 segundos...
timeout /t 10
