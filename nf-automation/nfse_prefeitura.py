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

    Formato confirmado (Cowork 2026-05-21):
      <tr id="id_tomador<|>ccm<|>cnpj<|>nome" onclick="lineSelected(this);">
    OK chama: window.parent.contribResult(selected.id) — passa o id completo para nfe.php.
    """
    import re as _re

    for scope_filter in [cpf_limpo, None]:
        haystack = html
        if scope_filter:
            linhas = [l for l in html.splitlines() if scope_filter in l]
            if linhas:
                haystack = '\n'.join(linhas)
            else:
                continue

        # ── Padrão principal confirmado: <tr id="id<|>ccm<|>cnpj<|>nome" ──
        m = _re.search(
            r'<tr[^>]+\bid="(\d+)<\|>(-?\d+)<\|>([^<"|]*)<\|>([^<"|]*)"',
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
            print(f"  Parse <|> OK: id={result['id_tomador']} ccm={result['ccm']}")
            return result

        # ── Fallback: lineSelected('id','ccm','cpf','nome') literal ──
        m2 = _re.search(
            r"lineSelected\(['\"](\d+)['\"],\s*['\"](-?\d+)['\"],\s*['\"]([^'\"]*)['\"],\s*['\"]([^'\"]*)['\"]",
            haystack
        )
        if m2:
            result = {
                'id_tomador': m2.group(1),
                'ccm': m2.group(2),
                'cnpj': m2.group(3),
                'razao': m2.group(4),
            }
            print(f"  Parse lineSelected literal OK: {result}")
            return result

    return {}


def _buscar_tomador_via_http(page, cpf_limpo: str) -> dict:
    """
    Extrai id_tomador/ccm do SIGISS para contornar tr.line que não renderiza em headless.

    Estratégia 1: lê o HTML do frame Playwright já carregado (mais confiável — mesma sessão).
    Estratégia 2: HTTP POST direto com cookies do Playwright (fallback).
    Ambos usam _parsear_tomador_html() para diferentes padrões de onclick.
    """
    import re as _re
    import requests as _req

    # ── Estratégia 1: frame já carregado pelo Playwright ─────────────────────
    # O frame navegou para nfe_filtro_contribuinte.php com os resultados PHP-renderizados.
    # Ler o HTML daqui é mais confiável que um HTTP POST separado.
    for f in page.frames:
        if 'nfe_filtro_contribuinte' in f.url:
            try:
                html_frame = f.content()
                print(f"  Frame content: {len(html_frame)} chars ({f.url[:70]})")
                result = _parsear_tomador_html(html_frame, cpf_limpo)
                if result:
                    return result
                # Log diagnóstico — primeiros 2000 chars para inspecionar o HTML real
                print(f"  [DIAG HTML frame] {html_frame[:2000]}")
            except Exception as e:
                print(f"  Frame content erro: {e}")

    # ── Estratégia 2: HTTP POST com cookies do Playwright ─────────────────────
    base = 'https://ipatinga.meumunicipio.online'
    url_filtro = f'{base}/ISS/contribuinte/nfe/nfe_filtro_contribuinte.php'
    cookies = {c['name']: c['value'] for c in page.context.cookies()}
    headers_post = {
        'Referer': f'{base}/ISS/contribuinte/nfe/nfe_lookup.php',
        'Content-Type': 'application/x-www-form-urlencoded',
    }
    # Campo confirmado pelo Cowork: form id="busca" usa campo "cnpj"
    payloads = [
        {'cnpj': cpf_limpo, 'local': 'F'},
        {'cnpj': cpf_limpo},
        {'cpf': cpf_limpo, 'local': 'F'},
        {'cpf': cpf_limpo},
    ]
    last_html = ''
    for data in payloads:
        try:
            r = _req.post(url_filtro, data=data, cookies=cookies,
                          headers=headers_post, timeout=15)
            last_html = r.text
            result = _parsear_tomador_html(last_html, cpf_limpo)
            if result:
                return result
            print(f"  HTTP POST ({list(data.keys())}): sem match ({len(last_html)} chars)")
        except Exception as e:
            print(f"  HTTP POST ({list(data.keys())}): {e}")
            continue

    # Log do HTML para diagnóstico quando todos os métodos falham
    if last_html:
        print(f"  [DIAG HTML http] {last_html[:2000]}")

    print(f"  AVISO: tomador não encontrado para CPF {cpf_limpo}")
    return {}


def _pesquisar_tomador(page, tipo_tomador: str, cpf: str):
    """
    Seleciona Tipo de Tomador → abre wizard 'nfe_filtro_contribuinte' →
    pesquisa CPF → clica tr.line (executa lineSelected) → clica #btnOk
    (executa confirmSelection que copia ccm e id_tomador para nfe.php).

    O servidor valida o tomador pelo campo id_tomador no POST para nfe_exec.php.
    Sem esse campo preenchido o SIGISS emite PFNI.
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

    # Reset para vazio — garante que onchange dispara mesmo com valor já selecionado
    try:
        form.evaluate(
            "() => { const s=document.querySelector('select[name=\"local\"],select#local'); if(s) s.value=''; }"
        )
        time.sleep(0.3)
    except Exception:
        pass

    for lbl in labels:
        try:
            tipo_sel.select_option(label=lbl)
            print(f"  Tipo tomador selecionado: {lbl}")
            break
        except Exception:
            continue

    time.sleep(1.0)

    lookup = _aguardar_frame_lookup(page, timeout_s=8)
    if lookup is None:
        raise RuntimeError("Frame nfe_filtro_contribuinte não apareceu após seleção do tipo tomador.")

    print(f"  Lookup carregado: name={lookup.name!r} url={lookup.url[:70]}")
    lookup.wait_for_load_state("domcontentloaded", timeout=8000)
    time.sleep(0.5)

    # Preenche CPF no campo de busca — campo confirmado: name="cnpj" (form id="busca")
    for sel in ['input[name="cnpj"]', 'input[name*="cpf"]', 'input[id*="cpf"]',
                'input[placeholder*="CPF"]', 'input[type="text"]']:
        try:
            loc = lookup.locator(sel).first
            if loc.is_visible(timeout=2000):
                loc.fill(cpf_limpo)
                print(f"  CPF preenchido no lookup ({sel}): {cpf_limpo}")
                break
        except Exception:
            continue

    # Clica Pesquisar
    clicou_pesquisar = False
    for sel in [
        'button:has-text("Pesquisar")', 'input[value*="Pesquisar"]',
        'button[type="submit"]', 'input[type="submit"]',
        '[onclick*="pesquis"]', '[onclick*="Pesquis"]',
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
        print("  Pesquisar não encontrado, submetendo form#busca via JS...")
        try:
            lookup.evaluate(
                "() => { const f = document.getElementById('busca'); if(f) f.submit(); }"
            )
            clicou_pesquisar = True
            print("  Submit via JS (form#busca)")
        except Exception as e:
            print(f"  JS submit erro: {e}")
            try:
                lookup.locator('input[type="text"]').first.press("Enter")
            except Exception:
                pass

    # Aguarda resultados — o iframe recarrega em nfe_filtro_contribuinte.php (POST response)
    time.sleep(1.5)
    lookup2 = _aguardar_frame_lookup(page, timeout_s=8)
    if lookup2:
        lookup = lookup2
        try:
            lookup.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
    print(f"  Lookup pós-pesquisa: {lookup.url[:80]}")

    # HTTP lookup — tr.line não renderiza em headless; extrai id_tomador/ccm via POST HTTP
    # Chamado aqui (antes de clicar OK) enquanto a sessão ainda tem o resultado fresco
    tomador_http = _buscar_tomador_via_http(page, cpf_limpo)

    # Aguarda tr.line aparecer — os resultados são renderizados depois do DOMContentLoaded
    tr_line_ok = False
    for _ in range(12):  # até ~6 segundos
        count = lookup.evaluate("() => document.querySelectorAll('tr.line').length")
        if count > 0:
            print(f"  tr.line encontrados: {count}")
            tr_line_ok = True
            break
        time.sleep(0.5)
    if not tr_line_ok:
        print("  AVISO: tr.line não apareceu após 6s — resultados podem não ter carregado")

    # Clica tr.line — executa lineSelected(this) que preenche ccmTom e id_tomador no lookup
    cpf_fmt = (f"{cpf_limpo[:3]}.{cpf_limpo[3:6]}.{cpf_limpo[6:9]}-{cpf_limpo[9:]}"
               if len(cpf_limpo) == 11 else cpf_limpo)
    try:
        resultado_click = lookup.evaluate("""
            (d) => {
                const cpf = d.cpf; const fmt = d.fmt;

                // 1. tr.line é o seletor confirmado pelo SIGISS Ipatinga
                const lines = [...document.querySelectorAll('tr.line')];
                if (lines.length > 0) {
                    const target = lines.find(r => {
                        const t = r.textContent;
                        return t.includes(cpf) || t.includes(fmt);
                    }) || lines[0];
                    target.click();
                    return 'tr.line:' + target.textContent.substring(0, 80).trim();
                }

                // 2. Fallback genérico: qualquer tr com CPF
                const rows = [...document.querySelectorAll('table tr')];
                const byDoc = rows.find(r => {
                    const t = r.textContent;
                    return (t.includes(cpf) || t.includes(fmt)) && r.querySelectorAll('td').length > 0;
                });
                if (byDoc) { byDoc.click(); return 'tr_fallback:' + byDoc.textContent.substring(0, 80).trim(); }

                // 3. Primeira linha de dados
                const dataRow = rows.find(r => r.querySelectorAll('td').length > 0);
                if (dataRow) { dataRow.click(); return 'first_data_row:' + dataRow.textContent.substring(0, 80).trim(); }

                return 'nao_encontrado:' + rows.length + '_rows';
            }
        """, {"cpf": cpf_limpo, "fmt": cpf_fmt})
        print(f"  Click resultado lookup: {resultado_click}")
    except Exception as e:
        print(f"  Click resultado lookup JS erro: {e}")

    time.sleep(0.8)

    # Clica #btnOk — executa confirmSelection() que copia ccm e id_tomador para nfe.php
    # SEM esses campos no form, nfe_exec.php emite PFNI.
    ok_clicado = False
    for ok_sel in ['#btnOk', 'input#btnOk', 'button#btnOk',
                   'input[value="Ok"]', 'input[value="OK"]',
                   'button:has-text("Ok")', 'button:has-text("OK")']:
        try:
            loc = lookup.locator(ok_sel).first
            if loc.is_visible(timeout=2000):
                loc.click()
                ok_clicado = True
                print(f"  Clicou Ok no lookup ({ok_sel})")
                break
        except Exception:
            continue

    if not ok_clicado:
        print("  #btnOk não encontrado no lookup, tentando em todos os frames...")
        for ctx in _todos_frames(page):
            for ok_sel in ['#btnOk', 'input[value="Ok"]', 'button:has-text("Ok")']:
                try:
                    loc = ctx.locator(ok_sel).first
                    if loc.is_visible(timeout=1000):
                        loc.click()
                        ok_clicado = True
                        print(f"  Ok clicado no frame: {ctx.url[:60]}")
                        break
                except Exception:
                    continue
            if ok_clicado:
                break

    time.sleep(1.5)  # Aguarda confirmSelection() copiar campos para nfe.php

    # Verifica se id_tomador e ccm foram copiados para o form principal
    try:
        form2 = _frame_formulario(page)
        diag = form2.evaluate("""
            () => {
                const g = id => document.querySelector('#'+id)?.value
                             || document.querySelector('[name="'+id+'"]')?.value || '';
                return {
                    id_tomador: g('id_tomador'),
                    ccm: g('ccm'),
                    cnpj: g('cnpj'),
                    razao: g('razao'),
                };
            }
        """)
        print(f"  Form pós-lookup: id_tomador={diag.get('id_tomador')!r} "
              f"ccm={diag.get('ccm')!r} cnpj={diag.get('cnpj')!r} "
              f"razao={diag.get('razao')!r}")
        if not diag.get('id_tomador'):
            print("  AVISO: id_tomador vazio após Ok — confirmSelection pode não ter rodado!")
            if tomador_http:
                # Tenta chamar contribResult() — função nativa do nfe.php que recebe o
                # id completo "id_tomador<|>ccm<|>cnpj<|>nome" e preenche os campos.
                id_string = tomador_http.get('_id_string')
                injetou = False
                if id_string:
                    try:
                        cr = form2.evaluate("""
                            (id_str) => {
                                if (typeof contribResult === 'function') {
                                    contribResult(id_str);
                                    return 'OK:contribResult';
                                }
                                return 'NOT_FOUND';
                            }
                        """, id_string)
                        print(f"  contribResult: {cr}")
                        injetou = cr.startswith('OK:')
                    except Exception as e:
                        print(f"  contribResult erro: {e}")

                if not injetou:
                    # Fallback: inject campos individualmente
                    inject = {k: v for k, v in tomador_http.items()
                              if v and not k.startswith('_')}
                    inj_result = form2.evaluate("""
                        (d) => {
                            const changed = [];
                            Object.entries(d).forEach(([name, val]) => {
                                if (!val) return;
                                const el = document.getElementById(name)
                                    || document.querySelector('[name="' + name + '"]');
                                if (el) {
                                    el.value = val;
                                    ['input', 'change'].forEach(
                                        ev => el.dispatchEvent(new Event(ev, {bubbles: true}))
                                    );
                                    changed.push(name + '=' + val);
                                }
                            });
                            return changed.join(', ');
                        }
                    """, inject)
                    print(f"  Injeção direta: {inj_result}")
            else:
                print("  AVISO CRÍTICO: lookup falhou — nota pode sair como PFNI!")
    except Exception as e:
        print(f"  Aviso diagnóstico pós-lookup: {e}")


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

    # O modal Reforma Tributária reseta aliquota/aliquotaSimples/situacao após salvar.
    # O código já repreenche valor, mas esses campos ficam errados. Corrige aqui.
    if not form_data.get('aliquota') or form_data.get('aliquota') in ('0', '0.00', '0,00'):
        form_data['aliquota'] = '3.00'
        print("  [FIX] aliquota → 3.00")
    if not form_data.get('aliquotaSimples'):
        form_data['aliquotaSimples'] = nota.get('aliquota_simples', '4,3547')
        print(f"  [FIX] aliquotaSimples → {form_data['aliquotaSimples']}")
    if not form_data.get('situacao'):
        form_data['situacao'] = 'tp'
        print("  [FIX] situacao → tp")

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
        print(f"  Seguindo redirect → {redirect_url}  msg1={msg1_val!r}")
        try:
            r2 = session.post(
                redirect_url, data=redirect_data,
                headers={'Referer': post_url, 'Content-Type': 'application/x-www-form-urlencoded'},
                timeout=20, allow_redirects=True,
            )
            html_pagina2 = r2.text
            print(f"  Redirect resp: {len(html_pagina2)} chars")
            print(f"  Trecho2: {html_pagina2[:2000]}")
            # Loga todos os hrefs para encontrar URL de impressão/PDF
            hrefs2 = re.findall(r'href=["\']([^"\']+)["\']', html_pagina2, re.IGNORECASE)
            print(f"  Hrefs Trecho2: {hrefs2[:20]}")
        except Exception as e:
            print(f"  Aviso redirect: {e}")

    # Extrai número da nota — tenta html_pagina2 (nfe.php) primeiro, depois html (nfe_exec.php)
    # IMPORTANTE: não usar padrão genérico nota=(\d+) — captura campos hidden com valor "1"
    num_nota = ""
    for html_src in [html_pagina2, html]:
        for pattern in [
            r'[Nn][úu]mero[^\d]*(\d{3,})',     # "Número: 363" ou "Número da NFSe: 363"
            r'NFS[- ]?e[^\d]*(\d{3,})',          # "NFS-e 363" ou "NFSe363"
            r'n[ºo°°]\s*(\d{3,})',               # "nº 363"
            r'num_nfse[^\d]*(\d{3,})',            # campo num_nfse=363
            r'num_nota[^\d]*(\d{3,})',            # campo num_nota=363
            r'>\s*(\d{3,})\s*<',                 # número isolado entre tags (3+ dígitos)
        ]:
            m = re.search(pattern, html_src)
            if m:
                num_nota = m.group(1)
                print(f"  Número da nota: {num_nota} (padrão: {pattern})")
                break
        if num_nota:
            break

    # Tenta capturar URL de impressão/PDF — busca em html_pagina2 E html
    caminho = ""
    print_url = ""
    pdf_urls: list[str] = []
    for html_src in [html_pagina2, html]:
        pdf_urls += re.findall(r'href=["\']([^"\']*\.pdf[^"\']*)["\']', html_src, re.IGNORECASE)
        pdf_urls += re.findall(r'href=["\']([^"\']*imprimir[^"\']*)["\']', html_src, re.IGNORECASE)
        pdf_urls += re.findall(r'href=["\']([^"\']*download[^"\']*)["\']', html_src, re.IGNORECASE)
        pdf_urls += re.findall(r'href=["\']([^"\']*nfe_print[^"\']*)["\']', html_src, re.IGNORECASE)
        pdf_urls += re.findall(r'href=["\']([^"\']*nfse[^"\']*print[^"\']*)["\']', html_src, re.IGNORECASE)
    # Redirects JavaScript (location.href / window.location)
    js_locs = re.findall(
        r'''(?:window\.location|location\.href)\s*=\s*['"]([^'"]+)['"]''', html_pagina2 or html
    )
    pdf_urls += [u for u in js_locs if any(k in u for k in ('imprimir', 'pdf', 'nota', 'nfse', 'print'))]

    for url in pdf_urls[:3]:
        try:
            full_url = url if url.startswith('http') else base_url + '/' + url.lstrip('/')
            if not print_url:
                print_url = full_url  # guarda primeira URL encontrada como candidata
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

    # Se não baixou PDF, usa a URL de impressão como referência (stored in caminho_pdf)
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

    # Encontra botão Emitir no form frame
    emitir_loc = None
    for sel in [
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

    if not emitir_loc:
        raise RuntimeError("Botão Emitir NFSe não encontrado no form frame")

    # Captura resposta do nfe_exec.php via intercept (mesma sessão browser)
    html_exec = ""
    try:
        with page.expect_response(
            lambda r: 'nfe_exec' in r.url,
            timeout=20000,
        ) as resp_info:
            emitir_loc.click()
            print("  Clicou Emitir NFSe via Playwright")

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

    # Lê HTML do frame nfe.php após redirect (contém número da nota + link PDF)
    html_nfe = ""
    for f in page.frames:
        if f.url and 'nfe.php' in f.url and 'Componentes' not in f.url:
            try:
                html_nfe = f.content()
                print(f"  nfe.php pós-emissão ({len(html_nfe)} chars)")
                print(f"  Trecho nfe.php: {html_nfe[:2000]}")
                hrefs = re.findall(r'href=["\']([^"\']+)["\']', html_nfe)
                print(f"  Hrefs nfe.php: {hrefs[:20]}")
                break
            except Exception as e:
                print(f"  Aviso lendo nfe.php frame: {e}")

    # Verifica mensagem de erro
    for html_src in [html_nfe, html_exec]:
        if not html_src:
            continue
        m = re.search(r'name=["\']msg["\'][^>]*value=["\']([^"\']+)["\']', html_src)
        if not m:
            m = re.search(r'value=["\']([^"\']+)["\'][^>]*name=["\']msg["\']', html_src)
        if m and m.group(1).strip():
            raise RuntimeError(f"Prefeitura rejeitou: {m.group(1)}")

    # Extrai número da nota
    num_nota = ""
    for html_src in [html_nfe, html_exec]:
        if not html_src:
            continue
        for pattern in [
            r'[Nn][úu]mero[^\d]*(\d{3,})',
            r'NFS[- ]?e[^\d]*(\d{3,})',
            r'n[ºo°°]\s*(\d{3,})',
            r'num_nfse[^\d]*(\d{3,})',
            r'num_nota[^\d]*(\d{3,})',
            r'>\s*(\d{3,})\s*<',
        ]:
            m = re.search(pattern, html_src)
            if m:
                num_nota = m.group(1)
                print(f"  Número da nota: {num_nota} (padrão: {pattern})")
                break
        if num_nota:
            break

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
