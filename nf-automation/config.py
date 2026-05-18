import os
from dotenv import load_dotenv

load_dotenv()

CRM_API_URL = os.getenv("CRM_API_URL", "https://plataformaama-plataforma.uc5as5.easypanel.host")

SIGISS_URL       = "https://ipatinga.meumunicipio.online/ISS/contribuinte/main.php"
SIGISS_LOGIN_URL = "https://ipatinga.meumunicipio.online/ISS/contribuinte/login.php"

ENTIDADES = {
    "Vieira": {
        "nome": "Vieira e Vidigal Martins LTDA",
        "cnpj": "05617377000108",
        "sistema": "nfse",
        "login": os.getenv("SIGISS_AMA_LOGIN"),
        "senha": os.getenv("SIGISS_AMA_SENHA"),
        "pasta": os.getenv("PASTA_AMA", r"P:\Documentos\NF AMA 2026"),
    },
    "Martins": {
        "nome": "Clinica Odontologica Martins",
        "cnpj": "33967625000186",
        "sistema": "nfse",
        "login": os.getenv("SIGISS_AUXILIUM_LOGIN"),
        "senha": os.getenv("SIGISS_AUXILIUM_SENHA"),
        "pasta": os.getenv("PASTA_AUXILIUM", r"P:\Documentos\NF AUXILIUM 2026"),
    },
    "Receita Saude": {
        "nome": "Marcos Vinicius Coelho Vidigal Martins",
        "cpf": "01520816669",
        "crn": "MG39405",
        "sistema": "receita_saude",
        "pasta": os.getenv("PASTA_MARCOS_PF", r"P:\Documentos\NF MARCOS VINICIUS PF 2026"),
    },
}

# Colunas da planilha (índice 0)
COL_SISTEMA      = 0
COL_COMPETENCIA  = 1
COL_STATUS       = 2
COL_TIPO_TOMADOR = 3
COL_CPF_TOMADOR  = 4
COL_NOME_TOMADOR = 5
COL_CPF_PACIENTE = 6
COL_NOME_PACIENTE= 7
COL_PARENTESCO   = 8
COL_DATA_PGTO    = 9
COL_VALOR        = 10
COL_DESCRICAO    = 11
COL_NUM_NOTA     = 12
COL_DATA_EMISSAO = 13
COL_CAMINHO_PDF  = 14

STATUS_PENDENTE = ""   # linha sem status = pendente
STATUS_EMITIDA  = "Emitida"
STATUS_ERRO     = "Erro"
