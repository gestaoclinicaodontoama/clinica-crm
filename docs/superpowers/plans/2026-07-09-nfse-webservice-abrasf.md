# Motor NFS-e via WebService ABRASF — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o robô Playwright (serviço `nf-agente`) por emissão de NFS-e direto do CRM Node via webservice ABRASF 2.04 oficial de Ipatinga (SigCorp), com cancelamento e upload de PDF ao Google Drive.

**Architecture:** Módulo `lib/nfse/` (montar XML → assinar se necessário → SOAP POST → parse retorno → estados no Supabase), rotas novas em `server.js`, UI atual da SPA adaptada (mesma tela/polling). Idempotência por número de RPS próprio + `ConsultarNfsePorRps` antes de reenvio.

**Tech Stack:** Node 18+ (fetch nativo), Express, Supabase (service_role), `node --test`. Sem libs novas exceto (condicional à POC) `xml-crypto` + `node-forge` para assinatura A1.

**Spec:** `docs/superpowers/specs/2026-07-09-nfse-webservice-abrasf-design.md`

## Global Constraints

- Front é vanilla JS na SPA `public/index.html` (página `notas-fiscais`) — sem framework.
- Toda tabela nova: `ENABLE ROW LEVEL SECURITY` na mesma migração; sem policy (acesso só via servidor/service_role).
- Toda função SQL nova: `REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role;`
- Rotas novas: `requireAuth` ANTES de `requireRole('admin','gestor','mod_notas_fiscais')` (cancelar: só `admin`,`gestor`).
- Nunca somar/filtrar >1000 linhas no client Supabase — filtros no SQL (volume de NF é pequeno, mas manter `.limit()` explícito).
- Nunca logar senha de certificado nem conteúdo do PFX.
- Segredos só em env (Easypanel): `NFSE_AMBIENTE`, `NFSE_CERT_VIEIRA_B64/SENHA`, `NFSE_CERT_MARTINS_B64/SENHA`, `GOOGLE_SA_JSON_B64`.
- Endpoints Ipatinga: produção `https://abrasfipatinga.meumunicipio.online/ws` · homologação `https://testeipatingaabrasf.meumunicipio.online/ws`. SOAP **document/literal**; operação recebe o XML ABRASF como **string** em `<GerarNfse xmlns="<URL do ambiente>"><xml>…</xml></GerarNfse>`; `SOAPAction: "ws#GerarNfse"`. ⚠️ O namespace do body = URL do ambiente (muda entre homolog/prod).
- Testes: `node --test "lib/**/*.test.js"` (padrão da casa; arquivos `*.test.js` ao lado do código).
- Deploy: `git push` → `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"` (CRM). Serviço nf-agente NÃO recebe mais deploy.
- Git: trabalhar em branch `nfse-ws` criada de `origin/main` (working dir da main é compartilhado com outra sessão — usar worktree).

---

### Task 1: POC em homologação (resolve as incógnitas — GATE do resto)

A POC é um script descartável que responde: (a) o WS aceita `GerarNfse` sem assinatura digital? (b) precisa de cadastro prévio do CNPJ em homologação? (c) formato de alíquota (`3.00` ou `0.03`)? (d) onde entram `cNBS`/`IBSCBS`? (e) o retorno traz link de DANFSE/PDF? (f) a consulta pública do DANFSE funciona sem login?

**Files:**
- Create: `scripts/poc-nfse-homolog.js`
- Create: `docs/superpowers/specs/2026-07-09-nfse-poc-achados.md` (achados)

**Interfaces:**
- Produces: decisões registradas no arquivo de achados — em especial `PRECISA_ASSINATURA: sim|não`, formato de alíquota, e o XML mínimo aceito. As Tasks 3-6 leem esse arquivo antes de começar.

- [ ] **Step 1: Escrever o script da POC**

```js
// scripts/poc-nfse-homolog.js — POC DESCARTÁVEL. Não importar em produção.
// Uso: node scripts/poc-nfse-homolog.js [gerar|consultar]
require('dotenv').config();

const HOMOLOG = 'https://testeipatingaabrasf.meumunicipio.online/ws';
const NS = HOMOLOG; // targetNamespace do WSDL = URL do ambiente

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function envelope(operacao, xmlInterno) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><${operacao} xmlns="${NS}"><xml><![CDATA[${xmlInterno}]]></xml></${operacao}></soap:Body>` +
    `</soap:Envelope>`;
}

// GerarNfseEnvio ABRASF 2.04 mínimo — Vieira, tomador fictício, R$ 1,00
function xmlGerarMinimo() {
  const hoje = new Date().toISOString().slice(0, 10);
  return `<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">` +
    `<Rps><InfDeclaracaoPrestacaoServico Id="rps1">` +
    `<Rps><IdentificacaoRps><Numero>1</Numero><Serie>1</Serie><Tipo>1</Tipo></IdentificacaoRps>` +
    `<DataEmissao>${hoje}</DataEmissao><Status>1</Status></Rps>` +
    `<Competencia>${hoje}</Competencia>` +
    `<Servico><Valores><ValorServicos>1.00</ValorServicos><Aliquota>3.00</Aliquota></Valores>` +
    `<IssRetido>2</IssRetido><ItemListaServico>4.12</ItemListaServico>` +
    `<Discriminacao>TESTE POC - nao valido</Discriminacao>` +
    `<CodigoMunicipio>3131307</CodigoMunicipio><ExigibilidadeISS>1</ExigibilidadeISS></Servico>` +
    `<Prestador><CpfCnpj><Cnpj>05617377000108</Cnpj></CpfCnpj>` +
    `<InscricaoMunicipal>${esc(process.env.POC_IM_VIEIRA || '106657')}</InscricaoMunicipal></Prestador>` +
    `<Tomador><IdentificacaoTomador><CpfCnpj><Cpf>11144477735</Cpf></CpfCnpj></IdentificacaoTomador>` +
    `<RazaoSocial>Tomador Teste POC</RazaoSocial></Tomador>` +
    `<OptanteSimplesNacional>1</OptanteSimplesNacional><IncentivoFiscal>2</IncentivoFiscal>` +
    `</InfDeclaracaoPrestacaoServico></Rps></GerarNfseEnvio>`;
}

// ConsultarNfseFaixaEnvio — leitura, sem efeito colateral (bom 1º teste de auth)
function xmlConsultaFaixa() {
  return `<ConsultarNfseFaixaEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">` +
    `<Prestador><CpfCnpj><Cnpj>05617377000108</Cnpj></CpfCnpj>` +
    `<InscricaoMunicipal>${esc(process.env.POC_IM_VIEIRA || '106657')}</InscricaoMunicipal></Prestador>` +
    `<Faixa><NumeroNfseInicial>1</NumeroNfseInicial><NumeroNfseFinal>1</NumeroNfseFinal></Faixa>` +
    `<Pagina>1</Pagina></ConsultarNfseFaixaEnvio>`;
}

