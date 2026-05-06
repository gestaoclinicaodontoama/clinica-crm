import re
import unicodedata
from pathlib import Path


def _limpar_nome(texto: str) -> str:
    """Remove acentos e caracteres inválidos para nome de arquivo."""
    sem_acento = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return re.sub(r'[\\/:*?"<>|]', "", sem_acento).strip()


def pasta_competencia(pasta_base: str, competencia: str) -> Path:
    """Retorna (e cria) a pasta  <base>\\MM-YYYY."""
    p = Path(pasta_base) / competencia
    p.mkdir(parents=True, exist_ok=True)
    return p


def caminho_pdf(pasta_base: str, competencia: str, num_nota: str, nome_tomador: str) -> Path:
    """Gera o caminho completo do PDF: <base>\\MM-YYYY\\NNN - Nome Tomador.pdf"""
    pasta = pasta_competencia(pasta_base, competencia)
    num   = _limpar_nome(str(num_nota)) if num_nota else "SN"
    nome  = _limpar_nome(nome_tomador)[:60]
    return pasta / f"{num} - {nome}.pdf"


def salvar_pdf(download, pasta_base: str, competencia: str, num_nota: str, nome_tomador: str) -> str:
    """Recebe um objeto Download do Playwright e salva no caminho correto."""
    destino = caminho_pdf(pasta_base, competencia, num_nota, nome_tomador)
    download.save_as(str(destino))
    return str(destino)
