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
import sys
import time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

from config import SIGISS_LOGIN_URL, SIGISS_URL, ENTIDADES
from file_manager import salvar_pdf


def _capturar_img_captcha(page) -> bytes | None:
    """Captura screenshot da página de login para exibição manual do captcha."""
    return page.screenshot()


def _preprocessar_captcha(img_bytes: bytes) -> list:
    """Gera variações pré-processadas da imagem para melhorar acurácia do OCR."""
    variações = [img_bytes]
    try:
        from PIL import Image, ImageEnhance, ImageOps
        import io

        img = Image.open(io.BytesIO(img_bytes)).convert('RGB')

        def _salvar(pil_img):
            buf = io.BytesIO()
            pil_img.save(buf, format='PNG')
            return buf.getvalue()

        # Variação 1: escala de cinza + escala 2x + binarização
        gray = img.convert('L')
        big = gray.resize((gray.width * 2, gray.height * 2), Image.LANCZOS)
        variações.append(_salvar(big.point(lambda p: 255 if p > 128 else 0)))

        # Variação 2: alto contraste + escala de cinza + escala 2x + binarização forte
        enhanced = ImageEnhance.Contrast(img).enhance(3.0)
        gray2 = enhanced.convert('L')
        big2 = gray2.resize((gray2.width * 2, gray2.height * 2), Image.LANCZOS)
        variações.append(_salvar(big2.point(lambda p: 255 if p > 150 else 0)))

        # Variação 3: invertido (cobre captchas com fundo escuro)
        inverted = ImageOps.invert(gray)
        big3 = inverted.resize((inverted.width * 2, inverted.height * 2), Image.LANCZOS)
        variações.append(_salvar(big3.point(lambda p: 255 if p > 128 else 0)))

    except Exception:
        pass
    return variações


def _ler_captcha_ia(page) -> str:
    """Lê o captcha (4 dígitos) com pré-processamento de imagem + ddddocr."""
    try:
        import ddddocr
        # Captura só o elemento da imagem do captcha para melhor precisão no OCR
        img_bytes = None
        try:
            loc = page.locator(
                'img[src*="imagem.php"], img[src*="GetCaptcha"], '
                'img[src*="captcha"], img[src*="Captcha"]'
            ).first
            if loc.is_visible(timeout=2000):
                img_bytes = loc.screenshot()
        except Exception:
            pass
        if img_bytes is None:
            img_bytes = _capturar_img_captcha(page)
        if img_bytes is None:
            return ""
        ocr = ddddocr.DdddOcr(show_ad=False)
        for variação in _preprocessar_captcha(img_bytes):
            try:
                resultado = ocr.classification(variação)
                digits = ''.join(c for c in resultado if c.isdigit())[:4]
                if len(digits) == 4:
                    return digits
            except Exception:
                continue
        return ""
    except Exception:
        return ""


# ── helpers ────────────────────────────────────────────────────────────────────

def _fechar_popup(page, tentativas=6):
    """Fecha modais pelo × (Bootstrap .close) ou por botões de confirmação."""
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
            for sel in ['button:has-text("Estou Ciente")', 'button:has-text("Estou ciente")',
                        'button:has-text("Fechar")', 'button:has-text("OK")',
                        'button:has-text("Ok")']:
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

        # Captcha — IA primeiro, depois manual via CRM ou terminal
        captcha = _ler_captcha_ia(page)
        if captcha:
            print(f"  Captcha lido automaticamente: {captcha} (tentativa {tentativa})")
        elif sys.stdin.isatty():
            print(f"  IA não conseguiu ler o captcha (tentativa {tentativa}).")
            print("  Digite os 4 dígitos que aparecem no navegador: ", end="", flush=True)
            captcha = input().strip()
        else:
            # Modo nuvem — solicita digitação manual no CRM
            print(f"  IA não conseguiu ler o captcha (tentativa {tentativa}), aguardando digitação no CRM...")
            try:
                import crm_api
                img_bytes = _capturar_img_captcha(page)
                captcha = crm_api.solicitar_captcha_manual(img_bytes) if img_bytes else ""
            except Exception as e:
                print(f"  Erro ao solicitar captcha manual: {e}")
                captcha = ""
            if not captcha:
                print("  Sem resposta, tentando nova leitura automática...")
                continue

        # Re-preenche CNPJ e senha (podem ter sido limpos durante a espera)
        for sel in ['input[name="login"]', 'input[id="login"]',
                    'input[placeholder*="CNPJ"]', 'input[placeholder*="nscri"]']:
            try:
                page.locator(sel).first.fill(cnpj_limpo, timeout=2000)
                break
            except Exception:
                continue
        for sel in ['input[name="senha"]', 'input[id="senha"]', 'input[type="password"]']:
            try:
                page.locator(sel).first.fill(senha, timeout=2000)
                break
            except Exception:
                continue

        for sel in ['input[name="confirma"]', 'input[id="confirma"]',
                    'input[placeholder*="caracteres"]',
                    'input[name="captcha"]', 'input[id="captcha"]', 'input[name*="cap"]']:
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

        try:
            page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass  # chat/long-polling impede networkidle; checa URL diretamente
        time.sleep(2)

        if "login" not in page.url.lower():
            # Login OK
            _fechar_popup(page, tentativas=8)
            time.sleep(0.5)
            print("  Login OK")
            return

        try:
            body_text = page.inner_text('body')
            print(f"  Msg SIGISS: {body_text[:300]}")
        except Exception:
            pass
        print(f"  Login falhou (tentativa {tentativa}/{max_tentativas}). Tentando novamente...")

    raise RuntimeError(f"Login falhou após {max_tentativas} tentativas.")


