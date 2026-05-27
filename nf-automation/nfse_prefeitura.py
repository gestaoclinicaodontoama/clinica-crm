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
    """Retorna todas as páginas do contexto (inclui popups window.open) + seus frames."""
    try:
        all_pages = list(page.context.pages)
    except Exception:
        all_pages = [page]
    result = []
    for p in all_pages:
        result.append(p)
        try:
            result.extend(p.frames)
        except Exception:
            pass
    return result


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

def _aguardar_frame_lookup(page, timeout_s: int = 12):
    """
    Aguarda o frame de busca de contribuinte estar em nfe_filtro_contribuinte.php.

    nfe_lookup.php é um placeholder vazio que o SIGISS usa como src inicial do
    iframe detail — ele NÃO é o frame de busca. O JS de nfe.php muda o src para
    nfe_filtro_contribuinte.php quando o tipo de tomador é selecionado.
    Por isso ignoramos nfe_lookup.php e só retornamos quando o frame correto carrega.
    """
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for f in page.frames:
            if f.name == 'nfe_filtro_contribuinte':
                return f
            if f.url and 'filtro_contribuinte' in f.url:
                return f
        time.sleep(0.4)
    return None


def _parsear_tomador_html(html: str, cpf_limpo: str) -> dict:
    """
    Extrai id_tomador/ccm/cnpj/razao do HTML de nfe_filtro_contribuinte.php.

    Formato no HTML bruto (entities HTML):
      <tr id="id&lt;|&gt;ccm&lt;|&gt;cnpj&lt;|&gt;nome..." onclick="lineSelected(this);">
    O JS decodifica para <|> mas o HTML usa &lt;|&gt; — o regex precisa cobrir ambos.
    """
    import re as _re

    # Separador pode ser &lt;|&gt; (HTML raw) ou <|> (já decodificado)
    SEP = r'(?:&lt;\|&gt;|<\|>)'

    for scope_filter in [cpf_limpo, None]:
        haystack = html
        if scope_filter:
            linhas = [l for l in html.splitlines() if scope_filter in l or
                      cpf_limpo.replace(' ', '') in l]
            if linhas:
                haystack = '\n'.join(linhas)
            else:
                continue

        # ── Padrão principal: <tr id="id<|>ccm<|>cnpj<|>nome" ──
        m = _re.search(
            rf'<tr[^>]*\bid="(\d+){SEP}(-?\d+){SEP}([^"&<\|]*){SEP}([^"&<\|]*)',
            haystack
        )
        if m:
            result = {
                'id_tomador': m.group(1),
                'ccm': m.group(2),
                'cnpj': m.group(3),
                'razao': m.group(4).strip(),
                '_id_string': f"{m.group(1)}<|>{m.group(2)}<|>{m.group(3)}<|>{m.group(4).strip()}",
            }
            print(f"  Parse OK: id={result['id_tomador']} ccm={result['ccm']} razao={result['razao']!r}")
            return result

    return {}


def _buscar_tomador_via_http(page, cpf_limpo: str, form_frame=None, local: str = 'F') -> dict:
    """
    Extrai id_tomador/ccm do SIGISS. Estratégias em ordem de confiabilidade:

    S0: Submete form de busca dentro do iframe#detail via JS (sessão browser, sem HTTP externo).
    S1: Lê frame nfe_filtro_contribuinte.php já carregado pelo Playwright.
    S2: HTTP POST com campos reais extraídos do iframe#detail (URL com ?local= obrigatório).
    S3: HTTP POST com campos mínimos (último recurso).
    """
    import requests as _req

    # ── S0: Submete form dentro do iframe#detail via JS ───────────────────────
    # nfe.php tem iframe#detail contendo nfe_filtro_contribuinte.php (mesmo domínio).
    # Preenchemos o campo cnpj e submetemos o form diretamente — sem roundtrip HTTP separado.
    if form_frame:
        try:
            sub_result = form_frame.evaluate("""
                (cpf) => {
                    const detail = document.getElementById('detail');
                    if (!detail) return 'no_detail';
                    const idoc = detail.contentDocument
                               || (detail.contentWindow && detail.contentWindow.document);
                    if (!idoc) return 'no_idoc';
                    const form = idoc.getElementById('busca');
                    if (!form) return 'no_busca';
                    const inp = form.querySelector('[name="cnpj"]');
                    if (!inp) return 'no_cnpj_input';
                    inp.value = cpf;
                    const acao = form.querySelector('[name="acao"]');
                    if (acao) acao.value = '1';
                    form.submit();
                    return 'submitted';
                }
            """, cpf_limpo)
            print(f"  S0 iframe submit: {sub_result}")
            if sub_result == 'submitted':
                time.sleep(4.0)  # aguarda navegação do iframe
                html_iframe = form_frame.evaluate("""
                    () => {
                        const detail = document.getElementById('detail');
                        if (!detail) return '';
                        const idoc = detail.contentDocument
                                   || (detail.contentWindow && detail.contentWindow.document);
                        return idoc ? idoc.documentElement.outerHTML : '';
                    }
                """)
                if html_iframe:
                    print(f"  S0 iframe HTML: {len(html_iframe)} chars")
                    result = _parsear_tomador_html(html_iframe, cpf_limpo)
                    if result:
                        return result
                    print(f"  [DIAG S0] {html_iframe[:1500]}")
        except Exception as e:
            print(f"  S0 erro: {e}")

    # ── S1: frame já carregado pelo Playwright ───────────────────────────────
    for f in page.frames:
        if 'nfe_filtro_contribuinte' in f.url:
            try:
                html_frame = f.content()
                print(f"  S1 frame: {len(html_frame)} chars ({f.url[:70]})")
                result = _parsear_tomador_html(html_frame, cpf_limpo)
                if result:
                    return result
                print(f"  [DIAG S1] {html_frame[:1500]}")
            except Exception as e:
                print(f"  S1 erro: {e}")

    base = 'https://ipatinga.meumunicipio.online'
    cookies = {c['name']: c['value'] for c in page.context.cookies()}
    headers_post = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': f'{base}/ISS/contribuinte/nfe/nfe_filtro_contribuinte.php?local={local}',
    }

    # ── S2: HTTP POST com campos extraídos do iframe#detail ───────────────────
    # URL confirmada via Playwright MCP: ?local= no query string é obrigatório.
    # cnpjPrest/ccmPrest identificam o prestador — sem eles o SIGISS pode rejeitar.
    if form_frame:
        try:
            dom_info = form_frame.evaluate("""
                (cpf) => {
                    const detail = document.getElementById('detail');
                    if (!detail) return null;
                    const idoc = detail.contentDocument
                               || (detail.contentWindow && detail.contentWindow.document);
                    if (!idoc) return null;
                    const form = idoc.getElementById('busca');
                    if (!form) return null;
                    const data = {};
                    for (const el of form.elements) {
                        if (el.name) data[el.name] = el.value || '';
                    }
                    data.cnpj = cpf;
                    data.nome = '';
                    data.acao = '1';
                    return {action: form.action, data: data};
                }
            """, cpf_limpo)
            if dom_info and dom_info.get('data'):
                post_data = dom_info['data']
                action = dom_info.get('action', '')
                local_val = post_data.get('local', local)
                if action and action.startswith('http'):
                    url_s2 = action
                elif action:
                    url_s2 = base.rstrip('/') + '/' + action.lstrip('/')
                else:
                    url_s2 = f'{base}/ISS/contribuinte/nfe/nfe_filtro_contribuinte.php'
                if '?local=' not in url_s2:
                    sep = '&' if '?' in url_s2 else '?'
                    url_s2 = f'{url_s2}{sep}local={local_val}'
                print(f"  S2 POST -> {url_s2}")
                print(f"  S2 cnpjPrest={post_data.get('cnpjPrest','?')!r} ccmPrest={post_data.get('ccmPrest','?')!r}")
                r = _req.post(url_s2, data=post_data, cookies=cookies,
                              headers=headers_post, timeout=15)
                html = r.text
                print(f"  S2 resp: {len(html)} chars status={r.status_code}")
                result = _parsear_tomador_html(html, cpf_limpo)
                if result:
                    return result
                print(f"  [DIAG S2] {html[:1500]}")
            else:
                print(f"  S2 iframe inacessível: {dom_info}")
        except Exception as e:
            print(f"  S2 erro: {e}")

    # ── S3: HTTP POST com campos mínimos ──────────────────────────────────────
    url_s3 = f'{base}/ISS/contribuinte/nfe/nfe_filtro_contribuinte.php?local={local}'
    cnpj_prest = ''
    ccm_prest = ''
    if form_frame:
        try:
            prest = form_frame.evaluate("""
                () => ({
                    cnpjPrest: document.querySelector('[name="cnpjPrest"]')?.value || '',
                    ccmPrest:  document.querySelector('[name="ccmPrest"]')?.value  || '',
                })
            """)
            cnpj_prest = prest.get('cnpjPrest', '')
            ccm_prest = prest.get('ccmPrest', '')
        except Exception:
            pass
    post_data_s3 = {
        'cnpj': cpf_limpo, 'nome': '', 'ccm': '', 'acao': '1', 'local': local,
        'cnpjPrest': cnpj_prest, 'ccmPrest': ccm_prest,
        'ccmTom': '', 'cnpjTom': '', 'razaoEle': '', 'cnpjEle': '',
    }
    print(f"  S3 POST -> {url_s3} cnpjPrest={cnpj_prest!r}")
    try:
        r = _req.post(url_s3, data=post_data_s3, cookies=cookies,
                      headers=headers_post, timeout=15)
        html = r.text
        print(f"  S3 resp: {len(html)} chars status={r.status_code}")
        result = _parsear_tomador_html(html, cpf_limpo)
        if result:
            return result
        print(f"  [DIAG S3] {html[:1500]}")
    except Exception as e:
        print(f"  S3 erro: {e}")

    print(f"  AVISO: tomador não encontrado para CPF {cpf_limpo} (todas as estratégias falharam)")
    return {}


