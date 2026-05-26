"""
Teste de emissão de NF — R$1 em nome de Luiz Eduardo
Fluxo: script captura captcha → salva PNG → espera captcha_answer.txt → continua
"""
import sys, os, time
sys.stdout.reconfigure(line_buffering=True)
sys.path.insert(0, os.path.dirname(__file__))

from config import SIGISS_LOGIN_URL, ENTIDADES
import nfse_prefeitura

CAPTCHA_IMG  = os.path.join(os.path.dirname(__file__), "captcha_debug.png")
CAPTCHA_ANS  = os.path.join(os.path.dirname(__file__), "captcha_answer.txt")

nota_teste = {
    "id": 9999,
    "tipo_tomador": "CPF",
    "cpf_tomador": "06563650643",
    "nome_tomador": "LUIZ EDUARDO COELHO VIDIGAL MARTINS",
    "nome_paciente": "",
    "cpf_paciente": "",
    "valor": 1.00,
    "descricao": "teste",
    "competencia": "05-2026",
}

print("=== TESTE DE EMISSÃO NF ===")

def _ler_captcha_com_espera(page) -> str:
    # Remove resposta anterior
    if os.path.exists(CAPTCHA_ANS):
        os.remove(CAPTCHA_ANS)

    # Captura imagem do captcha
    captured = False
    for sel in ['img[src*="imagem.php"]', 'img[src*="captcha"]', 'img[src*="Captcha"]']:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=2000):
                loc.screenshot(path=CAPTCHA_IMG)
                captured = True
                print(f"  Captcha salvo em: {CAPTCHA_IMG}")
                break
        except Exception:
            continue
    if not captured:
        page.screenshot(path=CAPTCHA_IMG)
        print(f"  Captcha (página) salvo em: {CAPTCHA_IMG}")

    # Aguarda arquivo de resposta
    print("  Aguardando captcha_answer.txt (ate 300s)...")
    deadline = time.time() + 300
    while time.time() < deadline:
        if os.path.exists(CAPTCHA_ANS):
            ans = open(CAPTCHA_ANS).read().strip()
            if ans:
                print(f"  Captcha lido do arquivo: {ans!r}")
                return ans
        time.sleep(0.5)
    raise RuntimeError("Timeout aguardando captcha_answer.txt (300s)")

nfse_prefeitura._ler_captcha_ia = _ler_captcha_com_espera

resultados = nfse_prefeitura.processar("Vieira", [nota_teste])

for r in resultados:
    if r.get("ok"):
        print(f"\nSUCESSO! Nota #{r['num_nota']}")
        print(f"   PDF: {r.get('caminho_pdf', '(nao capturado)')}")
    else:
        print(f"\nERRO: {r.get('erro')}")
