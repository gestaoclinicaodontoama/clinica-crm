const test = require('node:test');
const assert = require('node:assert');
const { normalizarGranulesOggOpus, _oggCrc, _paginas } = require('./ogg-granule');

// Monta uma página Ogg válida (CRC calculado) com pacotes completos.
function pagina({ flags = 0, granule, serial = 7, seq, pacotes }) {
  const lacing = [];
  for (const p of pacotes) {
    let resto = p.length;
    while (resto >= 255) { lacing.push(255); resto -= 255; }
    lacing.push(resto);
  }
  const head = Buffer.alloc(27 + lacing.length);
  head.write('OggS', 0);
  head[4] = 0; head[5] = flags;
  head.writeBigInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(serial, 14);
  head.writeUInt32LE(seq, 18);
  head.writeUInt32LE(0, 22); // crc depois
  head[26] = lacing.length;
  Buffer.from(lacing).copy(head, 27);
  const pg = Buffer.concat([head, ...pacotes]);
  pg.writeUInt32LE(_oggCrc(pg), 22);
  return pg;
}

// Pacote Opus SILK-WB 20ms mono (TOC cfg=9 → 0x48), padding até `tam` bytes
function pacoteOpus(tam = 40) {
  const p = Buffer.alloc(tam, 0xAA);
  p[0] = 0x48;
  return p;
}

const opusHead = () => {
  const p = Buffer.alloc(19);
  p.write('OpusHead', 0); p[8] = 1; p[9] = 1;
  p.writeUInt16LE(312, 10); p.writeUInt32LE(16000, 12);
  return p;
};
const opusTags = () => {
  const v = Buffer.from('teste');
  const p = Buffer.alloc(8 + 4 + v.length + 4);
  p.write('OpusTags', 0); p.writeUInt32LE(v.length, 8); v.copy(p, 12);
  p.writeUInt32LE(0, 12 + v.length);
  return p;
};

// Ogg completo: header + tags + 2 páginas de áudio (50 e 30 pacotes de 20ms) com desvio `delta`
function oggComDesvio(delta) {
  const a1 = Array.from({ length: 50 }, () => pacoteOpus());
  const a2 = Array.from({ length: 30 }, () => pacoteOpus());
  return Buffer.concat([
    pagina({ flags: 2, granule: 0, seq: 0, pacotes: [opusHead()] }),
    pagina({ granule: 0, seq: 1, pacotes: [opusTags()] }),
    pagina({ granule: 48000 + delta, seq: 2, pacotes: a1 }),
    pagina({ flags: 4, granule: 76800 + delta, seq: 3, pacotes: a2 }),
  ]);
}

test('CRC do Ogg bate com implementação de referência', () => {
  // valor calculado por implementação independente (Python) validada por decode no ffmpeg
  const pg = pagina({ granule: 48000, serial: 7, seq: 2, pacotes: [Buffer.from('abc')] });
  assert.strictEqual(pg.readUInt32LE(22), 0x20974513);
});

test('desvio -24 (caso real do iPhone) é corrigido em todas as páginas', () => {
  const out = normalizarGranulesOggOpus(oggComDesvio(-24));
  const g = _paginas(out).map(p => Number(p.granule));
  assert.deepStrictEqual(g, [0, 0, 48000, 76800]);
});

test('páginas corrigidas têm CRC válido', () => {
  const out = normalizarGranulesOggOpus(oggComDesvio(-24));
  for (const p of _paginas(out)) {
    const pg = Buffer.from(out.subarray(p.off, p.off + p.len));
    const crcArmazenado = pg.readUInt32LE(22);
    pg.writeUInt32LE(0, 22);
    assert.strictEqual(crcArmazenado, _oggCrc(pg));
  }
});

test('arquivo já correto volta intacto (mesmo objeto, zero cópia)', () => {
  const ok = oggComDesvio(0);
  assert.strictEqual(normalizarGranulesOggOpus(ok), ok);
});

test('só os granules e CRCs mudam — bitstream intocado', () => {
  const antes = oggComDesvio(-24);
  const depois = normalizarGranulesOggOpus(antes);
  const pgsA = _paginas(antes), pgsD = _paginas(depois);
  for (let i = 0; i < pgsA.length; i++) {
    const a = antes.subarray(pgsA[i].off + 27, pgsA[i].off + pgsA[i].len);
    const d = depois.subarray(pgsD[i].off + 27, pgsD[i].off + pgsD[i].len);
    assert.ok(a.equals(d), `corpo da página ${i} mudou`);
  }
});

test('desvio absurdo (>1s) não é tocado — proteção contra estrutura inesperada', () => {
  const estranho = oggComDesvio(50000);
  assert.strictEqual(normalizarGranulesOggOpus(estranho), estranho);
});

test('buffer que não é ogg volta intacto', () => {
  const naoOgg = Buffer.from('definitivamente nao e um ogg');
  assert.strictEqual(normalizarGranulesOggOpus(naoOgg), naoOgg);
});