def _pesquisar_tomador(page, tipo_tomador: str, cpf: str):
    """
    Seleciona Tipo de Tomador no form nfe.php, depois busca id_tomador/ccm
    via HTTP POST direto para nfe_filtro_contribuinte.php (sem depender de
    iframe Playwright — o iframe nunca navega no tempo esperado em headless).
    Injeta os campos no form via contribResult() ou JS direto.
    """
    form = _frame_formulario(page)
    cpf_limpo = cpf.replace(".", "").replace("-", "").replace("/", "")

    # Labels reais do SIGISS Ipatinga
    labels = ["Pessoa Física", "Pessoa Fisica"] if tipo_tomador == "CPF" else [
        "Jurídica do Município", "Juridica do Municipio",
        "Jurídica de Fora", "Juridica de Fora",
    ]

    tipo_sel = form.locator('select[name="local"], select#local').first
    tipo_sel.wait_for(state="visible", timeout=6000)

    # Reset para vazio — garante que onchange dispara mesmo se já selecionado
    try:
        form.evaluate(
            "() => { const s=document.querySelector('select[name=\"local\"],select#local'); if(s) s.value=''; }"
        )
        time.sleep(0.3)
    except Exception:
        pass

    selecionou = False
    for lbl in labels:
        try:
            tipo_sel.select_option(label=lbl)
            print(f"  Tipo tomador selecionado: {lbl}")
            selecionou = True
            break
        except Exception:
            continue

    if not selecionou:
        raise RuntimeError("Não foi possível selecionar tipo de tomador no select#local.")

    # Aguarda JS do SIGISS processar onchange (muda iframe src internamente)
    time.sleep(2.0)

    # Lê valor real do select — usado como parâmetro ?local= no POST
    local_val = 'F'
    try:
        local_val = form.evaluate(
            "() => document.querySelector('select[name=\"local\"],select#local')?.value || 'F'"
        ) or 'F'
        print(f"  local value: {local_val!r}")
    except Exception:
        pass

    tomador = _buscar_tomador_via_http(page, cpf_limpo, form_frame=form, local=local_val)

    if not tomador:
        raise RuntimeError(
            f"CPF {cpf} ({tipo_tomador}) — tomador não encontrado no SIGISS. "
            "Verifique cadastro na Prefeitura de Ipatinga."
        )

    print(f"  Tomador OK: id={tomador['id_tomador']} ccm={tomador['ccm']} "
          f"nome={tomador.get('razao','?')}")

    # ── Injeta campos no form nfe.php ─────────────────────────────────────────
    form2 = _frame_formulario(page)
    id_string = tomador.get('_id_string')
    injetou = False

    # Tenta contribResult() — função nativa nfe.php que preenche tudo de uma vez
    if id_string:
        try:
            cr = form2.evaluate("""
                (s) => {
                    if (typeof contribResult === 'function') {
                        contribResult(s);
                        return 'OK';
                    }
                    return 'NOT_FOUND';
                }
            """, id_string)
            print(f"  contribResult: {cr}")
            injetou = (cr == 'OK')
        except Exception as e:
            print(f"  contribResult erro: {e}")

    if not injetou:
        # Fallback: injeta os quatro campos críticos individualmente
        inject = {k: v for k, v in tomador.items() if v and not k.startswith('_')}
        inj_result = form2.evaluate("""
            (d) => {
                const changed = [];
                const set = (n, v) => {
                    const el = document.getElementById(n)
                            || document.querySelector('[name="' + n + '"]');
                    if (el && v) {
                        el.value = v;
                        ['input','change'].forEach(
                            ev => el.dispatchEvent(new Event(ev, {bubbles:true}))
                        );
                        changed.push(n + '=' + v);
                    }
                };
                set('id_tomador', d.id_tomador);
                set('ccm',        d.ccm);
                set('cnpj',       d.cnpj);
                set('razao',      d.razao);
                return changed.join(', ');
            }
        """, inject)
        print(f"  Injeção direta: {inj_result}")

    # Diagnóstico final
    try:
        diag = form2.evaluate("""
            () => {
                const g = n => document.querySelector('#'+n)?.value
                             || document.querySelector('[name="'+n+'"]')?.value || '';
                return {id_tomador: g('id_tomador'), ccm: g('ccm'),
                        cnpj: g('cnpj'), razao: g('razao')};
            }
        """)
        print(f"  Form após inject: {diag}")
    except Exception as e:
        print(f"  Diag pós-inject: {e}")


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

    # Registra páginas existentes antes do clique para detectar popup novo
    paginas_antes = set(page.context.pages)

    # Tenta clique normal; se sobreposto por overlay usa JS click
    try:
        lupa.click(timeout=6000)
    except Exception:
        print("  Clique normal falhou, usando JS click na lupa de atividade...")
        form.evaluate("document.querySelector('button[onclick*=\"openFiltro\"]').click()")
    time.sleep(1.5)

    # Aguarda popup novo carregar (se abriu via window.open)
    try:
        paginas_novas = [p for p in page.context.pages if p not in paginas_antes]
        if paginas_novas:
            popup = paginas_novas[0]
            popup.wait_for_load_state("domcontentloaded", timeout=8000)
            print(f"  Popup atividade detectado: {popup.url[:80]}")
        else:
            print("  Nenhum popup novo — modal inline ou iframe")
    except Exception as e:
        print(f"  Aviso popup atividade: {e}")

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

    # confirmSelection() já preencheu id_tomador, ccm, cnpj, razao via JS.
    # Garante cnpj e razao como fallback caso confirmSelection não tenha rodado.
    cpf_limpo = nota["cpf_tomador"].replace(".", "").replace("-", "").replace("/", "")
    form_tmp = _frame_formulario(page)
    form_tmp.evaluate("""
        (d) => {
            const set = (id, name, v) => {
                const el = document.getElementById(id)
                         || document.querySelector('[name="'+name+'"]');
                // só sobrescreve se estiver vazio (confirmSelection tem prioridade)
                if (el && !el.value) {
                    el.value = v;
                    el.dispatchEvent(new Event('change', {bubbles:true}));
                }
            };
            set('cnpj', 'cnpj', d.cpf);
            set('razao', 'razao', d.nome);
        }
    """, {"cpf": cpf_limpo, "nome": nota.get("nome_tomador", "")})
    print(f"  Fallback cnpj/razao (só se vazio): {cpf_limpo!r} / {nota.get('nome_tomador','')!r}")

    # Validação obrigatória: sem id_tomador o SIGISS emite PFNI.
    # Melhor dar erro no CRM agora do que emitir nota errada.
    form_check = _frame_formulario(page)
    id_tomador_val = form_check.evaluate(
        "() => document.querySelector('#id_tomador,[name=\"id_tomador\"]')?.value || ''"
    )
    if not id_tomador_val:
        raise RuntimeError(
            f"CPF {nota['cpf_tomador']} ({nota.get('nome_tomador','?')}) — "
            "id_tomador vazio após lookup. Tomador pode não estar cadastrado no SIGISS "
            "ou HTTP lookup falhou. Corrija o cadastro na Prefeitura e tente novamente."
        )
    print(f"  Validação tomador OK: id_tomador={id_tomador_val!r}")

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
                s('aliquotaSimples', '4.3547');
            }
        """)
        print("  Alíquota forçada para 3.00, aliquotaSimples=4.3547 (callback não disparou)")
    else:
        # Mesmo com aliquota OK, garante aliquotaSimples preenchida
        aliq_simples = form.evaluate(
            "() => document.querySelector('input[name=\"aliquotaSimples\"]')?.value || ''"
        )
        if not aliq_simples or aliq_simples in ("0", "0.00", "0,00"):
            form.evaluate(
                "() => { const el=document.querySelector('input[name=\"aliquotaSimples\"]'); "
                "if(el){ el.value='4.3547'; el.dispatchEvent(new Event('change',{bubbles:true})); } }"
            )
            print("  aliquotaSimples forçada para 4.3547")

    form = _frame_formulario(page)

    # Preenche valor ANTES da Reforma Tributária (o modal pode recalcular)
    if not _preencher_valor(form, nota):
        print("  Aviso: valor não preenchido antes da Reforma Tributária")

    _reforma_tributaria(page)

    # Volta ao form após modal e repreenche valor (garantia)
    form = _frame_formulario(page)
    if not _preencher_valor(form, nota):
        raise RuntimeError("Campo 'Valor Total da Nota' não encontrado.")

    # Re-injeta codigo=412 após modal IBS (o modal pode resetar o campo)
    try:
        form.evaluate(
            "const el=document.querySelector('input[name=\"codigo\"]'); if(el && !el.value){ el.value='412'; }"
        )
    except Exception:
        pass

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
                // Nenhuma opção carregada: injeta 'tp' diretamente no select
                const tpOpt = document.createElement('option');
                tpOpt.value = 'tp';
                tpOpt.text  = 'Tributacao no Municipio do Prestador';
                sel.appendChild(tpOpt);
                sel.value = 'tp';
                sel.dispatchEvent(new Event('change', {bubbles: true}));
                return 'FORCED:tp';
            }
        """)
        print(f"  Situacao tributacao: {sit_val}")
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

    # O modal Reforma Tributária reseta aliquota/aliquotaSimples/situacao após salvar.
    # O código já repreenche valor, mas esses campos ficam errados. Corrige aqui.
    if not form_data.get('aliquota') or form_data.get('aliquota') in ('0', '0.00', '0,00'):
        form_data['aliquota'] = '3.00'
        print("  [FIX] aliquota -> 3.00")
    if not form_data.get('aliquotaSimples'):
        form_data['aliquotaSimples'] = nota.get('aliquota_simples', '4,3547')
        print(f"  [FIX] aliquotaSimples -> {form_data['aliquotaSimples']}")
    if not form_data.get('situacao'):
        form_data['situacao'] = 'tp'
        print("  [FIX] situacao -> tp")
    if not form_data.get('codigo'):
        form_data['codigo'] = '412'
        print("  [FIX] codigo -> 412")

    # Segunda barreira anti-PFNI: não envia POST se id_tomador ausente.
    if not form_data.get('id_tomador'):
        raise RuntimeError(
            f"id_tomador vazio no POST — abortando para evitar PFNI. "
            f"CPF: {form_data.get('cnpj', '?')} — verifique lookup manual."
        )

    # DIAGNÓSTICO: mostra campos relevantes para identificar campos vazios
    # id_tomador e ccm são os campos que o SIGISS usa para identificar o tomador.
    # Se estiverem vazios a nota sai com PFNI.
    campos_criticos = ['id_tomador', 'ccm', 'cnpj', 'razao',
                       'codigo', 'aliquota', 'aliquotaSimples',
                       'valor', 'base', 'situacao', 'dtEmissao', 'dtEmissaoPrest',
                       'descricaoNF', 'localServico', 'exterior']
    def _safe_print(s):
        try:
            print(s)
        except UnicodeEncodeError:
            print(s.encode('ascii', errors='replace').decode('ascii'))

    _safe_print("  [DIAG] Campos criticos no POST:")
    for k in campos_criticos:
        _safe_print(f"    {k}={form_data.get(k, '(ausente)')!r}")
    _safe_print("  [DIAG] Todos com valor:")
    for k, v in sorted(form_data.items()):
        if v:
            _safe_print(f"    {k}={v!r}")

    # Monta URL de POST: tenta usar action do form; fallback para path fixo
    if form_action and form_action.startswith('http'):
        post_url = form_action
    elif form_action:
        post_url = base_url + '/' + form_action.lstrip('/')
    else:
        post_url = f'{base_url}/ISS/contribuinte/nfe/nfe_exec.php'
    print(f"  POST -> {post_url}")

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

    # Detecta sucesso: msg vazio + msg1 com texto de sucesso → segue redirect para nfe.php
    # nfe_exec.php retorna form que faz POST automático para nfe.php com msg1="Dados registrados com sucesso."
    msg1_match = re.search(r'name=["\']msg1["\'][^>]*value=["\']([^"\']*)["\']', html)
    if not msg1_match:
        msg1_match = re.search(r'value=["\']([^"\']*)["\'][^>]*name=["\']msg1["\']', html)
    msg1_val = msg1_match.group(1).strip() if msg1_match else ""

    html_pagina2 = ""
    if msg1_val:
        # Extrai todos os campos do form de redirect
        redirect_data = {}
        for m in re.finditer(r'<input[^>]+>', html, re.IGNORECASE):
            tag = m.group(0)
            nm = re.search(r'name=["\']([^"\']+)["\']', tag)
            vl = re.search(r'value=["\']([^"\']*)["\']', tag)
            if nm:
                redirect_data[nm.group(1)] = vl.group(1) if vl else ""
        redirect_url = f'{base_url}/ISS/contribuinte/nfe/nfe.php'
        print(f"  Seguindo redirect -> {redirect_url}  msg1={msg1_val!r}")
        try:
            r2 = session.post(
                redirect_url, data=redirect_data,
                headers={'Referer': post_url, 'Content-Type': 'application/x-www-form-urlencoded'},
                timeout=20, allow_redirects=True,
            )
            html_pagina2 = r2.text
            print(f"  Redirect resp: {len(html_pagina2)} chars")
            # Busca PHP URLs usadas em JS (endpoint AJAX da lista de notas)
            php_in_js = re.findall(r'["\']([^"\']*\.php[^"\']*)["\']', html_pagina2)
            php_uniq = list(dict.fromkeys(u for u in php_in_js if 'nfe' in u.lower() or 'nota' in u.lower() or 'lista' in u.lower() or 'grid' in u.lower()))
            print(f"  PHP URLs em nfe.php JS: {php_uniq[:20]}")
            # Busca funções JS com URL que carregam dados
            load_fns = re.findall(r'(?:url\s*:\s*|src\s*=\s*|\.get\s*\(|\.post\s*\(|\.ajax\s*\(|fetch\s*\()\s*["\']([^"\']+\.php[^"\']*)["\']', html_pagina2, re.IGNORECASE)
            print(f"  AJAX load URLs: {load_fns[:10]}")
            # Loga todos os hrefs para encontrar URL de impressão/PDF
            hrefs2 = re.findall(r'href=["\']([^"\']+)["\']', html_pagina2, re.IGNORECASE)
            print(f"  Hrefs Trecho2: {hrefs2[:20]}")
            # Extrai NR_NOTA de linhas com formato <tr id="NR_NOTA<|>CODIGO<|>...">
            _tr_notas = re.findall(r'<tr[^>]*id="(\d+)<\|>[^"]*"[^>]*class="[^"]*line', html_pagina2)
            if _tr_notas:
                _nr = str(max(int(x) for x in _tr_notas))
                print(f"  [HTTP] NR_NOTA (tr-id[0]): {_nr} de {len(_tr_notas)} linhas")
            # Diagnóstico: busca padrões de número de nota
            for _pat, _nome in [
                (r'imprimir\((\d+)', 'imprimir('),
                (r'cancelar\((\d+)', 'cancelar('),
                (r'nota=(\d+)', 'nota='),
                (r'num_nfse[^\d]*(\d+)', 'num_nfse'),
                (r'<td[^>]*>(\d{4,})<', 'td-4dig'),
                (r'NFS[- ]?e[^\d]*(\d+)', 'NFS-e-num'),
                (r'onclick[^>]*?(\d{5,})', 'onclick-5dig'),
                (r'nfse?_print\s*\(\s*(\d+)', 'nfse_print('),
                (r'nfe_imprime\s*\(\s*(\d+)', 'nfe_imprime('),
            ]:
                _matches = re.findall(_pat, html_pagina2, re.IGNORECASE)
                if _matches:
                    print(f"  [DIAG-NUM] {_nome}: {_matches[:5]}")
        except Exception as e:
            print(f"  Aviso redirect: {e}")

    # Extrai número da nota — a tabela nfe.php lista TODAS as notas (antigas + nova)
    # ordenadas crescente, então a nova nota tem o MAIOR número. Não usar 1ª ocorrência.
    num_nota = ""
    pkid_nota = ""  # DB_PKID para nfe_base.php?acao=imprimir&id=PKID

    # Prioridade 0: <tr id> com formato <|> — dois formatos:
    #   nfe.php lista: NR_NOTA<|>SERV_CODE<|>... → NR_NOTA em [0] (número pequeno)
    #   nfe_historico.php: DB_PKID<|>CODE<|>NR_NOTA<|>... → NR_NOTA em [2] (DB_PKID > 1M)
    for src in [html_pagina2, html]:
        if not src:
            continue
        _tr_full = re.findall(r'<tr[^>]*id="(\d+)<\|>[^<|"]*<\|>(\d+)<\|>[^"]*"[^>]*class="[^"]*line', src)
        if _tr_full:
            _s0 = int(_tr_full[0][0]) if _tr_full else 0
            if _s0 > 1_000_000:
                _cands = [int(x[1]) for x in _tr_full if x[1].isdigit()]
                _desc = 'tr-id[2]'
            else:
                _cands = [int(x[0]) for x in _tr_full if x[0].isdigit()]
                _desc = 'tr-id[0]'
            if _cands:
                num_nota = str(max(_cands))
                print(f"  Número da nota ({_desc} HTTP): {num_nota} de {len(_tr_full)} linhas")
                break

    # Prioridade 1: print URL patterns — SIGISS insere onclick/href com nota= por nota
    # Pega TODOS os números nesses padrões e usa o MÁXIMO (nova nota = maior número)
    for src in [html_pagina2, html]:
        for pat in [
            r'(?:nfe_print|nfse_print|nfe_imprime|imprimir)[^"\'<>]*(?:nota|num_nfse|num)=(\d{3,})',
            r'nfse?_print\s*\(\s*(\d{3,})',       # nfse_print(8304) — sem parâmetro nomeado
            r'nfe_imprime\s*\(\s*(\d{3,})',        # nfe_imprime(8304)
            r'onclick="[^"]*?(?:imprimir|cancelar|abrir|detalhe)\w*\([^)]*?(\d{3,})[^)]*?\)"',
            r"onclick='[^']*?(?:imprimir|cancelar|abrir|detalhe)\w*\([^)]*?(\d{3,})[^)]*?\)'",
            r'[?&](?:nota|num_nfse)=(\d{3,})',
        ]:
            todos = re.findall(pat, src, re.IGNORECASE)
            if todos:
                num_nota = str(max(int(x) for x in todos))
                print(f"  Número da nota (print URL max): {num_nota}")
                break
        if num_nota:
            break

    # Prioridade 2: máximo de números em células <td> (nova nota = maior número na tabela)
    if not num_nota and html_pagina2:
        todos_td = re.findall(r'<td[^>]*>\s*(\d{3,})\s*</td>', html_pagina2)
        if todos_td:
            num_nota = str(max(int(x) for x in todos_td))
            print(f"  Número da nota (max td): {num_nota}")

    # Prioridade 3: padrões específicos em campos ocultos / texto de sucesso
    if not num_nota:
        for src in [html_pagina2, html]:
            for pattern in [
                r'num_nfse[^\d]*(\d{3,})',
                r'num_nota[^\d]*(\d{3,})',
                r'NFS[- ]?e\s+n[ºo°.]*\s*(\d{3,})',
            ]:
                m = re.search(pattern, src, re.IGNORECASE)
                if m:
                    num_nota = m.group(1)
                    print(f"  Número da nota (texto): {num_nota}")
                    break
            if num_nota:
                break

    # Prioridade 3b: GET nfe_filtro.php (lista de notas do dia — iframe da tabela)
    if not num_nota and msg1_val:
        from datetime import date as _date
        _hoje = _date.today()
        _filtro_url = (
            f'{base_url}/ISS/contribuinte/nfe/nfe_filtro.php'
            f'?dia={_hoje.day:02d}&mes={_hoje.month:02d}&ano={_hoje.year}'
        )
        try:
            rf = session.get(_filtro_url, timeout=15,
                             headers={'Referer': f'{base_url}/ISS/contribuinte/nfe/nfe.php'})
            html_filtro = rf.text
            print(f"  GET nfe_filtro.php: {len(html_filtro)} chars (status {rf.status_code})")
            for pat in [
                r'nfse?_print\s*\(\s*(\d{3,})',
                r'nfe_imprime\s*\(\s*(\d{3,})',
                r'(?:nfe_print|nfse_print)[^"\'<>]*(?:nota|num_nfse|num)=(\d{3,})',
                r'onclick="[^"]*?(?:imprimir|cancelar|abrir|detalhe)\w*\([^)]*?(\d{3,})[^)]*?\)"',
                r'[?&](?:nota|num_nfse)=(\d{3,})',
                r'<td[^>]*>\s*(\d{3,})\s*</td>',
            ]:
                todos = re.findall(pat, html_filtro, re.IGNORECASE)
                grandes = [x for x in todos if int(x) >= 100]
                if grandes:
                    num_nota = str(max(int(x) for x in grandes))
                    print(f"  Número da nota (nfe_filtro max): {num_nota}")
                    break
            if not num_nota:
                print(f"  nfe_filtro trecho: {html_filtro[:500]}")
        except Exception as e:
            print(f"  Aviso nfe_filtro: {e}")

    # Prioridade 4: GET fresco para nfe.php sem redirect data (pode mostrar lista)
    if not num_nota and msg1_val:
        try:
            r_get = session.get(
                f'{base_url}/ISS/contribuinte/nfe/nfe.php',
                headers={'Referer': f'{base_url}/ISS/contribuinte/nfe/nfe_exec.php'},
                timeout=15, allow_redirects=True,
            )
            html_get = r_get.text
            print(f"  GET nfe.php: {len(html_get)} chars")
            for pat in [
                r'onclick="[^"]*?(?:imprimir|cancelar|abrir|detalhe)\w*\([^)]*?(\d{3,})[^)]*?\)"',
                r"onclick='[^']*?(?:imprimir|cancelar|abrir|detalhe)\w*\([^)]*?(\d{3,})[^)]*?\)'",
                r'(?:nfe_print|nfse_print|nfe_imprime)[^"\'<>]*(?:nota|num_nfse|num)=(\d{3,})',
                r'[?&](?:nota|num_nfse)=(\d{3,})',
                r'<td[^>]*>\s*(\d{3,})\s*</td>',
                r'<td[^>]*>\s*(\d{3,})\s*<',
            ]:
                todos = re.findall(pat, html_get, re.IGNORECASE)
                grandes = [x for x in todos if int(x) >= 100]
                if grandes:
                    num_nota = str(max(int(x) for x in grandes))
                    print(f"  Número da nota (GET nfe.php): {num_nota}")
                    break
        except Exception as e:
            print(f"  Aviso GET nfe.php: {e}")

    # Prioridade 4b: tenta URLs candidatas da lista de notas
    # Dois formatos de <tr id> no SIGISS:
    #   nfe.php lista emissão:  NR_NOTA<|>SERV_CODE<|>...   → índice [0] (NR_NOTA pequeno)
    #   nfe_historico.php:      DB_PKID<|>CODE<|>NR_NOTA<|>... → índice [2] (DB_PKID > 1M)
    if not num_nota and msg1_val:
        from datetime import date as _date
        _hoje = _date.today()
        _candidatas = [
            f'{base_url}/ISS/contribuinte/nfe/nfe.php?acao=lista&dia={_hoje.day:02d}&mes={_hoje.month:02d}&ano={_hoje.year}',
            f'{base_url}/ISS/contribuinte/nfe/nfe_hist.php?dia={_hoje.day:02d}&mes={_hoje.month:02d}&ano={_hoje.year}',
            f'{base_url}/ISS/contribuinte/nfe/nfe_lista.php?dia={_hoje.day:02d}&mes={_hoje.month:02d}&ano={_hoje.year}',
            f'{base_url}/ISS/contribuinte/nfe/nfe_historico.php',
        ]
        for _url in _candidatas:
            try:
                _r = session.get(_url, timeout=10, headers={'Referer': f'{base_url}/ISS/contribuinte/nfe/nfe.php'})
                if _r.status_code != 200 or len(_r.text) < 500:
                    continue
                # Formato histórico: DB_PKID<|>CODE<|>NR_NOTA<|>...
                _tr_full = re.findall(r'<tr[^>]*id="(\d+)<\|>[^<|"]*<\|>(\d+)<\|>[^"]*"[^>]*class="[^"]*line', _r.text)
                # Formato emissão: NR_NOTA<|>SERV_CODE<|>...
                _tr_simple = re.findall(r'<tr[^>]*id="(\d+)<\|>[^"]*"[^>]*class="[^"]*line', _r.text)
                print(f"  GET {_url[-55:]}: {len(_r.text)}ch, full={len(_tr_full)} simple={len(_tr_simple)}")
                if _tr_full:
                    # Verifica se [0] é DB_PKID (>1M) → usa [2]; senão usa [0]
                    _sample0 = int(_tr_full[0][0]) if _tr_full else 0
                    if _sample0 > 1_000_000:
                        # formato histórico: DB_PKID<|>CODE<|>NR_NOTA<|>...
                        _candidatos = [int(x[1]) for x in _tr_full if x[1].isdigit()]
                        _idx_desc = 'tr-id[2]'
                        if _candidatos:
                            _max_nr = max(_candidatos)
                            num_nota = str(_max_nr)
                            # extrai PKID da linha com esse NR_NOTA
                            for x in _tr_full:
                                if x[1].isdigit() and int(x[1]) == _max_nr:
                                    pkid_nota = x[0]
                                    break
                    else:
                        # formato emissão: NR_NOTA<|>SERV_CODE<|>...
                        _candidatos = [int(x[0]) for x in _tr_full if x[0].isdigit()]
                        _idx_desc = 'tr-id[0]'
                        if _candidatos:
                            num_nota = str(max(_candidatos))
                    if num_nota:
                        print(f"  Número da nota ({_idx_desc} {_url[-30:]}): {num_nota}" +
                              (f"  PKID={pkid_nota}" if pkid_nota else ""))
                        break
            except Exception as e:
                print(f"  Candidata {_url[-40:]}: {e}")

    # Prioridade 4c: busca endpoint AJAX da lista nos scripts do nfe.php redirect
    if not num_nota and msg1_val and html_pagina2:
        _ajax_endpoints = re.findall(r'["\']([^"\']*\.php[^"\']{0,60})["\']', html_pagina2)
        _interessantes = [u for u in _ajax_endpoints if any(k in u.lower() for k in ['lista', 'hist', 'grid', 'ajax', 'nfe']) and u not in ['/nfe.php', 'nfe_exec.php']]
        if _interessantes:
            print(f"  AJAX endpoints em nfe.php: {list(dict.fromkeys(_interessantes))[:10]}")

    # Prioridade 5: se emissão foi confirmada mas número não encontrado, emitiu ok mas número desconhecido
    if not num_nota and msg1_val and 'sucesso' in msg1_val.lower():
        num_nota = "?"
        print("  Nota emitida (confirmado), número desconhecido — verifique no SIGISS")

    if num_nota and num_nota != "?":
        print(f"  Número final da nota: {num_nota}")
    elif num_nota == "?":
        pass  # already printed
    else:
        raise RuntimeError(
            "Número da NFS-e não encontrado na resposta do SIGISS. "
            "A nota pode não ter sido emitida — verifique manualmente no portal da Prefeitura."
        )

    # Captura URL de impressão/PDF
    caminho = ""
    print_url = ""
    pdf_urls: list[str] = []
    for html_src in [html_pagina2, html]:
        pdf_urls += re.findall(r'href=["\']([^"\']*\.pdf[^"\']*)["\']', html_src, re.IGNORECASE)
        pdf_urls += re.findall(r'href=["\']([^"\']*imprimir[^"\']*)["\']', html_src, re.IGNORECASE)
        pdf_urls += re.findall(r'href=["\']([^"\']*download[^"\']*)["\']', html_src, re.IGNORECASE)
        pdf_urls += re.findall(r'href=["\']([^"\']*nfe_print[^"\']*)["\']', html_src, re.IGNORECASE)
        pdf_urls += re.findall(r'href=["\']([^"\']*nfse[^"\']*print[^"\']*)["\']', html_src, re.IGNORECASE)
    js_locs = re.findall(
        r'''(?:window\.location|location\.href)\s*=\s*['"]([^'"]+)['"]''', html_pagina2 or html
    )
    pdf_urls += [u for u in js_locs if any(k in u for k in ('imprimir', 'pdf', 'nota', 'nfse', 'print'))]

    for url in pdf_urls[:3]:
        try:
            full_url = url if url.startswith('http') else base_url + '/' + url.lstrip('/')
            if not print_url:
                print_url = full_url
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

    # Se PDF não encontrado via href, tenta URLs padrão do SIGISS Ipatinga
    if not caminho and num_nota:
        _print_pats = []
        # nfe_ver.php?id=PKID retorna PDF direto; nfe_base.php?acao=imprimir retorna HTML
        if pkid_nota:
            _print_pats.append(f'{base_url}/ISS/contribuinte/nfe/nfe_ver.php?id={pkid_nota}')
            _print_pats.append(f'{base_url}/ISS/contribuinte/nfe/nfe_base.php?acao=imprimir&id={pkid_nota}')
        _print_pats += [
            f'{base_url}/ISS/contribuinte/nfe/nfe_print.php?nota={num_nota}',
            f'{base_url}/ISS/contribuinte/nfe/nfse_imprime.php?nota={num_nota}',
            f'{base_url}/ISS/contribuinte/nfe/nfe_print.php?num_nfse={num_nota}',
        ]
        for print_pat in _print_pats:
            try:
                pdf_r = session.get(print_pat, timeout=20)
                ct = pdf_r.headers.get('content-type', '')
                is_pdf = 'pdf' in ct.lower() or pdf_r.content[:4] == b'%PDF' or len(pdf_r.content) > 10000
                if is_pdf:
                    if not print_url:
                        print_url = print_pat  # garante URL PDF mesmo se save falhar
                    try:
                        from file_manager import salvar_pdf_bytes
                        caminho = salvar_pdf_bytes(
                            pdf_r.content, pasta, nota["competencia"], num_nota, nota["nome_tomador"]
                        )
                        print(f"  PDF salvo: {caminho}")
                    except Exception as save_err:
                        print(f"  PDF obtido mas save falhou ({save_err}) — URL: {print_pat}")
                        caminho = print_pat
                    break
                else:
                    print(f"  Print URL resp: {pdf_r.status_code} {len(pdf_r.content)} chars ct={ct}")
                    if not print_url:
                        print_url = print_pat
            except Exception as e:
                print(f"  Print URL {print_pat}: {e}")

    if not caminho and print_url:
        caminho = print_url
        print(f"  URL impressão capturada: {print_url}")
    print(f"  PDF URLs encontradas: {pdf_urls[:5]}")

    return {"num_nota": num_nota, "caminho_pdf": caminho}


