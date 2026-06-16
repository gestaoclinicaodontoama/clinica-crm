function deacc(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}
const ENT = /\s*-\s*(AMA|MAR|PF|Martins)\b/i;
const STOP = new Set(['de','da','do','dos','das','e','a','o','conta','pagamento','nfe','nf','n','por','para','com']);

function nucleo(desc) {
  let s = deacc(desc);
  s = s.replace(/^pagamento de conta:\s*/i, '');
  s = s.replace(/\s*\d+\/\d+\s*/g, ' ');   // parcela N/M
  s = s.replace(ENT, ' ');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function empresa(desc) {
  const m = ENT.exec(String(desc || ''));
  if (!m) return null;
  const e = m[1].toUpperCase();
  return (e === 'MARTINS') ? 'MAR' : e;
}

function tokens(desc) {
  return nucleo(desc).match(/[a-z]{3,}/g)?.filter(t => !STOP.has(t)) || [];
}

module.exports = { nucleo, empresa, tokens, deacc };