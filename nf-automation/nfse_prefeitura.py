"""
Automação NFS-e — SIGISS Ipatinga (DIGCORP ISS)

Fluxo por nota:
  1. Login: CNPJ + senha + captcha manual (4 dígitos)
  2. Fechar popup "Comunicado"
  3. Menu: Serviços Prestados → Emissão de NFSe
  4. Tipo de Tomador → abre wizard "Pesquisar Contribuinte"
       · digita CPF/CNPJ → Pesquisar → clica linha → OK
  5. Lupa "Atividade" → seleciona código 412 → OK
  6. Botão "Reforma Tributária" → Município "Ipatinga" → Salvar
  7. Preenche Valor Total da Nota + Descrição do Serviço
  8. Clica "Emitir NFSe" → captura número → baixa PDF
"""
import base64
import sys
import time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

from config import SIGISS_LOGIN_URL, SIGISS_URL, ENTIDADES
from file_manager import salvar_pdf


def _ler_captcha_ia(page) -> str:
    """
    Captura screenshot da área do captcha e pede ao Claude para ler os 4 dígitos.
    Tenta focar no elemento imagem; se não achar, usa screenshot da página toda.
    """
    try:
        import anthropic

        img_bytes = None

        # Tenta capturar só o elemento <img> do captcha
        for sel in ['img[src*="captcha"]', 'img[src*="seguranca"]',
                    '.captcha img', '#captcha_img', 'img.captcha']:
            try:
                el = page.locator(sel).first
                if el.is_visible(timeout=1500):
                    img_bytes = el.screenshot()
                    break
            except Exception:
                continue

        # Fallback: screenshot da área ao redor do input de captcha
        if img_bytes is None:
            for sel in ['input[name="captcha"]', 'input[id="captcha"]', 'input[name*="cap"]']:
                try:
                    el = page.locator(sel).first
                    box = el.bounding_box()
                    if box:
                        img_bytes = page.screenshot(clip={
                            "x": max(0, box["x"] - 5),
                            "y": max(0, box["y"] - 5),
                            "width": 420,
                            "height": box["height"] + 10,
                        })
                        break
                except Exception:
                    continue

        # Último recurso: screenshot da página inteira
        if img_bytes is None:
            img_bytes = page.screenshot()

        img_b64 = base64.standard_b64encode(img_bytes).decode()
        client = anthropic.Anthropic()
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=10,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/png", "data": img_b64
                    }},
                    {"type": "text",
                     "text": "This image contains a CAPTCHA with exactly 4 digits. "
                             "Reply with ONLY those 4 digits, nothing else."}
                ]
            }]
        )
        digits = ''.join(c for c in resp.content[0].text if c.isdigit())[:4]
        return digits if len(digits) == 4 else ""
    except Exception:
        return ""


# ── helpers ────────────────────────────────────────────────────────────────────

def _fechar_popup(page, tentativas=6):
    """Fecha modais pelo × (Bootstrap .close) ou pelo botão 'Estou Ciente'."""
    for _ in range(tentativas):
        fechou = False
        for sel in ['button.close', '.modal-header .close',
                    '[data-dismiss="modal"]', 'button[aria-label="Close"]']:
            try:
                loc = page.locator(sel).first
                if loc.is_visible(timeout=1000):
                    loc.click()
                    time.sleep(0.6)
                    fechou = True
                    break
            except Exception:
                continue
        if not fechou:
            for sel in ['button:has-text("Estou Ciente")', 'button:has-text("Estou ciente")']:
                try:
                    loc = page.locator(sel).first
                    if loc.is_visible(timeout=1000):
                        loc.click()
                        time.sleep(0.6)
                        fechou = True
                        break
                except Exception:
                    continue
        if not fechou:
            break


def _clicar_ok(page, timeout=4000):
    """Clica no botão OK do wizard/modal ativo."""
    for sel in ['button:has-text("Ok")', 'button:has-text("OK")',
                'input[value="Ok"]', 'input[value="OK"]']:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=timeout):
                loc.click()
                time.sleep(1.0)
                return
        except Exception:
            continue
    raise RuntimeError("Botão OK não encontrado no modal.")


