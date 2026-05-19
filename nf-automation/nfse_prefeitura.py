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
    """Aguarda e retorna o frame do formulário NFSe (iframe#detail com nfe.php)."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for f in page.frames:
            if f.url and any(k in f.url for k in ['nfe', 'nfse', 'emissao']):
                return f
        time.sleep(0.5)
    # fallback: qualquer frame não-principal com URL
    candidates = [f for f in page.frames
                  if f != page.main_frame and f.url and f.url not in ('', 'about:blank', '_')]
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

    # Ok é necessário — modal abre sobre a página, busca em page e form
    ok_clicado = False
    for ctx in [page, form]:
        for sel in ['button:has-text("Ok")', 'button:has-text("OK")',
                    'input[value="Ok"]', 'input[value="OK"]']:
            try:
                loc = ctx.locator(sel).first
                if loc.is_visible(timeout=2000):
                    loc.click()
                    ok_clicado = True
                    break
            except Exception:
                continue
        if ok_clicado:
            break
    if ok_clicado:
        print("  Clicou Ok na atividade")
    else:
        print("  Ok não encontrado (modal já fechou ao clicar linha)")
    time.sleep(1.5)


# ── popup: Reforma Tributária ──────────────────────────────────────────────────

def _aguardar_frame_ibs(page, timeout_s: int = 15):
    """Aguarda iframe id=ibs_cbs_modal (injetado por abrirIBSCBS em ibs_cbs.js)."""
    KEYWORDS = ['Componentes', 'reformaTributaria', 'ibs_cbs', 'componentes', 'tributo', 'Tributo', 'modal']
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for f in page.frames:
            if f.url and any(k in f.url for k in KEYWORDS):
                return f
        time.sleep(0.4)
    # Diagnóstico: lista todos os frames disponíveis para ajudar a identificar a URL real
    print("  [DIAG] Frames disponíveis no timeout:")
    for f in page.frames:
        print(f"    frame url={f.url!r}")
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
    modal_frame = _aguardar_frame_ibs(page, timeout_s=12)
    if modal_frame is None:
        raise RuntimeError("iframe IBS/CBS (Componentes.php) não apareceu após clique.")
    print(f"  Modal IBS: {modal_frame.url[:90]}")
    try:
        modal_frame.wait_for_load_state("domcontentloaded", timeout=8000)
    except Exception:
        pass
    time.sleep(1.5)

    # Abre dropdown do município
    modal_frame.evaluate("""
        () => {
            const s2 = document.querySelector('.select2-selection');
            if (s2) { s2.click(); return; }
            for (const el of document.querySelectorAll('*')) {
                if (!el.children.length &&
                    (el.textContent||'').trim().startsWith('Digite para pesquisar')) {
                    el.click(); return;
                }
            }
        }
    """)
    time.sleep(0.8)

    # Digita município
    digitou = False
    for sel in [
        '.select2-search__field', '.select2-input', '.select2-search input',
        'input[placeholder*="nimo"]', 'input[placeholder*="2 car"]',
        'input[placeholder*="aract"]', 'input[placeholder*="igite"]',
        'input[placeholder*="esquisar"]', 'input[placeholder*="buscar"]',
        'input[type="search"]',
    ]:
        try:
            loc = modal_frame.locator(sel).first
            if loc.is_visible(timeout=1000):
                loc.fill(municipio)
                time.sleep(1.5)
                digitou = True
                print(f"  Digitou município: {municipio!r} via {sel}")
                break
        except Exception:
            continue

    if not digitou:
        try:
            result = modal_frame.evaluate(f"""
                (mun) => {{
                    const inputs = [...document.querySelectorAll(
                        'input[type="text"], input[type="search"], input:not([type])'
                    )].filter(el => el.offsetParent !== null && !el.disabled);
                    if (!inputs.length) return null;
                    const inp = inputs[inputs.length - 1];
                    inp.focus(); inp.value = mun;
                    ['input','change','keydown','keyup'].forEach(ev =>
                        inp.dispatchEvent(new Event(ev, {{bubbles:true}})));
                    return inp.name + '|' + inp.placeholder;
                }}
            """, municipio)
            if result:
                print(f"  Brute-force: {result}")
                digitou = True
                time.sleep(1.5)
        except Exception:
            pass

    if not digitou:
        raise RuntimeError("Campo de busca do Município (Reforma Tributária) não encontrado.")

    # Seleciona opção Ipatinga
    clicou = False
    for sel in [
        f'li:has-text("{municipio}")',
        '.select2-results__option:has-text("Ipatinga")',
        'li:has-text("Ipatinga - MG")', 'li:has-text("Ipatinga")',
        '[class*="option"]:has-text("Ipatinga")',
        '.select2-result:has-text("Ipatinga")',
    ]:
        try:
            loc = modal_frame.locator(sel).first
            if loc.is_visible(timeout=2000):
                loc.click()
                time.sleep(0.5)
                clicou = True
                print(f"  Selecionou {municipio}")
                break
        except Exception:
            continue
    if not clicou:
        raise RuntimeError(f"Opção '{municipio}' não encontrada no modal IBS/CBS.")

    # Salvar
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
                print("  Reforma Tributária salva")
                break
        except Exception:
            continue

    # Aguarda modal fechar
    deadline = time.time() + 8
    while time.time() < deadline:
        if not any(f.url and 'Componentes' in f.url for f in page.frames):
            print("  Modal IBS fechado")
            break
        time.sleep(0.5)
    time.sleep(1.0)


# ── formulário principal ───────────────────────────────────────────────────────

def _preencher_form(page, nota: dict):
    _pesquisar_tomador(page, nota.get("tipo_tomador", "CPF"), nota["cpf_tomador"])
    _selecionar_atividade(page, "412")
    _reforma_tributaria(page)

    form = _frame_formulario(page)

    # Valor Total da Nota
    valor_str = f"{float(nota['valor']):.2f}".replace(".", ",")
    preencheu_valor = False
    for sel in ['input[name*="valor_total"]', 'input[id*="valor_total"]',
                'input[name*="valorTotal"]', 'input[name*="valor"]',
                'input[placeholder*="alor"]']:
        try:
            loc = form.locator(sel).first
            if loc.is_visible(timeout=3000):
                loc.fill(valor_str)
                preencheu_valor = True
                break
        except Exception:
            continue
    if not preencheu_valor:
        raise RuntimeError("Campo 'Valor Total da Nota' não encontrado.")

    # Situação de Tributação — primeira opção não-vazia
    try:
        sit = form.locator(
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
                    data[el.name] = el.checked ? (el.value || '1') : '';
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

    # Monta URL de POST: tenta usar action do form; fallback para path fixo
    if form_action and form_action.startswith('http'):
        post_url = form_action
    elif form_action:
        post_url = base_url + '/' + form_action.lstrip('/')
    else:
        post_url = f'{base_url}/ISS/contribuinte/nfe/nfe_exec.php'
    print(f"  POST → {post_url}")

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
