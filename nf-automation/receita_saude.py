"""
Automação Receita Saúde — e-CAC / gov.br (semi-automática)

O login gov.br exige 2FA por SMS/app — o script abre o navegador
e aguarda o usuário completar o login manualmente. Depois assume.
"""
import time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

from config import ENTIDADES
from file_manager import salvar_pdf

ECAC_URL      = "https://cav.receita.fazenda.gov.br/autenticacao/login"
RS_PATH       = "/e-Contribuinte/pages/receitaSaude/emitirRecibo.xhtml"


# ── helpers ────────────────────────────────────────────────────────────────────

def _aguardar_usuario_logar(page):
    """Pausa até detectar que o login gov.br foi concluído."""
    print("\n" + "="*60)
    print("  AÇÃO NECESSÁRIA: faça login no gov.br no navegador aberto.")
    print("  (inclui código de 2FA se solicitado)")
    print("  Quando estiver na tela do e-CAC, pressione ENTER aqui.")
    print("="*60)
    input("  >> Pressione ENTER para continuar: ")


def _navegar_receita_saude(page):
    """Navega até a tela de emissão do Receita Saúde."""
    base = page.url.split("/e-Contribuinte")[0] if "/e-Contribuinte" in page.url else \
           "https://cav.receita.fazenda.gov.br"
    page.goto(f"{base}{RS_PATH}", timeout=30_000)
    page.wait_for_load_state("networkidle")
    time.sleep(2)


def _emitir_recibo(page, nota: dict) -> dict:
    """
    Preenche e submete o formulário de recibo do Receita Saúde.
    Retorna {'num_nota': str, 'download': objeto_playwright_download}
    """
    pagador_cpf    = nota["cpf_tomador"]
    beneficiario   = nota.get("cpf_paciente", "")
    tem_paciente   = bool(beneficiario)

    # ── CPF do pagador ─────────────────────────────────────────────────────────
    page.locator('input[id*="cpfPagador"], input[placeholder*="CPF do Pagador"]').first.fill(pagador_cpf)
    page.keyboard.press("Tab")
    time.sleep(1)

    # ── Pagador é o beneficiário? ──────────────────────────────────────────────
    cb_sel = 'input[type="checkbox"][id*="mesmoBenef"], input[type="checkbox"][id*="pagadorBenef"]'
    try:
        cb = page.locator(cb_sel).first
        is_checked = cb.is_checked()
        if tem_paciente and is_checked:
            cb.uncheck()
            time.sleep(0.5)
        elif not tem_paciente and not is_checked:
            cb.check()
            time.sleep(0.5)
    except PWTimeout:
        pass

    # ── CPF do beneficiário (se diferente) ────────────────────────────────────
    if tem_paciente:
        try:
            page.locator(
                'input[id*="cpfBenef"], input[placeholder*="CPF do Beneficiário"]'
            ).first.fill(beneficiario)
            page.keyboard.press("Tab")
            time.sleep(1)
        except PWTimeout:
            pass

    # ── Data do pagamento ──────────────────────────────────────────────────────
    if nota.get("data_pagamento"):
        try:
            page.locator('input[id*="dataPagamento"], input[id*="data"]').first.fill(
                nota["data_pagamento"]
            )
        except PWTimeout:
            pass

    # ── Valor ──────────────────────────────────────────────────────────────────
    valor_fmt = f"{float(nota['valor']):.2f}".replace(".", ",")
    page.locator('input[id*="valor"]').first.fill(valor_fmt)

    # ── Descrição ──────────────────────────────────────────────────────────────
    descricao = (nota.get("descricao") or "Serviços odontológicos")[:255]
    try:
        page.locator('textarea[id*="descricao"], input[id*="descricao"]').first.fill(descricao)
    except PWTimeout:
        pass

    # ── Submete ────────────────────────────────────────────────────────────────
    page.locator(
        'button:has-text("Emitir"), button:has-text("Incluir"), input[value*="Emitir"]'
    ).first.click()
    page.wait_for_load_state("networkidle")
    time.sleep(2)

    # ── Número do recibo ───────────────────────────────────────────────────────
    num_nota = ""
    for sel in ['[id*="numeroRecibo"]', '[id*="numero"]', '[class*="numero"]']:
        try:
            num_nota = page.locator(sel).first.inner_text(timeout=3000).strip()
            if num_nota:
                break
        except PWTimeout:
            continue

    # ── Download do PDF ────────────────────────────────────────────────────────
    download_obj = None
    try:
        with page.expect_download(timeout=20_000) as dl:
            page.locator(
                'a:has-text("PDF"), button:has-text("PDF"), a:has-text("Imprimir")'
            ).first.click()
        download_obj = dl.value
    except PWTimeout:
        pass

    return {"num_nota": num_nota, "download": download_obj}


# ── ponto de entrada público ───────────────────────────────────────────────────

def processar(notas: list[dict]) -> list[dict]:
    """
    Abre o e-CAC, aguarda login manual, emite todos os recibos.
    Retorna lista de resultados.
    """
    cfg = ENTIDADES["Receita Saude"]
    resultados = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=60)
        ctx = browser.new_context(accept_downloads=True)
        page = ctx.new_page()

        try:
            page.goto(ECAC_URL, timeout=30_000)
            _aguardar_usuario_logar(page)
            _navegar_receita_saude(page)
            print("   ✅ Receita Saúde aberta\n")

            for nota in notas:
                print(f"   → #{nota['id']} {nota['nome_tomador']}  R$ {nota['valor']:.2f}")
                try:
                    _navegar_receita_saude(page)   # volta ao form limpo a cada nota
                    r = _emitir_recibo(page, nota)
                    caminho = ""
                    if r["download"]:
                        caminho = salvar_pdf(
                            r["download"],
                            cfg["pasta"],
                            nota["competencia"],
                            r["num_nota"],
                            nota["nome_tomador"],
                        )
                    resultados.append({
                        "nota": nota,
                        "ok": True,
                        "num_nota": r["num_nota"],
                        "caminho_pdf": caminho,
                    })
                    print(f"      ✅ Recibo #{r['num_nota']} — {caminho or '(PDF não capturado)'}")
                except Exception as e:
                    resultados.append({"nota": nota, "ok": False, "erro": str(e)})
                    print(f"      ❌ {e}")

        finally:
            input("\nPressione ENTER para fechar o navegador...")
            ctx.close()
            browser.close()

    return resultados