def _emitir_playwright(page, form, nota: dict, pasta: str) -> dict:
    """
    Emite NFSe clicando o botão Emitir no próprio browser Playwright.
    Usa a MESMA sessão PHP que registrou o tomador via lookup Ok —
    garante que o servidor encontra o IM correto e não emite PFNI.
    """
    import re
    from urllib.parse import urlparse

    frame_url = form.url or page.url
    parsed = urlparse(frame_url)
    base_url = f"{parsed.scheme}://{parsed.netloc}"

    # Encontra botão Emitir no form frame.
    # is_visible() retorna False em headless para elementos em iframe — fallback via JS.
    emitir_loc = None
    for sel in [
        'button#btnEmitirNF', 'input#btnEmitirNF',
        'button:has-text("Emitir")', 'input[value*="Emitir"]',
        'input[type="submit"]', 'button[type="submit"]',
        'input[value*="emitir"]',
    ]:
        try:
            loc = form.locator(sel).first
            if loc.is_visible(timeout=2000):
                emitir_loc = loc
                print(f"  Botão Emitir: {sel}")
                break
        except Exception:
            continue

    # Intercepta respostas AJAX pós-emissão (context = captura todos os frames)
    # Procura especificamente por respostas com rows <tr id="DB_ID<|>CODE<|>NR_NOTA<|>...">
    ajax_captured = []
    def _ajax_handler(resp):
        try:
            ct = resp.headers.get('content-type', '')
            if not any(t in ct for t in ['html', 'json', 'text', 'xml']):
                return
            body = resp.text()
            if len(body) < 50:
                return
            # Captura qualquer resposta com o delimitador <|> das linhas da lista
            if '<|>' in body or '&lt;|&gt;' in body:
                ajax_captured.append((resp.url, body))
            elif any(p in resp.url for p in ['nfe', 'nota', 'nfse']) and len(body) > 200:
                ajax_captured.append((resp.url, body))
        except Exception:
            pass
    page.context.on('response', _ajax_handler)

    # Captura resposta do nfe_exec.php via intercept (mesma sessão browser)
    html_exec = ""
    _emitiu_clique = False  # rastrea se o clique no botão Emitir foi disparado
    try:
        with page.expect_response(
            lambda r: 'nfe_exec' in r.url,
            timeout=20000,
        ) as resp_info:
            if emitir_loc:
                emitir_loc.click()
                _emitiu_clique = True
                print("  Clicou Emitir NFSe via Playwright")
            else:
                # JS fallback — is_visible() falha em headless para botões em iframe
                js_result = form.evaluate("""
                    () => {
                        const cands = [
                            document.getElementById('btnEmitirNF'),
                            document.querySelector('input[onclick*="emitirNF"], input[onclick*="EmitirNF"]'),
                            document.querySelector('button[onclick*="emitirNF"]'),
                            document.querySelector('input[value*="Emitir"], input[value*="emitir"]'),
                            [...document.querySelectorAll('button,input[type="button"],input[type="submit"]')]
                                .find(b => /emitir/i.test((b.value || '') + (b.textContent || '') + (b.getAttribute('onclick') || ''))),
                        ];
                        const btn = cands.find(b => b);
                        if (btn) {
                            btn.click();
                            return 'OK:' + (btn.id || btn.value || btn.textContent).slice(0, 40);
                        }
                        return 'NOT_FOUND';
                    }
                """)
                print(f"  JS emitir: {js_result}")
                if 'NOT_FOUND' in js_result:
                    raise RuntimeError("Botão Emitir NFSe não encontrado no form frame")
                _emitiu_clique = 'OK:' in js_result

        resp = resp_info.value
        html_exec = resp.text()
        print(f"  nfe_exec.php: HTTP {resp.status} ({len(html_exec)} chars)")
        print(f"  Trecho exec: {html_exec[:600]}")
    except PWTimeout:
        print("  Timeout nfe_exec.php — aguardando redirect direto")
    except Exception as e:
        print(f"  Aviso captura nfe_exec: {e}")

    # Aguarda auto-redirect: nfe_exec retorna form que auto-submete para nfe.php
    time.sleep(6.0)

    # Aguarda AJAX da lista de notas completar (networkidle = sem requisições por 500ms)
    try:
        page.wait_for_load_state('networkidle', timeout=15000)
        print("  networkidle OK")
    except PWTimeout:
        print("  networkidle timeout — continuando")
    except Exception as e:
        print(f"  networkidle aviso: {e}")

    # Processa respostas AJAX capturadas — extrai NR_NOTA do formato <tr id="DB<|>CODE<|>NR_NOTA<|>...">
    num_nota_ajax = ""
    pkid_nota_ajax = ""
    print(f"  AJAX capturadas: {len(ajax_captured)} respostas")
    for url, body in ajax_captured:
        print(f"  AJAX URL: {url[-80:]}")
        _tr_full = re.findall(r'<tr[^>]*id="(\d+)<\|>[^<|"]*<\|>(\d+)<\|>[^"]*"[^>]*class="[^"]*line', body)
        if _tr_full:
            _s0 = int(_tr_full[0][0]) if _tr_full else 0
            if _s0 > 1_000_000:
                _cands = [int(x[1]) for x in _tr_full if x[1].isdigit()]
                _desc = 'tr-id[2]'
                if _cands:
                    _max_nr = max(_cands)
                    num_nota_ajax = str(_max_nr)
                    for x in _tr_full:
                        if x[1].isdigit() and int(x[1]) == _max_nr:
                            pkid_nota_ajax = x[0]
                            break
            else:
                _cands = [int(x[0]) for x in _tr_full if x[0].isdigit()]
                _desc = 'tr-id[0]'
                if _cands:
                    num_nota_ajax = str(max(_cands))
            if num_nota_ajax:
                print(f"  Número da nota (AJAX {_desc}): {num_nota_ajax}" +
                      (f"  PKID={pkid_nota_ajax}" if pkid_nota_ajax else ""))
        break

    # Lê frames atuais sem navegar (preserva estado do form para HTTP fallback)
    # Formato da lista de notas em nfe.php: <tr id="NR_NOTA<|>CODIGO<|>..."> → índice [0]
    html_nfe = ""
    dom_nums = []
    num_nota_dom = ""
    pkid_nota_dom = ""
    for f in page.frames:
        if f.name == 'main' and f.url and 'nfe' in f.url:
            try:
                # Aguarda linhas da lista renderizarem (AJAX pós-emissão)
                try:
                    f.wait_for_selector('tr.line[id]', timeout=25000)
                    print("  tr.line[id] encontrado no frame atual")
                except Exception:
                    print("  tr.line[id] não apareceu em 25s")
                rows = f.query_selector_all('tr.line[id]')
                print(f"  tr.line rows: {len(rows)}")
                for row in reversed(rows):
                    tr_id = row.get_attribute('id') or ''
                    parts = tr_id.split('<|>')
                    if not parts or not parts[0].strip().isdigit():
                        continue
                    # DB_PKID > 1M → formato histórico, NR_NOTA em [2]
                    if int(parts[0]) > 1_000_000 and len(parts) >= 3 and parts[2].strip().isdigit():
                        num_nota_dom = parts[2].strip()
                        pkid_nota_dom = parts[0].strip()
                        print(f"  Número da nota (tr-id[2] DOM): {num_nota_dom}  PKID={pkid_nota_dom}")
                    else:
                        num_nota_dom = parts[0].strip()
                        pkid_nota_dom = ""
                        print(f"  Número da nota (tr-id[0] DOM): {num_nota_dom}")
                    break
                html_nfe = f.content()
                print(f"  Main frame HTML: {len(html_nfe)} chars")
            except Exception as e:
                print(f"  Aviso main frame: {e}")
            break

    # Prioridade: nfe_filtro.php — CUIDADO: este frame é o popup de seleção de atividade
    # (mostra CNAE codes), NÃO uma lista de notas emitidas
    for f in page.frames:
        if f.url and 'nfe_filtro.php' in f.url:
            try:
                print(f"  Frame lista: {f.url}")
                html_nfe = f.content()
                print(f"  nfe_filtro.php ({len(html_nfe)} chars)")
                dom_result = f.evaluate("""
                    () => {
                        const tds = [...document.querySelectorAll('td')].map(t => t.textContent.trim()).filter(t => /^[0-9]{3,}$/.test(t) && parseInt(t) >= 100);
                        const ocs = [...document.querySelectorAll('[onclick]')].map(el => el.getAttribute('onclick'));
                        const hrefs = [...document.querySelectorAll('a[href]')].map(el => el.getAttribute('href')).filter(h => /nota|nfse|print|imprimir|pdf/i.test(h));
                        const trIds = [...document.querySelectorAll('tr[id]')].map(tr => tr.id);
                        const allTds = [...document.querySelectorAll('td')].map(t => t.textContent.trim()).filter(t => t.length > 0 && t.length < 60);
                        return {tds: tds.slice(-30), ocs: ocs.slice(0, 20), hrefs: hrefs.slice(0, 10), trIds: trIds.slice(0, 10), allTds: allTds.slice(0, 60)};
                    }
                """)
                # Diagnóstico: nfe_filtro.php é o popup de ATIVIDADE (mostra CNAE), não lista de notas
                print(f"  [ATIV] filtro trIds: {dom_result.get('trIds', [])[:3]}")
                print(f"  [ATIV] filtro onclicks: {dom_result.get('ocs', [])[:5]}")
                # NÃO usa dom_nums daqui — são CNAE codes, não números de notas
                break
            except Exception as e:
                print(f"  Aviso nfe_filtro frame: {e}")

    # Fallback: nfe.php frame (se nfe_filtro não encontrado)
    if not html_nfe:
        for f in page.frames:
            if f.url and 'nfe.php' in f.url and 'Componentes' not in f.url and 'nfe_filtro' not in f.url:
                try:
                    html_nfe = f.content()
                    print(f"  nfe.php fallback ({len(html_nfe)} chars)")
                    break
                except Exception:
                    pass

    # Verifica mensagem de erro
    for html_src in [html_nfe, html_exec]:
        if not html_src:
            continue
        m = re.search(r'name=["\']msg["\'][^>]*value=["\']([^"\']+)["\']', html_src)
        if not m:
            m = re.search(r'value=["\']([^"\']+)["\'][^>]*name=["\']msg["\']', html_src)
        if m and m.group(1).strip():
            raise RuntimeError(f"Prefeitura rejeitou: {m.group(1)}")

    # Extrai número da nota — tabela nfe.php lista TODAS as notas crescente,
    # nova nota tem o MAIOR número. Usar MAX, não primeira ocorrência.
    num_nota = ""
    pkid_nota = ""  # DB_PKID para nfe_ver.php?id=PKID (retorna PDF direto)

    # Prioridade 0a: tr id index 2 via DOM Playwright (formato DB_ID<|>CODE<|>NR_NOTA<|>...)
    if num_nota_dom:
        num_nota = num_nota_dom
        if pkid_nota_dom:
            pkid_nota = pkid_nota_dom

    # Prioridade 0b: tr id index 2 via AJAX capturado
    if not num_nota and num_nota_ajax:
        num_nota = num_nota_ajax
        if pkid_nota_ajax and not pkid_nota:
            pkid_nota = pkid_nota_ajax

    # Prioridade 0c: DOM renderizado pelo Playwright (lista de números de td)
    if not num_nota and dom_nums:
        grandes = [x for x in dom_nums if int(x) >= 100]
        if grandes:
            num_nota = str(max(int(x) for x in grandes))
            print(f"  Número da nota (DOM max): {num_nota}")

    # Prioridade 1: print URL patterns — pega TODOS e usa MAX
    for html_src in [html_nfe, html_exec]:
        if not html_src:
            continue
        for pat in [
            r'(?:nfe_print|nfse_print|nfe_imprime|imprimir)[^"\'<>]*(?:nota|num_nfse|num)=(\d{3,})',
            r'nfse?_print\s*\(\s*(\d{3,})',       # nfse_print(8304) — sem parâmetro nomeado
            r'nfe_imprime\s*\(\s*(\d{3,})',        # nfe_imprime(8304)
            r'onclick="[^"]*?(?:imprimir|cancelar|abrir|detalhe)\w*\([^)]*?(\d{3,})[^)]*?\)"',
            r"onclick='[^']*?(?:imprimir|cancelar|abrir|detalhe)\w*\([^)]*?(\d{3,})[^)]*?\)'",
            r'[?&](?:nota|num_nfse)=(\d{3,})',
        ]:
            todos = re.findall(pat, html_src, re.IGNORECASE)
            if todos:
                num_nota = str(max(int(x) for x in todos))
                print(f"  Número da nota (print URL max): {num_nota}")
                break
        if num_nota:
            break

    # Prioridade 2: máximo de números em células <td> (nova nota = maior número)
    if not num_nota and html_nfe:
        todos_td = re.findall(r'<td[^>]*>\s*(\d{3,})\s*</td>', html_nfe)
        if todos_td:
            num_nota = str(max(int(x) for x in todos_td))
            print(f"  Número da nota (max td): {num_nota}")

    # Prioridade 3: padrões específicos em campos ocultos / texto de sucesso
    if not num_nota:
        for html_src in [html_nfe, html_exec]:
            if not html_src:
                continue
            for pattern in [
                r'num_nfse[^\d]*(\d{3,})',
                r'num_nota[^\d]*(\d{3,})',
                r'NFS[- ]?e\s+n[ºo°.]*\s*(\d{3,})',
            ]:
                m = re.search(pattern, html_src, re.IGNORECASE)
                if m:
                    num_nota = m.group(1)
                    print(f"  Número da nota (texto): {num_nota}")
                    break
            if num_nota:
                break

    # Fallback: navega para nfe_historico.php — confirmação definitiva de sucesso/falha
    # Se o botão foi clicado, nfe_historico.php é a fonte da verdade:
    #   • nota nova presente → emissão confirmada (sem HTTP fallback = sem duplicata)
    #   • nota nova ausente  → SIGISS rejeitou → RuntimeError → HTTP fallback (seguro)
    _hist_max_nr = 0
    if not num_nota and _emitiu_clique:
        try:
            page.goto(f'{base_url}/ISS/contribuinte/nfe/nfe_historico.php', timeout=15000)
            page.wait_for_load_state('networkidle', timeout=10000)
            html_hist = page.content()
            _tr_full = re.findall(r'<tr[^>]*id="(\d+)<\|>[^<|"]*<\|>(\d+)<\|>[^"]*"[^>]*class="[^"]*line', html_hist)
            if _tr_full and int(_tr_full[0][0]) > 1_000_000:
                _hist_max_nr = max(int(x[1]) for x in _tr_full if x[1].isdigit())
                num_nota = str(_hist_max_nr)
                for x in _tr_full:
                    if x[1].isdigit() and int(x[1]) == _hist_max_nr:
                        pkid_nota = x[0]
                        break
                print(f"  Número da nota (nfe_historico nav): {num_nota}  PKID={pkid_nota}")
        except Exception as e:
            print(f"  Aviso nfe_historico nav: {e}")

    _exec_ok = bool(html_exec and 'Dados registrados com sucesso' in html_exec)
    _emitiu_confirmado = _emitiu_clique and (_hist_max_nr > 0 or _exec_ok or len(html_nfe) > 50000)

    if num_nota:
        print(f"  Número final da nota: {num_nota}")
    elif _emitiu_confirmado:
        print("  AVISO: número da nota não encontrado — nota emitida, verifique NF# no SIGISS")
    else:
        raise RuntimeError(
            "Número da NFS-e não encontrado após emissão Playwright. "
            "A nota pode não ter sido emitida — verifique manualmente no portal da Prefeitura."
        )

    # Captura URL de impressão/PDF
    caminho = ""
    print_url = ""
    pdf_urls: list[str] = []
    for html_src in [html_nfe, html_exec]:
        if not html_src:
            continue
        pdf_urls += re.findall(r'href=["\']([^"\']*\.pdf[^"\']*)["\']', html_src, re.IGNORECASE)
        pdf_urls += re.findall(r'href=["\']([^"\']*imprimir[^"\']*)["\']', html_src, re.IGNORECASE)
        pdf_urls += re.findall(r'href=["\']([^"\']*download[^"\']*)["\']', html_src, re.IGNORECASE)
        pdf_urls += re.findall(r'href=["\']([^"\']*nfe_print[^"\']*)["\']', html_src, re.IGNORECASE)
        pdf_urls += re.findall(r'href=["\']([^"\']*print[^"\']*)["\']', html_src, re.IGNORECASE)
    print(f"  PDF URLs: {pdf_urls[:5]}")

    # Tenta baixar PDF via requests com cookies do Playwright
    import requests as _req
    cookies = {c['name']: c['value'] for c in page.context.cookies()}
    for url in pdf_urls[:3]:
        try:
            full = url if url.startswith('http') else base_url + '/' + url.lstrip('/')
            if not print_url:
                print_url = full
            pdf_r = _req.get(full, cookies=cookies, timeout=20)
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

    # Fallback: tenta URLs padrão de impressão do SIGISS Ipatinga
    if not caminho and num_nota and num_nota != '?':
        _pats = []
        if pkid_nota:
            _pats.append(f'{base_url}/ISS/contribuinte/nfe/nfe_ver.php?id={pkid_nota}')
            _pats.append(f'{base_url}/ISS/contribuinte/nfe/nfe_base.php?acao=imprimir&id={pkid_nota}')
        _pats += [
            f'{base_url}/ISS/contribuinte/nfe/nfe_print.php?nota={num_nota}',
            f'{base_url}/ISS/contribuinte/nfe/nfse_imprime.php?nota={num_nota}',
            f'{base_url}/ISS/contribuinte/nfe/nfe_print.php?num_nfse={num_nota}',
        ]
        for print_pat in _pats:
            try:
                pdf_r = _req.get(print_pat, cookies=cookies, timeout=20)
                ct = pdf_r.headers.get('content-type', '')
                is_pdf = 'pdf' in ct.lower() or pdf_r.content[:4] == b'%PDF' or len(pdf_r.content) > 10000
                if is_pdf:
                    if not print_url:
                        print_url = print_pat
                    try:
                        from file_manager import salvar_pdf_bytes
                        caminho = salvar_pdf_bytes(
                            pdf_r.content, pasta, nota["competencia"], num_nota, nota["nome_tomador"]
                        )
                        print(f"  PDF salvo: {caminho}")
                    except Exception as save_err:
                        print(f"  PDF obtido mas save falhou ({save_err}) — URL: {print_pat}")
                        caminho = print_pat
                    break
                else:
                    print(f"  Print URL: {pdf_r.status_code} {len(pdf_r.content)}ch ct={ct} url={print_pat}")
                    if not print_url:
                        print_url = print_pat
            except Exception as e:
                print(f"  Print URL {print_pat}: {e}")

    if not caminho and print_url:
        caminho = print_url
        print(f"  URL impressão: {print_url}")

    return {"num_nota": num_nota, "caminho_pdf": caminho}


def _emitir_e_baixar(page, nota: dict, pasta: str) -> dict:
    _preencher_form(page, nota)
    form = _frame_formulario(page)

    # Tenta emissão via Playwright (mesma sessão PHP que registrou tomador no lookup)
    try:
        return _emitir_playwright(page, form, nota, pasta)
    except Exception as e:
        print(f"  Playwright emissão falhou ({e}), tentando via HTTP...")
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
