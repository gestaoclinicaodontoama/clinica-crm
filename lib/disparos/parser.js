// Parser de CSV para disparo em massa (roda no servidor).
// Aceita o formato wa_3 (nome_completo,primeiro_nome,telefone,tratamento,valor_orcamento)
// e o formato simples (nome,telefone). Separador virgula ou ponto-e-virgula.

function normalizarTelefoneEnvio(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) d = '55' + d;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  return null;
}

// Quebra uma linha de CSV respeitando aspas. Separador virgula ou ponto-e-virgula.
function splitLinha(linha) {
  const out = []; let i = 0, campo = '', emAspas = false;
  while (i < linha.length) {
    const ch = linha[i];
    if (emAspas) {
      if (ch === '"' && linha[i + 1] === '"') { campo += '"'; i += 2; continue; }
      if (ch === '"') { emAspas = false; i++; continue; }
      campo += ch; i++; continue;
    }
    if (ch === '"') { emAspas = true; i++; continue; }
    if (ch === ',' || ch === ';') { out.push(campo.trim()); campo = ''; i++; continue; }
    campo += ch; i++;
  }
  out.push(campo.trim());
  return out;
}

function tirarIdParenteses(nome) {
  return String(nome || '').replace(/\s*\(\d+\)\s*$/, '').trim();
}

function primeiroToken(nome) {
  const t = String(nome || '').trim().split(/\s+/)[0];
  return t || '';
}

// Detecta o indice de colunas conhecidas a partir do cabecalho.
function mapearColunas(cabecalho) {
  const norm = cabecalho.map(c => c.toLowerCase().replace(/^﻿/, '').trim());
  const idx = (nomes) => {
    for (const n of nomes) { const i = norm.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  return {
    nomeCompleto: idx(['nome_completo', 'nome', 'name']),
    primeiroNome: idx(['primeiro_nome', 'first_name', 'fn']),
    telefone: idx(['telefone', 'phone', 'celular', 'whatsapp']),
  };
}

const CABECALHO_RX = /(nome|name|telefone|phone|celular|whatsapp|primeiro_nome)/i;

function parseCsv(texto) {
  const linhas = String(texto || '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (!linhas.length) return { contatos: [], invalidos: 0 };

  // Decide se a 1a linha e cabecalho.
  const primeira = splitLinha(linhas[0]);
  const primeiraComDigito = primeira.find(c => /\d/.test(c)) || '';
  const temCabecalho = primeira.some(c => CABECALHO_RX.test(c)) &&
    normalizarTelefoneEnvio(primeiraComDigito) === null;

  let cols, dados;
  if (temCabecalho) {
    cols = mapearColunas(primeira);
    dados = linhas.slice(1);
  } else {
    // Sem cabecalho: assume nome, telefone.
    cols = { nomeCompleto: 0, primeiroNome: -1, telefone: 1 };
    dados = linhas;
  }

  const contatos = [];
  let invalidos = 0;
  for (const linha of dados) {
    const campos = splitLinha(linha);
    // telefone: coluna mapeada, ou a 1a coluna que normalize para um numero valido.
    let telBruto = cols.telefone >= 0 ? campos[cols.telefone] : '';
    let telefone = normalizarTelefoneEnvio(telBruto);
    if (!telefone) {
      for (const c of campos) { const t = normalizarTelefoneEnvio(c); if (t) { telefone = t; break; } }
    }
    if (!telefone) { invalidos++; continue; }

    const nomeCompletoRaw = cols.nomeCompleto >= 0 ? campos[cols.nomeCompleto] : '';
    const nome = tirarIdParenteses(nomeCompletoRaw);
    let primeiro_nome = cols.primeiroNome >= 0 ? campos[cols.primeiroNome] : '';
    primeiro_nome = (primeiro_nome || primeiroToken(nome)).trim() || 'tudo bem';

    contatos.push({ nome: nome || primeiro_nome, primeiro_nome, telefone });
  }
  return { contatos, invalidos };
}

module.exports = { parseCsv, normalizarTelefoneEnvio };
