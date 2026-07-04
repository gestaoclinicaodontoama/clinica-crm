// 30 categorias canônicas (extraídas de "descricao e cat certa.xlsm" / DRE do Luiz).
// tipo: receita|imposto|custo|despesa|financeiro|investimento
const CONTAS = [
  { codigo: '1.1', nome: 'Convênio',   grupo: '1 - RECEITA', tipo: 'receita', ordem: 1 },
  { codigo: '1.2', nome: 'Particular', grupo: '1 - RECEITA', tipo: 'receita', ordem: 2 },

  { codigo: '2.1', nome: 'SIMPLES',     grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 10 },
  { codigo: '2.2', nome: 'Cofins',      grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 11 },
  { codigo: '2.3', nome: 'CSLL',        grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 12 },
  { codigo: '2.4', nome: 'IRPJ',        grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 13 },
  { codigo: '2.5', nome: 'IRPF',        grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 14 },
  { codigo: '2.6', nome: 'PIS',         grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 15 },
  { codigo: '2.7', nome: 'ISS',         grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 16 },
  { codigo: '2.8', nome: 'Carnê Leão',  grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 17 },

  { codigo: '3.0.1', nome: 'Tarifa cartão de crédito', grupo: '3.0 - TARIFAS', tipo: 'custo', ordem: 20 },

  { codigo: '3.1.2', nome: 'Laboratório de Prótese', grupo: '3.1 - CUSTOS MATERIAL', tipo: 'custo', ordem: 30 },
  { codigo: '3.1.3', nome: 'Dentais',         grupo: '3.1 - CUSTOS MATERIAL', tipo: 'custo', ordem: 31 },
  { codigo: '3.1.4', nome: 'Farmácias',       grupo: '3.1 - CUSTOS MATERIAL', tipo: 'custo', ordem: 32 },
  { codigo: '3.1.5', nome: 'Gases medicinais',grupo: '3.1 - CUSTOS MATERIAL', tipo: 'custo', ordem: 33 },
  { codigo: '3.1.6', nome: 'Implantes',       grupo: '3.1 - CUSTOS MATERIAL', tipo: 'custo', ordem: 34 },
  { codigo: '3.1.7', nome: 'Invisalign',      grupo: '3.1 - CUSTOS MATERIAL', tipo: 'custo', ordem: 35 },

  { codigo: '3.2.1', nome: 'Pagamento aos dentistas - Sócios', grupo: '3.2 - MÃO DE OBRA DENTISTA', tipo: 'custo', ordem: 40 },
  { codigo: '3.2.2', nome: 'Pagamento aos dentistas - CNPJ',   grupo: '3.2 - MÃO DE OBRA DENTISTA', tipo: 'custo', ordem: 41 },
  // Fica no grupo 3.2 na cascata, mas as fórmulas de PE/projeção tratam como FIXA
  // (FIXAS_CONTAS em dre-analise.js). Hoje: pró-labore do Marcos; Joaquim segue em 3.2.1.
  { codigo: '3.2.3', nome: 'Pró-labore sócios — fixo',         grupo: '3.2 - MÃO DE OBRA DENTISTA', tipo: 'custo', ordem: 42 },

  { codigo: '3.3.1', nome: 'Técnicos',            grupo: '3.3 - CUSTOS INDIRETOS', tipo: 'custo', ordem: 50 },
  { codigo: '3.3.2', nome: 'Moto taxi (Transporte)', grupo: '3.3 - CUSTOS INDIRETOS', tipo: 'custo', ordem: 51 },

  { codigo: '4.1.1', nome: 'Recursos Humanos',        grupo: '4 - DESPESAS FIXAS', tipo: 'despesa', ordem: 60 },
  { codigo: '4.1.2', nome: 'Administrativo',          grupo: '4 - DESPESAS FIXAS', tipo: 'despesa', ordem: 61 },
  { codigo: '4.1.3', nome: 'Comercial',               grupo: '4 - DESPESAS FIXAS', tipo: 'despesa', ordem: 62 },
  { codigo: '4.1.4', nome: 'Marketing',               grupo: '4 - DESPESAS FIXAS', tipo: 'despesa', ordem: 63 },
  { codigo: '4.1.5', nome: 'Conservação e Reposição', grupo: '4 - DESPESAS FIXAS', tipo: 'despesa', ordem: 64 },
  { codigo: '4.1.6', nome: 'Cursos/Treinamentos',     grupo: '4 - DESPESAS FIXAS', tipo: 'despesa', ordem: 65 },

  { codigo: '5.1', nome: 'Empréstimos (Juros)',       grupo: '5 - FINANCEIRAS', tipo: 'financeiro', ordem: 70 },
  { codigo: '5.5', nome: 'Devolução de recebimento',  grupo: '5 - FINANCEIRAS', tipo: 'financeiro', ordem: 71 },

  { codigo: '7.3', nome: 'Reforma (Melhorias)', grupo: '7 - INVESTIMENTOS', tipo: 'investimento', ordem: 80 },
  { codigo: '7.5', nome: 'Investimentos',       grupo: '7 - INVESTIMENTOS', tipo: 'investimento', ordem: 81 },

  { codigo: '8.1', nome: 'Distribuição de lucro — sócios', grupo: '8 - DISTRIBUIÇÃO DE LUCRO', tipo: 'distribuicao', ordem: 90 },
];

const GRUPOS_DRE = [
  { codigo: '1',   titulo: '1 - RECEITA' },
  { codigo: '2',   titulo: '2 - IMPOSTOS' },
  { codigo: '3.0', titulo: '3.0 - TARIFAS' },
  { codigo: '3.1', titulo: '3.1 - CUSTOS MATERIAL' },
  { codigo: '3.2', titulo: '3.2 - MÃO DE OBRA DENTISTA' },
  { codigo: '3.3', titulo: '3.3 - CUSTOS INDIRETOS' },
  { codigo: '4',   titulo: '4 - DESPESAS FIXAS' },
  { codigo: '5',   titulo: '5 - FINANCEIRAS' },
  { codigo: '7',   titulo: '7 - INVESTIMENTOS' },
  { codigo: '8',   titulo: '8 - DISTRIBUIÇÃO DE LUCRO' }, // abaixo do Resultado Final na cascata
];

const _byCodigo = new Map(CONTAS.map(c => [c.codigo, c]));
const byCodigo = (cod) => _byCodigo.get(cod);

module.exports = { CONTAS, GRUPOS_DRE, byCodigo };