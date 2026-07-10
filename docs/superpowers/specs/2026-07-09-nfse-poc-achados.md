# POC WebService NFS-e ABRASF Ipatinga (SigCorp) — Achados (homologação)

Data da execução: 10/07/2026.
Endpoint testado: `https://testeipatingaabrasf.meumunicipio.online/ws` (SOAP document/literal).
Script: `scripts/poc-nfse-homolog.js` (`node scripts/poc-nfse-homolog.js [consultar|gerar|gerar-nbs|gerar-fracao]`).

Este documento é o gate das Tasks 3-6. Todas as perguntas do brief foram respondidas
ou marcadas como pendente-de-certificado, conforme instruído.

---

## 1) Inscrição Municipal da Vieira (IM real, não é o chute `106657`)

Extraída do PDF de uma nota real emitida (`print_test_nota401.pdf`, nota 401, série 1,
CNPJ 05617377000108 = VIEIRA & VIDIGAL MARTINS LTDA):

```
CNPJ/CPF: 05.617.377/0001-08  IM: 8439700  IE: <vazio>  TELEFONE: (31) 3823-0061
```

**IM real = `8439700`**. O `106657` do brief era o CCM de um TOMADOR (Luiz Eduardo
Coelho Vidigal Martins), não do prestador — confirmado também pela WS: consultar com
`106657` retorna `E43 — Inscrição Municipal do prestador do serviço não encontrada na
base de dados do município`; com `8439700` a consulta é aceita normalmente (erro muda
para `E212 — NFS-e não encontrada`, que é o esperado para uma faixa vazia). O script
já usa `8439700` como default (`IM_VIEIRA`), sobrescrevível via env `POC_IM_VIEIRA`.

---

## 2) `ConsultarNfseFaixa` sem assinatura (Step 2)

`node scripts/poc-nfse-homolog.js consultar` com IM `8439700`:

```xml
<ConsultarNfseFaixaResposta xmlns="http://www.abrasf.org.br/nfse.xsd">
  <ListaMensagemRetorno>
    <MensagemRetorno>
      <Codigo>E212</Codigo>
      <Mensagem>NFS-e não encontrada. - CODE: 8</Mensagem>
      <Correcao>Não existe NFS-e emitida com o número do documento ou do RPS ou período pesquisado.</Correcao>
    </MensagemRetorno>
  </ListaMensagemRetorno>
</ConsultarNfseFaixaResposta>
```

HTTP 200, **sem qualquer erro de autenticação/assinatura**. Isso confirma:
- **A consulta (operação de leitura) NÃO exige assinatura digital nem certificado.**
- O prestador (CNPJ + IM `8439700`) já está cadastrado em homologação (senão o erro
  seria `E43`, como reproduzido no teste de controle com a IM errada `106657`).
- Não houve exigência de handshake/token/API-key adicional — a autenticação (se
  existir) é feita só pelo par CNPJ+IM dentro do XML, não por HTTP.

**CADASTRO_PREVIO_HOMOLOG: resolvido — o prestador já está cadastrado** (não foi
preciso nenhum passo de cadastro manual antes de testar).

---

## 3) `GerarNfse` mínimo (Step 3) — correção de schema necessária

A primeira tentativa usou o XML **exatamente como no brief**, com a tag `<Tomador>`.
Retorno:

```xml
<MensagemRetorno>
  <Codigo>SCH1</Codigo>
  <Mensagem>TAG 'Tomador': Esta TAG não é esperada. O Esperado é um dos
  ( TomadorServico, Intermediario, ConstrucaoCivil, Obra, RegimeEspecialTributacao,
  OptanteSimplesNacional ). - CODE: 1</Mensagem>
</MensagemRetorno>
<MensagemRetorno>
  <Codigo>E160</Codigo>
  <Mensagem>Arquivo em desacordo com o XML Schema. - CODE: 1</Mensagem>
</MensagemRetorno>
```

**Achado:** o schema ABRASF 2.04 usado por este município espera `<TomadorServico>`,
não `<Tomador>`. Corrigido no script (`scripts/poc-nfse-homolog.js`, função
`xmlGerarMinimo`). Task 5/6 (montagem do XML de produção) devem usar `TomadorServico`.

Depois da correção, `node scripts/poc-nfse-homolog.js gerar`:

```xml
<GerarNfseResposta xmlns="http://www.abrasf.org.br/nfse.xsd">
  <ListaMensagemRetorno>
    <MensagemRetorno>
      <Codigo>E174</Codigo>
      <Mensagem>RPS não assinado. - CODE: 1</Mensagem>
      <Correcao>Assine o  RPS</Correcao>
    </MensagemRetorno>
  </ListaMensagemRetorno>
</GerarNfseResposta>
```

