// Normalização dos granule positions de um Ogg/Opus vindo do ffmpeg.
//
// PROBLEMA (descoberto 17/07/2026, forense do "áudio não disponível" no iPhone):
// quando a entrada da conversão é o webm do MediaRecorder (gravação do navegador),
// o timestamp inicial da gravação às vezes vem deslocado (~-0,5ms) e o ffmpeg
// propaga o deslocamento para TODOS os granule positions do ogg (ex.: 1ª página de
// áudio com granule 47976 em vez de 48000 = -24 amostras @48kHz). Granule menor
// que o total de amostras da página é inválido pela RFC 7845 — o WhatsApp do iOS
// REJEITA o arquivo ("Este áudio não está mais disponível"); Android tolera.
// O deslocamento depende do timestamp que o navegador gravou naquele momento —
// por isso o bug parecia intermitente (áudios do MESMO servidor ora tocavam, ora não).
//
// CORREÇÃO: pós-processar os bytes do ogg — medir o desvio da 1ª página de áudio
// (granule real − soma das amostras dos pacotes) e somar o delta em todas as
// páginas com granule, recalculando o CRC de cada página alterada. Determinístico,
// independe da versão do ffmpeg e não toca no bitstream Opus.

// Amostras (@48kHz) por frame, indexado pelo config do TOC (RFC 6716 §3.1).
function _amostrasPorFrame(cfg) {
  if (cfg < 12) return [480, 960, 1920, 2880][cfg % 4];   // SILK NB/MB/WB 10/20/40/60ms
  if (cfg < 16) return [480, 960][cfg % 2];               // Híbrido 10/20ms
  return [120, 240, 480, 960][(cfg - 16) % 4];            // CELT 2.5/5/10/20ms
}

// Amostras (@48kHz) de um pacote Opus a partir do TOC (1º byte) e, se code 3, do 2º byte.
function _amostrasPacote(b0, b1) {
  const frames = (b0 & 0x3) === 0 ? 1 : (b0 & 0x3) < 3 ? 2 : (b1 & 0x3F);
  return frames * _amostrasPorFrame(b0 >> 3);
}

// CRC-32 do Ogg: polinômio 0x04C11DB7, NÃO refletido, init 0, sem xor final
// (difere do CRC-32 comum do zlib — não reutilizar require('zlib').crc32).
const _CRC_TAB = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = ((r & 0x80000000) ? (r << 1) ^ 0x04C11DB7 : r << 1) >>> 0;
    t[i] = r;
  }
  return t;
})();
function _oggCrc(buf) {
  let r = 0;
  for (let i = 0; i < buf.length; i++) r = (((r << 8) >>> 0) ^ _CRC_TAB[((r >>> 24) & 0xFF) ^ buf[i]]) >>> 0;
  return r;
}

// Percorre as páginas do ogg. Retorna [{off, len, granule, amostras}] — `amostras` é a
// soma das amostras dos pacotes que COMEÇAM na página (pacote continuado conta onde começa).
function _paginas(buf) {
  const pgs = [];
  let off = 0, continuando = false;
  while (off + 27 <= buf.length && buf.readUInt32BE(off) === 0x4F676753) { // 'OggS'
    const nseg = buf[off + 26];
    const corpo = off + 27 + nseg;
    let amostras = 0, tam = 0, inicioPacote = !continuando && !(buf[off + 5] & 0x01);
    let pos = corpo;
    for (let s = 0; s < nseg; s++) {
      const lace = buf[off + 27 + s];
      if (inicioPacote && tam === 0 && lace > 0 && pos + 1 < buf.length) {
        const ehHeader = lace >= 8 && (buf.readBigUInt64BE(pos) === 0x4F70757348656164n || buf.readBigUInt64BE(pos) === 0x4F70757354616773n);
        if (!ehHeader) amostras += _amostrasPacote(buf[pos], buf[pos + 1] || 0);
      }
      tam += lace; pos += lace;
      if (lace < 255) { tam = 0; inicioPacote = true; }
      else inicioPacote = false;
    }
    continuando = tam > 0; // último pacote não terminou → continua na próxima página
    const len = corpo + [...buf.subarray(off + 27, off + 27 + nseg)].reduce((a, b) => a + b, 0) - off;
    pgs.push({ off, len, granule: buf.readBigInt64LE(off + 6), amostras });
    off += len;
  }
  return pgs;
}

// Corrige o desvio uniforme dos granules. Retorna o MESMO buffer se nada a corrigir.
function normalizarGranulesOggOpus(buf) {
  let pgs;
  try { pgs = _paginas(buf); } catch (_) { return buf; }
  if (!pgs.length || pgs[pgs.length - 1].off + pgs[pgs.length - 1].len !== buf.length) return buf; // estrutura inesperada: não mexe
  let acumulado = 0, delta = null;
  for (const p of pgs) {
    acumulado += p.amostras;
    if (delta === null && p.granule > 0n) { delta = BigInt(acumulado) - p.granule; break; }
  }
  if (delta === null || delta === 0n) return buf;
  if (delta < -48000n || delta > 48000n) return buf; // desvio absurdo (>1s): estrutura fora do esperado, não arrisca
  const out = Buffer.from(buf);
  for (const p of pgs) {
    if (p.granule <= 0n) continue; // headers (0) e páginas sem fim de pacote (-1) ficam
    out.writeBigInt64LE(p.granule + delta, p.off + 6);
    out.writeUInt32LE(0, p.off + 22);
    out.writeUInt32LE(_oggCrc(out.subarray(p.off, p.off + p.len)), p.off + 22);
  }
  return out;
}

module.exports = { normalizarGranulesOggOpus, _oggCrc, _paginas };
