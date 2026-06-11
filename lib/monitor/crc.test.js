const { test } = require('node:test');
const assert = require('node:assert');
const { montarMonitorCrc, resumoCrcTexto } = require('./crc');

const DIA = { from: '2026-06-11T00:00:00-03:00', to: '2026-06-11T23:59:59.999-03:00' };
const T = h => `2026-06-11T${h}:00-03:00`;
const ANA = 'aaaaaaaa-0000-0000-0000-000000000001';
const BIA = 'bbbbbbbb-0000-0000-0000-000000000002';

function ev(tipo, lead_id, usuario_id, criado_em, metadata = {}) {
  return { tipo, lead_id, usuario_id, criado_em, metadata };
}

test('conversas = leads distintos (mensagem OU template); mensagens e templates contam volume', () => {
  const m = montarMonitorCrc({ periodo: DIA, eventos: [
    ev('mensagem_enviada', 1, ANA, T('09:00')),
    ev('mensagem_enviada', 1, ANA, T('09:05')),
    ev('template_enviado', 2, ANA, T('10:00')),
    ev('mensagem_enviada', 3, BIA, T('11:00')),
  ] });
  const ana = m.porCrc.find(c => c.usuario_id === ANA);
  assert.strictEqual(ana.conversas, 2);
  assert.strictEqual(ana.mensagens, 2);
  assert.strictEqual(ana.templates, 1);
  assert.strictEqual(m.time.conversas, 3);
});

test('eventos do sistema (usuario_id null) e fora da janela ficam de fora', () => {
  const m = montarMonitorCrc({ periodo: DIA, eventos: [
    ev('mensagem_enviada', 1, null, T('09:00')),
    ev('mensagem_enviada', 1, ANA, '2026-06-10T09:00:00-03:00'),
    ev('status_mudou', 2, ANA, T('10:00'), { para: 'Agendado' }),
  ] });
  assert.strictEqual(m.porCrc.length, 1);
  assert.strictEqual(m.porCrc[0].mensagens, 0);
  assert.strictEqual(m.porCrc[0].agendamentos, 1);
});

test('movimentacoes com breakdown por destino; Agendado tambem conta em agendamentos', () => {
  const m = montarMonitorCrc({ periodo: DIA, eventos: [
    ev('status_mudou', 1, ANA, T('09:00'), { para: 'Agendado' }),
    ev('status_mudou', 2, ANA, T('09:10'), { para: 'Nao tem Interesse' }),
    ev('status_mudou', 3, ANA, T('09:20'), { para: 'Nao tem Interesse' }),
  ] });
  const ana = m.porCrc[0];
  assert.strictEqual(ana.movimentacoes.total, 3);
  assert.strictEqual(ana.movimentacoes.porDestino['Agendado'], 1);
  assert.strictEqual(ana.movimentacoes.porDestino['Nao tem Interesse'], 2);
  assert.strictEqual(ana.agendamentos, 1);
});

test('anotacoes conta eventos nota_sdr_editada', () => {
  const m = montarMonitorCrc({ periodo: DIA, eventos: [
    ev('nota_sdr_editada', 1, ANA, T('09:00')),
    ev('nota_sdr_editada', 1, ANA, T('10:00')),
  ] });
  assert.strictEqual(m.porCrc[0].anotacoes, 2);
});

test('ligacoes: total e atendidas (duracao > 0)', () => {
  const m = montarMonitorCrc({ periodo: DIA, eventos: [], ligacoes: [
    { usuario_id: ANA, duracao_segundos: 35 },
    { usuario_id: ANA, duracao_segundos: 0 },
    { usuario_id: ANA, duracao_segundos: null },
  ] });
  assert.deepStrictEqual(m.porCrc[0].ligacoes, { total: 3, atendidas: 1 });
});

test('1a resposta: rajada de recebidas = UMA espera; media atribuida a quem respondeu', () => {
  const m = montarMonitorCrc({ periodo: DIA,
    recebidas: [
      { lead_id: 1, criada_em: T('09:00') },
      { lead_id: 1, criada_em: T('09:02') },
    ],
    eventos: [ ev('mensagem_enviada', 1, ANA, T('09:30')) ],
  });
  const ana = m.porCrc[0];
  assert.strictEqual(ana.respostas, 1);
  assert.strictEqual(ana.primeiraRespostaMediaMin, 30);
});

test('1a resposta: segunda espera depois de respondida; resposta de outro dia fecha espera do dia', () => {
  const m = montarMonitorCrc({ periodo: DIA,
    recebidas: [
      { lead_id: 1, criada_em: T('09:00') },
      { lead_id: 1, criada_em: T('14:00') },
    ],
    eventos: [
      ev('mensagem_enviada', 1, ANA, T('09:10')),
      ev('mensagem_enviada', 1, BIA, '2026-06-12T08:00:00-03:00'),
    ],
  });
  const ana = m.porCrc.find(c => c.usuario_id === ANA);
  const bia = m.porCrc.find(c => c.usuario_id === BIA);
  assert.strictEqual(ana.primeiraRespostaMediaMin, 10);
  assert.strictEqual(bia.respostas, 1);
  assert.strictEqual(bia.primeiraRespostaMediaMin, 1080);
  assert.strictEqual(m.time.respostas, 2);
});

test('espera aberta nao entra na media; sem respostas => media null', () => {
  const m = montarMonitorCrc({ periodo: DIA,
    recebidas: [{ lead_id: 9, criada_em: T('16:00') }],
    eventos: [ ev('mensagem_enviada', 8, ANA, T('10:00')) ],
  });
  const ana = m.porCrc[0];
  assert.strictEqual(ana.respostas, 0);
  assert.strictEqual(ana.primeiraRespostaMediaMin, null);
});

test('esperasAbertas passa direto para time.semResposta', () => {
  const abertas = [{ lead_id: 5, nome: 'Maria', desde: T('08:00') }];
  const m = montarMonitorCrc({ periodo: DIA, eventos: [], esperasAbertas: abertas });
  assert.deepStrictEqual(m.time.semResposta, abertas);
});

test('resumoCrcTexto monta o texto do push', () => {
  const m = montarMonitorCrc({ periodo: DIA, eventos: [
    ev('mensagem_enviada', 1, ANA, T('09:00')),
    ev('status_mudou', 1, ANA, T('09:30'), { para: 'Agendado' }),
    ev('mensagem_enviada', 2, BIA, T('10:00')),
  ], esperasAbertas: [{ lead_id: 7, nome: 'X', desde: T('07:00') }] });
  const txt = resumoCrcTexto(m, { [ANA]: 'Paola Cristine', [BIA]: 'Maria Jose' }, '11/06');
  assert.match(txt, /Resumo CRC 11\/06/);
  assert.match(txt, /2 conversas/);
  assert.match(txt, /1 agendamento/);
  assert.match(txt, /1 sem resposta/);
  assert.match(txt, /Paola 1c\/1a/);
  assert.match(txt, /Maria 1c\/0a/);
});