// Uso: node scripts/import-standalone-localstorage.js --json /path/to/export.json --dentista-id <uuid> [--execute]
// Sem --execute: imprime SQL no stdout para revisão
// Com --execute: insere direto no Supabase via service_role

'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// ─── Carregar .env manualmente (evita dependência de dotenv instalado em scripts/)
// Procura .env na raiz do projeto (um nível acima de scripts/)
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} else {
  // dotenv como fallback se não achou .env manualmente
  try {
    require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
  } catch (_) {
    // dotenv não disponível; prosseguir — variáveis podem estar no ambiente
  }
}

// ─── Parse de argumentos CLI ───────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--json' && argv[i + 1]) {
      args.jsonPath = argv[++i];
    } else if (argv[i] === '--dentista-id' && argv[i + 1]) {
      args.dentistaId = argv[++i];
    } else if (argv[i] === '--execute') {
      args.execute = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv);

if (!args.jsonPath || !args.dentistaId) {
  console.error('Erro: argumentos obrigatórios faltando.\n');
  console.error('Uso:');
  console.error('  node scripts/import-standalone-localstorage.js \\');
  console.error('    --json /caminho/para/export.json \\');
  console.error('    --dentista-id <uuid-do-dentista-no-supabase> \\');
  console.error('    [--execute]\n');
  console.error('Sem --execute: imprime SQL no stdout para revisão.');
  console.error('Com --execute: insere diretamente no Supabase via service_role.');
  process.exit(1);
}

// UUID v4 simples — valida formato sem biblioteca
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!UUID_RE.test(args.dentistaId)) {
  console.error(`Erro: --dentista-id "${args.dentistaId}" não parece um UUID v4 válido.`);
  process.exit(1);
}

// ─── Ler arquivo JSON de entrada ───────────────────────────────────────────────
let exportData;
try {
  const raw = fs.readFileSync(path.resolve(args.jsonPath), 'utf8');
  exportData = JSON.parse(raw);
} catch (err) {
  console.error(`Erro ao ler/parsear o arquivo JSON: ${err.message}`);
  process.exit(1);
}

if (!exportData.consultas || !Array.isArray(exportData.consultas)) {
  console.error('Erro: o JSON não contém uma chave "consultas" com um array.');
  console.error('Estrutura esperada: { "consultas": [ { "id": "...", ... } ] }');
  process.exit(1);
}

const consultasRaw = exportData.consultas;
console.error(`[info] ${consultasRaw.length} consulta(s) encontrada(s) no arquivo.`);

// ─── Inferência de modo ────────────────────────────────────────────────────────
// O standalone armazenava uso.deepgram_duracao_min para sessões ao vivo com Deepgram.
// Se esse campo é > 0, a consulta usou gravação em tempo real → modo 'deepgram'.
// Se transcript contiver objetos com campo "source: 'upload'" ou similar, foi upload de áudio.
// Caso contrário, assumimos que foi inserção de texto manual.
function inferirModo(consulta) {
  const durMin = consulta.uso && consulta.uso.deepgram_duracao_min;
  if (typeof durMin === 'number' && durMin > 0) return 'deepgram';

  // Heurística de upload: transcript com objetos que têm campo source='upload'
  // (o standalone não formalizou isso, mas deixamos como fallback defensivo)
  if (Array.isArray(consulta.transcript) && consulta.transcript.length > 0) {
    const temUpload = consulta.transcript.some(
      (t) => t && t.source === 'upload'
    );
    if (temUpload) return 'audio';
  }

  return 'texto';
}

// ─── Transformação de cada consulta ───────────────────────────────────────────
function transformarConsulta(c, dentistaId) {
  const legacyId = String(c.id);                 // preservar como string
  const newId    = randomUUID();                  // UUID v4 novo para a PK
  const savedAt  = c.savedAt || new Date().toISOString();

  // Normalizar uso
  const usoOriginal = c.uso || {};
  const uso = {
    gemini_tokens_out: usoOriginal.gemini_tokens_total ?? 0,
    gemini_tokens_in:  0,                                       // standalone não rastreava tokens de entrada
    custo_usd:         usoOriginal.custo_total_usd ?? null,
    deepgram_seg:      typeof usoOriginal.deepgram_duracao_min === 'number'
                         ? Math.round(usoOriginal.deepgram_duracao_min * 60)
                         : 0,
  };

  // Garantir schema_version no bloco analysis
  const analysis = Object.assign({}, c.analysis || {});
  if (!analysis.schema_version) {
    analysis.schema_version = 1;
  }

  return {
    id:                          newId,
    id_legacy_localstorage:      legacyId,
    dentista_id:                 dentistaId,
    paciente_id:                 null,
    paciente_nome:               c.paciente || 'Desconhecido',
    paciente_vinculado:          false,
    lead_id:                     null,
    modo:                        inferirModo(c),
    started_at:                  savedAt,
    ended_at:                    null,
    transcript:                  c.transcript || null,
    analysis:                    analysis,
    analysis_schema_version:     1,
    uso:                         uso,
    // Consentimento manual: marcado como importação legacy
    // CHECK no banco exige consentimento_manual_versao quando paciente_vinculado=false e modo != 'texto'
    consentimento_manual_versao: 'v1-legacy-import',
    consentimento_manual_em:     savedAt,
    created_at:                  savedAt,
  };
}

