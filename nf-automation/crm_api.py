import base64
import time
import requests
from datetime import datetime
from config import CRM_API_URL

def listar_pendentes(sistema=None):
    params = {'status': 'Pendente'}
    if sistema:
        params['sistema'] = sistema
    r = requests.get(f'{CRM_API_URL}/api/notas-fiscais', params=params, timeout=10)
    r.raise_for_status()
    return r.json()

def listar_por_status(status, sistema=None):
    params = {'status': status}
    if sistema:
        params['sistema'] = sistema
    r = requests.get(f'{CRM_API_URL}/api/notas-fiscais', params=params, timeout=10)
    r.raise_for_status()
    return r.json()

def resetar_para_pendente(nota_id):
    r = requests.patch(f'{CRM_API_URL}/api/notas-fiscais/{nota_id}',
                       json={'status': 'Pendente', 'quem': 'sistema', 'erro_msg': ''}, timeout=10)
    r.raise_for_status()

def marcar_processando(nota_id):
    r = requests.patch(f'{CRM_API_URL}/api/notas-fiscais/{nota_id}',
                       json={'status': 'Processando', 'quem': 'sistema'}, timeout=10)
    r.raise_for_status()

def marcar_emitida(nota_id, num_nota, caminho_pdf):
    agora = datetime.now().strftime('%d/%m/%Y %H:%M')
    r = requests.patch(f'{CRM_API_URL}/api/notas-fiscais/{nota_id}',
                       json={
                           'status': 'Emitida',
                           'num_nota': str(num_nota),
                           'data_emissao': agora,
                           'caminho_pdf': caminho_pdf,
                           'erro_msg': '',
                           'quem': 'sistema',
                       }, timeout=10)
    r.raise_for_status()

def marcar_erro(nota_id, mensagem):
    r = requests.patch(f'{CRM_API_URL}/api/notas-fiscais/{nota_id}',
                       json={'status': 'Erro', 'erro_msg': mensagem, 'quem': 'sistema'}, timeout=10)
    r.raise_for_status()


def solicitar_captcha_manual(img_bytes: bytes, timeout_s: int = 90) -> str:
    """Envia captcha ao CRM para digitação manual. Aguarda até timeout_s segundos."""
    img_b64 = base64.b64encode(img_bytes).decode()
    r = requests.post(f'{CRM_API_URL}/api/nf-captcha',
                      json={'img_b64': img_b64}, timeout=10)
    r.raise_for_status()
    token = r.json().get('token', '')
    if not token:
        return ""

    print(f"  Captcha enviado ao CRM (token {token[:8]}). Aguardando até {timeout_s}s...")
    for _ in range(timeout_s // 2):
        time.sleep(2)
        try:
            r2 = requests.get(f'{CRM_API_URL}/api/nf-captcha/{token}/aguardar', timeout=5)
            if r2.ok:
                data = r2.json()
                if data.get('ok'):
                    digits = ''.join(c for c in str(data.get('digitos', '')) if c.isdigit())[:4]
                    print(f"  Captcha recebido do CRM: {digits}")
                    return digits if len(digits) == 4 else ""
                if data.get('expirado'):
                    return ""
        except Exception:
            continue
    return ""
