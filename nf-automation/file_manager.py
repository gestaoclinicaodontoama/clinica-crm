import os
import re
import unicodedata
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

SUPABASE_URL    = os.getenv("SUPABASE_URL", "")
# Usa anon key para upload (bucket tem INSERT policy aberta); service key tem formato sb_secret_ incompatível com REST direto
SUPABASE_KEY    = os.getenv("SUPABASE_ANON_KEY", "") or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_BUCKET = "nf-pdfs"


def _limpar_nome(texto: str) -> str:
    sem_acento = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return re.sub(r'[\\/:*?"<>|]', "", sem_acento).strip()


def _nome_arquivo(num_nota: str, nome_tomador: str) -> str:
    num  = _limpar_nome(str(num_nota)) if num_nota else "SN"
    nome = _limpar_nome(nome_tomador)[:60]
    return f"{num} - {nome}.pdf"


def _upload_supabase(pdf_bytes: bytes, competencia: str, num_nota: str, nome_tomador: str) -> str:
    import requests
    from urllib.parse import quote
    nome = _nome_arquivo(num_nota, nome_tomador)
    path = f"{competencia}/{nome}"
    encoded = quote(path, safe='/')
    url  = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{encoded}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/pdf",
        "x-upsert": "true",
    }
    r = requests.post(url, data=pdf_bytes, headers=headers, timeout=30)
    r.raise_for_status()
    return f"{SUPABASE_URL}/storage/v1/object/public/{SUPABASE_BUCKET}/{encoded}"


# ── API pública ────────────────────────────────────────────────────────────────

def pasta_competencia(pasta_base: str, competencia: str) -> Path:
    p = Path(pasta_base) / competencia
    p.mkdir(parents=True, exist_ok=True)
    return p


def caminho_pdf(pasta_base: str, competencia: str, num_nota: str, nome_tomador: str) -> Path:
    pasta = pasta_competencia(pasta_base, competencia)
    return pasta / _nome_arquivo(num_nota, nome_tomador)


def salvar_pdf(download, pasta_base: str, competencia: str, num_nota: str, nome_tomador: str) -> str:
    """Recebe objeto Download do Playwright. Tenta Supabase; fallback local."""
    pdf_bytes = download.read_bytes() if hasattr(download, 'read_bytes') else None
    if pdf_bytes and SUPABASE_URL and SUPABASE_KEY:
        try:
            return _upload_supabase(pdf_bytes, competencia, num_nota, nome_tomador)
        except Exception as e:
            print(f"  Upload Supabase falhou ({e}), salvando local...")
    destino = caminho_pdf(pasta_base, competencia, num_nota, nome_tomador)
    download.save_as(str(destino))
    return str(destino)


def salvar_pdf_bytes(pdf_bytes: bytes, pasta_base: str, competencia: str, num_nota: str, nome_tomador: str) -> str:
    """Recebe bytes de PDF. Tenta Supabase; fallback local."""
    if SUPABASE_URL and SUPABASE_KEY:
        try:
            url = _upload_supabase(pdf_bytes, competencia, num_nota, nome_tomador)
            print(f"  PDF enviado ao Supabase: {url}")
            return url
        except Exception as e:
            print(f"  Upload Supabase falhou ({e}), tentando local...")
    destino = caminho_pdf(pasta_base, competencia, num_nota, nome_tomador)
    destino.write_bytes(pdf_bytes)
    return str(destino)
