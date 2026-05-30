"""
Diagnóstico: encontrar a URL correta de impressão para nota #401.
Faz login, busca nfe_historico.php, extrai onclicks e testa URLs.
"""
import sys, os, re, time
sys.stdout.reconfigure(line_buffering=True)
sys.path.insert(0, os.path.dirname(__file__))

from config import SIGISS_LOGIN_URL, SIGISS_URL, ENTIDADES
import requests

CAPTCHA_IMG = os.path.join(os.path.dirname(__file__), "captcha_debug.png")
CAPTCHA_ANS = os.path.join(os.path.dirname(__file__), "captcha_answer.txt")
NUM_NOTA = "401"

def _login_http(entidade):
    cfg = ENTIDADES[entidade]
    base_url = "https://ipatinga.meumunicipio.online"
    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

    login_url = SIGISS_LOGIN_URL
    r0 = session.get(login_url, timeout=10)
    print(f"Login page: {r0.status_code} {len(r0.text)}ch")

    # Captcha
    captcha_urls = [
        f"{base_url}/ISS/imagem.php",
        f"{base_url}/ISS/captcha.php",
        f"{base_url}/ISS/login_captcha.php",
    ]
    for curl in captcha_urls:
        try:
            rc = session.get(curl, timeout=5)
            if rc.status_code == 200 and len(rc.content) > 100:
                with open(CAPTCHA_IMG, 'wb') as f:
                    f.write(rc.content)
                print(f"Captcha salvo de: {curl}")
                break
        except:
            pass

    if os.path.exists(CAPTCHA_ANS):
        os.remove(CAPTCHA_ANS)

    print(f"Aguardando captcha_answer.txt (ate 300s)...")
    deadline = time.time() + 300
    captcha = ""
    while time.time() < deadline:
        if os.path.exists(CAPTCHA_ANS):
            ans = open(CAPTCHA_ANS, 'rb').read().lstrip(b'\xef\xbb\xbf').decode('utf-8').strip()
            if ans:
                captcha = ans
                print(f"Captcha: {captcha!r}")
                break
        time.sleep(0.5)
    if not captcha:
        raise RuntimeError("Timeout captcha")

    # POST login
    data = {
        "cnpj": cfg["cnpj"].replace(".", "").replace("/", "").replace("-", ""),
        "senha": cfg["senha"],
        "captcha": captcha,
        "acao": "logar",
    }
    rl = session.post(login_url, data=data, timeout=10)
    print(f"Login POST: {rl.status_code} {len(rl.text)}ch")
    if "Bem-vindo" in rl.text or "contribuinte" in rl.url or rl.status_code == 200:
        print("Login OK (assumindo)")
    return session, base_url

def main():
    session, base_url = _login_http("Vieira")

    hist_url = f"{base_url}/ISS/contribuinte/nfe/nfe_historico.php"
    r = session.get(hist_url, timeout=15)
    print(f"\nnfe_historico.php: {r.status_code} {len(r.text)}ch")

    # Encontrar linha da nota 401
    # Formato: id="DB_PKID<|>CODE<|>NR_NOTA<|>..."
    rows = re.findall(r'<tr[^>]+id="(\d+<\|>[^"]+)"[^>]*>(.*?)</tr>', r.text, re.DOTALL)
    print(f"Total rows: {len(rows)}")

    target_row = None
    target_pkid = None
    for tr_id, tr_body in rows:
        parts = tr_id.split('<|>')
        if len(parts) >= 3 and parts[2].strip() == NUM_NOTA:
            target_row = tr_body
            target_pkid = parts[0].strip()
            print(f"\nROW para nota {NUM_NOTA}:")
            print(f"  tr-id: {tr_id[:120]}")
            print(f"  DB_PKID: {target_pkid}")
            # Extrai onclicks
            onclicks = re.findall(r'onclick=["\']([^"\']+)["\']', tr_body)
            hrefs = re.findall(r'href=["\']([^"\']+)["\']', tr_body)
            print(f"  onclicks: {onclicks}")
            print(f"  hrefs: {hrefs}")
            # Mostra os TDs
            tds = re.findall(r'<td[^>]*>(.*?)</td>', tr_body, re.DOTALL)
            print(f"  TDs ({len(tds)}): {[re.sub(r'<[^>]+>', '', td).strip()[:30] for td in tds]}")
            break

    if not target_pkid:
        print(f"\nNota {NUM_NOTA} não encontrada no historico!")
        # Mostra primeiras 3 linhas para debug
        for tr_id, tr_body in rows[:3]:
            parts = tr_id.split('<|>')
            print(f"  sample row parts: {parts[:5]}")
        return

    # Testa URLs de impressão com o PKI e número sequencial
    print(f"\n=== Testando URLs de impressão ===")
    urls = [
        f"{base_url}/ISS/contribuinte/nfe/nfe_print.php?nota={NUM_NOTA}",
        f"{base_url}/ISS/contribuinte/nfe/nfe_print.php?nota={target_pkid}",
        f"{base_url}/ISS/contribuinte/nfe/nfe_ver.php?nota={NUM_NOTA}",
        f"{base_url}/ISS/contribuinte/nfe/nfe_ver.php?id={target_pkid}",
        f"{base_url}/ISS/contribuinte/nfe/nfe_ver.php?nota={target_pkid}",
        f"{base_url}/ISS/contribuinte/nfe/nfe_base.php?id={target_pkid}",
        f"{base_url}/ISS/contribuinte/nfe/nfe_base.php?id={NUM_NOTA}",
        f"{base_url}/ISS/contribuinte/nfe/nfse_imprime.php?nota={NUM_NOTA}",
        f"{base_url}/ISS/contribuinte/nfe/nfse_imprime.php?id={target_pkid}",
        f"{base_url}/ISS/contribuinte/nfe/nfe_historico_impressao_lote.php?nota={NUM_NOTA}",
    ]
    for url in urls:
        try:
            rp = session.get(url, timeout=10)
            ct = rp.headers.get('content-type', '')
            size = len(rp.content)
            snippet = rp.text[:100].replace('\n', ' ') if rp.text else ''
            print(f"  {rp.status_code} {size}ch ct={ct[:30]} {url.split('/')[-1][:50]}")
            if rp.status_code == 200 and size > 500:
                print(f"    -> CANDIDATO! snippet: {snippet[:80]}")
        except Exception as e:
            print(f"  ERR {url.split('/')[-1][:40]}: {e}")

    # Também olha se há onclick no row que revela a URL
    if target_row:
        js_calls = re.findall(r'\w+\s*\([^)]*\)', target_row)
        print(f"\nJS calls na row: {js_calls[:10]}")

if __name__ == "__main__":
    main()
