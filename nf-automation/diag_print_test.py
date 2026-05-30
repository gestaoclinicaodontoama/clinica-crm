"""Testa a URL de impressão nfe_base.php?acao=imprimir&id=PKID sem emitir nota."""
import sys, os, time
sys.stdout.reconfigure(line_buffering=True)
sys.path.insert(0, os.path.dirname(__file__))

from config import SIGISS_LOGIN_URL, ENTIDADES
import nfse_prefeitura

CAPTCHA_IMG = os.path.join(os.path.dirname(__file__), "captcha_debug.png")
CAPTCHA_ANS = os.path.join(os.path.dirname(__file__), "captcha_answer.txt")

PKID    = "52816556"   # nota 401
NR_NOTA = "401"
CHAVE   = "31313071205617377000108000000000040126052960880956"

def _ler_captcha_com_espera(page) -> str:
    if os.path.exists(CAPTCHA_ANS):
        os.remove(CAPTCHA_ANS)
    for sel in ['img[src*="imagem.php"]', 'img[src*="captcha"]']:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=2000):
                loc.screenshot(path=CAPTCHA_IMG)
                print(f"Captcha salvo em: {CAPTCHA_IMG}")
                break
        except:
            continue
    print("Aguardando captcha_answer.txt (ate 300s)...")
    deadline = time.time() + 300
    while time.time() < deadline:
        if os.path.exists(CAPTCHA_ANS):
            ans = open(CAPTCHA_ANS, 'rb').read().lstrip(b'\xef\xbb\xbf').decode('utf-8').strip()
            if ans:
                print(f"Captcha: {ans!r}")
                return ans
        time.sleep(0.5)
    raise RuntimeError("Timeout captcha")

nfse_prefeitura._ler_captcha_ia = _ler_captcha_com_espera

from playwright.sync_api import sync_playwright
import requests

cfg = ENTIDADES["Vieira"]
base_url = "https://ipatinga.meumunicipio.online"

print("=== DIAG PRINT TEST ===")

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context()
    page = ctx.new_page()

    nfse_prefeitura._login(page, cfg["cnpj"], cfg["senha"])
    print(f"Login OK — URL: {page.url}")

    # Captura cookies para usar com requests
    cookies = {c['name']: c['value'] for c in ctx.cookies()}
    session = requests.Session()
    session.cookies.update(cookies)
    session.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

    print(f"\nTestando URLs de impressão para nota {NR_NOTA} (PKID={PKID}):")
    urls = [
        (f"{base_url}/ISS/contribuinte/nfe/nfe_base.php?acao=imprimir&id={PKID}", "nfe_base PKID"),
        (f"{base_url}/ISS/contribuinte/nfe/imprimeDANFSe.php?c={CHAVE}", "imprimeDANFSe chave"),
        (f"{base_url}/ISS/contribuinte/nfe/nfe_print.php?nota={NR_NOTA}", "nfe_print NR_NOTA"),
        (f"{base_url}/ISS/contribuinte/nfe/nfe_ver.php?id={PKID}", "nfe_ver PKID"),
    ]
    for url, desc in urls:
        try:
            r = session.get(url, timeout=15, allow_redirects=True)
            ct = r.headers.get('content-type', '')
            size = len(r.content)
            snippet = r.text[:150].replace('\n', ' ') if r.text else ''
            is_pdf = 'pdf' in ct.lower() or r.content[:4] == b'%PDF'
            is_html = 'html' in ct.lower()
            status_str = "PDF!" if is_pdf else ("HTML" if is_html else ct[:20])
            print(f"  [{desc}] {r.status_code} {size}ch {status_str}")
            if r.status_code == 200 and size > 1000:
                print(f"    snippet: {snippet[:120]}")
                if is_pdf:
                    out = os.path.join(os.path.dirname(__file__), f"print_test_nota{NR_NOTA}.pdf")
                    with open(out, 'wb') as f:
                        f.write(r.content)
                    print(f"    PDF SALVO: {out}")
        except Exception as e:
            print(f"  [{desc}] ERRO: {e}")

    browser.close()

print("\nDone.")