# ── login ──────────────────────────────────────────────────────────────────────

def _login(page, cnpj: str, senha: str, max_tentativas: int = 3):
    """
    Faz login no SIGISS. Tenta resolver o captcha via IA automaticamente.
    Se errar, recarrega o captcha e tenta de novo (até max_tentativas vezes).
    """
    cnpj_limpo = cnpj.replace(".", "").replace("/", "").replace("-", "")

    for tentativa in range(1, max_tentativas + 1):
        page.goto(SIGISS_LOGIN_URL, timeout=30_000)
        page.wait_for_load_state("networkidle")
        time.sleep(1)
        _fechar_popup(page)

        # CNPJ
        for sel in ['input[name="login"]', 'input[id="login"]',
                    'input[placeholder*="CNPJ"]', 'input[placeholder*="nscri"]']:
            try:
                page.locator(sel).first.fill(cnpj_limpo, timeout=2000)
                break
            except Exception:
                continue

        # Senha
        for sel in ['input[name="senha"]', 'input[id="senha"]', 'input[type="password"]']:
            try:
                page.locator(sel).first.fill(senha, timeout=2000)
                break
            except Exception:
                continue

        # Captcha — IA primeiro, manual como último recurso
        captcha = _ler_captcha_ia(page)
        if captcha:
            print(f"  Captcha lido automaticamente: {captcha} (tentativa {tentativa})")
        elif sys.stdin.isatty():
            print(f"  IA não conseguiu ler o captcha (tentativa {tentativa}).")
            print("  Digite os 4 dígitos que aparecem no navegador: ", end="", flush=True)
            captcha = input().strip()
        else:
            # Modo agente (sem terminal) — tenta de novo na próxima iteração
            print(f"  IA não conseguiu ler o captcha (tentativa {tentativa}), tentando novamente...")
            continue

        for sel in ['input[name="captcha"]', 'input[id="captcha"]', 'input[name*="cap"]']:
            try:
                page.locator(sel).first.fill(captcha, timeout=2000)
                break
            except Exception:
                continue

        # Submete
        for sel in ['button:has-text("Acessar")', 'button[type="submit"]', 'input[type="submit"]']:
            try:
                page.click(sel, timeout=2000)
                break
            except Exception:
                continue

        page.wait_for_load_state("networkidle")
        time.sleep(2)

        if "login" not in page.url.lower():
            # Login OK
            _fechar_popup(page, tentativas=8)
            time.sleep(0.5)
            print("  Login OK")
            return

        print(f"  Login falhou (captcha errado?). Tentando novamente...")

    raise RuntimeError(f"Login falhou após {max_tentativas} tentativas.")


# ── navegação ──────────────────────────────────────────────────────────────────

def _abrir_form_emissao(page):
    """Serviços Prestados → Emissão de NFSe, fecha popups."""
    page.locator('a:has-text("Serviços Prestados")').first.click()
    time.sleep(0.8)
    page.locator('a:has-text("Emissão de NFSe")').first.click()
    time.sleep(1.5)
    page.wait_for_load_state("networkidle")
    _fechar_popup(page)
    time.sleep(0.5)


# ── wizard: Pesquisar Contribuinte ────────────────────────────────────────────

