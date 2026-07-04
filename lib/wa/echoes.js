// lib/wa/echoes.js
// Ecos de mensagens enviadas pelo app WhatsApp Business / IA da Meta (coexistência).
// O webhook principal só trata field='messages'; sem este parser, respostas dadas
// fora do CRM não existem no banco (spec 2026-07-03-fila-aguardando-ecos-claim).
const FIELDS = new Set(['smb_message_echoes', 'message_echoes']);

function parseEchoes(body) {
  const out = [];
  try {
    for (const entry of (Array.isArray(body?.entry) ? body.entry : [])) {
      for (const change of (Array.isArray(entry?.changes) ? entry.changes : [])) {
        if (!FIELDS.has(change?.field)) continue;
        const v = change.value || {};
        for (const e of (Array.isArray(v.message_echoes) ? v.message_echoes : [])) {
          const tipo = e.type || 'text';
          out.push({
            to: String(e.to || ''),
            wamid: e.id || '',
            tipo,
            texto: e.text?.body || (tipo !== 'text' ? '[' + tipo + ']' : ''),
            phone_number_id: v.metadata?.phone_number_id || '',
            timestamp: e.timestamp ? new Date(Number(e.timestamp) * 1000).toISOString() : null,
          });
        }
      }
    }
  } catch { /* nunca quebra o webhook */ }
  return out.filter(e => e.to && e.wamid && e.tipo !== 'reaction');
}

module.exports = { parseEchoes };
