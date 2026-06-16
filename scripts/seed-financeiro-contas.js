require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { CONTAS } = require('../lib/financeiro/taxonomia');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

(async () => {
  const rows = CONTAS.map(c => ({ codigo: c.codigo, nome: c.nome, grupo: c.grupo, tipo: c.tipo, ordem: c.ordem, ativo: true }));
  const { error } = await supabase.from('fin_contas').upsert(rows, { onConflict: 'codigo' });
  if (error) { console.error('Erro:', error.message); process.exit(1); }
  console.log(`Seed fin_contas: ${rows.length} contas.`);
})();