def _pesquisar_tomador(page, tipo_tomador: str, cpf: str):
    """
    Seleciona Tipo de Tomador (dispara abertura do wizard),
    pesquisa por CPF/CNPJ, clica na linha encontrada e confirma OK.
    """
    tipo_label = "Pessoa Fisica" if tipo_tomador == "CPF" else "Pessoa Juridica"
    cpf_limpo  = cpf.replace(".", "").replace("-", "").replace("/", "")

    # Seleciona tipo de tomador — dispara onchange que abre o wizard
    tipo_sel = page.locator(
        'select[name*="tipo_tom"], select[id*="tipo_tom"], '
        'select[name*="tipoTom"], select[id*="tipoTom"], '
        'select[name*="tipo"]'
    ).first
    try:
        tipo_sel.wait_for(state="visible", timeout=4000)
        # Força change event trocando de valor primeiro se já estiver correto
        atual = tipo_sel.input_value()
        if tipo_label.lower().replace(" ", "") in (atual or "").lower().replace(" ", ""):
            outro = "Pessoa Juridica" if tipo_label == "Pessoa Fisica" else "Pessoa Fisica"
            try:
                tipo_sel.select_option(label=outro)
                time.sleep(0.4)
                # Fecha wizard se abriu indevidamente
                try:
                    page.locator('button:has-text("Cancelar")').first.click(timeout=1500)
                    time.sleep(0.4)
                except Exception:
                    pass
            except Exception:
                pass
        tipo_sel.select_option(label=tipo_label)
    except Exception:
        page.locator('select').first.select_option(label=tipo_label)
    time.sleep(1.5)

    # Aguarda wizard "Pesquisar Contribuinte" abrir
    try:
        page.wait_for_selector('button:has-text("Pesquisar")', timeout=6000)
    except PWTimeout:
        raise RuntimeError(
            "Wizard 'Pesquisar Contribuinte' não abriu após selecionar Tipo de Tomador."
        )

    # Preenche o campo CPF/CNPJ do wizard
    cpf_input = None
    for sel in [
        'input[name*="cpf"]', 'input[id*="cpf"]',
        'input[placeholder*="CPF"]',
        'td:has-text("CPF") ~ td input',
    ]:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=2000):
                cpf_input = loc
                break
        except Exception:
            continue

    if cpf_input is None:
        # fallback: primeiro input de texto visível (wizard está na frente)
        for loc in page.locator('input[type="text"]').all():
            if loc.is_visible():
                cpf_input = loc
                break

    if cpf_input is None:
        raise RuntimeError("Campo CPF/CNPJ do wizard não encontrado.")

    cpf_input.fill(cpf_limpo)
    time.sleep(0.3)

    # Clica em Pesquisar
    page.locator('button:has-text("Pesquisar")').first.click()
    time.sleep(2.5)

    # Clica na linha do resultado (seleciona o contribuinte)
    try:
        linha = page.locator(f'table tr').filter(has_text=cpf_limpo).first
        linha.wait_for(state="visible", timeout=5000)
        linha.click()
    except Exception:
        # fallback: clica na primeira linha de resultado (não cabeçalho)
        linhas = page.locator('table tr').all()
        clicou = False
        for i, l in enumerate(linhas):
            if i == 0:
                continue  # pula cabeçalho
            try:
                if l.is_visible():
                    l.click()
                    clicou = True
                    break
            except Exception:
                continue
        if not clicou:
            raise RuntimeError(
                f"Tomador CPF/CNPJ {cpf_limpo} não encontrado no SIGISS. "
                "Verifique se está cadastrado na Prefeitura de Ipatinga."
            )
    time.sleep(0.5)

    _clicar_ok(page)
    time.sleep(1.5)


# ── wizard: Atividade (lupa) ──────────────────────────────────────────────────

def _selecionar_atividade(page, codigo: str = "412"):
    """Clica na lupa de Atividade, seleciona o código e confirma OK."""
    # Botão da lupa ao lado do campo Atividade (btn-info = botão azul/teal)
    lupa = None
    for sel in [
        'button.btn-info',
        'button[onclick*="tividade"]', 'button[onclick*="atividade"]',
        'a[onclick*="tividade"]', 'a[onclick*="atividade"]',
        'input[type="button"][onclick*="tividade"]',
    ]:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=2000):
                lupa = loc
                break
        except Exception:
            continue

    if lupa is None:
        raise RuntimeError("Botão lupa de Atividade não encontrado no formulário.")

    lupa.click()
    time.sleep(1.5)

    # Modal "Atividades constantes no seu Cadastro Mobiliario"
    # Procura linha com o código exato (ex: "412") que contenha "Odontologia"
    linha_ativ = None
    for sel_linha in [
        f'tr:has-text("{codigo}"):has-text("Odontologia")',
        f'tr:has-text("{codigo}")',
    ]:
        try:
            loc = page.locator(sel_linha).first
            if loc.is_visible(timeout=4000):
                linha_ativ = loc
                break
        except Exception:
            continue

    if linha_ativ is None:
        raise RuntimeError(f"Atividade código {codigo} não encontrada no modal.")

    linha_ativ.click()
    time.sleep(0.5)
    _clicar_ok(page)
    time.sleep(1.5)