# ── navegação ──────────────────────────────────────────────────────────────────

def _todos_frames(page):
    """Retorna page + todos os frames filhos."""
    return [page] + list(page.frames)


def _frame_formulario(page, timeout_s: int = 12):
    """Aguarda e retorna o frame do formulário NFSe (nfe.php).

    Prioriza 'nfe.php' para evitar retornar o frame do modal IBS/CBS que também
    contém 'emissao' na URL.
    """
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        frames = page.frames
        # Prioridade 1: URL contém 'nfe.php' (forma exata)
        for f in frames:
            if f.url and 'nfe.php' in f.url and 'Componentes' not in f.url:
                return f
        # Prioridade 2: qualquer frame com nfe/nfse mas não modal
        for f in frames:
            if f.url and any(k in f.url for k in ['nfe', 'nfse']) and 'Componentes' not in f.url:
                return f
        time.sleep(0.5)
    # fallback: qualquer frame não-principal com URL
    candidates = [f for f in page.frames
                  if f != page.main_frame and f.url
                  and f.url not in ('', 'about:blank', '_')
                  and 'Componentes' not in f.url]
    if candidates:
        return candidates[-1]
    raise RuntimeError("Frame do formulário NFSe não encontrado.")


def _abrir_form_emissao(page):
    """Navega para Emissão de NFSe chamando abre_arquivo() via JS (mais robusto que clicar no dropdown)."""
    time.sleep(1)

    # abre_arquivo('nfe/nfe.php') é o onclick do item "Emissão de NFSe" no dropdown
    # Chamar via JS evita problemas de timing com o dropdown Bootstrap
    chamou_js = False
    for frame in _todos_frames(page):
        try:
            if frame.evaluate("typeof abre_arquivo !== 'undefined'"):
                frame.evaluate("abre_arquivo('nfe/nfe.php')")
                chamou_js = True
                print("  abre_arquivo('nfe/nfe.php') chamado via JS")
                break
        except Exception:
            continue

    if not chamou_js:
        # Fallback: clica no botão dropdown e depois no item
        for frame in _todos_frames(page):
            for sel in ['button#dropdownMenu2',
                        'button:has-text("Serviços Prestados")']:
                try:
                    loc = frame.locator(sel).first
                    if loc.is_visible(timeout=1500):
                        loc.click()
                        break
                except Exception:
                    continue
        time.sleep(0.8)
        for frame in _todos_frames(page):
            for sel in ['a[onclick*="nfe.php"]',
                        'a:has-text("Emissão de NFSe")',
                        'a.dropdown-item:has-text("Emiss")']:
                try:
                    loc = frame.locator(sel).first
                    loc.click(timeout=2000)
                    chamou_js = True
                    break
                except Exception:
                    continue
            if chamou_js:
                break

    if not chamou_js:
        raise RuntimeError("Não foi possível abrir formulário de Emissão de NFSe.")

    time.sleep(2)
    try:
        page.wait_for_load_state("networkidle", timeout=6000)
    except Exception:
        pass
    _fechar_popup(page)
    time.sleep(0.5)


# ── wizard: Pesquisar Contribuinte ────────────────────────────────────────────

