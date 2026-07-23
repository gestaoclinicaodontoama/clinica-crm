'use strict';
// Carga inicial do módulo Financeiro → Laboratórios. Idempotente: pula nota que já existe
// (mesma laboratorio+referencia). Rodar APÓS aplicar a migration 20260723120000_protetico.sql.
// Uso: node scripts/seed-protetico-2026.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { NOTAS } = require('./seed-protetico-2026.data.js');
const { prepararNota } = require('../lib/protetico/notas');
const { PADROES_SEED } = require('../lib/protetico/categoria');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
if (!url || !key) { console.error('Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE no ambiente.'); process.exit(1); }
const supabase = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  // Catálogo de categorias (upsert por padrao)
  const { error: catErr } = await supabase
    .from('protetico_categorias')
    .upsert(PADROES_SEED.map(p => ({ padrao: p.padrao, categoria: p.categoria })), { onConflict: 'padrao' });
  if (catErr) throw new Error(`catálogo: ${catErr.message}`);
  console.log(`Catálogo: ${PADROES_SEED.length} padrões garantidos.`);

  let inseridas = 0, puladas = 0, itensTotal = 0;
  const porLab = {};
  for (const notaSrc of NOTAS) {
    const { data: existente, error: exErr } = await supabase
      .from('protetico_notas').select('id')
      .eq('laboratorio', notaSrc.laboratorio).eq('referencia', notaSrc.referencia).maybeSingle();
    if (exErr) throw new Error(`consulta ${notaSrc.referencia}: ${exErr.message}`);
    if (existente) { puladas++; console.log(`pulada (já existe): ${notaSrc.laboratorio} | ${notaSrc.referencia}`); continue; }

    const { nota, itens, avisos } = prepararNota({ ...notaSrc, criado_por: 'seed', padroes: PADROES_SEED });
    for (const a of avisos) console.log(`⚠️ ${notaSrc.laboratorio} | ${notaSrc.referencia}: ${a}`);

    const { data: notaIns, error: notaErr } = await supabase
      .from('protetico_notas').insert(nota).select('id').single();
    if (notaErr) throw new Error(`insert nota ${notaSrc.referencia}: ${notaErr.message}`);

    const { error: itensErr } = await supabase
      .from('protetico_itens').insert(itens.map(i => ({ ...i, nota_id: notaIns.id })));
    if (itensErr) {
      await supabase.from('protetico_notas').delete().eq('id', notaIns.id);
      throw new Error(`insert itens ${notaSrc.referencia}: ${itensErr.message}`);
    }
    inseridas++; itensTotal += itens.length;
    const soma = itens.reduce((s, i) => s + i.valor_total, 0);
    porLab[nota.laboratorio] = Math.round(((porLab[nota.laboratorio] || 0) + soma) * 100) / 100;
    console.log(`ok: ${nota.laboratorio} | ${nota.referencia} | ${itens.length} itens | R$ ${soma.toFixed(2)}`);
  }
  console.log('---');
  console.log(`Notas inseridas: ${inseridas} · puladas: ${puladas} · itens: ${itensTotal}`);
  console.log('Soma por laboratório:', porLab);
  console.log('Lembrete: o "Total = 1.710,00" avulso da 4ª foto do caderno NÃO foi semeado (provável dupla contagem com a planilha do Marcos Miranda de março — confirmar com o Luiz).');
}

main().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