const rows = consultasRaw.map((c) => transformarConsulta(c, args.dentistaId));

// ─── Modo seguro: gerar SQL para revisão ──────────────────────────────────────
function escapeSql(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'object') {
    // JSONB: stringify e escapar aspas simples duplicando-as
    return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
  }
  // string: escapar aspas simples
  return `'${String(val).replace(/'/g, "''")}'`;
}

function rowToSql(row) {
  const cols = [
    'id', 'id_legacy_localstorage', 'dentista_id',
    'paciente_id', 'paciente_nome', 'paciente_vinculado',
    'lead_id', 'modo', 'started_at', 'ended_at',
    'transcript', 'analysis', 'analysis_schema_version', 'uso',
    'consentimento_manual_versao', 'consentimento_manual_em', 'created_at',
  ];
  const vals = cols.map((col) => escapeSql(row[col]));
  return `INSERT INTO consultas_spin (${cols.join(', ')})\nVALUES (${vals.join(', ')})\nON CONFLICT (dentista_id, id_legacy_localstorage) WHERE id_legacy_localstorage IS NOT NULL DO NOTHING;`;
}

// ─── Modo --execute: upsert direto no Supabase ────────────────────────────────
async function executarNoSupabase(rowsParaInserir) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error('Erro: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar definidos no .env');
    process.exit(1);
  }

  let createClient;
  try {
    ({ createClient } = require('@supabase/supabase-js'));
  } catch (_) {
    console.error('Erro: @supabase/supabase-js não encontrado. Instale com: npm install @supabase/supabase-js');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  console.error(`[info] Inserindo ${rowsParaInserir.length} consulta(s) no Supabase...`);

  // Upsert em lote com ignoreDuplicates=true — duplicatas (mesmo dentista_id + id_legacy)
  // são silenciosamente ignoradas graças ao UNIQUE INDEX parcial no banco.
  const { data, error } = await supabase
    .from('consultas_spin')
    .upsert(rowsParaInserir, {
      onConflict: 'dentista_id,id_legacy_localstorage',
      ignoreDuplicates: true,
    })
    .select('id, id_legacy_localstorage');

  if (error) {
    console.error('Erro ao inserir no Supabase:');
    console.error(JSON.stringify(error, null, 2));
    process.exit(1);
  }

  const inseridas   = data ? data.length : 0;
  const duplicatas  = rowsParaInserir.length - inseridas;

  console.error('\n─── Relatório final ───────────────────────────────────────');
  console.error(`  Total processadas : ${rowsParaInserir.length}`);
  console.error(`  Inseridas         : ${inseridas}`);
  console.error(`  Duplicatas ignor. : ${duplicatas}`);
  console.error('──────────────────────────────────────────────────────────');

  if (inseridas > 0) {
    console.error('\nIDs inseridos:');
    for (const row of data) {
      console.error(`  ${row.id}  (legacy: ${row.id_legacy_localstorage})`);
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
if (args.execute) {
  executarNoSupabase(rows).catch((err) => {
    console.error('Erro inesperado:', err);
    process.exit(1);
  });
} else {
  // Modo seguro: imprimir SQL no stdout para revisão antes de executar
  console.log('-- ============================================================');
  console.log(`-- Migração standalone → consultas_spin`);
  console.log(`-- Dentista ID : ${args.dentistaId}`);
  console.log(`-- Gerado em   : ${new Date().toISOString()}`);
  console.log(`-- Total       : ${rows.length} consulta(s)`);
  console.log('-- Revisar antes de executar com: psql $DATABASE_URL -f <este_arquivo>');
  console.log('-- ============================================================\n');

  for (const row of rows) {
    console.log(rowToSql(row));
    console.log();
  }

  console.error('\n─── Relatório final ───────────────────────────────────────');
  console.error(`  Total processadas : ${rows.length}`);
  console.error('  SQL impresso no stdout (redirecione para .sql para salvar)');
  console.error('  Execute com --execute para inserir direto no banco.');
  console.error('──────────────────────────────────────────────────────────');
  console.error('\nExemplo de uso completo:');
  console.error(`  node scripts/import-standalone-localstorage.js \\`);
  console.error(`    --json export.json --dentista-id ${args.dentistaId} \\`);
  console.error(`    > import.sql`);
  console.error(`  psql $DATABASE_URL -f import.sql`);
}