def _aguardar_frame_lookup(page, timeout_s: int = 8):
    """Aguarda o frame nfe_lookup.php aparecer (carregado via iframe, não popup)."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for f in page.frames:
            if f.url and 'nfe_lookup' in f.url:
                return f
        time.sleep(0.4)
    return None


def _pesquisar_tomador(page, tipo_tomador: str, cpf: str):
    """
    Seleciona Tipo de Tomador no form frame (select[name="local"]).
    O SIGISS Ipatinga carrega o wizard de busca em iframe (nfe_lookup.php),
    não em popup window — por isso usamos _aguardar_frame_lookup.
    """
    form = _frame_formulario(page)
    cpf_limpo = cpf.replace(".", "").replace("-", "").replace("/", "")

    # Labels reais do SIGISS Ipatinga
    if tipo_tomador == "CPF":
        labels = ["Pessoa Física", "Pessoa Fisica"]
    else:
        labels = ["Jurídica do Município", "Juridica do Municipio",
                  "Jurídica de Fora", "Juridica de Fora"]

    tipo_sel = form.locator('select[name="local"], select#local').first
    tipo_sel.wait_for(state="visible", timeout=6000)

    # Reset para vazio — garante que onchange dispara mesmo com valor já selecionado
    try:
        form.evaluate("""
            () => {
                const sel = document.querySelector('select[name="local"], select#local');
                if (sel) sel.value = '';
            }
        """)
        time.sleep(0.3)
    except Exception:
        pass

    # Seleciona o tipo — dispara onchange que carrega nfe_lookup.php no iframe lookup
    for lbl in labels:
        try:
            tipo_sel.select_option(label=lbl)
            print(f"  Tipo tomador selecionado: {lbl}")
            break
        except Exception:
            continue

    time.sleep(1.0)

    # Aguarda o frame lookup (nfe_lookup.php) aparecer
    lookup = _aguardar_frame_lookup(page, timeout_s=8)

    if lookup is None:
        # Fallback: tenta chamar a função JS diretamente
        print("  Iframe lookup não apareceu, tentando chamar função JS...")
        for fn in ["pop_tomador", "abreLookup", "openLookup", "abreTomador"]:
            try:
                form.evaluate(f"if (typeof {fn} === 'function') {fn}()")
                time.sleep(1.5)
                lookup = _aguardar_frame_lookup(page, timeout_s=5)
                if lookup:
                    print(f"  Lookup aberto via {fn}()")
                    break
            except Exception:
                continue

    if lookup is None:
        # Último fallback: procura campo CPF em qualquer frame
        print("  Lookup não encontrado, procurando campo CPF em frames...")
        for ctx in _todos_frames(page):
            for sel in ['input[name*="cpf"]', 'input[id*="cpf"]', 'input[placeholder*="CPF"]']:
                try:
                    loc = ctx.locator(sel).first
                    if loc.is_visible(timeout=1000):
                        loc.fill(cpf_limpo)
                        ctx.locator('button:has-text("Pesquisar"), input[value*="Pesquisar"]').first.click()
                        time.sleep(2.5)
                        try:
                            ctx.locator('table tr').filter(has_text=cpf_limpo).first.click()
                        except Exception:
                            pass
                        time.sleep(1.5)
                        return
                except Exception:
                    continue
        raise RuntimeError("Frame lookup (nfe_lookup.php) não encontrado após seleção do tipo tomador.")

    print(f"  Lookup carregado: {lookup.url[:70]}")
    lookup.wait_for_load_state("domcontentloaded", timeout=8000)
    time.sleep(0.5)

    # Preenche CPF/CNPJ no frame lookup
    for sel in ['input[name*="cpf"]', 'input[id*="cpf"]',
                'input[placeholder*="CPF"]', 'input[type="text"]']:
        try:
            loc = lookup.locator(sel).first
            if loc.is_visible(timeout=2000):
                loc.fill(cpf_limpo)
                print(f"  CPF preenchido no lookup: {cpf_limpo}")
                break
        except Exception:
            continue

    # Clica Pesquisar — tenta múltiplos seletores
    clicou_pesquisar = False
    for sel in [
        'button:has-text("Pesquisar")', 'button:has-text("pesquisar")',
        'input[value*="Pesquisar"]', 'input[value*="pesquisar"]',
        'a:has-text("Pesquisar")', 'a:has-text("pesquisar")',
        '[onclick*="pesquis"]', '[onclick*="Pesquis"]',
        'button[type="submit"]', 'input[type="submit"]', 'input[type="image"]',
    ]:
        try:
            loc = lookup.locator(sel).first
            if loc.is_visible(timeout=1500):
                loc.click()
                clicou_pesquisar = True
                print(f"  Clicou Pesquisar via: {sel}")
                break
        except Exception:
            continue
    if not clicou_pesquisar:
        # Fallback: pressiona Enter no campo CPF
        print("  Botão Pesquisar não encontrado, pressionando Enter no campo CPF...")
        try:
            lookup.locator('input[type="text"], input[name*="cpf"]').first.press("Enter")
        except Exception:
            pass
    time.sleep(2.5)

    # Clica na linha do resultado
    try:
        lookup.locator('table tr').filter(has_text=cpf_limpo).first.click()
    except Exception:
        rows = lookup.locator('table tr').all()
        for i, row in enumerate(rows):
            if i == 0:
                continue  # pula cabeçalho
            if row.is_visible():
                row.click()
                break

    time.sleep(1.0)

    # Clica Ok para confirmar seleção do tomador (botão na parte inferior do lookup)
    for ok_sel in ['button:has-text("Ok")', 'button:has-text("OK")',
                   'input[value="Ok"]', 'input[value="OK"]', 'a:has-text("Ok")']:
        try:
            loc = lookup.locator(ok_sel).first
            if loc.is_visible(timeout=3000):
                loc.click()
                print("  Clicou Ok no lookup")
                break
        except Exception:
            continue

    time.sleep(1.5)


# ── wizard: Atividade (lupa) ──────────────────────────────────────────────────

def _selecionar_atividade(page, codigo: str = "412"):
    """Clica no botão lupa de Atividade (openFiltro), seleciona o código."""
    form = _frame_formulario(page)

    lupa = None
    for sel in [
        'button[onclick*="openFiltro"]',
        'button:has(.glyphicon-search)',
        'button.btn-primary:has(.glyphicon-search)',
        'button.btn-info:not(#btnTributos)',
    ]:
        try:
            loc = form.locator(sel).first
            if loc.is_visible(timeout=2000):
                lupa = loc
                break
        except Exception:
            continue

    if lupa is None:
        raise RuntimeError("Botão lupa de Atividade não encontrado.")

    # Tenta clique normal; se sobreposto por overlay usa JS click
    try:
        lupa.click(timeout=6000)
    except Exception:
        print("  Clique normal falhou, usando JS click na lupa de atividade...")
        form.evaluate("document.querySelector('button[onclick*=\"openFiltro\"]').click()")
    time.sleep(1.5)

    # Modal/popup de atividades — busca em todos os frames e páginas
    linha_ativ = None
    for ctx in _todos_frames(page):
        for sel_linha in [
            f'tr:has-text("{codigo}"):has-text("Odontologia")',
            f'tr:has-text("{codigo}")',
        ]:
            try:
                loc = ctx.locator(sel_linha).first
                if loc.is_visible(timeout=3000):
                    linha_ativ = loc
                    break
            except Exception:
                continue
        if linha_ativ:
            break

    if linha_ativ is None:
        raise RuntimeError(f"Atividade {codigo} não encontrada.")

    linha_ativ.click()
    time.sleep(0.5)

    # Ok é necessário — busca em TODOS os frames (modal pode estar em frame separado)
    ok_clicado = False
    for ctx in _todos_frames(page):
        for sel in ['button:has-text("Ok")', 'button:has-text("OK")',
                    'input[value="Ok"]', 'input[value="OK"]']:
            try:
                loc = ctx.locator(sel).first
                if loc.is_visible(timeout=2000):
                    loc.click()
                    ok_clicado = True
                    print(f"  Clicou Ok na atividade (frame: {ctx.url[:60]})")
                    break
            except Exception:
                continue
        if ok_clicado:
            break
    if not ok_clicado:
        print("  Ok não encontrado em nenhum frame — modal pode ter fechado ao clicar linha")
    time.sleep(1.5)


# ── popup: Reforma Tributária ──────────────────────────────────────────────────

def _aguardar_frame_ibs(page, frames_antes: set, timeout_s: int = 20):
    """
    Aguarda o frame do modal IBS/CBS aparecer após clique em btnTributos.

    Estratégia dupla:
    1. Qualquer frame com URL contendo keywords conhecidas
    2. Qualquer frame NOVO (não existia antes do clique) — cobre o caso blank/about:blank
       que o abrirIBSCBS cria antes de carregar Componentes.php
    """
    KEYWORDS = ['Componentes', 'reformaTributaria', 'ibs_cbs', 'componentes', 'tributo', 'Tributo']
    deadline = time.time() + timeout_s
    candidate = None
    while time.time() < deadline:
        for f in page.frames:
            if f.url and any(k in f.url for k in KEYWORDS):
                return f
            # Frame novo (não estava na lista antes do clique)
            if id(f) not in frames_antes:
                candidate = f  # guarda e continua esperando URL carregar
        if candidate:
            # Tenta aguardar a URL carregar (pode estar blank ainda)
            try:
                candidate.wait_for_load_state("domcontentloaded", timeout=5000)
            except Exception:
                pass
            url = candidate.url or ''
            print(f"  [DIAG] Frame novo detectado: {url!r}")
            if url and 'login' not in url and 'nfe.php#' not in url:
                return candidate
        time.sleep(0.4)
    # Diagnóstico: lista todos os frames disponíveis para ajudar a identificar a URL real
    print("  [DIAG] Frames disponíveis no timeout:")
    for f in page.frames:
        print(f"    frame url={f.url!r}")
    if candidate:
        print(f"  [DIAG] Usando frame candidato (blank/desconhecido): {candidate.url!r}")
        return candidate
    return None


def _reforma_tributaria(page, municipio: str = "Ipatinga"):
    """
    Clica button#btnTributos → aguarda iframe ibs_cbs_modal (Componentes.php)
    → seleciona município → salva.

    abrirIBSCBS (ibs_cbs.js) verifica input[name="codigo"] antes de criar o iframe;
    se vazio dispara alert() e retorna sem efeito. Por isso forçamos o valor primeiro.
    """
    print("  [reforma v3-ibs]")
    form = _frame_formulario(page)

    # Garante codigo preenchido — abrirIBSCBS aborta silenciosamente se vazio
    try:
        codigo_val = form.evaluate(
            "document.querySelector('input[name=\"codigo\"]')?.value || ''"
        )
        print(f"  codigo={codigo_val!r}")
        if not codigo_val:
            form.evaluate(
                "const el=document.querySelector('input[name=\"codigo\"]'); if(el){ el.value='412'; }"
            )
            print("  Forçou codigo=412")
    except Exception as e:
        print(f"  Aviso codigo: {e}")

    # Encontra botão
    found_loc = None
    for ctx in [form, page]:
        for sel in ['button#btnTributos', 'button:has-text("Reforma Tributária")']:
            try:
                loc = ctx.locator(sel).first
                if loc.is_visible(timeout=2000):
                    found_loc = loc
                    break
            except Exception:
                continue
        if found_loc:
            break
    if not found_loc:
        raise RuntimeError("Botão Reforma Tributária não encontrado.")

    # Descarta alerts (abrirIBSCBS usa alert() se codigo vazio)
    alert_msgs = []
    def _dismiss_dialog(d):
        alert_msgs.append(d.message)
        print(f"  [DIAG] Dialog capturado: {d.message!r}")
        d.dismiss()
    page.on("dialog", _dismiss_dialog)

    # Relê código após possível preenchimento forçado
    try:
        codigo_final = form.evaluate(
            "document.querySelector('input[name=\"codigo\"]')?.value || ''"
        )
        print(f"  codigo final antes do click={codigo_final!r}")
    except Exception:
        pass

    # Captura IDs de frames existentes antes do clique para detectar frames novos
    frames_antes = {id(f) for f in page.frames}

    # JS click é mais confiável em iframe — Playwright click dá timeout por coordenadas
    clicou = False
    for tentativa, metodo in enumerate(["js_btn", "js_jquery", "playwright"], 1):
        try:
            if metodo == "js_btn":
                form.evaluate("document.querySelector('button#btnTributos').click()")
            elif metodo == "js_jquery":
                form.evaluate(
                    "if(typeof $!=='undefined'){ $('button#btnTributos').trigger('click'); }"
                )
            else:
                found_loc.click(timeout=4000)
            clicou = True
            print(f"  Botão Reforma Tributária clicado ({metodo})")
            break
        except Exception as e:
            print(f"  Click {metodo} falhou: {e}")
    if not clicou:
        raise RuntimeError("Não foi possível clicar no botão Reforma Tributária.")

    # Aguarda iframe ibs_cbs_modal
    modal_frame = _aguardar_frame_ibs(page, frames_antes, timeout_s=20)
    if modal_frame is None:
        raise RuntimeError("iframe IBS/CBS (Componentes.php) não apareceu após clique.")
    print(f"  Modal IBS: {modal_frame.url[:90]}")
    try:
        modal_frame.wait_for_load_state("domcontentloaded", timeout=8000)
    except Exception:
        pass
    time.sleep(1.5)

    # ── Município: Select2 AJAX — abre dropdown, digita, seleciona ───────────
    # O select#clocprestacao tem aria-hidden=true: Select2 controla visualmente.
    # As opções só carregam via AJAX após abrir o dropdown.
    mun_ok = False

    # Passo 1: abre o dropdown Select2 via jQuery/Select2 API ou clique no container
    try:
        modal_frame.evaluate("""
            () => {
                if (window.$ && $('#clocprestacao').data('select2')) {
                    $('#clocprestacao').select2('open');
                } else {
                    // Fallback: clica no container visual do Select2
                    const cont = document.querySelector(
                        '.select2-container--clocprestacao .select2-selection, ' +
                        '[data-select2-id*="clocprestacao"] .select2-selection, ' +
                        '.select2-container:has(+ select#clocprestacao) .select2-selection'
                    );
                    if (cont) cont.click();
                    else {
                        // Último recurso: localiza container pelo id gerado pelo Select2
                        const span = document.querySelector('#select2-clocprestacao-container');
                        if (span) span.closest('.select2-container')?.querySelector('.select2-selection')?.click();
                    }
                }
            }
        """)
        time.sleep(1.0)
    except Exception as e:
        print(f"  Aviso ao abrir Select2: {e}")

    # Passo 2: digita no campo de busca do dropdown aberto
    # Usa type() em vez de fill() para disparar keydown/keyup que o Select2 AJAX precisa
    try:
        search = modal_frame.locator('.select2-search__field, .select2-search--dropdown input').first
        search.wait_for(state='visible', timeout=5000)
        search.click()
        search.type(municipio, delay=80)  # digita char a char, dispara keyup
        print(f"  Digitou '{municipio}' no Select2 search")
        time.sleep(2.5)  # aguarda AJAX carregar resultados
    except Exception as e:
        print(f"  Aviso busca Select2: {e}")

    # Passo 3: clica na opção correspondente
    for sel in [
        f'.select2-results__option:has-text("{municipio}")',
        f'.select2-result-label:has-text("{municipio}")',
        f'li[role="option"]:has-text("{municipio}")',
        f'.select2-results li:has-text("{municipio}")',
    ]:
        try:
            loc = modal_frame.locator(sel).first
            if loc.is_visible(timeout=3000):
                loc.click()
                mun_ok = True
                print(f"  Município selecionado: {municipio}")
                break
        except Exception:
            continue

    # Passo 4 (fallback): se nenhuma opção apareceu, tenta via JS direto no Select2
    if not mun_ok:
        try:
            result = modal_frame.evaluate(f"""
                async (mun) => {{
                    // Tenta pegar opções que já carregaram no select oculto
                    const sel = document.querySelector('select#clocprestacao');
                    if (!sel) return 'no_select';
                    const opts = [...sel.options];
                    if (opts.length > 1) {{
                        const m = opts.find(o => o.text.toLowerCase().includes(mun.toLowerCase()));
                        if (m) {{
                            sel.value = m.value;
                            if (window.$) $('#clocprestacao').trigger('change');
                            else sel.dispatchEvent(new Event('change', {{bubbles:true}}));
                            return 'OK_JS:' + m.text;
                        }}
                        return 'NOT_FOUND:' + opts.slice(0,3).map(o=>o.text).join('|');
                    }}
                    return 'EMPTY_SELECT:nenhuma_opcao_carregada';
                }}
            """, municipio)
            print(f"  Município JS fallback: {result}")
            mun_ok = result.startswith('OK_JS:')
        except Exception as e:
            print(f"  Fallback JS erro: {e}")

    if not mun_ok:
        raise RuntimeError(f"Opção '{municipio}' não encontrada no modal IBS/CBS.")

    time.sleep(0.5)

    # ── Retenção PIS/COFINS: seleciona primeiro valor válido ──────────────────
    try:
        modal_frame.evaluate("""
            () => {
                const sel = document.querySelector('select[name="reforma[tpretpiscofins]"]');
                if (!sel) return;
                const opt = [...sel.options].find(o => o.value !== '' && o.value !== 'Selecione');
                if (opt) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', {bubbles: true}));
                }
            }
        """)
    except Exception:
        pass

    time.sleep(0.3)

    # ── Salvar ────────────────────────────────────────────────────────────────
    salvo = False
    for sel in ['button:has-text("Salvar")', 'button:has-text("Confirmar")',
                'input[value*="Salvar"]', 'button[type="submit"]']:
        try:
            loc = modal_frame.locator(sel).last
            if loc.is_visible(timeout=2000):
                try:
                    loc.click(timeout=5000)
                except Exception:
                    modal_frame.evaluate(
                        "[...document.querySelectorAll('button')].filter(b=>b.textContent.includes('Salvar')||b.textContent.includes('Confirmar')).pop()?.click()"
                    )
                salvo = True
                print("  Reforma Tributária salva")
                break
        except Exception:
            continue
    if not salvo:
        print("  Aviso: botão Salvar não encontrado no modal IBS/CBS")

    # ── Aguarda modal fechar ──────────────────────────────────────────────────
    deadline = time.time() + 10
    while time.time() < deadline:
        if not any(f.url and 'Componentes' in f.url for f in page.frames):
            print("  Modal IBS fechado")
            break
        time.sleep(0.5)
    time.sleep(1.0)


# ── formulário principal ───────────────────────────────────────────────────────

def _preencher_valor(form, nota: dict):
    """Preenche o campo Valor Total — chamado antes e depois da Reforma Tributária."""
    if form is None:
        print("  [ERRO] _preencher_valor: form é None")
        return False

    valor_str = f"{float(nota['valor']):.2f}".replace(".", ",")
    print(f"  Preenchendo valor: {valor_str} (frame: {form.url[:60]})")

    # Tentativa 1: JS direto — campo confirmado name="valor" id="valor"
    # Playwright is_visible() falha neste campo; JS bypassa essa verificação
    try:
        result = form.evaluate(f"""
            (val) => {{
                const inp = document.getElementById('valor')
                         || document.querySelector('input[name="valor"]');
                if (!inp) return 'NOT_FOUND';
                inp.focus();
                inp.value = val;
                ['input', 'change', 'blur', 'keyup'].forEach(ev =>
                    inp.dispatchEvent(new Event(ev, {{bubbles: true}})));
                // garante base = valor se estiver zerado
                const base = document.querySelector('input[name="base"]');
                if (base && (!base.value || base.value === '0' || base.value === '0,00')) {{
                    base.value = val;
                    base.dispatchEvent(new Event('change', {{bubbles: true}}));
                }}
                return 'OK:' + inp.name + '=' + inp.value + ' base=' + (base ? base.value : 'n/a');
            }}
        """, valor_str)
        print(f"  Valor JS: {result}")
        if result and result.startswith('OK:'):
            return True
    except Exception as e:
        print(f"  Valor JS erro: {e}")

    # Tentativa 2: Playwright locator (fallback)
    for sel in ['input#valor', 'input[name="valor"]', 'input[name="valor_servicos"]']:
        try:
            loc = form.locator(sel).first
            loc.fill(valor_str, force=True)
            loc.dispatch_event('change')
            print(f"  Valor preenchido via Playwright force: {sel}")
            return True
        except Exception:
            continue

    # Diagnóstico: lista todos os inputs visíveis
    try:
        campos = form.evaluate("""
            () => [...document.querySelectorAll('input,textarea')]
                .filter(el => el.offsetParent !== null)
                .map(el => el.name + '|' + el.id + '|' + el.placeholder + '|' + el.value)
                .join('\\n')
        """)
        print("  [DIAG VALOR] Inputs visíveis:")
        for linha in (campos or '').split('\n'):
            print(f"    {linha}")
    except Exception:
        pass
    return False


def _preencher_form(page, nota: dict):
    _pesquisar_tomador(page, nota.get("tipo_tomador", "CPF"), nota["cpf_tomador"])

    # Força cnpj e razao — callback do lookup não dispara em modo headless
    cpf_limpo = nota["cpf_tomador"].replace(".", "").replace("-", "").replace("/", "")
    form_tmp = _frame_formulario(page)
    form_tmp.evaluate("""
        (d) => {
            const set = (n, v) => {
                const el = document.querySelector('input[name="'+n+'"]');
                if (el) { el.value = v; el.dispatchEvent(new Event('change', {bubbles:true})); }
            };
            set('cnpj', d.cpf);
            set('razao', d.nome);
        }
    """, {"cpf": cpf_limpo, "nome": nota.get("nome_tomador", "")})
    print(f"  Forçou cnpj={cpf_limpo!r} razao={nota.get('nome_tomador','')!r}")

    _selecionar_atividade(page, "412")

    # Verifica se callbacks do modal de atividade popularam aliquota
    time.sleep(0.5)
    form = _frame_formulario(page)
    aliq = form.evaluate(
        "() => document.querySelector('input[name=\"aliquota\"]')?.value || ''"
    )
    if not aliq or aliq in ("0", "0.00", "0,00"):
        form.evaluate("""
            () => {
                const s = (n, v) => {
                    const el = document.querySelector('input[name="'+n+'"]');
                    if (el) { el.value = v; el.dispatchEvent(new Event('change', {bubbles:true})); }
                };
                s('aliquota', '3.00');
            }
        """)
        print("  Alíquota forçada para 3.00 (callback não disparou)")

    form = _frame_formulario(page)

    # Preenche valor ANTES da Reforma Tributária (o modal pode recalcular)
    if not _preencher_valor(form, nota):
        print("  Aviso: valor não preenchido antes da Reforma Tributária")

    _reforma_tributaria(page)

    # Volta ao form após modal e repreenche valor (garantia)
    form = _frame_formulario(page)
    if not _preencher_valor(form, nota):
        raise RuntimeError("Campo 'Valor Total da Nota' não encontrado.")

    # Situação de Tributação — força via JS (select_option falha quando options não carregam)
    try:
        sit_val = form.evaluate("""
            () => {
                const sel = document.querySelector(
                    'select[name*="situacao"], select[id*="situacao"]'
                );
                if (!sel) return 'NOT_FOUND';
                // seleciona a primeira opção válida (não vazia, não 'Selecione')
                const opt = [...sel.options].find(o =>
                    o.value && o.value !== '0' && !o.text.includes('Selecione')
                );
                if (opt) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', {bubbles: true}));
                    return 'OK:' + opt.value;
                }
                return 'NO_VALID_OPTION';
            }
        """)
        print(f"  Situação tributação: {sit_val}")
    except Exception as e:
        print(f"  Aviso situacao: {e}")

    # Descrição do Serviço Prestado
    descricao = nota.get("descricao") or "Servicos odontologicos"
    if nota.get("nome_paciente"):
        descricao += f" - Paciente: {nota['nome_paciente']}"
        if nota.get("cpf_paciente"):
            descricao += f", CPF: {nota['cpf_paciente']}"
    for sel in ['textarea[name*="descricao"]', 'textarea[id*="descricao"]', 'textarea']:
        try:
            loc = form.locator(sel).first
            if loc.is_visible(timeout=3000):
                loc.fill(descricao[:500])
                break
        except Exception:
            continue


# ── emissão e download do PDF ──────────────────────────────────────────────────

def _submeter_via_http(page, form_frame, pasta: str, nota: dict) -> dict:
    """
    Extrai todos os campos do formulário preenchido pelo Playwright e submete
    via requests.post() — mais confiável que clicar botão em modo headless.
    """
    import requests as _req
    import re
    from urllib.parse import urlparse

    # Deriva base_url do frame atual (evita hardcode errado de domínio)
    frame_url = form_frame.url or page.url
    _p = urlparse(frame_url)
    base_url = f"{_p.scheme}://{_p.netloc}"
    print(f"  base_url: {base_url}")

    # Extrai valores de todos os campos + action do form
    extracted = form_frame.evaluate("""
        () => {
            const data = {};
            const form = document.getElementById('form1') || document.querySelector('form');
            if (!form) return { fields: data, action: '' };
            for (const el of form.elements) {
                if (!el.name) continue;
                if (el.type === 'checkbox') {
                    // não envia checkboxes desmarcados (comportamento real do formulário HTML)
                    if (el.checked) data[el.name] = el.value || '1';
                } else if (el.type === 'radio') {
                    if (el.checked) data[el.name] = el.value;
                } else {
                    data[el.name] = el.value;
                }
            }
            return { fields: data, action: form.action || '' };
        }
    """)
    form_data = extracted.get('fields', {})
    form_action = extracted.get('action', '')
    print(f"  Campos extraídos do form: {len(form_data)}")

    # DIAGNÓSTICO: mostra campos relevantes para identificar campos vazios
    campos_criticos = ['cnpj', 'razao', 'codigo', 'aliquota', 'aliquotaSimples',
                       'valor', 'base', 'situacao', 'dtEmissao', 'dtEmissaoPrest',
                       'descricaoNF', 'localServico', 'exterior']
    print("  [DIAG] Campos críticos no POST:")
    for k in campos_criticos:
        print(f"    {k}={form_data.get(k, '(ausente)')!r}")
    # Campos com valor preenchido (exclui vazios e ocultos sem interesse)
    print("  [DIAG] Todos com valor:")
    for k, v in sorted(form_data.items()):
        if v:
            print(f"    {k}={v!r}")

    # Monta URL de POST: tenta usar action do form; fallback para path fixo
    if form_action and form_action.startswith('http'):
        post_url = form_action
    elif form_action:
        post_url = base_url + '/' + form_action.lstrip('/')
    else:
        post_url = f'{base_url}/ISS/contribuinte/nfe/nfe_exec.php'
    print(f"  POST → {post_url}")

    # Log campos de valor antes do POST para diagnóstico
    valor_campos = {k: v for k, v in form_data.items()
                    if any(x in k.lower() for x in ['valor', 'total', 'liquido', 'servico', 'serviço'])}
    print(f"  Campos valor no POST: {valor_campos}")

    # Extrai cookies da sessão autenticada do Playwright
    cookies = {c['name']: c['value'] for c in page.context.cookies()}

    session = _req.Session()
    session.cookies.update(cookies)

    r = session.post(
        post_url,
        data=form_data,
        headers={
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': f'{base_url}/ISS/contribuinte/nfe/nfe.php',
            'Origin': base_url,
        },
        timeout=30,
        allow_redirects=True,
    )
    r.raise_for_status()

    html = r.text
    print(f"  HTTP {r.status_code} — resp {len(html)} chars")
    print(f"  Trecho: {html[:500]}")

    # Detecta mensagem de erro no HTML retornado (campo hidden msg)
    msg_erro = re.search(r'name=["\']msg["\'][^>]*value=["\']([^"\']+)["\']', html)
    if not msg_erro:
        msg_erro = re.search(r'value=["\']([^"\']+)["\'][^>]*name=["\']msg["\']', html)
    if msg_erro and msg_erro.group(1).strip():
        raise RuntimeError(f"Prefeitura rejeitou: {msg_erro.group(1)}")

    # Extrai número da nota da resposta HTML
    num_nota = ""
    for pattern in [
        r'[Nn][úu]mero[^\d]*(\d+)',
        r'NFS[- ]?e[^\d]*(\d+)',
        r'Nota[^\d]*(\d{4,})',
        r'num_nota[^\d]*(\d+)',
        r'RPS[^\d]*(\d+)',
        r'>(\d{4,})<',
    ]:
        m = re.search(pattern, html)
        if m:
            num_nota = m.group(1)
            print(f"  Número da nota extraído: {num_nota} (padrão: {pattern})")
            break

    # Tenta baixar PDF via HTTP — procura links diretos, redirects JS e URLs de impressão
    caminho = ""
    pdf_urls: list[str] = []
    pdf_urls += re.findall(r'href=["\']([^"\']*\.pdf[^"\']*)["\']', html, re.IGNORECASE)
    pdf_urls += re.findall(r'href=["\']([^"\']*imprimir[^"\']*)["\']', html, re.IGNORECASE)
    pdf_urls += re.findall(r'href=["\']([^"\']*download[^"\']*)["\']', html, re.IGNORECASE)
    # Redirects JavaScript (location.href / window.location)
    js_locs = re.findall(
        r'''(?:window\.location|location\.href)\s*=\s*['"]([^'"]+)['"]''', html
    )
    pdf_urls += [u for u in js_locs if any(k in u for k in ('imprimir', 'pdf', 'nota', 'nfse'))]

    for url in pdf_urls[:3]:
        try:
            full_url = url if url.startswith('http') else base_url + '/' + url.lstrip('/')
            pdf_r = session.get(full_url, timeout=20)
            ct = pdf_r.headers.get('content-type', '')
            if 'pdf' in ct or len(pdf_r.content) > 5000:
                from file_manager import salvar_pdf_bytes
                caminho = salvar_pdf_bytes(
                    pdf_r.content, pasta, nota["competencia"], num_nota, nota["nome_tomador"]
                )
                print(f"  PDF salvo: {caminho}")
                break
        except Exception as e:
            print(f"  PDF não baixado ({url}): {e}")

    return {"num_nota": num_nota, "caminho_pdf": caminho}


def _emitir_e_baixar(page, nota: dict, pasta: str) -> dict:
    _preencher_form(page, nota)
    form = _frame_formulario(page)
    return _submeter_via_http(page, form, pasta, nota)


# ── ponto de entrada público ───────────────────────────────────────────────────

def processar(entidade: str, notas: list) -> list:
    """Faz login uma vez, emite todas as notas, retorna lista de resultados."""
    cfg = ENTIDADES[entidade]
    resultados = []

    with sync_playwright() as p:
        headless = not sys.stdin.isatty()  # headless na nuvem, visível no terminal local
        browser = p.chromium.launch(
            headless=headless,
            slow_mo=100 if not headless else 0,
            args=['--disable-popup-blocking'],  # window.open() bloqueado por isTrusted:false sem isso
        )
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
