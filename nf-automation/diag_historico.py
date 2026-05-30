"""
Diagnóstico: login Playwright + captura HTML nfe_historico.php + análise onclicks da nota 401.
"""
import sys, os, re, time
sys.stdout.reconfigure(line_buffering=True)
sys.path.insert(0, os.path.dirname(__file__))

from config import SIGISS_LOGIN_URL, SIGISS_URL, ENTIDADES
import nfse_prefeitura

CAPTCHA_IMG = os.path.join(os.path.dirname(__file__), "captcha_debug.png")
CAPTCHA_ANS = os.path.join(os.path.dirname(__file__), "captcha_answer.txt")
NUM_NOTA = "401"
OUT_HTML = os.path.join(os.path.dirname(__file__), "historico_dump.html")

def _ler_captcha_com_espera(page) -> str:
    if os.path.exists(CAPTCHA_ANS):
        os.remove(CAPTCHA_ANS)
    captured = False
    for sel in ['img[src*="imagem.php"]', 'img[src*="captcha"]', 'img[src*="Captcha"]']:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=2000):
                loc.screenshot(path=CAPTCHA_IMG)
                captured = True
                print(f"Captcha salvo em: {CAPTCHA_IMG}")
                break
        except:
            continue
    if not captured:
        page.screenshot(path=CAPTCHA_IMG)
        print(f"Captcha (página) salvo em: {CAPTCHA_IMG}")

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

# ---- login + navegação ----
from playwright.sync_api import sync_playwright

cfg = ENTIDADES["Vieira"]
base_url = "https://ipatinga.meumunicipio.online"

print("=== DIAG HISTORICO ===")

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context()
    page = ctx.new_page()

    # Login usando a função real do nfse_prefeitura
    nfse_prefeitura._login(page, cfg["cnpj"], cfg["senha"])
    print(f"Pós-login URL: {page.url}")

    # Navega direto para nfe_historico.php
    hist_url = f"{base_url}/ISS/contribuinte/nfe/nfe_historico.php"
    page.goto(hist_url)
    page.wait_for_load_state("domcontentloaded", timeout=10000)
    print(f"Historico URL: {page.url}")

    html = page.content()
    print(f"HTML: {len(html)} chars")

    with open(OUT_HTML, 'w', encoding='utf-8', errors='replace') as f:
        f.write(html)
    print(f"HTML salvo em: {OUT_HTML}")

    # Analisa onclicks da linha 401
    rows = re.findall(r'<tr[^>]+id="(\d+<\|>[^"]+)"[^>]*>(.*?)</tr>', html, re.DOTALL)
    print(f"Total rows com tr-id: {len(rows)}")

    for tr_id, tr_body in rows:
        parts = tr_id.split('<|>')
        if len(parts) >= 3 and parts[2].strip() == NUM_NOTA:
            print(f"\nLinha nota {NUM_NOTA}:")
            print(f"  tr-id: {tr_id[:150]}")
            onclicks = re.findall(r'onclick=["\']([^"\']+)["\']', tr_body)
            hrefs = re.findall(r'href=["\']([^"\']+)["\']', tr_body)
            js_opens = re.findall(r"window\.open\(['\"]([^'\"]+)['\"]", tr_body)
            print(f"  onclicks: {onclicks}")
            print(f"  hrefs: {hrefs}")
            print(f"  window.open: {js_opens}")
            tds = re.findall(r'<td[^>]*>(.*?)</td>', tr_body, re.DOTALL)
            print(f"  TDs: {[re.sub(r'<[^>]+>', '', t).strip()[:40] for t in tds]}")
            print(f"  HTML completo da row:\n{tr_body[:800]}")
            break

    # Também procura por funções JS que aparecem nos onclicks das rows
    print("\n=== JS relevante no historico ===")
    js_funcs = re.findall(r'function\s+(\w+imprimir\w*|imprimir\w*|\w+print\w*|\w+ver\w*)\s*\(', html, re.IGNORECASE)
    print(f"Funções JS: {js_funcs}")

    # Procura linhas de script que mencionam print/imprimir/ver
    script_lines = []
    for m in re.finditer(r'.{0,50}(nfe_print|nfe_ver|nfe_base|imprimir|window\.open).{0,100}', html):
        script_lines.append(m.group(0)[:150])
    print(f"\nLinhas com print/ver/open ({len(script_lines)}):")
    for l in script_lines[:10]:
        print(f"  {l}")

    browser.close()

print("\nDone.")
