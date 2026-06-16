require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { nucleo, tokens } = require('../lib/financeiro/normalizar');

const XLSM = process.env.DEPARA_PATH || 'C:\\Users\\Luiz Martins\\Documents\\AMA -ADMIN\\descricao e cat certa.xlsm';
const XLSX = require('xlsx');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

(async () => {
  const wb = XLSX.readFile(XLSM);
  const ws = wb.Sheets['Planilha1'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(2);

  const { CONTAS } = require('../lib/financeiro/taxonomia');
  const byNomeLower = new Map(CONTAS.map(c => [c.nome.toLowerCase(), c.codigo]));
  function resolveCodigo(catCerta) {
    const m = String(catCerta).match(/^(\d+(?:\.\d+)*)/);
    if (m && CONTAS.find(c => c.codigo === m[1])) return m[1];
    const nome = String(catCerta).replace(/^[\d.\s]+/, '').trim().toLowerCase();
    return byNomeLower.get(nome) || null;
  }

  const exatos = new Map();
  const tokVote = new Map();
  let skipped = 0;
  for (const r of rows) {
    const desc = r[0], cat = r[1];
    if (!desc || !cat) continue;
    const cod = resolveCodigo(cat);
    if (!cod) { skipped++; continue; }
    exatos.set(nucleo(desc), cod);
    for (const t of tokens(desc)) {
      const m = tokVote.get(t) || new Map();
      m.set(cod, (m.get(cod) || 0) + 1);
      tokVote.set(t, m);
    }
  }
  const keywords = [];
  for (const [t, m] of tokVote) {
    const [cod, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n >= 2) keywords.push({ metodo: 'keyword', padrao: t, conta_codigo: cod, peso: n });
  }
  const seed = [
    ...[...exatos].map(([padrao, cod]) => ({ metodo: 'exato', padrao, conta_codigo: cod, peso: 1 })),
    ...keywords,
  ];
  fs.writeFileSync(__dirname + '/_seed_regras.json', JSON.stringify(seed, null, 2));
  console.log(`De-para: ${rows.filter(r => r[0] && r[1]).length} linhas válidas; ${skipped} categorias não mapeadas (puladas).`);

  const { data: contas } = await supabase.from('fin_contas').select('id,codigo');
  const idByCod = new Map(contas.map(c => [c.codigo, c.id]));
  const rowsDb = seed.filter(s => idByCod.has(s.conta_codigo))
    .map(s => ({ metodo: s.metodo, padrao: s.padrao, conta_id: idByCod.get(s.conta_codigo), peso: s.peso, origem: 'semente' }));
  const { error } = await supabase.from('fin_regras').upsert(rowsDb, { onConflict: 'metodo,padrao' });
  if (error) { console.error(error.message); process.exit(1); }
  console.log(`Seed regras: ${exatos.size} exatas + ${keywords.length} keywords. Inseridas: ${rowsDb.length}.`);
})();