# ── popup: Reforma Tributária ──────────────────────────────────────────────────

def _reforma_tributaria(page, municipio: str = "ipatinga"):
    """Abre popup Reforma Tributária, seleciona o município e salva."""
    page.locator('button:has-text("Reforma Tributária")').first.click()
    time.sleep(1.5)

    # Campo "Município de Prestação do Serviço" — dropdown tipo Select2 com busca
    # Passo 1: abre o dropdown clicando no container
    abriu = False
    for sel in [
        '.select2-selection',
        '.select2-container .select2-selection--single',
        'div:has-text("Digite para pesquisar")',
    ]:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=2000):
                loc.click()
                time.sleep(0.8)
                abriu = True
                break
        except Exception:
            continue

    # Passo 2: digita no campo de busca
    digitou = False
    for sel in ['.select2-search__field', '.select2-input',
                'input[placeholder*="pesquisar"]', 'input[placeholder*="Pesquisar"]']:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=2000):
                loc.fill(municipio)
                time.sleep(1.5)
                digitou = True
                break
        except Exception:
            continue

    if not digitou:
        raise RuntimeError("Campo de busca do Município (Reforma Tributária) não encontrado.")

    # Passo 3: clica na opção "Ipatinga - MG"
    clicou = False
    for sel in [
        '.select2-results__option:has-text("Ipatinga")',
        'li:has-text("Ipatinga - MG")',
        'li:has-text("Ipatinga")',
        '[class*="option"]:has-text("Ipatinga")',
    ]:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=3000):
                loc.click()
                time.sleep(0.5)
                clicou = True
                break
        except Exception:
            continue

    if not clicou:
        raise RuntimeError("Opção 'Ipatinga - MG' não encontrada no dropdown de município.")

    # Salva o popup
    page.locator('button:has-text("Salvar")').last.click()
    time.sleep(1.5)


# ── formulário principal ───────────────────────────────────────────────────────

def _preencher_form(page, nota: dict):
    # 1. Pesquisa e seleciona o tomador via wizard
    _pesquisar_tomador(page, nota.get("tipo_tomador", "CPF"), nota["cpf_tomador"])

    # 2. Seleciona atividade 412 (Odontologia) via lupa
    _selecionar_atividade(page, "412")

    # 3. Preenche popup Reforma Tributária (obrigatório no SIGISS Ipatinga)
    _reforma_tributaria(page)

    # 4. Valor Total da Nota
    valor_str = f"{float(nota['valor']):.2f}".replace(".", ",")
    preencheu_valor = False
    for sel in [
        'input[name*="valor_total"], input[id*="valor_total"]',
        'input[name*="valorTotal"], input[id*="valorTotal"]',
        'input[name*="valor"], input[id*="valor"]',
        'input[placeholder*="alor"]',
    ]:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=3000):
                loc.fill(valor_str)
                preencheu_valor = True
                break
        except Exception:
            continue
    if not preencheu_valor:
        raise RuntimeError("Campo 'Valor Total da Nota' não encontrado.")

    # 5. Situação de Tributação — primeira opção não-vazia
    try:
        sit = page.locator(
            'select[name*="situacao"], select[id*="situacao"], '
            'select[name*="tribut"], select[id*="tribut"]'
        ).first
        for opt in sit.locator("option").all():
            val = opt.get_attribute("value") or ""
            txt = opt.inner_text().strip()
            if val and val not in ("0", "") and "Selecione" not in txt:
                sit.select_option(value=val)
                break
    except Exception:
        pass

    # 6. Descrição do Serviço Prestado
    descricao = nota.get("descricao") or "Servicos odontologicos"
    if nota.get("nome_paciente"):
        descricao += f" - Paciente: {nota['nome_paciente']}"
        if nota.get("cpf_paciente"):
            descricao += f", CPF: {nota['cpf_paciente']}"
    preencheu_desc = False
    for sel in [
        'textarea[name*="descricao"], textarea[id*="descricao"]',
        'textarea',
    ]:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=3000):
                loc.fill(descricao[:500])
                preencheu_desc = True
                break
        except Exception:
            continue
    if not preencheu_desc:
        raise RuntimeError("Campo 'Descrição do Serviço' não encontrado.")


