"""
diagnostico.py — mapeia campos reais do SIGISS sem emitir nada.
Salva screenshots em screenshots/ e imprime name/id de cada campo.
"""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

from config import SIGISS_LOGIN_URL, SIGISS_URL, ENTIDADES

OUT = Path(__file__).parent / "screenshots"
OUT.mkdir(exist_ok=True)


def shot(page, nome):
    p = OUT / f"{nome}.png"
    page.screenshot(path=str(p), full_page=True)
    print(f"  [screenshot] {p.name}")


def fechar_popup(page):
    """Tenta fechar qualquer popup/modal aberto (x ou Estou Ciente)."""
    for sel in [
        'button.close',
        '.modal-header .close',
        'button[aria-label="Close"]',
        'button:has-text("x")',
        'button:has-text("X")',
        '[data-dismiss="modal"]',
    ]:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=1500):
                loc.click()
                time.sleep(0.5)
                print(f"  Popup fechado via: {sel}")
                return True
        except Exception:
            continue
    for sel in ['button:has-text("Estou Ciente")', 'button:has-text("Estou ciente")']:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=1500):
                loc.click()
                time.sleep(0.5)
                print(f"  Popup 'Estou Ciente' fechado")
                return True
        except Exception:
            continue
    return False


def main():
    cfg = ENTIDADES["Vieira"]
    cnpj  = cfg["login"].replace(".", "").replace("/", "").replace("-", "")
    senha = cfg["senha"]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=150)
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()

        # ── 1. Login ──────────────────────────────────────────────────────────
        print("\n[1] Abrindo pagina de login...")
        page.goto(SIGISS_LOGIN_URL, timeout=30_000)
        page.wait_for_load_state("networkidle")
        time.sleep(1)
        fechar_popup(page)
        shot(page, "01_login")

        # Dump campos de login
        print("\n  Campos encontrados:")
        for c in page.query_selector_all("input, select"):
            print(f"    {c.evaluate('el=>el.tagName').lower():6s}  "
                  f"name={str(c.get_attribute('name') or ''):25s}  "
                  f"id={str(c.get_attribute('id') or ''):25s}  "
                  f"placeholder={str(c.get_attribute('placeholder') or '')!r}")

        # Preenche CNPJ e senha automaticamente
        for sel in ['input[name="login"]', 'input[id="login"]',
                    'input[placeholder*="CNPJ"]', 'input[placeholder*="nscri"]']:
            try:
                page.fill(sel, cnpj, timeout=2000)
                print(f"\n  CNPJ preenchido via: {sel}")
                break
            except Exception:
                continue

        for sel in ['input[name="senha"]', 'input[id="senha"]', 'input[type="password"]']:
            try:
                page.fill(sel, senha, timeout=2000)
                print(f"  Senha preenchida via: {sel}")
                break
            except Exception:
                continue

        # Pausa para captcha
        print("\n" + "="*55)
        print("  ATENCAO: Olhe o navegador aberto.")
        print("  Voce vera um captcha de 4 digitos.")
        captcha = input("  Digite os 4 digitos do captcha: ").strip()
        print("="*55)

        for sel in ['input[name="captcha"]', 'input[id="captcha"]',
                    'input[name*="cap"]', 'input:nth-of-type(3)']:
            try:
                page.fill(sel, captcha, timeout=2000)
                print(f"  Captcha preenchido via: {sel}")
                break
            except Exception:
                continue

        # Clica Acessar
        for sel in ['button:has-text("Acessar")', 'input[type="submit"]',
                    'button[type="submit"]', 'a:has-text("Acessar")']:
            try:
                page.click(sel, timeout=2000)
                print(f"  Submit via: {sel}")
                break
            except Exception:
                continue

        page.wait_for_load_state("networkidle")
        time.sleep(2)
        shot(page, "02_pos_login")
        print(f"  URL apos login: {page.url}")

        # ── 2. Fecha popups pos-login ─────────────────────────────────────────
        print("\n[2] Fechando popups...")
        for _ in range(4):   # pode aparecer ate 2 popups
            if not fechar_popup(page):
                break
            time.sleep(1)
        shot(page, "03_sem_popups")

        # ── 3. Navega para Emissao de NFSe ────────────────────────────────────
        print("\n[3] Navegando para Servicos Prestados > Emissao de NFSe...")
        try:
            page.click('a:has-text("Serviços Prestados"), a:has-text("Servicos Prestados")',
                       timeout=5000)
            time.sleep(0.8)
            shot(page, "04_menu_aberto")

            page.click('a:has-text("Emissão de Nfse"), a:has-text("Emissão de NFSe"), '
                       'a:has-text("Emitir NFS"), a:has-text("Emissao de Nfse")',
                       timeout=5000)
            time.sleep(1.5)
        except Exception as e:
            print(f"  Erro ao navegar no menu: {e}")

        page.wait_for_load_state("networkidle")
        shot(page, "05_form_emissao")
        print(f"  URL: {page.url}")

        # ── 4. Dump do formulario ─────────────────────────────────────────────
        print("\n  Todos os campos do formulario de emissao:")
        for c in page.query_selector_all("input, select, textarea"):
            tag  = c.evaluate('el=>el.tagName').lower()
            name = c.get_attribute('name') or ''
            cid  = c.get_attribute('id') or ''
            ph   = c.get_attribute('placeholder') or ''
            val  = c.get_attribute('value') or ''
            print(f"    {tag:8s}  name={name:30s}  id={cid:30s}  "
                  f"placeholder={ph!r:30s}  value={val!r}")

        # Labels
        print("\n  Labels do formulario:")
        for lbl in page.query_selector_all("label"):
            txt  = lbl.inner_text().strip()
            para = lbl.get_attribute('for') or ''
            if txt:
                print(f"    [{txt[:50]}] for={para!r}")

        # Botoes
        print("\n  Botoes:")
        for btn in page.query_selector_all("button, input[type=submit], input[type=button]"):
            txt = btn.inner_text().strip() if btn.evaluate('el=>el.tagName').lower()=="button" \
                  else (btn.get_attribute('value') or '')
            if txt:
                print(f"    [{txt[:50]}]")

        input("\n  Verifique o navegador. Pressione ENTER para fechar: ")
        ctx.close()
        browser.close()

    print(f"\nScreenshots em: {OUT}")


if __name__ == "__main__":
    main()
