'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CSV_BASE = 'P:\\LUIZ\\POWER BI\\Dashboard\\Dashboard\\CSV\\03 - Comparecimentos';

function normPhone(s) {
  let t = String(s || '').replace(/\D/g, '');
  if (t.startsWith('55') && t.length >= 12) t = t.slice(2);
  if (t.length === 10) t = t.slice(0, 2) + '9' + t.slice(2);
  return t.slice(-11);
}

function parseCSV(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  // Detectar formato: arquivos antigos têm header na linha 0, novos têm título na linha 0 e header na linha 1
  const headerLine = lines[0].replace(/"/g, '').startsWith('Data de cadastro') ? 0 : 1;
  const dataStart  = headerLine + 1;
  const headers = lines[headerLine].split(';').map(h => h.replace(/"/g, '').trim());
  const rows = [];
  for (let i = dataStart; i < lines.length; i++) {
    const vals = lines[i].split(';').map(v => v.replace(/"/g, '').trim());
    const obj = {};
    headers.forEach((h, j) => { if (h) obj[h] = vals[j] || ''; });
    rows.push(obj);
  }
  return rows;
}

// Status que podem ser promovidos para Compareceu
const PRE_COMPARECEU = new Set(['Lead', 'Aguardando', 'Agendado', 'Faltou', 'Nutrir', 'Reclassificar']);

// Status além de Compareceu — não fazer downgrade, só preencher data se nula
const POS_COMPARECEU = new Set(['Compareceu', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'Em nutrição', 'Fechou', 'Perdido']);

async function main() {
  // 1. Ler todos os CSVs de comparecimento (histórico inteiro)
  const files = fs.readdirSync(CSV_BASE)
    .filter(f => f.match(/\.csv$/i))
    .sort();

  console.log(`\n📂 Arquivos de comparecimento: ${files.length}`);
  files.forEach(f => console.log('  ', f));

  // 2. Construir mapa phone → comparecimento mais recente
  const phoneMap = new Map();
  let totalRegistros = 0;

  for (const file of files) {
    const rows = parseCSV(path.join(CSV_BASE, file));
    totalRegistros += rows.length;
    for (const r of rows) {
      const phone = normPhone(r['Telefone']);
      if (!phone) continue;
      const dataComp = r['Data da consulta'];
      if (!dataComp) continue;
      if (!phoneMap.has(phone) || dataComp > phoneMap.get(phone).data_comparecimento) {
        phoneMap.set(phone, { data_comparecimento: dataComp, nome: r['Nome'] });
      }
    }
  }

  console.log(`\n📊 Total registros lidos: ${totalRegistros}`);
  console.log(`📱 Telefones únicos com comparecimento: ${phoneMap.size}`);

  // 3. Buscar e atualizar leads no banco em lotes
  const phones = [...phoneMap.keys()];
  const BATCH = 100;
  let totalEncontrados = 0;
  let totalAtualizados = 0;
  let totalJaCompareceu = 0;
  let totalPosCompareceu = 0;
  let totalNaoEncontrado = 0;

  console.log(`\n🔍 Buscando e atualizando em lotes de ${BATCH}...`);

  for (let i = 0; i < phones.length; i += BATCH) {
    const lote = phones.slice(i, i + BATCH);

    // Todas as variações de formato de telefone
    const loteExpanded = [];
    for (const p of lote) {
      const sem9 = p.length === 11 ? p.slice(0, 2) + p.slice(3) : null;
      loteExpanded.push(p);
      loteExpanded.push('55' + p);
      if (sem9) {
        loteExpanded.push(sem9);
        loteExpanded.push('55' + sem9);
      }
    }

    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, nome, telefone, status, data_comparecimento')
      .in('telefone', loteExpanded);

    if (error) {
      console.error('Erro ao buscar lote:', error.message);
      continue;
    }

    const leadsMap = new Map();
    for (const lead of (leads || [])) {
      const p = normPhone(lead.telefone);
      if (!leadsMap.has(p)) leadsMap.set(p, []);
      leadsMap.get(p).push(lead);
    }

    for (const phone of lote) {
      const info = phoneMap.get(phone);
      const matchedLeads = leadsMap.get(phone) || [];

      if (matchedLeads.length === 0) {
        totalNaoEncontrado++;
        continue;
      }

      totalEncontrados += matchedLeads.length;

      for (const lead of matchedLeads) {
        if (POS_COMPARECEU.has(lead.status)) {
          if (!lead.data_comparecimento) {
            await supabase.from('leads').update({ data_comparecimento: info.data_comparecimento }).eq('id', lead.id);
          }
          totalPosCompareceu++;
          continue;
        }

        if (lead.status === 'Compareceu') {
          totalJaCompareceu++;
          continue;
        }

        if (!PRE_COMPARECEU.has(lead.status)) continue;

        const { error: errUpd } = await supabase
          .from('leads')
          .update({ status: 'Compareceu', data_comparecimento: info.data_comparecimento })
          .eq('id', lead.id);

        if (errUpd) {
          console.error(`  ❌ Erro ${lead.id} (${lead.nome}):`, errUpd.message);
        } else {
          totalAtualizados++;
          if (totalAtualizados <= 15) {
            console.log(`  ✅ ${lead.nome} | ${lead.status} → Compareceu | ${info.data_comparecimento.slice(0, 10)}`);
          }
        }
      }
    }

    process.stdout.write(`\r  Lote ${Math.min(i + BATCH, phones.length)}/${phones.length} processado...`);
  }

  console.log('\n');
  console.log('='.repeat(50));
  console.log('📋 RESULTADO FINAL');
  console.log('='.repeat(50));
  console.log(`  Telefones únicos nos CSVs:     ${phoneMap.size}`);
  console.log(`  Encontrados no banco:           ${totalEncontrados}`);
  console.log(`  ✅ Atualizados → Compareceu:    ${totalAtualizados}`);
  console.log(`  ⏭️  Já eram Compareceu:          ${totalJaCompareceu}`);
  console.log(`  ⏭️  Já além de Compareceu:       ${totalPosCompareceu}`);
  console.log(`  ❓ Não encontrados no banco:     ${totalNaoEncontrado}`);
  console.log('='.repeat(50));
}

main().catch(err => { console.error('Erro fatal:', err); process.exit(1); });
