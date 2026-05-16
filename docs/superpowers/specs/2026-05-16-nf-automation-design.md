# Design: Automacao NF — SIGISS Ipatinga + Google Drive + Easypanel

**Data:** 2026-05-16
**Status:** Aprovado pelo usuario, aguardando implementacao

---

## Contexto

A clinica tem automacao de emissao de Notas Fiscais de Servico (NFS-e) no site da
Prefeitura de Ipatinga (SIGISS / meumunicipio.online). O codigo Python + Playwright
ja existe em `nf-automation/`. O objetivo e migrar para Easypanel, salvar PDFs no
Google Drive e adicionar botao de disparo manual no CRM.

**Entidades:**
- Vieira (CNPJ 05617377000108) — credenciais SIGISS_AMA_LOGIN / SIGISS_AMA_SENHA
- Martins (CNPJ 33967625000186) — credenciais SIGISS_AUXILIUM_LOGIN / SIGISS_AUXILIUM_SENHA
- Receita Saude — sistema diferente (receita_saude.py), fora deste escopo

---

## Arquitetura

```
Easypanel — projeto plataformaama
  [plataforma]  Node.js CRM ──POST /processar──► [nf-worker] Python FastAPI
                  botao "Emitir NFs"              Playwright
                  link Drive por nota ◄─────────  SIGISS emissao
                  config pasta Drive              upload Google Drive
                       ▲                                ▲
                  Supabase DB                   Google Drive API
                  (notas, status,               (pasta configuravel
                   drive_link)                   por entidade)
```

Dois servicos no Easypanel dentro do mesmo projeto `plataformaama`:
- **plataforma** (ja existe): CRM Node.js
- **nf-worker** (novo): Python + FastAPI + Playwright

---

## Componentes

### 1. nf-worker (novo servico Easypanel)

Adicionar `api.py` ao `nf-automation/` com FastAPI:

```
POST /processar    body: { "entidade": "Vieira" | "Martins" | "all" }
                   retorna: { "job_id": "..." }
                   inicia processamento em background (asyncio task)

GET  /status       retorna: { "rodando": bool, "processadas": int,
                               "erros": int, "log": [...] }

GET  /health       liveness check para Easypanel
```

- Processa em background (nao bloqueia o HTTP response)
- CRM faz polling GET /status a cada 3s enquanto job roda
- Ao terminar, atualiza Supabase via CRM API com status + drive_link

### 2. Banco de dados (Supabase)

Adicionar campos na tabela `notas_fiscais` existente:
```sql
ALTER TABLE notas_fiscais
  ADD COLUMN IF NOT EXISTS drive_link     text,
  ADD COLUMN IF NOT EXISTS drive_file_id  text;
```

Nova tabela de configuracoes:
```sql
CREATE TABLE IF NOT EXISTS nf_config (
  entidade        text PRIMARY KEY,  -- 'Vieira' | 'Martins'
  drive_folder_id text NOT NULL,
  updated_at      timestamptz DEFAULT now()
);
```

### 3. Google Drive

- Usar a **mesma service account** ja configurada para gspread (planilhas)
- Compartilhar a pasta desejada do Drive com o email da service account (setup manual, uma vez)
- Biblioteca: `google-api-python-client` (adicionar ao requirements.txt)
- Fluxo: Playwright baixa PDF → nf-worker faz upload → retorna link para o CRM

O usuario configura a pasta pelo CRM: cola a URL do Drive → sistema extrai o folder_id.

### 4. CRM (alteracoes no plataforma existente)

- Botao "▶ Emitir NFs pendentes" na pagina de notas fiscais
- Escolha de entidade (Vieira / Martins / Todas)
- Progress indicator durante processamento (polling /status)
- Por nota: coluna com link do PDF no Drive apos emissao
- Settings page: campo "Pasta do Drive" por entidade (cola URL, extrai ID)

### 5. Diagnostico + fix do SIGISS

Antes de deployar, rodar localmente `python main.py` apontando para CRM no Easypanel
para identificar falhas. Suspeitos:

1. **Captcha** — ja usa Claude Vision (claude-haiku-4-5), precisa de ANTHROPIC_API_KEY no Easypanel
2. **Reforma Tributaria** — botao btnTributos via JS click, iframe com dropdown Select2
3. **CPF do tomador** — possivel ponto de falha nao confirmado
4. **CRM_API_URL** — ainda aponta para Railway; atualizar para URL Easypanel

---

## Deploy nf-worker no Easypanel

Dockerfile (baseado no existente, com Playwright):
```dockerfile
FROM python:3.11-slim
RUN pip install playwright && playwright install chromium --with-deps
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
```

Variaveis de ambiente no Easypanel:
- SIGISS_AMA_LOGIN / SIGISS_AMA_SENHA
- SIGISS_AUXILIUM_LOGIN / SIGISS_AUXILIUM_SENHA
- ANTHROPIC_API_KEY
- CRM_API_URL=http://plataforma:3000  (URL interna Easypanel)
- GOOGLE_SERVICE_ACCOUNT_JSON (JSON da service account em base64 ou string)

---

## Ordem de implementacao

1. Diagnostico local — rodar python main.py, anotar onde quebra
2. Corrigir bugs SIGISS encontrados (captcha, reforma tributaria, etc.)
3. Adicionar Google Drive upload em nf-automation/
4. Criar api.py (FastAPI) com endpoints /processar e /status
5. Criar Dockerfile funcional com Playwright headless
6. Deploy nf-worker no Easypanel
7. Alteracoes no CRM: botao, settings Drive, colunas na lista de NFs
8. Migracoes Supabase (drive_link, nf_config)
9. Teste end-to-end com nota real

---

## Decisoes tomadas

- **Sem cron** — disparo e 100% manual pelo botao no CRM (mais simples, suficiente)
- **Google Drive** — mesmo service account das planilhas, pasta configuravel por entidade
- **Dois servicos no Easypanel** — isolamento: CRM nao cai se worker travar
- **Polling simples** — CRM faz GET /status a cada 3s (sem WebSocket)