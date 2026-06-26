// Carga histórica da prevenção (janela larga). Uso: node scripts/backfill-prevencao.js [dias]
const { syncPrevencao } = require('../sync/clinicorp-sync');
const dias = Number(process.argv[2]) || 1080;
syncPrevencao(dias)
  .then(r => { console.log('backfill prevenção:', JSON.stringify(r)); process.exit(0); })
  .catch(e => { console.error('falhou:', e.message); process.exit(1); });