# ── emissão e download do PDF ──────────────────────────────────────────────────

def _emitir_e_baixar(page, nota: dict, pasta: str) -> dict:
    _preencher_form(page, nota)

    # Clica "Emitir NFSe" (abre confirmação — sem download imediato)
    page.locator(
        'button:has-text("Emitir NFSe"), '
        'a:has-text("Emitir NFSe"), '
        'input[value*="Emitir NFSe"]'
    ).first.click()
    page.wait_for_load_state("networkidle")
    time.sleep(2)

    # Captura o número da nota na tela de confirmação
    num_nota = ""
    for sel in [
        '[id*="num_nota"]', '[id*="numero_nota"]', '[id*="numeroNota"]',
        '.numero-nota', 'td:has-text("Número")', 'span:has-text("NFS")',
    ]:
        try:
            txt = page.locator(sel).first.inner_text(timeout=2000).strip()
            digits = ''.join(c for c in txt if c.isdigit())
            if digits:
                num_nota = digits
                break
        except Exception:
            continue

    # Baixa o PDF (expect_download apenas para o clique no link PDF)
    caminho = ""
    try:
        with page.expect_download(timeout=20_000) as dl_info:
            page.locator(
                'a:has-text("PDF"), button:has-text("PDF"), '
                'a:has-text("Imprimir"), a[href*=".pdf"]'
            ).first.click(timeout=10_000)
        caminho = salvar_pdf(
            dl_info.value, pasta, nota["competencia"], num_nota, nota["nome_tomador"]
        )
    except Exception as e:
        print(f"     ⚠️  PDF não baixado automaticamente: {e}")
        print(f"     ℹ️  Nota #{num_nota} emitida — baixe o PDF manualmente.")

    return {"num_nota": num_nota, "caminho_pdf": caminho}


# ── ponto de entrada público ───────────────────────────────────────────────────

def processar(entidade: str, notas: list) -> list:
    """Faz login uma vez, emite todas as notas, retorna lista de resultados."""
    cfg = ENTIDADES[entidade]
    resultados = []

    with sync_playwright() as p:
        headless = not sys.stdin.isatty()  # headless na nuvem, visível no terminal local
        browser = p.chromium.launch(headless=headless, slow_mo=100 if not headless else 0)
        ctx = browser.new_context(accept_downloads=True)
        page = ctx.new_page()

        try:
            print(f"\n[LOGIN] {entidade}")
            _login(page, cfg["login"], cfg["senha"])
            print("  Login OK")

            for nota in notas:
                print(f"\n  -> #{nota['id']}  {nota['nome_tomador']}  "
                      f"R$ {nota['valor']:.2f}  {nota['competencia']}")
                try:
                    _abrir_form_emissao(page)
                    r = _emitir_e_baixar(page, nota, cfg["pasta"])
                    resultados.append({"nota": nota, "ok": True, **r})
                    print(f"     OK  Nota #{r['num_nota']}  {r['caminho_pdf']}")
                except Exception as e:
                    resultados.append({"nota": nota, "ok": False, "erro": str(e)})
                    print(f"     ERRO: {e}")
                    # Tenta voltar ao estado limpo
                    try:
                        page.goto(SIGISS_URL, timeout=10_000)
                        _fechar_popup(page)
                    except Exception:
                        pass

        finally:
            if sys.stdin.isatty():
                time.sleep(3)  # pausa visual só no modo interativo
            ctx.close()
            browser.close()

    return resultados