O XML passou por **toda** a validação de schema (Servico, Prestador, TomadorServico,
Aliquota, etc. — nenhum outro erro de campo obrigatório apareceu) e falhou só na
assinatura. Ou seja, **a estrutura mínima do brief (corrigida) é aceita pelo schema**;
falta apenas assinar.

---

## 4) Assinatura digital (Step 4) — BLOQUEADO, certificado A1 pendente

**PRECISA_ASSINATURA: sim**, evidência: `E174 — RPS não assinado. Correcao: Assine o RPS.`
(HTTP 200, retorno normal do WS, não é erro de transporte/auth).

Conforme instrução, **não foi tentado assinar** — o certificado A1 da Vieira ainda não
está disponível (pendente resposta do contador). Este passo fica pendente para quando o
certificado chegar; nesse momento repetir `node scripts/poc-nfse-homolog.js gerar` com a
assinatura aplicada em `InfDeclaracaoPrestacaoServico` (única tag citada no erro/manual
ABRASF padrão — **não foi possível confirmar experimentalmente** se a WS também exige
assinatura na raiz `GerarNfseEnvio`, isso só é observável tentando com certificado real).

**Ação para quando o certificado chegar:** rodar de novo o Step 4 do brief (instalar
`xml-crypto`/`node-forge`, assinar, repetir `gerar`) e atualizar esta seção.

---

## 5) `cNBS` / `IBSCBS` (reforma tributária) — não existem neste schema

Teste `node scripts/poc-nfse-homolog.js gerar-nbs` (adiciona `<NBS>123456</NBS>` e
`<IBSCBS><valor>1.00</valor></IBSCBS>` dentro de `<Servico>`, depois de `ItemListaServico`):

```xml
<MensagemRetorno>
  <Codigo>SCH1</Codigo>
  <Mensagem>TAG 'NBS': Esta TAG não é esperada. O Esperado é um dos
  ( ListaServico, CodigoCnae, CodigoTributacaoMunicipio, CodigoNbs, Discriminacao ).
  - CODE: 1</Mensagem>
</MensagemRetorno>
<MensagemRetorno>
  <Codigo>E160</Codigo>
  <Mensagem>Arquivo em desacordo com o XML Schema. - CODE: 1</Mensagem>
</MensagemRetorno>
```

**Achados:**
- A tag correta (se o município aceitasse) seria `<CodigoNbs>`, não `<NBS>` — o próprio
  erro de schema lista as tags esperadas em `<Servico>` naquela posição:
  `ListaServico, CodigoCnae, CodigoTributacaoMunicipio, CodigoNbs, Discriminacao`.
- **Não existe `IBSCBS` neste schema.** O endpoint de homologação usa ABRASF 2.04
  "clássico" (pré-reforma) — não há suporte a IBS/CBS na estrutura de `GerarNfseEnvio`.
- `CodigoNbs` é **opcional**: o XML mínimo original (sem `CodigoNbs` nenhum) passou por
  toda a validação de schema até chegar em `E174` (assinatura) — se fosse obrigatório,
  teria dado erro de campo faltante antes disso.
- O portal público linka `https://sigcorp.com.br/reforma-tributaria/` no rodapé do
  `index.php` do SIGISS, sugerindo que a adequação à reforma tributária é tratada como
  projeto separado do fornecedor (SigCorp), ainda não refletido neste ambiente de
  homologação. **Não assumir que produção terá o mesmo schema** — vale confirmar de
  novo antes da Task de produção, se a virada de schema acontecer entre agora e o go-live.

---

## 6) Formato de alíquota — inconclusivo pela via de schema (requer nota assinada)

Teste `node scripts/poc-nfse-homolog.js gerar-fracao` (`<Aliquota>0.03</Aliquota>` em vez
de `3.00`):

```xml
<MensagemRetorno>
  <Codigo>E174</Codigo>
  <Mensagem>RPS não assinado. - CODE: 1</Mensagem>
</MensagemRetorno>
```

Mesmo erro (`E174`) que com `3.00` — ou seja, **o schema XSD não distingue os dois
formatos** (é só um decimal, sem validação de faixa/semântica nesse nível). A pergunta
"`3.00` ou `0.03`" só pode ser respondida de fato **depois de uma nota assinada e
aceita**, olhando o `ValorIss` calculado no retorno do `GerarNfse` (bate com 3% ou com
0,03% do valor do serviço?).

