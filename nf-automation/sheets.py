import gspread
from google.oauth2.service_account import Credentials
from datetime import datetime
from config import (
    SHEET_ID, GOOGLE_CREDENTIALS_FILE,
    COL_SISTEMA, COL_STATUS, COL_NUM_NOTA, COL_DATA_EMISSAO, COL_CAMINHO_PDF,
    STATUS_PENDENTE, STATUS_EMITIDA, STATUS_ERRO
)

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
]

def conectar():
    creds = Credentials.from_service_account_file(GOOGLE_CREDENTIALS_FILE, scopes=SCOPES)
    client = gspread.authorize(creds)
    return client.open_by_key(SHEET_ID).sheet1

def listar_pendentes(sheet, sistema_filtro=None):
    """Retorna lista de (row_index, row_data) com status vazio (pendente)."""
    todas = sheet.get_all_values()
    cabecalho = todas[0]
    pendentes = []
    for i, row in enumerate(todas[1:], start=2):  # linha 2 em diante (1-indexed na API)
        status = row[COL_STATUS].strip() if len(row) > COL_STATUS else ""
        sistema = row[COL_SISTEMA].strip() if len(row) > COL_SISTEMA else ""
        if status == STATUS_PENDENTE:
            if sistema_filtro is None or sistema == sistema_filtro:
                pendentes.append((i, row))
    return pendentes

def marcar_emitida(sheet, row_index, num_nota, caminho_pdf):
    agora = datetime.now().strftime("%d/%m/%Y %H:%M")
    sheet.update(f"M{row_index}:O{row_index}", [[num_nota, agora, caminho_pdf]])
    sheet.update_cell(row_index, 3, STATUS_EMITIDA)  # coluna C = Status

def marcar_erro(sheet, row_index, mensagem_erro):
    sheet.update_cell(row_index, 3, f"{STATUS_ERRO}: {mensagem_erro}")
