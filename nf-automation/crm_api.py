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

def marcar_processando(nota_id):
    r = requests.patch(f'{CRM_API_URL}/api/notas-fiscais/{nota_id}',
                       json={'status': 'Processando'}, timeout=10)
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
                       }, timeout=10)
    r.raise_for_status()

def marcar_erro(nota_id, mensagem):
    r = requests.patch(f'{CRM_API_URL}/api/notas-fiscais/{nota_id}',
                       json={'status': 'Erro', 'erro_msg': mensagem}, timeout=10)
    r.raise_for_status()