**Evidência indireta a favor de `3.00` (percentual):** o PDF de uma nota real emitida
mostra a coluna impressa `ALÍQUOTA(%) 4,3547` (claramente percentual, não fração), o que
é consistente com a convenção usual do ABRASF nacional (`Aliquota` = percentual, ex.
"3.00" = 3%). Mas essa nota não foi confirmada como tendo sido gerada por este mesmo WS
(pode ter vindo do sistema legado/scraper) — **tratar como forte indício, não certeza.**

**FORMATO_ALIQUOTA: inconclusivo por schema; indício forte de `3.00` (percentual) pela
nota real impressa. Confirmar definitivamente no primeiro `GerarNfse` assinado e aceito
(Task 5/6), comparando `ValorIss` retornado.**

---

## 7) DANFSE público (Step 5)

As URLs sugeridas no brief **não existem**:

```
https://ipatinga.meumunicipio.online/ISS/nfe_verifica.php            → HTTP 404
https://ipatinga.meumunicipio.online/ISS/contribuinte/nfe_print.php  → HTTP 404
https://ipatinga.meumunicipio.online/ISS/nfe_print.php               → HTTP 404
```

A página real (achada navegando o portal `https://ipatinga.meumunicipio.online/ISS/index.php`,
link "Consulta de Autenticidade de NFS-e", **sem login**) é:

```
https://ipatinga.meumunicipio.online/ISS/consulta/consulta.php
```

Formulário público (GET exibe o form, POST com `acao=validar_nfse` + `csrf_token` da
sessão consulta):
- **Notas até 31/12/2025**: campos `periodo=2025`, `hash` (código de Autenticidade
  impresso na nota, ex. `602F-A9BN`).
- **Notas a partir de 01/01/2026**: campo `periodo=2026`; a UI só mostra a opção
  "Chave de Acesso" (`chaveacesso`, 50 dígitos numéricos) — a opção de validar por hash
  está **comentada no HTML** (`<!-- ... Sem chave (usar Autenticidade/Hash) ... -->`),
  isto é, **desativada para notas 2026 no front**.
- Campos comuns obrigatórios: `nota`, `valor` (formato `1000,55`), `ccmPrestador` (IM do
  prestador), `cnpjPrestador`.

**Testado ao vivo** (sem login) com a nota real 401/série 1 (competência 05/2026,
Autenticidade impressa `602F-A9BN`, IM `8439700`, CNPJ `05617377000108`, valor `1,00`):
em todas as 4 variações tentadas (`periodo=2025`+hash com traço, `periodo=2026`+hash
sem traço no front mas aceito no back, `periodo=2026`+chave vazia, hash sem traço +
série `001`) o resultado foi **sempre**:

```
Razão Social: VIEIRA & VIDIGAL MARTINS LTDA
CNPJ: 05617377000108
Documento: <vazio>
```

— classe CSS `result-err`. Ou seja: **o sistema reconhece corretamente o prestador**
(CNPJ+IM batem), mas **não confirma o documento** com os dados que temos dessa nota.
Hipóteses (não confirmadas): (a) o `hash` "Autenticidade" impresso não é o mesmo formato
que o backend espera para `modo=hash`; (b) essa nota 401 foi emitida pelo sistema legado
(scraper antigo) e não está indexada da mesma forma que uma nota emitida via este WS
ABRASF; (c) falta algum campo extra (ex. `serie` como string com zeros). Não convém
insistir mais nessa nota específica — **quando a Task 5/6 gerar a primeira nota real via
WS assinado, testar esta mesma página com o número + a Chave de Acesso retornada** (o
formulário deixa claro que 2026+ = fluxo por Chave de Acesso de 50 dígitos, não mais
hash curto).

**DANFSE_PUBLICO: `https://ipatinga.meumunicipio.online/ISS/consulta/consulta.php`**
— página pública confirmada (sem login, HTTP 200, form funcional), mas **não retorna
link de PDF/DANFSE diretamente no resultado testado** — o resultado é uma confirmação
textual (Razão Social/CNPJ/Documento). Não há evidência, nesta POC, de que a validação
bem-sucedida devolva um link para baixar o PDF. **Recomendação para a Task 8: não
depender deste endpoint para obter o PDF; gerar a DANFSE própria** (o brief já cogitava
essa alternativa como fallback) — decisão a confirmar quando houver uma nota real
2026 com Chave de Acesso para testar de novo.

---

## 8) Resumo executivo

