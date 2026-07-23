'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolverCategoria, PADROES_SEED, CATEGORIAS } = require('./categoria');

// Casos reais lidos das notas dos 5 laboratórios (23/07/2026)
const casos = [
  ['Coroa Fresada Dissilicato', 'Coroa unitária'],
  ['CMC AMA', 'Coroa unitária'],
  ['Zircônia Ama', 'Coroa unitária'],
  ['Zirconia - Coroa Zirconia 3D', 'Coroa unitária'],
  ['01 coroa total e-max (D: 45)', 'Coroa unitária'],
  ['01 onlay e-max (D: 47)', 'Coroa unitária'],
  ['01 c/impl', 'Coroa unitária'],
  ['01 Rest EMAX 46', 'Coroa unitária'],
  ['RESINA IMPRESSA COM CARGA DE CERÂMICA', 'Coroa unitária'],
  ['Protocolo Fresado Em Zircônia', 'Protocolo'],
  ['PROTOCOLO STG TRILUX SUPERIOR', 'Protocolo'],
  ['PROTOCOLO S/ BARRA STG TRILUX INFERIOR', 'Protocolo'],
  ['PROVA DE PROTOCOLO DE ZIRCONIA', 'Protocolo'],
  ['PROTOCOLO FRESADO PMMA', 'Protocolo'],
  ['PT IMEDIATA SUPERIOR', 'Prótese total'],
  ['PT IMEDIATA STG INFERIOR', 'Prótese total'],
  ['PROTESE TOTAL INFERIOR', 'Prótese total'],
  ['PRÓTESE TOTAL COMUM SUPERIOR COM STG', 'Prótese total'],
  ['ROACH PREMIUM TRILUX SUPERIOR', 'Prótese parcial'],
  ['ROACH STG TRILUX SUPERIOR', 'Prótese parcial'],
  ['PARCIAL PROVISÓRIA INFERIOR', 'Prótese parcial'],
  ['Provisorio Digital Fresado PMMA', 'Provisório'],
  ['PLACA BRUXISMO', 'Placa de bruxismo'],
  ['PLACA DE BRUXISMO FRESADA', 'Placa de bruxismo'],
  ['Modelo Digital - Total', 'Modelo/acessório'],
  ['Modelo Digital - Parcial', 'Modelo/acessório'],
  ['Link Cad/ Cam+Parafuso', 'Modelo/acessório'],
  ['Ánalogos Mini Pilar', 'Modelo/acessório'],
  ['tbase', 'Modelo/acessório'],
  ['Muralha de Zetalabor', 'Modelo/acessório'],
  ['PLANO DE CERA INFERIOR', 'Modelo/acessório'],
  ['Enceramento Diagnóstico', 'Enceramento'],
  ['Zirconia - Enceramento', 'Enceramento'],
  ['Zirconia - Reparo', 'Reparo'],
  ['Coroa Fresada de Dissilicato - Reparo', 'Reparo'],
  ['Coroa Dissilicato Reparo', 'Reparo'],
  ['Enceramento - Reparo', 'Reparo'],
  ['01 gengiva', 'Outros'],
  ['Gesso - Acabamento (Cortesia)', 'Outros'],
];

test('resolverCategoria cobre os padrões reais dos 5 labs', () => {
  for (const [desc, esperado] of casos) {
    assert.strictEqual(resolverCategoria(desc, PADROES_SEED), esperado, desc);
  }
});

test('reparo vence coroa (prioridade explícita ganha)', () => {
  assert.strictEqual(resolverCategoria('Coroa Fresada de Dissilicato - Reparo', PADROES_SEED), 'Reparo');
});

test('matching é insensível a acento e caixa', () => {
  assert.strictEqual(resolverCategoria('protese total superior', PADROES_SEED), 'Prótese total');
  assert.strictEqual(resolverCategoria('ZIRCÔNIA AMA', PADROES_SEED), 'Coroa unitária');
});

test('sem match cai em Outros; toda categoria do seed existe no canônico', () => {
  assert.strictEqual(resolverCategoria('coisa desconhecida xyz', PADROES_SEED), 'Outros');
  for (const p of PADROES_SEED) assert.ok(CATEGORIAS.includes(p.categoria), p.categoria);
});