async function chamar(operacao, xmlInterno) {
  const body = envelope(operacao, xmlInterno);
  console.log(`\n===== ${operacao} =====`);
  const r = await fetch(HOMOLOG, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"ws#${operacao}"` },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const texto = await r.text();
  console.log('HTTP', r.status);
  console.log(texto.slice(0, 4000));
  return texto;
}

(async () => {
  const modo = process.argv[2] || 'consultar';
  if (modo === 'consultar') await chamar('ConsultarNfseFaixa', xmlConsultaFaixa());
  else await chamar('GerarNfse', xmlGerarMinimo());
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
```

- [ ] **Step 2: Rodar a consulta (leitura) sem assinatura**

Run: `node scripts/poc-nfse-homolog.js consultar`
Expected: resposta XML da prefeitura. Anotar: veio `ListaMensagemRetorno` com erro de autenticação/assinatura (ex.: E92/E225) ou resposta de consulta normal?

- [ ] **Step 3: Rodar o GerarNfse mínimo sem assinatura**

Run: `node scripts/poc-nfse-homolog.js gerar`
Expected: ou nota de teste gerada (retorno com `<Numero>` + `<CodigoVerificacao>`) ou lista de erros. Cada código de erro retornado vai para o arquivo de achados com o texto oficial.

- [ ] **Step 4: Se exigir assinatura, repetir assinado**

Se o retorno pedir assinatura digital: instalar `npm i xml-crypto node-forge`, obter o `.pfx` de teste com o Luiz/contador (`NFSE_CERT_VIEIRA_B64` + senha no `.env` local), assinar `InfDeclaracaoPrestacaoServico` (ver código de `lib/nfse/assinar.js` na Task 5 — a POC pode copiar a função) e repetir o Step 3.
Expected: nota de homologação gerada. Anotar exatamente QUAIS elementos precisaram de assinatura (só `InfDeclaracaoPrestacaoServico`, ou também a raiz `GerarNfseEnvio`).

- [ ] **Step 5: Testar acesso público ao DANFSE**

Com o número + código de verificação retornados, testar no browser (sem login):
`https://ipatinga.meumunicipio.online/ISS/nfe_verifica.php` (página de verificação pública do SIGISS — o caminho exato aparece no rodapé do DANFSE/portal; anotar a URL que funcionar com numero+código).
Expected: PDF/página da nota acessível sem sessão → esse é o `caminho_pdf`. Se NÃO houver acesso público, registrar no arquivo de achados: `PDF: gerar DANFSE própria` (decisão da Task 8).

- [ ] **Step 6: Escrever os achados e commitar**

Criar `docs/superpowers/specs/2026-07-09-nfse-poc-achados.md` com: `PRECISA_ASSINATURA`, elementos assinados, formato de alíquota aceito, campos obrigatórios além do mínimo (mensagens de erro reais), posição aceita de `cNBS`/`IBSCBS` (testar incluí-los se o WS rejeitar a ausência), URL pública do DANFSE, e o XML mínimo completo que foi ACEITO (colar íntegro).

```bash
git add scripts/poc-nfse-homolog.js docs/superpowers/specs/2026-07-09-nfse-poc-achados.md
git commit -m "poc(nfse): homologacao ABRASF Ipatinga - achados de auth/assinatura/danfse"
```

---

### Task 2: Migração de banco (colunas + emissores + sequência de RPS)

**Files:**
- Create: `supabase/migrations/20260710090000_nfse_ws.sql` (aplicar via MCP Supabase, projeto `mtqdpjhhqzvuklnlfpvi`)

**Interfaces:**
- Produces: tabelas `nf_emissores`, `nf_rps_seq`; função `nf_reservar_rps(p_sistema text) returns int`; colunas novas em `notas_fiscais` (`rps_numero int`, `rps_serie text`, `codigo_verificacao text`, `xml_envio text`, `xml_retorno text`, `ambiente text`, `drive_link text`). Tasks 3-7 dependem desses nomes exatos.

- [ ] **Step 1: Escrever a migração**

```sql
-- 20260710090000_nfse_ws.sql
alter table public.notas_fiscais
  add column if not exists rps_numero int,
  add column if not exists rps_serie text not null default '1',
  add column if not exists codigo_verificacao text,
  add column if not exists xml_envio text,
  add column if not exists xml_retorno text,
  add column if not exists ambiente text not null default 'producao',
  add column if not exists drive_link text;

create table if not exists public.nf_emissores (
  sistema text primary key,              -- 'Vieira' | 'Martins'
  razao_social text not null,
  cnpj text not null,
  inscricao_municipal text not null,
  regime_tributario int not null default 6,   -- código ABRASF (6 = Simples Nacional ME/EPP)
  optante_simples int not null default 1,     -- 1=sim 2=não
  item_lista_servico text not null default '4.12',
  cnae text,
  codigo_tributacao_municipio text,
  aliquota numeric not null default 3.00,
  aliquota_simples numeric,
  cnbs text default '123012300',
  descricao_padrao text default 'Serviços odontológicos',
  drive_folder_id text,
  ativo boolean not null default true
);
alter table public.nf_emissores enable row level security;

create table if not exists public.nf_rps_seq (
  sistema text primary key references public.nf_emissores(sistema),
  proximo_rps int not null default 1
);
alter table public.nf_rps_seq enable row level security;

create or replace function public.nf_reservar_rps(p_sistema text)
returns int language sql security definer set search_path = public as $$
  update public.nf_rps_seq set proximo_rps = proximo_rps + 1
  where sistema = p_sistema
  returning proximo_rps - 1;
$$;
revoke all on function public.nf_reservar_rps(text) from public, anon, authenticated;
grant execute on function public.nf_reservar_rps(text) to service_role;

insert into public.nf_emissores (sistema, razao_social, cnpj, inscricao_municipal) values
  ('Vieira',  'Vieira e Vidigal Martins LTDA', '05617377000108', 'PREENCHER_IM_VIEIRA'),
  ('Martins', 'Clinica Odontologica Martins',  '33967625000186', 'PREENCHER_IM_MARTINS')
on conflict (sistema) do nothing;

insert into public.nf_rps_seq (sistema) values ('Vieira'), ('Martins')
on conflict (sistema) do nothing;
```

⚠️ As inscrições municipais reais: pegar do portal SIGISS (aparecem logado; o robô antigo usava `ccm=-106657` para a Vieira — confirmar o valor sem o sinal) e atualizar via `update nf_emissores set inscricao_municipal=... where sistema=...` na mesma sessão de aplicação. A POC (Task 1) já validou a da Vieira.

- [ ] **Step 2: Aplicar via MCP Supabase e verificar**

Aplicar com `apply_migration`; depois `list_migrations` (deve listar `nfse_ws`) e
`execute_sql`: `select sistema, proximo_rps from nf_rps_seq; select public.nf_reservar_rps('Vieira'); select proximo_rps from nf_rps_seq where sistema='Vieira';`
Expected: reserva retorna 1 e `proximo_rps` vira 2.

- [ ] **Step 3: Desfazer o consumo do teste e commitar**

`execute_sql`: `update nf_rps_seq set proximo_rps = 1 where sistema = 'Vieira';`

```bash
git add supabase/migrations/20260710090000_nfse_ws.sql
git commit -m "feat(nfse): migracao - emissores, sequencia RPS, colunas de auditoria"
```

---

### Task 3: `lib/nfse/montar-xml.js` — geração do XML ABRASF

**Files:**
- Create: `lib/nfse/montar-xml.js`
- Test: `lib/nfse/montar-xml.test.js`

**Interfaces:**
- Consumes: achados da POC (formato de alíquota, posição do cNBS — ajustar template conforme o XML aceito registrado na POC).
- Produces: `montarGerarNfseEnvio(nota, emissor, rps) -> string`, `montarCancelarNfseEnvio({ numeroNfse, emissor, codigoCancelamento }) -> string`, `montarConsultarNfsePorRpsEnvio({ rpsNumero, rpsSerie, emissor }) -> string`, `escapeXml(s) -> string`. `nota` = linha de `notas_fiscais`; `emissor` = linha de `nf_emissores`.

- [ ] **Step 1: Escrever os testes que falham**

```js
// lib/nfse/montar-xml.test.js
const test = require('node:test');
const assert = require('node:assert');
const { montarGerarNfseEnvio, montarCancelarNfseEnvio, escapeXml } = require('./montar-xml');

const emissor = {
  sistema: 'Vieira', razao_social: 'Vieira e Vidigal Martins LTDA', cnpj: '05617377000108',
  inscricao_municipal: '106657', optante_simples: 1, item_lista_servico: '4.12',
  aliquota: 3.00, cnbs: '123012300', descricao_padrao: 'Serviços odontológicos',
};
const nota = {
  id: 42, sistema: 'Vieira', competencia: '07-2026', tipo_tomador: 'CPF',
  cpf_tomador: '11144477735', nome_tomador: 'Maria & Silva <Teste>',
  data_pagamento: '2026-07-05', valor: 395.62, descricao: 'Tratamento odontológico',
};

test('gera GerarNfseEnvio com RPS, competência e valores formatados', () => {
  const xml = montarGerarNfseEnvio(nota, emissor, { numero: 7, serie: '1' });
  assert.match(xml, /<GerarNfseEnvio xmlns="http:\/\/www\.abrasf\.org\.br\/nfse\.xsd">/);
  assert.match(xml, /<IdentificacaoRps><Numero>7<\/Numero><Serie>1<\/Serie><Tipo>1<\/Tipo>/);
  assert.match(xml, /<Competencia>2026-07-01<\/Competencia>/);      // MM-AAAA → AAAA-MM-01
  assert.match(xml, /<ValorServicos>395\.62<\/ValorServicos>/);      // ponto decimal, 2 casas
  assert.match(xml, /<Cnpj>05617377000108<\/Cnpj>/);
  assert.match(xml, /<Cpf>11144477735<\/Cpf>/);                      // tomador PF
  assert.match(xml, /Maria &amp; Silva &lt;Teste&gt;/);              // escape XML
  assert.match(xml, /<CodigoMunicipio>3131307<\/CodigoMunicipio>/);
});

test('tomador CNPJ usa <Cnpj> e valida 14 dígitos', () => {
  const xml = montarGerarNfseEnvio({ ...nota, tipo_tomador: 'CNPJ', cpf_tomador: '19876424000142' }, emissor, { numero: 8, serie: '1' });
  assert.match(xml, /<IdentificacaoTomador><CpfCnpj><Cnpj>19876424000142<\/Cnpj>/);
});

test('valor inválido ou CPF com tamanho errado lança erro claro', () => {
  assert.throws(() => montarGerarNfseEnvio({ ...nota, valor: 0 }, emissor, { numero: 9, serie: '1' }), /valor/i);
  assert.throws(() => montarGerarNfseEnvio({ ...nota, cpf_tomador: '123' }, emissor, { numero: 9, serie: '1' }), /CPF/i);
});

test('CancelarNfseEnvio inclui numero, prestador e código de cancelamento', () => {
  const xml = montarCancelarNfseEnvio({ numeroNfse: '412', emissor, codigoCancelamento: '2' });
  assert.match(xml, /<Numero>412<\/Numero>/);
  assert.match(xml, /<CodigoCancelamento>2<\/CodigoCancelamento>/);
});

test('escapeXml cobre & < > " \'', () => {
  assert.strictEqual(escapeXml(`a&b<c>"d'`), 'a&amp;b&lt;c&gt;&quot;d&#39;');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/nfse/montar-xml.test.js`
Expected: FAIL — `Cannot find module './montar-xml'`.

- [ ] **Step 3: Implementar**

```js
// lib/nfse/montar-xml.js — gera os XMLs ABRASF 2.04 (padrão SigCorp/Ipatinga).
// ⚠️ Ajustar template ao XML ACEITO registrado em docs/superpowers/specs/2026-07-09-nfse-poc-achados.md
const NS = 'http://www.abrasf.org.br/nfse.xsd';
const COD_MUNICIPIO = '3131307'; // IBGE Ipatinga

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _valor(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  if (!n || n <= 0 || !isFinite(n)) throw new Error(`valor inválido: ${v}`);
  return n.toFixed(2);
}

function _competencia(mmaaaa) {
  const m = /^(\d{2})-(\d{4})$/.exec(String(mmaaaa || ''));
  if (!m) throw new Error(`competência inválida (esperado MM-AAAA): ${mmaaaa}`);
  return `${m[2]}-${m[1]}-01`;
}

function _tomadorDoc(nota) {
  const doc = String(nota.cpf_tomador || '').replace(/\D/g, '');
  if (nota.tipo_tomador === 'CNPJ') {
    if (doc.length !== 14) throw new Error(`CNPJ do tomador deve ter 14 dígitos: ${doc}`);
    return `<Cnpj>${doc}</Cnpj>`;
  }
  if (doc.length !== 11) throw new Error(`CPF do tomador deve ter 11 dígitos: ${doc}`);
  return `<Cpf>${doc}</Cpf>`;
}

function _prestador(emissor) {
  return `<Prestador><CpfCnpj><Cnpj>${emissor.cnpj}</Cnpj></CpfCnpj>` +
    `<InscricaoMunicipal>${escapeXml(emissor.inscricao_municipal)}</InscricaoMunicipal></Prestador>`;
}

function montarGerarNfseEnvio(nota, emissor, rps) {
  const hoje = new Date().toISOString().slice(0, 10);
  const valor = _valor(nota.valor);
  const discriminacao = escapeXml(nota.descricao || emissor.descricao_padrao || 'Serviços odontológicos');
  return `<GerarNfseEnvio xmlns="${NS}">` +
    `<Rps><InfDeclaracaoPrestacaoServico Id="rps${rps.numero}">` +
    `<Rps><IdentificacaoRps><Numero>${rps.numero}</Numero><Serie>${escapeXml(rps.serie)}</Serie><Tipo>1</Tipo></IdentificacaoRps>` +
    `<DataEmissao>${hoje}</DataEmissao><Status>1</Status></Rps>` +
    `<Competencia>${_competencia(nota.competencia)}</Competencia>` +
    `<Servico><Valores><ValorServicos>${valor}</ValorServicos>` +
    `<Aliquota>${Number(emissor.aliquota).toFixed(2)}</Aliquota></Valores>` +
    `<IssRetido>2</IssRetido>` +
    `<ItemListaServico>${escapeXml(emissor.item_lista_servico)}</ItemListaServico>` +
    (emissor.codigo_tributacao_municipio ? `<CodigoTributacaoMunicipio>${escapeXml(emissor.codigo_tributacao_municipio)}</CodigoTributacaoMunicipio>` : '') +
    `<Discriminacao>${discriminacao}</Discriminacao>` +
    `<CodigoMunicipio>${COD_MUNICIPIO}</CodigoMunicipio><ExigibilidadeISS>1</ExigibilidadeISS></Servico>` +
    _prestador(emissor) +
    `<Tomador><IdentificacaoTomador><CpfCnpj>${_tomadorDoc(nota)}</CpfCnpj></IdentificacaoTomador>` +
    `<RazaoSocial>${escapeXml(nota.nome_tomador)}</RazaoSocial></Tomador>` +
    `<OptanteSimplesNacional>${emissor.optante_simples}</OptanteSimplesNacional><IncentivoFiscal>2</IncentivoFiscal>` +
    `</InfDeclaracaoPrestacaoServico></Rps></GerarNfseEnvio>`;
}

function montarCancelarNfseEnvio({ numeroNfse, emissor, codigoCancelamento }) {
  return `<CancelarNfseEnvio xmlns="${NS}"><Pedido><InfPedidoCancelamento Id="canc${numeroNfse}">` +
    `<IdentificacaoNfse><Numero>${escapeXml(numeroNfse)}</Numero>` +
    `<CpfCnpj><Cnpj>${emissor.cnpj}</Cnpj></CpfCnpj>` +
    `<InscricaoMunicipal>${escapeXml(emissor.inscricao_municipal)}</InscricaoMunicipal>` +
    `<CodigoMunicipio>${COD_MUNICIPIO}</CodigoMunicipio></IdentificacaoNfse>` +
    `<CodigoCancelamento>${escapeXml(codigoCancelamento)}</CodigoCancelamento>` +
    `</InfPedidoCancelamento></Pedido></CancelarNfseEnvio>`;
}

function montarConsultarNfsePorRpsEnvio({ rpsNumero, rpsSerie, emissor }) {
  return `<ConsultarNfseRpsEnvio xmlns="${NS}">` +
    `<IdentificacaoRps><Numero>${rpsNumero}</Numero><Serie>${escapeXml(rpsSerie)}</Serie><Tipo>1</Tipo></IdentificacaoRps>` +
    _prestador(emissor) + `</ConsultarNfseRpsEnvio>`;
}

module.exports = { montarGerarNfseEnvio, montarCancelarNfseEnvio, montarConsultarNfsePorRpsEnvio, escapeXml };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/nfse/montar-xml.test.js`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/nfse/montar-xml.js lib/nfse/montar-xml.test.js
git commit -m "feat(nfse): montar-xml - GerarNfse/Cancelar/ConsultarPorRps ABRASF 2.04"
```

---

### Task 4: `lib/nfse/cliente.js` — transporte SOAP + parse do retorno

**Files:**
- Create: `lib/nfse/cliente.js`
- Test: `lib/nfse/cliente.test.js`

**Interfaces:**
- Produces:
  - `chamarWs(operacao, xmlInterno, opts?) -> Promise<string>` (corpo XML interno da resposta; lança `NfseComunicacaoError` em timeout/HTTP≠200; `opts.fetchImpl` injetável p/ teste)
  - `parseGerarNfse(xmlResp) -> { ok:true, numero, codigoVerificacao, dataEmissao } | { ok:false, erros:[{codigo,mensagem}] }`
  - `parseCancelarNfse(xmlResp) -> { ok:true, dataCancelamento } | { ok:false, erros }`
  - `parseConsultarPorRps(xmlResp) -> { existe:true, numero, codigoVerificacao, dataEmissao } | { existe:false, erros }`
  - `class NfseComunicacaoError extends Error` (marca "não sei se chegou" → reconciliar)
  - Ambiente: `process.env.NFSE_AMBIENTE === 'producao'` → URL/NS de produção; qualquer outro valor → homologação.

- [ ] **Step 1: Escrever os testes que falham**

```js
// lib/nfse/cliente.test.js
const test = require('node:test');
const assert = require('node:assert');
const { chamarWs, parseGerarNfse, parseConsultarPorRps, NfseComunicacaoError } = require('./cliente');

function fakeFetch(status, texto) {
  return async (url, init) => ({ status, ok: status === 200, text: async () => texto, _url: url, _init: init });
}

test('chamarWs monta envelope com CDATA, SOAPAction e namespace de homologação', async () => {
  let capturado;
  const f = async (url, init) => { capturado = { url, init }; return { status: 200, ok: true, text: async () => '<resp/>' }; };
  await chamarWs('GerarNfse', '<GerarNfseEnvio/>', { fetchImpl: f });
  assert.strictEqual(capturado.url, 'https://testeipatingaabrasf.meumunicipio.online/ws');
  assert.strictEqual(capturado.init.headers.SOAPAction, '"ws#GerarNfse"');
  assert.match(capturado.init.body, /<GerarNfse xmlns="https:\/\/testeipatingaabrasf\.meumunicipio\.online\/ws"><xml><!\[CDATA\[<GerarNfseEnvio\/>\]\]><\/xml><\/GerarNfse>/);
});

test('chamarWs lança NfseComunicacaoError em HTTP 500', async () => {
  await assert.rejects(
    chamarWs('GerarNfse', '<x/>', { fetchImpl: fakeFetch(500, 'erro interno') }),
    NfseComunicacaoError
  );
});

test('parseGerarNfse extrai numero + codigo de verificacao', () => {
  const xml = `<GerarNfseResposta><ListaNfse><CompNfse><Nfse><InfNfse>` +
    `<Numero>412</Numero><CodigoVerificacao>AB12-CD34</CodigoVerificacao>` +
    `<DataEmissao>2026-07-10T10:00:00</DataEmissao></InfNfse></Nfse></CompNfse></ListaNfse></GerarNfseResposta>`;
  const r = parseGerarNfse(xml);
  assert.deepStrictEqual(r, { ok: true, numero: '412', codigoVerificacao: 'AB12-CD34', dataEmissao: '2026-07-10T10:00:00' });
});

test('parseGerarNfse extrai lista de erros', () => {
  const xml = `<GerarNfseResposta><ListaMensagemRetorno><MensagemRetorno>` +
    `<Codigo>E160</Codigo><Mensagem>CPF invalido</Mensagem><Correcao>Informe um CPF valido</Correcao>` +
    `</MensagemRetorno></ListaMensagemRetorno></GerarNfseResposta>`;
  const r = parseGerarNfse(xml);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.erros, [{ codigo: 'E160', mensagem: 'CPF invalido. Informe um CPF valido' }]);
});

test('parseConsultarPorRps: nota existe / nao existe', () => {
  const existe = parseConsultarPorRps(`<x><InfNfse><Numero>77</Numero><CodigoVerificacao>ZZ</CodigoVerificacao><DataEmissao>2026-07-10</DataEmissao></InfNfse></x>`);
  assert.strictEqual(existe.existe, true);
  assert.strictEqual(existe.numero, '77');
  const nao = parseConsultarPorRps(`<x><ListaMensagemRetorno><MensagemRetorno><Codigo>E92</Codigo><Mensagem>RPS nao encontrado</Mensagem></MensagemRetorno></ListaMensagemRetorno></x>`);
  assert.strictEqual(nao.existe, false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/nfse/cliente.test.js`
Expected: FAIL — `Cannot find module './cliente'`.

- [ ] **Step 3: Implementar**

```js
// lib/nfse/cliente.js — transporte SOAP (document/literal, xml como string) + parse dos retornos.
// Respostas ABRASF são pequenas e de esquema fixo → extração por regex tolerante
// (decisão consciente: zero dependência de parser XML; o conteúdo vem escapado dentro do <return>).
const ENDPOINTS = {
  producao: 'https://abrasfipatinga.meumunicipio.online/ws',
  homologacao: 'https://testeipatingaabrasf.meumunicipio.online/ws',
};

class NfseComunicacaoError extends Error {}

function _ambiente() { return process.env.NFSE_AMBIENTE === 'producao' ? 'producao' : 'homologacao'; }
function urlWs() { return ENDPOINTS[_ambiente()]; }

function _desescapar(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function _tag(xml, nome) {
  const m = new RegExp(`<(?:\\w+:)?${nome}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${nome}>`).exec(xml);
  return m ? m[1].trim() : null;
}

function _todas(xml, nome) {
  const re = new RegExp(`<(?:\\w+:)?${nome}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${nome}>`, 'g');
  const out = []; let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

async function chamarWs(operacao, xmlInterno, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const url = urlWs();
  const body = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${operacao} xmlns="${url}"><xml><![CDATA[${xmlInterno}]]></xml></${operacao}>` +
    `</soap:Body></soap:Envelope>`;
  let resp;
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"ws#${operacao}"` },
      body,
      signal: AbortSignal.timeout(parseInt(process.env.NFSE_TIMEOUT_MS || '45000', 10)),
    });
  } catch (e) {
    throw new NfseComunicacaoError(`falha de rede/timeout em ${operacao}: ${e.message}`);
  }
  const texto = await resp.text();
  if (resp.status !== 200) throw new NfseComunicacaoError(`HTTP ${resp.status} em ${operacao}: ${texto.slice(0, 300)}`);
  // resposta vem no <return> (ou direto no body); pode vir escapada
  const interno = _tag(texto, 'return') ?? texto;
  return interno.includes('&lt;') ? _desescapar(interno) : interno;
}

function _erros(xml) {
  return _todas(xml, 'MensagemRetorno').map((bloco) => {
    const codigo = _tag(bloco, 'Codigo') || '?';
    const msg = _tag(bloco, 'Mensagem') || 'erro não informado';
    const corr = _tag(bloco, 'Correcao');
    return { codigo, mensagem: corr ? `${msg}. ${corr}` : msg };
  });
}

function parseGerarNfse(xml) {
  const inf = _tag(xml, 'InfNfse');
  if (inf) {
    return { ok: true, numero: _tag(inf, 'Numero'), codigoVerificacao: _tag(inf, 'CodigoVerificacao'), dataEmissao: _tag(inf, 'DataEmissao') };
  }
  const erros = _erros(xml);
  return { ok: false, erros: erros.length ? erros : [{ codigo: '?', mensagem: `resposta sem InfNfse nem erros: ${xml.slice(0, 200)}` }] };
}

function parseCancelarNfse(xml) {
  const conf = _tag(xml, 'Confirmacao') ?? _tag(xml, 'RetCancelamento');
  if (conf !== null) return { ok: true, dataCancelamento: _tag(xml, 'DataHora') || new Date().toISOString() };
  const erros = _erros(xml);
  if (erros.length) return { ok: false, erros };
  return { ok: false, erros: [{ codigo: '?', mensagem: `resposta inesperada: ${xml.slice(0, 200)}` }] };
}

function parseConsultarPorRps(xml) {
  const inf = _tag(xml, 'InfNfse');
  if (inf) return { existe: true, numero: _tag(inf, 'Numero'), codigoVerificacao: _tag(inf, 'CodigoVerificacao'), dataEmissao: _tag(inf, 'DataEmissao') };
  return { existe: false, erros: _erros(xml) };
}

module.exports = { chamarWs, urlWs, parseGerarNfse, parseCancelarNfse, parseConsultarPorRps, NfseComunicacaoError };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/nfse/cliente.test.js`
Expected: PASS (5 testes). ⚠️ Conferir contra a resposta REAL colada nos achados da POC — se o formato do `<return>` divergir (ex.: `GerarNfseResponse><xml>`), ajustar `_tag(texto,'return')` para o nome real e atualizar o teste.

- [ ] **Step 5: Commit**

```bash
git add lib/nfse/cliente.js lib/nfse/cliente.test.js
git commit -m "feat(nfse): cliente SOAP + parse de retornos (Gerar/Cancelar/ConsultarPorRps)"
```

---

### Task 5: `lib/nfse/assinar.js` — assinatura digital A1 (CONDICIONAL à POC)

**Se os achados da POC disserem `PRECISA_ASSINATURA: não`, pular esta task inteira** (deixar `assinar.js` fora; `emitir.js` da Task 6 chama a assinatura só se `process.env.NFSE_CERT_${SISTEMA}_B64` existir E o módulo existir).

**Files:**
- Create: `lib/nfse/assinar.js`
- Test: `lib/nfse/assinar.test.js`
- Modify: `package.json` (deps novas: `xml-crypto`, `node-forge`)

**Interfaces:**
- Produces: `assinarXml(xml, { pfxB64, senha, referenciaUri }) -> string` (XML com `<Signature>` XMLDSig anexada ao elemento referenciado) e `carregarCertificado(sistema) -> { pfxB64, senha } | null` (lê `NFSE_CERT_VIEIRA_B64`/`NFSE_CERT_VIEIRA_SENHA` ou `_MARTINS_`).

- [ ] **Step 1: Instalar dependências**

Run: `npm i xml-crypto@^6 node-forge@^1`
Expected: adicionadas ao package.json sem erro.

- [ ] **Step 2: Escrever teste com certificado autoassinado gerado no próprio teste**

```js
// lib/nfse/assinar.test.js
const test = require('node:test');
const assert = require('node:assert');
const forge = require('node-forge');
const { assinarXml } = require('./assinar');

function pfxTeste(senha) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const attrs = [{ name: 'commonName', value: 'TESTE NFSE' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64');
}

test('assinarXml anexa Signature com Reference ao Id informado', () => {
  const pfxB64 = pfxTeste('123456');
  const xml = `<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd"><Rps>` +
    `<InfDeclaracaoPrestacaoServico Id="rps7"><Competencia>2026-07-01</Competencia></InfDeclaracaoPrestacaoServico>` +
    `</Rps></GerarNfseEnvio>`;
  const assinado = assinarXml(xml, { pfxB64, senha: '123456', referenciaUri: 'rps7' });
  assert.match(assinado, /<(?:ds:)?Signature/);
  assert.match(assinado, /URI="#rps7"/);
  assert.match(assinado, /<(?:ds:)?X509Certificate>/);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test lib/nfse/assinar.test.js`
Expected: FAIL — `Cannot find module './assinar'`.

- [ ] **Step 4: Implementar**

```js
// lib/nfse/assinar.js — assinatura XMLDSig (padrão ABRASF: RSA-SHA1 + C14N, cert dentro de KeyInfo).
// ⚠️ Se a prefeitura rejeitar SHA1, trocar por RSA-SHA256 (ver achados da POC).
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');

function _extrairChaveECert(pfxB64, senha) {
  const der = forge.util.decode64(pfxB64);
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), senha);
  let privateKey = null, cert = null;
  for (const safeContents of p12.safeContents) {
    for (const safeBag of safeContents.safeBags) {
      if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag || safeBag.type === forge.pki.oids.keyBag) privateKey = safeBag.key;
      else if (safeBag.type === forge.pki.oids.certBag && !cert) cert = safeBag.cert;
    }
  }
  if (!privateKey || !cert) throw new Error('PFX sem chave privada ou certificado');
  const keyPem = forge.pki.privateKeyToPem(privateKey);
  const certDerB64 = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
  return { keyPem, certDerB64 };
}

function assinarXml(xml, { pfxB64, senha, referenciaUri }) {
  const { keyPem, certDerB64 } = _extrairChaveECert(pfxB64, senha);
  const sig = new SignedXml({
    privateKey: keyPem,
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    getKeyInfoContent: () => `<X509Data><X509Certificate>${certDerB64}</X509Certificate></X509Data>`,
  });
  sig.addReference({
    xpath: `//*[@Id='${referenciaUri}']`,
    uri: `#${referenciaUri}`,
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
  });
  sig.computeSignature(xml, { location: { reference: `//*[@Id='${referenciaUri}']`, action: 'after' } });
  return sig.getSignedXml();
}

function carregarCertificado(sistema) {
  const chave = sistema === 'Vieira' ? 'VIEIRA' : sistema === 'Martins' ? 'MARTINS' : null;
  if (!chave) return null;
  const pfxB64 = process.env[`NFSE_CERT_${chave}_B64`];
  const senha = process.env[`NFSE_CERT_${chave}_SENHA`];
  return pfxB64 && senha ? { pfxB64, senha } : null;
}

module.exports = { assinarXml, carregarCertificado };
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test lib/nfse/assinar.test.js`
Expected: PASS. Validação real acontece na homologação (Task 10) — a POC já provou o formato aceito.

- [ ] **Step 6: Commit**

```bash
git add lib/nfse/assinar.js lib/nfse/assinar.test.js package.json package-lock.json
git commit -m "feat(nfse): assinatura XMLDSig A1 (xml-crypto + node-forge)"
```

---

### Task 6: `lib/nfse/emitir.js` — orquestração, estados e reconciliação

**Files:**
- Create: `lib/nfse/emitir.js`
- Test: `lib/nfse/emitir.test.js`

**Interfaces:**
- Consumes: `montarGerarNfseEnvio`, `montarConsultarNfsePorRpsEnvio` (Task 3); `chamarWs`, `parseGerarNfse`, `parseConsultarPorRps`, `NfseComunicacaoError` (Task 4); `assinarXml`, `carregarCertificado` (Task 5, opcional); RPC `nf_reservar_rps` (Task 2).
- Produces:
  - `processarPendentes(supabase, { onLog }) -> Promise<{ emitidas, erros, detalhes[] }>` — processa a fila inteira, sequencial.
  - `reconciliarProcessando(supabase) -> Promise<{ fechadas, voltaram }>` — fecha notas presas em `Processando` via consulta por RPS.
  - `statusJob() -> { rodando, processadas, erros, log[] }` — estado em memória p/ polling da UI (mesma forma que o nf-agente antigo servia).

- [ ] **Step 1: Escrever os testes que falham (Supabase e WS mockados)**

```js
// lib/nfse/emitir.test.js
const test = require('node:test');
const assert = require('node:assert');
const { _processarUma, reconciliarProcessando } = require('./emitir');

// Mock mínimo do client Supabase para as operações usadas (from().update().eq(), rpc())
function supabaseMock({ rps = 10 } = {}) {
  const updates = [];
  return {
    updates,
    rpc: async (fn, args) => ({ data: rps, error: null }),
    from: (tabela) => ({
      update: (patch) => ({ eq: async (col, val) => { updates.push({ tabela, patch, id: val }); return { error: null }; } }),
    }),
  };
}

const emissor = { sistema: 'Vieira', cnpj: '05617377000108', inscricao_municipal: '106657', optante_simples: 1, item_lista_servico: '4.12', aliquota: 3, descricao_padrao: 'Serviços odontológicos' };
const nota = { id: 42, sistema: 'Vieira', competencia: '07-2026', tipo_tomador: 'CPF', cpf_tomador: '11144477735', nome_tomador: 'Teste', valor: 100, descricao: 'x', rps_serie: '1' };

test('sucesso: grava Emitida com numero + codigo de verificacao + xmls', async () => {
  const sb = supabaseMock();
  const ws = async () => `<r><InfNfse><Numero>412</Numero><CodigoVerificacao>AB</CodigoVerificacao><DataEmissao>2026-07-10</DataEmissao></InfNfse></r>`;
  const r = await _processarUma(sb, nota, emissor, { chamarWsImpl: ws });
  assert.strictEqual(r.ok, true);
  const final = sb.updates.at(-1).patch;
  assert.strictEqual(final.status, 'Emitida');
  assert.strictEqual(final.num_nota, '412');
  assert.strictEqual(final.codigo_verificacao, 'AB');
  assert.ok(final.xml_envio.includes('<GerarNfseEnvio'));
  assert.ok(final.xml_retorno.includes('InfNfse'));
});

test('rejeição: grava Erro com mensagem oficial e NUNCA Emitida', async () => {
  const sb = supabaseMock();
  const ws = async () => `<r><ListaMensagemRetorno><MensagemRetorno><Codigo>E160</Codigo><Mensagem>CPF invalido</Mensagem></MensagemRetorno></ListaMensagemRetorno></r>`;
  const r = await _processarUma(sb, nota, emissor, { chamarWsImpl: ws });
  assert.strictEqual(r.ok, false);
  const final = sb.updates.at(-1).patch;
  assert.strictEqual(final.status, 'Erro');
  assert.match(final.erro_msg, /E160/);
});

test('timeout: nota fica Processando (não Erro, não Emitida)', async () => {
  const { NfseComunicacaoError } = require('./cliente');
  const sb = supabaseMock();
  const ws = async () => { throw new NfseComunicacaoError('timeout'); };
  const r = await _processarUma(sb, nota, emissor, { chamarWsImpl: ws });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.pendenteReconciliacao, true);
  const final = sb.updates.at(-1).patch;
  assert.strictEqual(final.status, 'Processando'); // permanece; reconciliador resolve
});

test('reconciliar: nota que EXISTE na prefeitura completa como Emitida; que NÃO existe volta a Pendente', async () => {
  const presas = [
    { id: 1, sistema: 'Vieira', rps_numero: 5, rps_serie: '1', status: 'Processando' },
    { id: 2, sistema: 'Vieira', rps_numero: 6, rps_serie: '1', status: 'Processando' },
  ];
  const updates = [];
  const sb = {
    from: (t) => ({
      select: () => ({ eq: () => ({ limit: async () => ({ data: presas, error: null }) }) }),
      update: (patch) => ({ eq: async (c, id) => { updates.push({ id, patch }); return { error: null }; } }),
    }),
  };
  const emissores = { Vieira: emissor };
  const ws = async (op, xml) => xml.includes('<Numero>5</Numero>')
    ? `<r><InfNfse><Numero>500</Numero><CodigoVerificacao>OK</CodigoVerificacao><DataEmissao>2026-07-10</DataEmissao></InfNfse></r>`
    : `<r><ListaMensagemRetorno><MensagemRetorno><Codigo>E92</Codigo><Mensagem>nao encontrado</Mensagem></MensagemRetorno></ListaMensagemRetorno></r>`;
  const r = await reconciliarProcessando(sb, { chamarWsImpl: ws, emissoresPorSistema: emissores });
  assert.strictEqual(r.fechadas, 1);
  assert.strictEqual(r.voltaram, 1);
  assert.strictEqual(updates.find(u => u.id === 1).patch.status, 'Emitida');
  assert.strictEqual(updates.find(u => u.id === 2).patch.status, 'Pendente');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/nfse/emitir.test.js`
Expected: FAIL — `Cannot find module './emitir'`.

- [ ] **Step 3: Implementar**

```js
// lib/nfse/emitir.js — orquestra a fila: Pendente → Processando → Emitida/Erro.
// Regra de ouro: SÓ marca Emitida com numero + codigo de verificacao na mão.
// Timeout/queda → fica Processando; reconciliarProcessando consulta por RPS antes de reenviar.
const { montarGerarNfseEnvio, montarConsultarNfsePorRpsEnvio } = require('./montar-xml');
const { chamarWs, parseGerarNfse, parseConsultarPorRps, NfseComunicacaoError } = require('./cliente');

let _assinar = null;
try { _assinar = require('./assinar'); } catch { /* assinatura não instalada (POC dispensou) */ }

const _job = { rodando: false, processadas: 0, erros: 0, log: [] };
function statusJob() { return { ..._job, log: _job.log.slice(-200) }; }
function _log(msg) { _job.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`); }

function _ambiente() { return process.env.NFSE_AMBIENTE === 'producao' ? 'producao' : 'homologacao'; }

function _linkDanfse(numero, codigoVerificacao) {
  // URL pública confirmada na POC (docs/superpowers/specs/2026-07-09-nfse-poc-achados.md).
  // Se a POC concluiu que não há acesso público, retornar '' (Drive cobre o PDF).
  const base = process.env.NFSE_DANFSE_URL || '';
  if (!base) return '';
  return base.replace('{numero}', encodeURIComponent(numero)).replace('{codigo}', encodeURIComponent(codigoVerificacao || ''));
}

async function _prepararXml(nota, emissor, rpsNumero) {
  let xml = montarGerarNfseEnvio(nota, emissor, { numero: rpsNumero, serie: nota.rps_serie || '1' });
  const cert = _assinar && _assinar.carregarCertificado(emissor.sistema);
  if (cert) xml = _assinar.assinarXml(xml, { ...cert, referenciaUri: `rps${rpsNumero}` });
  return xml;
}

/** Processa UMA nota. Exportada para teste. opts.chamarWsImpl injeta o transporte. */
async function _processarUma(supabase, nota, emissor, opts = {}) {
  const ws = opts.chamarWsImpl || chamarWs;
  // 1) reserva RPS (reutiliza se a nota já tem um, ex.: reprocesso de Erro)
  let rpsNumero = nota.rps_numero;
  if (!rpsNumero) {
    const { data, error } = await supabase.rpc('nf_reservar_rps', { p_sistema: nota.sistema });
    if (error || data == null) { _log(`#${nota.id} falha ao reservar RPS: ${error?.message}`); return { ok: false }; }
    rpsNumero = data;
  }
  const xmlEnvio = await _prepararXml(nota, emissor, rpsNumero);
  await supabase.from('notas_fiscais').update({
    status: 'Processando', rps_numero: rpsNumero, ambiente: _ambiente(), xml_envio: xmlEnvio,
  }).eq('id', nota.id);

  let xmlResp;
  try {
    xmlResp = await ws('GerarNfse', xmlEnvio);
  } catch (e) {
    if (e instanceof NfseComunicacaoError) {
      _log(`#${nota.id} comunicação falhou (${e.message}) — fica Processando p/ reconciliar`);
      await supabase.from('notas_fiscais').update({ status: 'Processando', erro_msg: `aguardando reconciliação: ${e.message}` }).eq('id', nota.id);
      return { ok: false, pendenteReconciliacao: true };
    }
    throw e;
  }
  const r = parseGerarNfse(xmlResp);
  if (r.ok && r.numero && r.codigoVerificacao) {
    await supabase.from('notas_fiscais').update({
      status: 'Emitida', num_nota: String(r.numero), codigo_verificacao: r.codigoVerificacao,
      data_emissao: r.dataEmissao || new Date().toISOString(), xml_retorno: xmlResp,
      caminho_pdf: _linkDanfse(r.numero, r.codigoVerificacao), erro_msg: '',
    }).eq('id', nota.id);
    _log(`#${nota.id} ✅ Emitida — nota ${r.numero}`);
    return { ok: true, numero: r.numero };
  }
  const msg = (r.erros || []).map((e) => `${e.codigo}: ${e.mensagem}`).join(' | ') || 'retorno sem número/código';
  await supabase.from('notas_fiscais').update({ status: 'Erro', erro_msg: msg.slice(0, 500), xml_retorno: xmlResp }).eq('id', nota.id);
  _log(`#${nota.id} ❌ ${msg}`);
  return { ok: false };
}

async function _carregarEmissores(supabase) {
  const { data, error } = await supabase.from('nf_emissores').select('*').eq('ativo', true).limit(10);
  if (error) throw new Error(`nf_emissores: ${error.message}`);
  return Object.fromEntries((data || []).map((e) => [e.sistema, e]));
}

async function processarPendentes(supabase, { onLog } = {}) {
  if (_job.rodando) return { emitidas: 0, erros: 0, detalhes: [], jaRodando: true };
  _job.rodando = true; _job.processadas = 0; _job.erros = 0; _job.log = [];
  try {
    const emissores = await _carregarEmissores(supabase);
    const { data: notas, error } = await supabase.from('notas_fiscais').select('*')
      .eq('status', 'Pendente').in('sistema', Object.keys(emissores)).order('id').limit(500);
    if (error) throw new Error(error.message);
    _log(`${(notas || []).length} pendentes (ambiente: ${_ambiente()})`);
    const detalhes = [];
    for (const nota of notas || []) {
      const r = await _processarUma(supabase, nota, emissores[nota.sistema]);
      if (r.ok) _job.processadas++; else _job.erros++;
      detalhes.push({ id: nota.id, ...r });
      if (onLog) onLog(statusJob());
    }
    await reconciliarProcessando(supabase, { emissoresPorSistema: emissores });
    return { emitidas: _job.processadas, erros: _job.erros, detalhes };
  } finally {
    _job.rodando = false;
  }
}

async function reconciliarProcessando(supabase, opts = {}) {
  const ws = opts.chamarWsImpl || chamarWs;
  const emissores = opts.emissoresPorSistema || (await _carregarEmissores(supabase));
  const { data: presas, error } = await supabase.from('notas_fiscais').select('*').eq('status', 'Processando').limit(100);
  if (error) throw new Error(error.message);
  let fechadas = 0, voltaram = 0;
  for (const nota of presas || []) {
    const emissor = emissores[nota.sistema];
    if (!emissor || !nota.rps_numero) continue;
    let resp;
    try {
      resp = await ws('ConsultarNfsePorRps', montarConsultarNfsePorRpsEnvio({ rpsNumero: nota.rps_numero, rpsSerie: nota.rps_serie || '1', emissor }));
    } catch { continue; } // segue presa; próximo reconcilio tenta de novo
    const r = parseConsultarPorRps(resp);
    if (r.existe) {
      await supabase.from('notas_fiscais').update({
        status: 'Emitida', num_nota: String(r.numero), codigo_verificacao: r.codigoVerificacao,
        data_emissao: r.dataEmissao || new Date().toISOString(), xml_retorno: resp,
        caminho_pdf: _linkDanfse(r.numero, r.codigoVerificacao), erro_msg: '',
      }).eq('id', nota.id);
      fechadas++;
    } else {
      await supabase.from('notas_fiscais').update({ status: 'Pendente', erro_msg: '' }).eq('id', nota.id);
      voltaram++;
    }
  }
  return { fechadas, voltaram };
}

module.exports = { processarPendentes, reconciliarProcessando, statusJob, _processarUma };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/nfse/emitir.test.js`
Expected: PASS (4 testes).

- [ ] **Step 5: Rodar a suíte inteira**

Run: `npm test`
Expected: todos os testes do repo passam (nenhuma regressão).

- [ ] **Step 6: Commit**

```bash
git add lib/nfse/emitir.js lib/nfse/emitir.test.js
git commit -m "feat(nfse): orquestracao de emissao com estados seguros e reconciliacao por RPS"
```

---

### Task 7: Rotas no `server.js` + status `Cancelada`

**Files:**
- Modify: `server.js` (bloco `// ========== NOTAS FISCAIS ==========`, ~linha 3410)

**Interfaces:**
- Consumes: `processarPendentes`, `statusJob`, `reconciliarProcessando` (Task 6); `montarCancelarNfseEnvio` (Task 3); `chamarWs`, `parseCancelarNfse` (Task 4).
- Produces: `POST /api/notas-fiscais/emitir` → `{ ok:true }` (dispara em background); `GET /api/notas-fiscais/emitir/status` → shape do `statusJob()` (`{rodando, processadas, erros, log[]}` — compatível com o polling da UI antiga); `POST /api/notas-fiscais/:id/cancelar` body `{ motivo, codigo }`.

- [ ] **Step 1: Adicionar `'Cancelada'` ao NF_STATUS e as rotas**

No topo do bloco (linha ~3411): `const NF_STATUS = ['Pendente', 'Processando', 'Emitida', 'Erro', 'Cancelada'];`

Adicionar após as rotas existentes de notas fiscais (usar os middlewares reais do arquivo — conferir o nome exato de `requireAuth`/`requireRole` usados nas rotas vizinhas e replicar):

```js
const nfse = require('./lib/nfse/emitir');
const { montarCancelarNfseEnvio } = require('./lib/nfse/montar-xml');
const { chamarWs: nfseChamarWs, parseCancelarNfse } = require('./lib/nfse/cliente');

const requireNotasFiscais = [requireAuth, requireRole('admin', 'gestor', 'mod_notas_fiscais')];

app.post('/api/notas-fiscais/emitir', rateLimit, ...requireNotasFiscais, async (req, res) => {
  const s = nfse.statusJob();
  if (s.rodando) return res.json({ ok: false, erro: 'Emissão já em andamento' });
  // dispara em background; a UI acompanha pelo /status
  nfse.processarPendentes(supabase).catch((e) => console.error('[nfse] processarPendentes:', e.message));
  res.json({ ok: true });
});

app.get('/api/notas-fiscais/emitir/status', ...requireNotasFiscais, (req, res) => {
  res.json({ ...nfse.statusJob(), ambiente: process.env.NFSE_AMBIENTE === 'producao' ? 'producao' : 'homologacao' });
});

app.post('/api/notas-fiscais/:id/cancelar', rateLimit, requireAuth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { motivo, codigo = '2' } = req.body || {};
    if (isNaN(id)) return res.status(400).json({ error: 'ID invalido' });
    if (!motivo || String(motivo).trim().length < 5) return res.status(400).json({ error: 'Motivo obrigatório (mín. 5 caracteres)' });
    const { data: nota } = await supabase.from('notas_fiscais').select('*').eq('id', id).maybeSingle();
    if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });
    if (nota.status !== 'Emitida' || !nota.num_nota) return res.status(400).json({ error: 'Só nota Emitida pode ser cancelada' });
    const { data: emissor } = await supabase.from('nf_emissores').select('*').eq('sistema', nota.sistema).maybeSingle();
    if (!emissor) return res.status(400).json({ error: `Emissor não configurado: ${nota.sistema}` });

    const xml = montarCancelarNfseEnvio({ numeroNfse: nota.num_nota, emissor, codigoCancelamento: String(codigo) });
    const resp = await nfseChamarWs('CancelarNfse', xml);
    const r = parseCancelarNfse(resp);
    if (!r.ok) return res.status(422).json({ error: (r.erros || []).map((e) => `${e.codigo}: ${e.mensagem}`).join(' | ') });

    const hist = Array.isArray(nota.historico) ? nota.historico : [];
    hist.push({ de: 'Emitida', para: 'Cancelada', quando: nowLocal(), quem: req.user?.email || 'manual', motivo: sanitizeStr(motivo, 300) });
    await supabase.from('notas_fiscais').update({ status: 'Cancelada', historico: hist, xml_retorno: resp }).eq('id', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

⚠️ Express casa rotas na ordem: registrar `/api/notas-fiscais/emitir` e `/emitir/status` ANTES de `/api/notas-fiscais/:id/pdf` e `PATCH /:id` para `:id` não capturar `emitir`. Conferir se as rotas existentes de NF têm `requireAuth` — se o bloco atual estiver sem auth (as rotas da linha 3414+ não mostram middleware), adicionar `...requireNotasFiscais` também nelas nesta task (fecha brecha existente).

- [ ] **Step 2: Teste manual local**

Run: `node -e "require('./server.js')"` num terminal (com `.env` local; `NFSE_AMBIENTE=homologacao`) e noutro:
`curl -s http://localhost:3000/api/notas-fiscais/emitir/status` (sem token)
Expected: 401 (auth exigida). Com token de admin (pegar do localStorage logado): retorna `{rodando:false, ..., ambiente:'homologacao'}`.

- [ ] **Step 3: Rodar suíte + commit**

Run: `npm test` → PASS.

```bash
git add server.js
git commit -m "feat(nfse): rotas emitir/status/cancelar no CRM + status Cancelada"
```

---

### Task 8: `lib/nfse/drive.js` — upload do PDF ao Google Drive

Pré-requisito: achados da POC sobre o DANFSE. Caminho feliz = baixar o PDF da URL pública e subir ao Drive. Se a POC concluiu que não há URL pública, subir o `xml_retorno` (`.xml`) no lugar e deixar PDF para evolução (registrar no commit).

**Files:**
- Create: `lib/nfse/drive.js`
- Test: `lib/nfse/drive.test.js`
- Modify: `lib/nfse/emitir.js` (chamada pós-Emitida, best-effort)

**Interfaces:**
- Produces: `uploadNota(supabase, nota, emissor, { fetchImpl }) -> Promise<{ ok, link }>` — baixa `nota.caminho_pdf`, sobe para `emissor.drive_folder_id` como `NF-<num_nota>-<nome_tomador>.pdf`, grava `drive_link`. Auth: service account em `GOOGLE_SA_JSON_B64` (JWT RS256 manual com `node:crypto`, sem lib do Google).

- [ ] **Step 1: Escrever os testes que falham**

```js
// lib/nfse/drive.test.js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { _montarJwt, _nomeArquivo } = require('./drive');

test('nome de arquivo sanitiza tomador e usa numero da nota', () => {
  assert.strictEqual(_nomeArquivo({ num_nota: '412', nome_tomador: 'Maria / Silva: Teste' }), 'NF-412-Maria - Silva- Teste.pdf');
});

test('JWT tem claims de escopo drive e assina RS256', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = _montarJwt({ client_email: 'sa@teste.iam.gserviceaccount.com', private_key: pem }, Date.now());
  const [h, p] = jwt.split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x, 'base64url').toString()));
  assert.strictEqual(h.alg, 'RS256');
  assert.strictEqual(p.iss, 'sa@teste.iam.gserviceaccount.com');
  assert.match(p.scope, /drive/);
  assert.strictEqual(p.aud, 'https://oauth2.googleapis.com/token');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/nfse/drive.test.js`
Expected: FAIL — `Cannot find module './drive'`.

- [ ] **Step 3: Implementar**

```js
// lib/nfse/drive.js — upload do PDF da nota ao Google Drive via service account.
// JWT RS256 manual (node:crypto) — sem SDK do Google (regra da casa: stdlib primeiro).
const crypto = require('node:crypto');

function _nomeArquivo(nota) {
  const tomador = String(nota.nome_tomador || '').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 60);
  return `NF-${nota.num_nota}-${tomador}.pdf`;
}

function _montarJwt(sa, agoraMs) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(agoraMs / 1000);
  const header = b64u({ alg: 'RS256', typ: 'JWT' });
  const payload = b64u({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    iat, exp: iat + 3600,
  });
  const assinatura = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), sa.private_key).toString('base64url');
  return `${header}.${payload}.${assinatura}`;
}

async function _accessToken(fetchImpl) {
  const sa = JSON.parse(Buffer.from(process.env.GOOGLE_SA_JSON_B64 || '', 'base64').toString('utf8'));
  const jwt = _montarJwt(sa, Date.now());
  const r = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`token Drive falhou: ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token;
}

async function uploadNota(supabase, nota, emissor, { fetchImpl = fetch } = {}) {
  try {
    if (!process.env.GOOGLE_SA_JSON_B64 || !emissor.drive_folder_id || !nota.caminho_pdf) return { ok: false, link: '' };
    const pdfResp = await fetchImpl(nota.caminho_pdf, { signal: AbortSignal.timeout(30000) });
    if (!pdfResp.ok) throw new Error(`download PDF HTTP ${pdfResp.status}`);
    const pdf = Buffer.from(await pdfResp.arrayBuffer());

    const token = await _accessToken(fetchImpl);
    const boundary = 'nfse' + crypto.randomBytes(8).toString('hex');
    const meta = JSON.stringify({ name: _nomeArquivo(nota), parents: [emissor.drive_folder_id] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
      pdf,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const up = await fetchImpl('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    const j = await up.json();
    if (!j.id) throw new Error(`upload falhou: ${JSON.stringify(j).slice(0, 200)}`);
    const link = j.webViewLink || `https://drive.google.com/file/d/${j.id}/view`;
    await supabase.from('notas_fiscais').update({ drive_link: link }).eq('id', nota.id);
    return { ok: true, link };
  } catch (e) {
    console.error(`[nfse-drive] nota ${nota.id}: ${e.message}`); // best-effort: nunca derruba a emissão
    return { ok: false, link: '', erro: e.message };
  }
}

module.exports = { uploadNota, _montarJwt, _nomeArquivo };
```

Em `lib/nfse/emitir.js`, dentro de `_processarUma`, logo após o update de `Emitida`, adicionar:

```js
const { uploadNota } = require('./drive'); // topo do arquivo
// ... após o update Emitida:
uploadNota(supabase, { ...nota, num_nota: String(r.numero), caminho_pdf: _linkDanfse(r.numero, r.codigoVerificacao) }, emissor)
  .catch(() => {}); // fire-and-forget
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/nfse/drive.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Preparar env + pastas**

Converter a service account existente (arquivo usado pelo `nf-automation/sheets.py`, ver `GOOGLE_CREDENTIALS_FILE` no `.env` de lá) para base64: `powershell: [Convert]::ToBase64String([IO.File]::ReadAllBytes('caminho\credentials.json'))` → colar como `GOOGLE_SA_JSON_B64` no env do Easypanel (serviço plataforma). Criar 2 pastas no Drive (NF Vieira / NF Martins), compartilhar com o e-mail da service account (permissão Editor), copiar os IDs das pastas e gravar: `update nf_emissores set drive_folder_id='<id>' where sistema='<sistema>';`

- [ ] **Step 6: Commit**

```bash
git add lib/nfse/drive.js lib/nfse/drive.test.js lib/nfse/emitir.js
git commit -m "feat(nfse): upload do PDF ao Google Drive (service account, sem SDK)"
```

---

### Task 9: Front — tela Notas Fiscais aponta pro CRM (adeus agente)

**Files:**
- Modify: `public/index.html` (página `notas-fiscais`: const `AGENTE` linha ~5275, `agenteVerificar()` ~5278, `agenteEmitir()` ~5307, HTML ~1130)

**Interfaces:**
- Consumes: `POST /api/notas-fiscais/emitir`, `GET /api/notas-fiscais/emitir/status`, `POST /api/notas-fiscais/:id/cancelar` (Task 7). O `api()` helper da SPA já injeta o token.

- [ ] **Step 1: Trocar o transporte**

1. Apagar `const AGENTE = 'https://plataformaama-nf-agente...'`.
2. `agenteVerificar()`: trocar `fetch(AGENTE + '/status')` por `api('/api/notas-fiscais/emitir/status')`; com resposta ok, dot 🟢 e msg `Motor de emissão pronto (ambiente: producao|homologacao)`. Se `ambiente === 'homologacao'`, mostrar banner amarelo acima da tabela: `⚠️ AMBIENTE DE TREINO — notas emitidas aqui NÃO têm valor fiscal` (criar `<div id="nf-banner-homolog">` no HTML ~linha 1131, `display:none` por padrão).
3. `agenteEmitir()`: trocar `fetch(AGENTE + '/processar', ...)` por `api('/api/notas-fiscais/emitir', { method:'POST' })`; manter o polling do log/status que já existe (mesma forma de resposta).
4. Remover TODO o fluxo de captcha do front (funções que chamam `/api/nf-captcha*`, ~linhas 5700-5740, e elementos de UI associados) — o motor novo não tem captcha.

- [ ] **Step 2: Botão Cancelar por linha**

Na função que renderiza as linhas da tabela de notas (procurar por `loadNotasFiscais`), adicionar, para notas `status === 'Emitida'` e se o usuário tem role admin/gestor (a SPA já expõe as roles do usuário — reusar o mesmo check usado pra montar o menu):

```js
`<button class="btn btn-sm" onclick="nfCancelar(${n.id})" title="Cancelar na prefeitura">🚫</button>`
```

```js
async function nfCancelar(id) {
  const motivo = prompt('Motivo do cancelamento (obrigatório, mín. 5 caracteres):');
  if (!motivo || motivo.trim().length < 5) return;
  const r = await api(`/api/notas-fiscais/${id}/cancelar`, { method: 'POST', body: JSON.stringify({ motivo }) });
  if (r.ok) { toast('✅ Nota cancelada na prefeitura'); loadNotasFiscais(); }
  else toast('❌ ' + (r.error || 'falha ao cancelar'), true);
}
```

Exibir status `Cancelada` com badge cinza na coluna de status (seguir o mapa de cores dos outros status na mesma função) e mostrar `drive_link` como ícone 📁 quando presente.

- [ ] **Step 3: Testar visual local**

Run: servidor local + abrir `http://localhost:3000/?page=notas-fiscais` logado.
Expected: dot 🟢 "Motor de emissão pronto (homologacao)", banner amarelo visível, sem erros no console, botão 🚫 nas Emitidas (como admin).

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(nfse): tela aponta pro motor interno; banner homologacao; botao cancelar; remove captcha"
```

---

### Task 10: Monitoramento (`job_health`) + ponta a ponta em HOMOLOGAÇÃO

**Files:**
- Modify: `lib/nfse/emitir.js` (registrar no job_health)
- Modify: `lib/sync/health.js` APENAS se necessário verbete (conferir como os 4 jobs existentes se registram — usar `registrarJob` idêntico)

- [ ] **Step 1: Registrar o job**

No fim de `processarPendentes` (bloco `finally` ou após o loop), chamar o helper existente (conferir a assinatura real em `lib/sync/` — os jobs `inadimplentes`/`comparecimentos` usam `registrarJob(nome, resultado)`):

```js
const { registrarJob } = require('../sync/health'); // conferir path real do helper
// após o loop:
await registrarJob(supabase, 'nf_emissao', { ok: _job.erros === 0, detalhe: { emitidas: _job.processadas, erros: _job.erros } }).catch(() => {});
```

⚠️ `nf_emissao` é job sob demanda (não tem cadência) — conferir se `JOB_HEARTBEAT` exige cadência; se exigir, registrar com cadência frouxa (ex.: 45 dias) ou omitir da checagem de frescor (só sucesso/falha da última rodada).

- [ ] **Step 2: Deploy em homologação**

Env do Easypanel (serviço plataforma): `NFSE_AMBIENTE=homologacao` (+ certs se a POC exigiu, + `NFSE_DANFSE_URL` da POC, + `GOOGLE_SA_JSON_B64`).

```bash
git push   # (branch nfse-ws → merge em main conforme fluxo da casa)
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 3: Bateria de aceite em homologação (critérios 1-5 da spec)**

1. Criar 2 notas de teste na tela (uma Vieira, uma Martins, R$ 1,00, CPF válido de teste) → Emitir Pendentes → ambas `Emitida` com número + código; conferir `xml_envio`/`xml_retorno` no banco.
2. Criar nota com CPF inválido (ex.: `11111111111`) → `Erro` com mensagem legível → corrigir o CPF pela tela → reprocessar → `Emitida`.
3. Simular queda: derrubar a rede do container no meio (ou setar `NFSE_TIMEOUT_MS=1` temporariamente no env, emitir, restaurar) → nota fica `Processando` → rodar Emitir de novo → reconciliador fecha o estado certo, sem duplicata (conferir na consulta por faixa da POC que só existe 1 nota).
4. Cancelar uma das notas de homologação pela tela com motivo → `Cancelada`, histórico com quem/quando/motivo.
5. Conferir PDF: link `caminho_pdf` abre; arquivo no Drive na pasta certa (`drive_link`).

Expected: os 5 passos verdes. Registrar evidências (prints/logs) no PR ou no arquivo de achados.

- [ ] **Step 4: Validação do Luiz em homologação**

Luiz roda o fluxo dele completo na tela (lançar → emitir → ver PDF → cancelar). GATE: só avança pra Task 11 com o OK dele.

- [ ] **Step 5: Commit**

```bash
git add lib/nfse/emitir.js
git commit -m "feat(nfse): registra nf_emissao no job_health + ajustes da bateria de homologacao"
```

---

### Task 11: Produção + aposentadoria do robô

- [ ] **Step 1: Virar a chave**

Env Easypanel: `NFSE_AMBIENTE=producao` (+ certs de produção se homolog usou cert de teste). Redeploy (mesmo curl). Banner amarelo some da tela (conferir).

- [ ] **Step 2: Primeira nota real supervisionada**

Emitir 1 nota real de valor baixo (Luiz escolhe). Conferir: (a) tela = `Emitida` com número; (b) portal SIGISS logado mostra a MESMA nota/número; (c) PDF abre; (d) Drive tem o arquivo. GATE: OK do Luiz.

- [ ] **Step 3: Aposentar o nf-agente**

1. Easypanel: **Stop** no serviço `nf-agente` (não Destroy — regra da casa; destruir só depois de ~1 mês estável).
2. `server.js`: remover as 4 rotas `/api/nf-captcha*` (linhas ~3378-3408).
3. `nf-automation/README.md` (criar): "⚠️ Emissão Vieira/Martins migrou para lib/nfse/ no CRM (spec 2026-07-09). Esta pasta permanece SÓ pelo fluxo local semi-manual do Receita Saúde (receita_saude.py + agente_local.py)."
4. `public/index.html`: conferir que nenhuma referência a `plataformaama-nf-agente` sobrou (grep).

Run: `npm test` → PASS; grep `nf-captcha` e `nf-agente` no repo → só hits em nf-automation/ (legado local) e docs.

- [ ] **Step 4: Commit final + deploy + memória**

```bash
git add server.js nf-automation/README.md public/index.html
git commit -m "chore(nfse): aposenta nf-agente - remove captcha endpoints, README de legado"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

Atualizar memórias: `project_nfse_webservice.md` (status → produção), `pending_tests.md` (item de validação), `project_nf_automation_state.md` (aposentado).

---

## Self-Review (feito na escrita)

- **Spec coverage:** §3 arquitetura→Tasks 3-7; §4 dados→Task 2; §5 fluxo→Task 6; §6 cancelamento→Tasks 3/7/9; §7 ambientes/rollout→Tasks 10-11; §8 segurança→Global Constraints + Tasks 2/7; §9 observabilidade→Task 10; §10 incógnitas→Task 1 (POC); §12 critérios de aceite→Tasks 10-11. Fila automática/Emissor Nacional: fora de escopo (spec §11). ✔
- **Placeholders:** nenhum TBD; os dois pontos dependentes da POC (assinatura, URL DANFSE) têm caminho decidido para ambos os resultados. ✔
- **Type consistency:** `montarGerarNfseEnvio(nota, emissor, rps)` idêntico nas Tasks 3/6; `chamarWs(operacao, xmlInterno, opts)` idêntico nas Tasks 4/6/7; `statusJob()` shape `{rodando, processadas, erros, log[]}` idêntico nas Tasks 6/7/9; nomes de coluna (`rps_numero`, `codigo_verificacao`, `drive_link`…) idênticos nas Tasks 2/6/8. ✔