| Pergunta do brief | Resposta |
|---|---|
| (a) Aceita `GerarNfse` sem assinatura? | **Não** — `E174 RPS não assinado`, mas passa por toda validação de schema antes disso |
| (b) Precisa cadastro prévio do CNPJ? | **Não precisou** — prestador já cadastrado em homologação (IM `8439700` reconhecida) |
| (c) Formato de alíquota | Inconclusivo por schema (`3.00` e `0.03` ambos passam); indício forte de `3.00` (percentual) pela nota real impressa — confirmar com nota assinada |
| (d) Onde entram `cNBS`/`IBSCBS`? | `CodigoNbs` (não `NBS`) é opcional na `Servico`; **`IBSCBS` não existe neste schema** — ABRASF 2.04 clássico, sem reforma tributária ainda |
| (e) Retorno traz link de DANFSE/PDF? | Não testado (bloqueado por assinatura) — pendente de nota real aceita |
| (f) Consulta pública funciona sem login? | **Sim, a página existe e é pública** (`consulta/consulta.php`), mas não confirmou a nota de teste disponível; fluxo 2026+ usa Chave de Acesso (50 dígitos), não hash curto |

---

## Bloco final (obrigatório)

```
PRECISA_ASSINATURA: sim (evidência: HTTP 200, retorno ABRASF normal com Codigo E174,
  Mensagem "RPS não assinado.", Correcao "Assine o RPS" — reproduzido em 'gerar' e
  'gerar-fracao'; não foi possível testar assinado, certificado A1 pendente do contador)
CADASTRO_PREVIO_HOMOLOG: não (prestador CNPJ 05617377000108 / IM 8439700 já cadastrado
  em homologação — ConsultarNfseFaixa retornou E212 "NFS-e não encontrada", não E43
  "IM não encontrada"; E43 foi reproduzido de propósito com a IM errada 106657 como
  controle)
FORMATO_ALIQUOTA: inconclusivo (schema aceita tanto 3.00 quanto 0.03 sem diferenciar;
  indício forte de 3.00/percentual pela nota real impressa mostrando "ALÍQUOTA(%)
  4,3547" — confirmar no primeiro GerarNfse assinado comparando o ValorIss retornado)
IM_VIEIRA: 8439700 (extraído do PDF print_test_nota401.pdf, campo "IM:" do bloco
  PRESTADOR; 106657 do brief era CCM de um tomador, não do prestador — confirmado
  também via WS: 106657 dá E43, 8439700 não dá erro de cadastro)
DANFSE_PUBLICO: https://ipatinga.meumunicipio.online/ISS/consulta/consulta.php
  (POST acao=validar_nfse; campos periodo[2025|2026], modo_validacao[chave|hash] +
  nota/serie/valor/ccmPrestador/cnpjPrestador + hash OU chaveacesso 50 dígitos
  conforme período) — página pública confirmada, mas não validou a nota de teste
  disponível (Documento: vazio em todas as tentativas); as URLs nfe_verifica.php /
  nfe_print.php sugeridas no brief não existem (HTTP 404)
XML_MINIMO_ACEITO: nenhum aceito ainda (bloqueado em E174 RPS não assinado — a
  estrutura abaixo passou por 100% da validação de schema, faltando só a assinatura):

<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd"><Rps><InfDeclaracaoPrestacaoServico Id="rps1"><Rps><IdentificacaoRps><Numero>1</Numero><Serie>1</Serie><Tipo>1</Tipo></IdentificacaoRps><DataEmissao>2026-07-10</DataEmissao><Status>1</Status></Rps><Competencia>2026-07-10</Competencia><Servico><Valores><ValorServicos>1.00</ValorServicos><Aliquota>3.00</Aliquota></Valores><IssRetido>2</IssRetido><ItemListaServico>4.12</ItemListaServico><Discriminacao>TESTE POC - nao valido</Discriminacao><CodigoMunicipio>3131307</CodigoMunicipio><ExigibilidadeISS>1</ExigibilidadeISS></Servico><Prestador><CpfCnpj><Cnpj>05617377000108</Cnpj></CpfCnpj><InscricaoMunicipal>8439700</InscricaoMunicipal></Prestador><TomadorServico><IdentificacaoTomador><CpfCnpj><Cpf>11144477735</Cpf></CpfCnpj></IdentificacaoTomador><RazaoSocial>Tomador Teste POC</RazaoSocial></TomadorServico><OptanteSimplesNacional>1</OptanteSimplesNacional><IncentivoFiscal>2</IncentivoFiscal></InfDeclaracaoPrestacaoServico></Rps></GerarNfseEnvio>

  (única correção necessária em relação ao brief original: <Tomador> → <TomadorServico>)
```
