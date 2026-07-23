'use strict';
// Dados da carga inicial do módulo Financeiro → Laboratórios.
// Fonte: 9 PDFs + 4 fotos entregues pelo Luiz em 23/07/2026 (pasta Downloads/Serviços protéticos 2026),
// transcritos manualmente na sessão que os leu. Auditável: cada nota espelha 1 documento.
// OBS: o "Total = 1.710,00" cortado no topo da 4ª foto do caderno NÃO entra — coincide com o total
// da planilha do Marcos Miranda (março) e seria dupla contagem; confirmar com o Luiz.

// Helpers: it(paciente, descricao, valor, extras) · ped espalha datas/dentista do pedido nos itens.
function it(paciente_nome, descricao_original, valor_total, extras = {}) {
  return { paciente_nome, descricao_original, valor_total, quantidade: 1, ...extras };
}
// Pedido do relatório "Pedidos Finalizados": mesmas datas (entrada/prevista/entrega) e Conv p/ todos os itens
function ped(entrada, prevista, entrega, dentista, itens) {
  return itens.map(i => ({ data_entrada: entrada, data_prevista: prevista, data_entrega: entrega, dentista_nome: dentista, ...i }));
}
const q = (n, item) => ({ ...item, quantidade: n });

// ───────────────────────── Ateliê Odonto (95 pedidos, R$ 99.621,46) ─────────────────────────
const AMANDA = 'AMANDA FERREIRA MOLICA', MARCOS = 'MARCOS', MATHEUS = 'MATHEUS', LIGIA = 'LIGIA';
const atelieItens = [
  ...ped('2026-01-12', '2026-01-14', '2026-01-19', AMANDA, [
    it('MARIA LUCINDA DE SOUZA', 'Modelo Digital - Parcial', 50),
    it('MARIA LUCINDA DE SOUZA', 'Link Cad/ Cam+Parafuso', 114.50),
    it('MARIA LUCINDA DE SOUZA', 'Zirconia - Coroa Zirconia 3D', 440),
  ]),
  ...ped('2026-01-13', '2026-01-19', '2026-01-19', MARCOS, [
    q(2, it('LUCIO CESAR GOMES CHAMON JUNIOR', 'Coroa Fresada Dissilicato', 440)), // -50% aplicado pelo lab
  ]),
  ...ped('2026-01-23', '2026-01-23', '2026-01-23', AMANDA, [
    it('HIGOR RAMOS DE SOUZA', 'Provisorio Digital Fresado PMMA', 156),
  ]),
  ...ped('2026-01-20', '2026-01-26', '2026-01-26', AMANDA, [
    it('MARIA APARECIDA HONORIO VILIAN', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-01-20', '2026-01-26', '2026-01-26', AMANDA, [
    it('RONY LEONARDO DA SILVA', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-01-22', '2026-01-26', '2026-01-26', AMANDA, [
    it('YURI QUARESMA FERREIRA NEVES', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-01-22', '2026-01-26', '2026-01-26', MARCOS, [
    it('TATIANE OLIVEIRA AMORIM', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2025-12-12', '2025-12-17', '2026-01-29', AMANDA, [
    q(2, it('MARIA APARECIDA FERREIRA SASAOKA', 'Coroa Fresada de Dissilicato - Reparo', 0)),
    q(2, it('MARIA APARECIDA FERREIRA SASAOKA', 'Coroa Fresada Dissilicato', 880)),
  ]),
  ...ped('2026-01-20', '2026-01-26', '2026-01-29', MARCOS, [
    q(8, it('GILSON RENHE', 'Coroa Fresada Dissilicato', 3520)),
    it('GILSON RENHE', 'Modelo Digital - Total', 70),
  ]),
  ...ped('2026-01-26', '2026-01-29', '2026-01-29', AMANDA, [
    it('CRISTINA MARIA MAURICIO ALVES', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2025-12-05', '2025-12-10', '2026-02-03', MARCOS, [
    q(12, it('CLAUDIA PERI', 'Zirconia - Reparo', 0)),
  ]),
  ...ped('2026-01-23', '2026-01-27', '2026-02-04', AMANDA, [
    q(3, it('MARIA LUCINDA DE SOUZA', 'Zirconia - Reparo', 0)),
  ]),
  ...ped('2026-02-03', '2026-02-05', '2026-02-04', AMANDA, [
    it('SONIA MARIA LAGES FIGUEIREDO', 'Modelo Digital - Total', 70),
  ]),
  ...ped('2026-01-20', '2026-01-26', '2026-02-11', AMANDA, [
    it('JOSE GERALDO DE ANDRADE', 'Modelo Digital - Total', 70),
    q(3, it('JOSE GERALDO DE ANDRADE', 'Link Cad/ Cam+Parafuso', 343.50)),
    q(7, it('JOSE GERALDO DE ANDRADE', 'Zirconia - Enceramento', 140)),
  ]),
  ...ped('2026-02-04', '2026-02-10', '2026-02-11', AMANDA, [
    it('SANDRA MIRANDA DE OLIVEIRA SOUZA', 'Modelo Digital - Total', 70),
    q(2, it('SANDRA MIRANDA DE OLIVEIRA SOUZA', 'Link Cad/ Cam+Parafuso', 229)),
    q(12, it('SANDRA MIRANDA DE OLIVEIRA SOUZA', 'Coroa Fresada Dissilicato', 5280)),
  ]),
  ...ped('2026-02-09', '2026-02-11', '2026-02-11', AMANDA, [
    q(2, it('DOUGLAS NACIBE DA SILVA', 'Coroa Fresada Dissilicato', 880)),
  ]),
  ...ped('2026-01-14', '2026-02-06', '2026-02-12', MARCOS, [
    it('MARIA CONCEIÇÃO DE ARAUJO', 'Modelo Digital - Total', 70),
    it('MARIA CONCEIÇÃO DE ARAUJO', 'Zirconia - Coroa Zirconia 3D', 440),
    it('MARIA CONCEIÇÃO DE ARAUJO', 'Link Cad/ Cam+Parafuso', 114.50),
  ]),
  ...ped('2026-02-04', '2026-02-09', '2026-02-12', AMANDA, [
    it('JOSE AUGUSTO DA SILVA', 'Modelo Digital - Total', 70),
    q(2, it('JOSE AUGUSTO DA SILVA', 'Link Cad/ Cam+Parafuso', 229)),
    q(5, it('JOSE AUGUSTO DA SILVA', 'Zirconia - Coroa Zirconia 3D', 2200)),
    q(8, it('JOSE AUGUSTO DA SILVA', 'Coroa Fresada Dissilicato', 3520)),
  ]),
  ...ped('2026-02-10', '2026-02-12', '2026-02-12', MARCOS, [
    it('HENRIQUE MOURA PARREIRA', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-02-12', '2026-02-19', '2026-02-18', AMANDA, [
    it('MARIA DO CARMO', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-02-13', '2026-02-23', '2026-02-18', MARCOS, [
    it('GILSON RENHE', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-02-12', '2026-02-20', '2026-02-19', MARCOS, [
    it('SIMONE CORREA COSTA', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-02-12', '2026-02-20', '2026-02-19', AMANDA, [
    it('ROGERIA MARIA MARTINS PEREIRA', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-02-19', '2026-02-27', '2026-02-23', AMANDA, [
    q(2, it('JHONATAS NACINE DA SILVA', 'Modelo Digital - Total', 140)),
  ]),
  ...ped('2026-02-20', '2026-02-25', '2026-02-27', AMANDA, [
    q(5, it('SANDRA MIRANDA DE OLIVEIRA SOUZA', 'Coroa Fresada de Dissilicato - Reparo', 0)),
    q(3, it('SANDRA MIRANDA DE OLIVEIRA SOUZA', 'Zirconia - Coroa Zirconia 3D', 1320)),
  ]),
  ...ped('2026-02-25', '2026-02-27', '2026-03-02', AMANDA, [
    q(7, it('JOSE GERALDO DA SILVA', 'Zirconia - Coroa Zirconia 3D', 3080)),
    q(5, it('JOSE GERALDO DA SILVA', 'Ánalogos Mini Pilar', 570)),
  ]),
  ...ped('2026-03-02', '2026-03-04', '2026-03-03', AMANDA, [
    q(2, it('ILMA MAGDA ANDRADE FERNANDES', 'Coroa Fresada Dissilicato', 880)),
  ]),
  ...ped('2026-03-04', '2026-03-09', '2026-03-06', MARCOS, [
    it('GILSON RENHE', 'Coroa Dissilicato Reparo', 0),
  ]),
  ...ped('2026-03-05', '2026-03-10', '2026-03-10', AMANDA, [
    it('FLORENTINA MARIA CASTRO VICTAL', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-03-06', '2026-03-10', '2026-03-10', AMANDA, [
    it('MAICON SAMUEL DOS SANTOS', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-03-09', '2026-03-13', '2026-03-11', AMANDA, [
    q(4, it('JOSE GERALDO DA SILVA', 'Zirconia - Coroa Zirconia 3D', 1760)),
  ]),
  ...ped('2026-03-05', '2026-03-09', '2026-03-16', AMANDA, [
    q(3, it('LOURANICE NAZARENO DA COSTA', 'Provisorio Digital Fresado PMMA', 468)),
  ]),
  ...ped('2026-03-11', '2026-03-16', '2026-03-18', AMANDA, [
    q(2, it('CELMA', 'Zirconia - Coroa Zirconia 3D', 880)),
  ]),
  ...ped('2026-03-10', '2026-03-13', '2026-03-19', AMANDA, [
    q(6, it('MARIA NEUZA DA SILVA', 'Enceramento Diagnóstico', 192)),
    it('MARIA NEUZA DA SILVA', 'Modelo Digital - Total', 70),
  ]),
  ...ped('2026-03-16', '2026-03-20', '2026-03-19', MARCOS, [
    q(2, it('LUCAS TEXEIRA COSTA', 'Modelo Digital - Total', 140)),
  ]),
  ...ped('2026-03-17', '2026-03-20', '2026-03-19', MARCOS, [
    q(2, it('NILZILENE SOUZA TEIXEIRA', 'RESINA IMPRESSA COM CARGA DE CERÂMICA', 312)),
  ]),
  ...ped('2026-03-11', '2026-03-16', '2026-03-20', AMANDA, [
    it('MARIA DAS GRAÇAS PEIXOTO', 'Provisorio Digital Fresado PMMA', 156),
    it('MARIA DAS GRAÇAS PEIXOTO', 'Modelo Digital - Parcial', 50),
    it('MARIA DAS GRAÇAS PEIXOTO', 'Link Cad/ Cam+Parafuso', 114.50),
  ]),
  ...ped('2026-03-16', '2026-03-20', '2026-03-20', MATHEUS, [
    it('VANIRA LUCIA GOMES DOS REIS', 'Zirconia - Coroa Zirconia 3D', 440),
    it('VANIRA LUCIA GOMES DOS REIS', 'Link Cad/ Cam+Parafuso', 114.50),
    it('VANIRA LUCIA GOMES DOS REIS', 'Modelo Digital - Parcial', 50),
  ]),
  ...ped('2026-03-17', '2026-03-19', '2026-03-20', MARCOS, [
    it('MARCOS GOMES RODRIGUES', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-03-17', '2026-03-20', '2026-03-23', MARCOS, [
    q(14, it('ERLI DA SILVA RAMOS', 'Enceramento Diagnóstico', 448)),
    it('ERLI DA SILVA RAMOS', 'Modelo Digital - Total', 70),
  ]),
  ...ped('2026-03-23', '2026-03-23', '2026-03-24', AMANDA, [
    q(24, it('ELIAS CARLOS FRAGA', 'PROVA DE PROTOCOLO DE ZIRCONIA', 480)),
  ]),
  ...ped('2026-03-23', '2026-03-27', '2026-03-25', LIGIA, [
    it('CRISTIANE SODRE CAETANO', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-02-26', '2026-03-04', '2026-03-27', AMANDA, [
    it('MAICOM SAMUEL DOS SANTOS', 'Zirconia - Coroa Zirconia 3D', 440),
    it('MAICOM SAMUEL DOS SANTOS', 'Modelo Digital - Parcial', 50),
    it('MAICOM SAMUEL DOS SANTOS', 'Link Cad/ Cam+Parafuso', 114.50),
  ]),
  ...ped('2026-03-11', '2026-03-16', '2026-03-27', MARCOS, [
    q(3, it('GILSON RENHE', 'Zirconia - Coroa Zirconia 3D', 1320)),
    q(3, it('GILSON RENHE', 'Link Cad/ Cam+Parafuso', 343.50)),
    it('GILSON RENHE', 'Modelo Digital - Parcial', 50),
  ]),
  ...ped('2026-03-20', '2026-03-24', '2026-03-27', MATHEUS, [
    q(3, it('VANIRA LUCIA GOMES DOS REIS', 'Zirconia - Coroa Zirconia 3D', 0)),
  ]),
  ...ped('2026-03-25', '2026-03-27', '2026-03-27', AMANDA, [
    q(24, it('ELIAS CARLOS FRAGA', 'Protocolo Fresado Em Zircônia', 15966.96)),
  ]),
  ...ped('2026-03-27', '2026-03-30', '2026-03-27', AMANDA, [
    it('ELIAS CARLOS FRAGA', 'PLACA DE BRUXISMO FRESADA', 360),
  ]),
  ...ped('2026-03-30', '2026-04-02', '2026-03-31', AMANDA, [
    it('CLEUNICE GOMES MIRANDA', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-03-23', '2026-03-27', '2026-03-31', MARCOS, [
    q(2, it('ANA ALICE FERNANDES', 'Zirconia - Coroa Zirconia 3D', 880)),
    q(2, it('ANA ALICE FERNANDES', 'Link Cad/ Cam+Parafuso', 229)),
    it('ANA ALICE FERNANDES', 'Modelo Digital - Parcial', 50),
  ]),
  ...ped('2026-03-26', '2026-03-31', '2026-03-31', AMANDA, [
    it('JUNIOR DE ASSIS DE CASTRO', 'Zirconia - Coroa Zirconia 3D', 440),
    it('JUNIOR DE ASSIS DE CASTRO', 'Link Cad/ Cam+Parafuso', 114.50),
    it('JUNIOR DE ASSIS DE CASTRO', 'Modelo Digital - Parcial', 50),
  ]),
  ...ped('2026-04-07', '2026-04-10', '2026-04-09', AMANDA, [
    it('KETELLY KELY FERREIRA AMORIM', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-03-11', '2026-03-16', '2026-04-14', MARCOS, [
    it('ELIZABETE MARINHO SERRA', 'Zirconia - Coroa Zirconia 3D', 440),
    it('ELIZABETE MARINHO SERRA', 'Modelo Digital - Parcial', 50),
    it('ELIZABETE MARINHO SERRA', 'Link Cad/ Cam+Parafuso', 114.50),
  ]),
  ...ped('2026-04-10', '2026-04-15', '2026-04-16', AMANDA, [
    q(2, it('MATILDE FERREIRA DE OLIVEIRA', 'Coroa Fresada Dissilicato', 880)),
  ]),
  ...ped('2026-03-17', '2026-03-20', '2026-04-17', MARCOS, [
    q(2, it('JACONIAS LOPES DE ALMEIDA', 'Zirconia - Coroa Zirconia 3D', 880)),
    q(2, it('JACONIAS LOPES DE ALMEIDA', 'Link Cad/ Cam+Parafuso', 229)),
    it('JACONIAS LOPES DE ALMEIDA', 'Modelo Digital - Parcial', 50),
  ]),
  ...ped('2026-04-10', '2026-04-15', '2026-04-17', AMANDA, [
    it('REGINA CELIA RODRIGUES FERREIRA', 'Zirconia - Coroa Zirconia 3D', 440),
    it('REGINA CELIA RODRIGUES FERREIRA', 'Modelo Digital - Parcial', 50),
    it('REGINA CELIA RODRIGUES FERREIRA', 'Link Cad/ Cam+Parafuso', 114.50),
  ]),
  ...ped('2026-04-10', '2026-04-15', '2026-04-17', LIGIA, [
    q(3, it('MARIA DAS GRAÇAS PENA', 'Zirconia - Coroa Zirconia 3D', 1320)),
    it('MARIA DAS GRAÇAS PENA', 'Modelo Digital - Parcial', 50),
    q(3, it('MARIA DAS GRAÇAS PENA', 'Link Cad/ Cam+Parafuso', 343.50)),
  ]),
  ...ped('2026-04-17', '2026-04-22', '2026-04-22', AMANDA, [
    q(2, it('MARCIO DA APARECIDA COSTA', 'Coroa Fresada Dissilicato', 880)),
  ]),
  ...ped('2026-04-08', '2026-04-13', '2026-04-27', MARCOS, [
    q(3, it('GILSON RENHE', 'Zirconia - Reparo', 0)),
  ]),
  ...ped('2026-04-23', '2026-04-27', '2026-04-28', AMANDA, [
    q(2, it('ILMA MAGDA ANDRADE FERNANDES', 'Coroa Fresada Dissilicato', 880)),
  ]),
  ...ped('2026-04-24', '2026-04-28', '2026-04-28', MARCOS, [
    it('PAULO ROBERTO DOS SANTOS', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-04-24', '2026-04-28', '2026-04-28', MARCOS, [
    q(3, it('RENILDO DA SILVA FLORES', 'Provisorio Digital Fresado PMMA', 468)),
  ]),
  ...ped('2026-04-24', '2026-04-28', '2026-04-28', MARCOS, [
    q(2, it('TIAGO ANTERO DA CRUZ', 'Coroa Fresada Dissilicato', 880)),
  ]),
  ...ped('2026-04-27', '2026-04-30', '2026-04-30', MARCOS, [
    q(2, it('MARIA DAS GRAÇAS GONÇALVES PEIXOTO', 'Modelo Digital - Total', 140)),
    q(8, it('MARIA DAS GRAÇAS GONÇALVES PEIXOTO', 'Zirconia - Coroa Zirconia 3D', 3520)),
    q(8, it('MARIA DAS GRAÇAS GONÇALVES PEIXOTO', 'Link Cad/ Cam+Parafuso', 1000)),
  ]),
  ...ped('2026-04-28', '2026-05-05', '2026-04-30', MARCOS, [
    it('FERNANDO DE SOUZA COSTA', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-04-28', '2026-05-05', '2026-05-08', MARCOS, [
    q(19, it('MARIA SEBASTIANA DE ALMEIDA', 'Enceramento Diagnóstico', 608)),
    q(2, it('MARIA SEBASTIANA DE ALMEIDA', 'Modelo Digital - Total', 140)),
    q(2, it('MARIA SEBASTIANA DE ALMEIDA', 'Muralha de Zetalabor', 40)),
    q(3, it('MARIA SEBASTIANA DE ALMEIDA', 'Link Cad/ Cam+Parafuso', 375)),
  ]),
  ...ped('2026-05-11', '2026-05-13', '2026-05-12', LIGIA, [
    it('ANA ALICE FERNANDES', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-05-21', '2026-05-25', '2026-05-22', null, [
    it('YURI QUARESMA FERREIRA NEVES', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-05-13', '2026-05-15', '2026-05-25', MARCOS, [
    q(4, it('GILSON RENHE', 'Coroa Fresada Dissilicato', 1760)),
    it('GILSON RENHE', 'Modelo Digital - Total', 70),
  ]),
  ...ped('2026-05-21', '2026-05-26', '2026-05-26', AMANDA, [
    it('FLORENTINA MARIA CASTRO', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-05-21', '2026-05-25', '2026-05-29', MARCOS, [
    q(11, it('MARIA SEBASTIANA DE ALMEIDA', 'Coroa Fresada Dissilicato', 4840)),
    q(5, it('MARIA SEBASTIANA DE ALMEIDA', 'RESINA IMPRESSA COM CARGA DE CERÂMICA', 900)),
  ]),
  ...ped('2026-05-13', '2026-05-18', '2026-06-02', AMANDA, [
    it('CLONILDA ROSA TEIXEIRA', 'Gesso - Acabamento (Cortesia)', 0),
    q(8, it('CLONILDA ROSA TEIXEIRA', 'PROTOCOLO FRESADO PMMA', 0)),
  ]),
  ...ped('2026-05-29', '2026-06-03', '2026-06-02', LIGIA, [
    it('CARLA ROSSANA SILVA ALVES', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-06-01', '2026-06-02', '2026-06-02', MARCOS, [
    q(2, it('MARIA SEBASTIANA DE ALMEIDA', 'Coroa Fresada Dissilicato', 880)),
  ]),
  ...ped('2026-05-26', '2026-06-02', '2026-06-03', MARCOS, [
    q(2, it('JACONIAS LOPES DE ALMEIDA', 'Zirconia - Reparo', 0)),
  ]),
  ...ped('2026-06-03', '2026-06-09', '2026-06-08', MARCOS, [
    q(2, it('GILSON RENHE', 'Coroa Fresada Dissilicato', 880)),
  ]),
  ...ped('2026-06-08', '2026-06-10', '2026-06-10', MARCOS, [
    it('DAYSE DE FATIMA', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-06-11', '2026-06-12', '2026-06-12', MARCOS, [
    q(6, it('DANIELA RODRIGUES PEREIRA SOUZA', 'Enceramento Diagnóstico', 192)),
    it('DANIELA RODRIGUES PEREIRA SOUZA', 'Modelo Digital - Total', 70),
  ]),
  ...ped('2026-06-03', '2026-06-09', '2026-06-16', LIGIA, [
    q(3, it('EUGENIO ARANTES DE MELO', 'Zirconia - Coroa Zirconia 3D', 1320)),
    q(3, it('EUGENIO ARANTES DE MELO', 'Link Cad/ Cam+Parafuso', 375)),
    it('EUGENIO ARANTES DE MELO', 'Modelo Digital - Total', 70),
  ]),
  ...ped('2026-06-11', '2026-06-16', '2026-06-16', LIGIA, [
    q(3, it('CARLA ROSSANA SILVA ALVES', 'Provisorio Digital Fresado PMMA', 468)),
  ]),
  ...ped('2026-06-15', '2026-06-18', '2026-06-16', LIGIA, [
    it('AUREA DA SILVA SANTOS', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-06-12', '2026-06-15', '2026-06-19', AMANDA, [
    q(3, it('NAIR LOPES DA SILVA', 'Zirconia - Coroa Zirconia 3D', 1320)),
    q(3, it('NAIR LOPES DA SILVA', 'Link Cad/ Cam+Parafuso', 375)),
    it('NAIR LOPES DA SILVA', 'Modelo Digital - Total', 70),
  ]),
  ...ped('2026-06-18', '2026-06-23', '2026-06-23', AMANDA, [
    q(8, it('CLONILDA ROSA TEIXEIRA', 'Enceramento - Reparo', 0)),
  ]),
  ...ped('2026-06-24', '2026-06-29', '2026-06-26', MARCOS, [
    it('ANGELA DE ARAUJO CHRISTIANO', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-06-24', '2026-06-29', '2026-06-26', LIGIA, [
    it('IZAIAS JOSE DA SILVA', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-06-25', '2026-06-29', '2026-06-30', LIGIA, [
    it('EVA CRISTINA DE SOUZA', 'Zirconia - Coroa Zirconia 3D', 440),
    it('EVA CRISTINA DE SOUZA', 'Modelo Digital - Parcial', 50),
    it('EVA CRISTINA DE SOUZA', 'Link Cad/ Cam+Parafuso', 125),
  ]),
  ...ped('2026-05-26', '2026-07-07', '2026-07-06', AMANDA, [
    it('REGINA CELIA RODRIGUES FERREIRA', 'Zirconia - Coroa Zirconia 3D', 440),
  ]),
  ...ped('2026-06-30', '2026-07-02', '2026-07-06', MARCOS, [
    q(4, it('ERLI DA SILVA RAMOS', 'Coroa Fresada Dissilicato', 1760)),
  ]),
  ...ped('2026-07-07', '2026-07-10', '2026-07-09', MARCOS, [
    it('JOAQUIM VIDIGAL MARTINS FILHO', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-07-07', '2026-07-09', '2026-07-09', MARCOS, [
    it('JOSE CARLOS FRINHANI', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-07-09', '2026-07-10', '2026-07-10', MARCOS, [
    q(4, it('ERSUELI PESKER', 'Provisorio Digital Fresado PMMA', 624)),
  ]),
  ...ped('2026-07-08', '2026-07-13', '2026-07-14', MARCOS, [
    it('ANGELA DE ARAUJO CHRISTIANO', 'Coroa Dissilicato Reparo', 0),
    it('ANGELA DE ARAUJO CHRISTIANO', 'Modelo Digital - Parcial', 0),
  ]),
  ...ped('2026-07-06', '2026-07-08', '2026-07-16', AMANDA, [
    q(8, it('CLONILDA ROSA TEIXEIRA', 'Zirconia - Coroa Zirconia 3D', 3520)),
  ]),
  ...ped('2026-07-15', '2026-07-20', '2026-07-17', MARCOS, [
    it('JOSE CARLOS FRINHANI', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-07-17', '2026-07-21', '2026-07-21', LIGIA, [
    it('MARIA DA GLORIA BRAZ SILVA', 'Coroa Fresada Dissilicato', 440),
  ]),
  ...ped('2026-07-20', '2026-07-22', '2026-07-22', AMANDA, [
    it('HELIO GREGORIO CARNEIRO', 'Coroa Fresada Dissilicato', 440),
  ]),
];

// ───────────────────────── Dente & Arte (12 pedidos, R$ 5.942,00) ─────────────────────────
const JOAQUIM_DA = 'Joaquim Vidigal Martins Filho';
const denteArteItens = [
  ...ped('2026-02-13', '2026-02-20', '2026-03-09', JOAQUIM_DA, [it('Paula Pereira Oliveira', 'CMC AMA', 297, { dente: '25' })]),
  ...ped('2026-03-03', '2026-03-10', '2026-03-23', JOAQUIM_DA, [it('Claudomiro Sabino', 'CMC AMA', 297, { dente: '11' })]),
  ...ped('2026-02-24', '2026-03-03', '2026-03-26', JOAQUIM_DA, [it('Nelson Magalhães', 'CMC AMA', 297, { dente: '25' })]),
  ...ped('2026-02-13', '2026-02-20', '2026-03-27', null, [it('Silvania Dos Santos Ferreira', 'CMC AMA', 297, { dente: '45' })]),
  ...ped('2026-03-26', '2026-04-02', '2026-03-30', 'Matheus', [
    q(3, it('Vanira Lúcia Gomes', 'Zircônia Ama', 990, { dente: '24/25/26' })),
    q(2, it('Vanira Lúcia Gomes', 'tbase', 200, { dente: '24/25' })),
  ]),
  ...ped('2026-03-11', '2026-03-18', '2026-04-07', JOAQUIM_DA, [it('Celson Luiz Mendes', 'CMC AMA', 297, { dente: '11' })]),
  ...ped('2026-03-17', '2026-03-24', '2026-04-17', JOAQUIM_DA, [q(3, it('Silvani Gonçalves De Oliveira Santos', 'CMC AMA', 891, { dente: '36/46/47' }))]),
  ...ped('2026-03-20', '2026-03-27', '2026-04-28', JOAQUIM_DA, [it('Vlamir Luciano Da Silva', 'CMC AMA', 297, { dente: '11' })]),
  ...ped('2026-03-09', '2026-03-16', '2026-05-04', JOAQUIM_DA, [it('Higor Hermogenes Freitas', 'CMC AMA', 297, { dente: '37' })]),
  ...ped('2026-04-16', '2026-04-23', '2026-05-05', JOAQUIM_DA, [it('Regilane Ferreira De Sales Ponciano', 'Zircônia Ama', 297, { dente: '36' })]),
  ...ped('2026-05-29', '2026-06-05', '2026-06-09', 'Amanda Ferreira Molica', [q(2, it('Anderson Araujo De Carvalho Miranda', 'Zircônia Ama', 594, { dente: '36/46' }))]),
  ...ped('2026-06-23', '2026-06-30', '2026-07-15', JOAQUIM_DA, [q(3, it('Maria Amelia Almeida Matias', 'Zircônia Ama', 891, { dente: '34/35/36' }))]),
];

// ───────────────────────── LAPROTEC (6 notas, R$ 48.675,00) ─────────────────────────
const AMANDA_L = 'Dra. Amanda Molica', JOAQUIM_L = 'Dr. Joaquim', MATHEUS_L = 'Dr. MATHEUS G.';
const lap = (entrada, entrega, desc, pac, valor, dentista, extras = {}) =>
  ({ data_entrada: entrada, data_entrega: entrega, descricao_original: desc, paciente_nome: pac, valor_total: valor, dentista_nome: dentista, quantidade: 1, ...extras });

const laprotec686 = [
  lap('2025-12-16', '2026-01-14', 'PLACA BRUXISMO', 'EDUARDO DE FARIA CASTRO', 215, JOAQUIM_L),
  lap('2026-01-05', '2026-01-26', 'PT IMEDIATA SUPERIOR', 'JOSE LOURIVAL DAMASCENO', 310, AMANDA_L),
  lap('2026-01-05', '2026-01-14', 'PLACA BRUXISMO', 'ADENIZE RODRIGUES DE SOUZA', 215, JOAQUIM_L),
  lap('2026-01-12', '2026-01-16', 'PLACA BRUXISMO', 'TIAGO DO AMARAL FLORES', 215, 'Dr. RAISSA ALVES'),
  lap('2026-01-12', '2026-01-21', 'PLACA BRUXISMO', 'VANESSA COELHO MONTE ALTO', 215, MATHEUS_L),
  lap('2026-01-13', '2026-01-26', 'PT IMEDIATA INFERIOR', 'RITA DE CASSIA XAVIER DA SILVA', 310, AMANDA_L),
  lap('2026-01-15', '2026-01-28', 'PT IMEDIATA SUPERIOR', 'ELZA DA CRUZ DE LANA GONÇALVES', 310, AMANDA_L),
  lap('2026-01-15', '2026-01-28', 'PT IMEDIATA INFERIOR', 'ELZA DA CRUZ DE LANA GONÇALVES', 310, AMANDA_L),
];
const laprotec697 = [
  lap('2025-12-16', '2026-02-23', 'PT IMEDIATA INFERIOR', 'MANOEL QUIRINO DA SILVA', 310, AMANDA_L),
  lap('2025-12-16', '2026-02-23', 'PT IMEDIATA SUPERIOR', 'MANOEL QUIRINO DA SILVA', 310, AMANDA_L),
  lap('2026-01-07', '2026-02-11', 'PT IMEDIATA SUPERIOR', 'MARIA DE FATIMA OLIVEIRA VIDAL', 310, AMANDA_L),
  lap('2026-01-13', '2026-02-04', 'PT IMEDIATA INFERIOR', 'ELISA DE ALMEIDA DOS REIS', 310, AMANDA_L),
  lap('2026-01-13', '2026-02-04', 'PT IMEDIATA SUPERIOR', 'ELISA DE ALMEIDA DOS REIS', 310, AMANDA_L),
  lap('2026-02-04', '2026-02-11', 'PT IMEDIATA INFERIOR', 'JOSE LOURIVAL DAMASCENO', 310, AMANDA_L, { dente: '62' }),
  lap('2026-02-06', '2026-02-19', 'PT IMEDIATA INFERIOR', 'GEOVANE SILVA DE ALMEIDA', 310, AMANDA_L),
];
const laprotec712 = [
  lap('2025-12-09', '2026-03-04', 'PT IMEDIATA STG INFERIOR', 'JOSE GUALBERTO DA REPUBLICA', 370, AMANDA_L),
  lap('2026-01-12', '2026-03-31', 'ROACH PREMIUM TRILUX SUPERIOR', 'SONIA MARIA LAGES FIGUEIREDO', 620, AMANDA_L),
  lap('2026-01-12', '2026-03-31', 'ROACH PREMIUM TRILUX INFERIOR', 'SONIA MARIA LAGES FIGUEIREDO', 620, AMANDA_L),
  lap('2026-02-04', '2026-03-18', 'PARCIAL PROVISÓRIA INFERIOR', 'FABIA ROBERTA PEREIRA', 240, AMANDA_L),
  lap('2026-02-04', '2026-03-18', 'PARCIAL PROVISÓRIA SUPERIOR', 'FABIA ROBERTA PEREIRA', 240, AMANDA_L),
  lap('2026-02-20', '2026-03-31', 'PT IMEDIATA STG INFERIOR', 'IMACULADA CONCEIÇÃO LIMA DA ROCHA', 370, AMANDA_L),
  lap('2026-02-20', '2026-03-31', 'PT IMEDIATA STG SUPERIOR', 'IMACULADA CONCEIÇÃO LIMA DA ROCHA', 370, AMANDA_L),
  lap('2026-02-21', '2026-03-31', 'PT IMEDIATA SUPERIOR', 'SIMEIA DRUMOND SOUZA', 310, AMANDA_L),
  lap('2026-03-17', '2026-03-31', 'PLANO DE CERA INFERIOR', 'SIMEIA DRUMOND SOUZA', 40, AMANDA_L),
  lap('2026-02-25', '2026-03-31', 'PROTESE TOTAL SUPERIOR', 'JOSIEL SILVA MARTINS', 355, AMANDA_L),
  lap('2026-02-25', '2026-03-31', 'PROTESE TOTAL INFERIOR', 'JOSIEL SILVA MARTINS', 355, AMANDA_L),
  lap('2026-02-27', '2026-03-04', 'PT IMEDIATA SUPERIOR', 'JHONATAS NACIBE DA SILVA', 310, AMANDA_L),
  lap('2026-03-09', '2026-03-16', 'PLACA BRUXISMO', 'JOSE AUGUSTO DA SILVA', 215, MATHEUS_L),
  lap('2026-03-11', '2026-03-16', 'PLACA BRUXISMO', 'REGINALDO EMILIO ANDRADE', 215, MATHEUS_L),
  lap('2026-03-13', '2026-03-23', 'PLACA BRUXISMO', 'JULIANA QUINTÃOGANDRA', 215, AMANDA_L),
  lap('2026-03-23', '2026-03-27', 'PLACA BRUXISMO', 'ANA PAULA SILVA PORTUGAL', 215, MATHEUS_L),
  lap('2026-03-23', '2026-03-27', 'PLACA BRUXISMO', 'ELOISA GOMES SILVA COSTA', 215, JOAQUIM_L),
  lap('2026-03-25', '2026-03-27', 'PLACA BRUXISMO', 'ANA ELIZA DA MATA LANA FRAGA', 215, AMANDA_L),
];
const laprotec733 = [
  lap('2026-02-12', '2026-04-22', 'PROTOCOLO STG TRILUX SUPERIOR', 'ELIANA MARQUES DA SILVA', 1600, AMANDA_L),
  lap('2026-03-09', '2026-04-30', 'PT IMEDIATA INFERIOR', 'ADRIANA LUCELIA RODRIGUES ANGELO', 310, AMANDA_L),
  lap('2026-03-09', '2026-04-30', 'PT IMEDIATA SUPERIOR', 'ADRIANA LUCELIA RODRIGUES ANGELO', 310, AMANDA_L),
  lap('2026-03-13', '2026-04-29', 'ROACH STG TRILUX SUPERIOR', 'EDSON BENEVENUTO SOARES DA SILVA', 530, AMANDA_L),
  lap('2026-03-23', '2026-04-01', 'PLACA BRUXISMO', 'MATHEUS RONCALLI TEIXEIRA', 215, MATHEUS_L),
  lap('2026-04-07', '2026-04-13', 'PLACA BRUXISMO', 'MARIA MARTA COSTA SILVA', 240, MATHEUS_L),
  lap('2026-04-09', '2026-04-13', 'PLACA BRUXISMO', 'ELI LOPES DA SILVA', 240, MATHEUS_L),
  lap('2026-04-13', '2026-04-16', 'PLACA BRUXISMO', 'MELINA TASSIA LORENÇONE RONTANI', 240, MATHEUS_L),
  lap('2026-04-13', '2026-04-16', 'PLACA BRUXISMO', 'CLAUDIA PERI', 240, 'Dr. Marcos Vinicius'),
];
const laprotec755 = [
  lap('2026-02-20', '2026-05-29', 'PROTOCOLO STG TRILUX INFERIOR', 'JOSE CARLOS LOPES', 1600, AMANDA_L),
  lap('2026-02-20', '2026-05-29', 'PROTOCOLO STG TRILUX SUPERIOR', 'JOSE CARLOS LOPES', 1600, AMANDA_L),
  lap('2026-03-13', '2026-05-29', 'PT IMEDIATA SUPERIOR', 'MARIA DAS GRAÇAS BORGES HERMOGENES', 400, AMANDA_L),
  lap('2026-03-25', '2026-05-29', 'PT IMEDIATA INFERIOR', 'MARIA DAS GRAÇAS BORGES HERMOGENES', 400, AMANDA_L),
  lap('2026-03-23', '2026-05-13', 'PT IMEDIATA SUPERIOR', 'MARIA DO CARMO', 310, AMANDA_L),
  lap('2026-04-07', '2026-05-19', 'PT IMEDIATA SUPERIOR', 'GERALDO DOS SANTOS BALDEZ', 400, AMANDA_L),
  lap('2026-04-13', '2026-05-28', 'PROTOCOLO STG TRILUX INFERIOR', 'SONIA MARIA DE FREITAS PITOL', 1690, AMANDA_L),
  lap('2026-04-16', '2026-05-22', 'PT IMEDIATA SUPERIOR', 'MARIA APARECIDA LIBERATO', 400, AMANDA_L),
  lap('2026-04-27', '2026-05-12', 'PROTOCOLO S/ BARRA STG TRILUX INFERIOR', 'JOSSEIR MIRANDA', 1090, AMANDA_L),
  lap('2026-04-27', '2026-05-29', 'PROTOCOLO STG TRILUX INFERIOR', 'MARIA DE FATIMA OLIVEIRA VIDAL', 1690, AMANDA_L),
  lap('2026-04-27', '2026-05-29', 'PROTOCOLO STG TRILUX SUPERIOR', 'MARIA DE FATIMA OLIVEIRA VIDAL', 1690, AMANDA_L),
  lap('2026-04-27', '2026-05-12', 'PROTOCOLO S/ BARRA STG TRILUX SUPERIOR', 'OSVALDO FLORES DE MENDONÇA', 1090, AMANDA_L),
  lap('2026-05-05', '2026-05-20', 'PLACA BRUXISMO', 'ELIZABETE MARINHO SERRA NEGRA', 240, AMANDA_L),
  lap('2026-05-11', '2026-05-27', 'PT IMEDIATA INFERIOR', 'LUIZ GONZAGA ALBINO', 400, AMANDA_L),
];
const laprotec774 = [
  lap('2026-04-13', '2026-06-19', 'PROTOCOLO STG TRILUX SUPERIOR', 'AGEU MODESTO', 1690, AMANDA_L),
  lap('2026-04-13', '2026-06-19', 'PROTOCOLO STG TRILUX INFERIOR', 'AGEU MODESTO', 1690, AMANDA_L),
  lap('2026-04-22', '2026-06-30', 'PRÓTESE TOTAL COMUM SUPERIOR COM STG', 'MARIA DA CONCEIÇÃO SOARES', 510, AMANDA_L),
  lap('2026-04-22', '2026-06-30', 'PT IMEDIATA INFERIOR', 'MARIA DA CONCEIÇÃO SOARES', 400, AMANDA_L),
  lap('2026-05-05', '2026-06-19', 'PT IMEDIATA INFERIOR', 'MARIA LUCIA DE JESUS SILVEIRA', 400, AMANDA_L),
  lap('2026-05-05', '2026-06-19', 'PT IMEDIATA SUPERIOR', 'MARIA LUCIA DE JESUS SILVEIRA', 400, AMANDA_L),
  lap('2026-05-05', '2026-06-27', 'PROTOCOLO STG TRILUX INFERIOR', 'ROSIANE RUELLA CARDOSO', 1690, AMANDA_L),
  lap('2026-05-05', '2026-06-27', 'PROTOCOLO STG TRILUX SUPERIOR', 'ROSIANE RUELLA CARDOSO', 1690, AMANDA_L),
  lap('2026-05-08', '2026-06-11', 'PT IMEDIATA INFERIOR', 'EVA MARIA CUSTODIO LIMA', 400, AMANDA_L),
  lap('2026-05-08', '2026-06-11', 'PT IMEDIATA SUPERIOR', 'EVA MARIA CUSTODIO LIMA', 400, AMANDA_L),
  lap('2026-05-15', '2026-06-30', 'PROTOCOLO STG TRILUX INFERIOR', 'GILSON JACINTO VIANA', 1690, AMANDA_L),
  lap('2026-05-15', '2026-06-27', 'PROTOCOLO STG TRILUX SUPERIOR', 'BERENICE COSTA OLIVEIRA MAGALHAES', 1690, AMANDA_L),
  lap('2026-05-19', '2026-06-30', 'PROTOCOLO STG TRILUX SUPERIOR', 'EDRIANA MARQUES DA SILVA FERREIRA', 1690, AMANDA_L),
  lap('2026-05-19', '2026-06-30', 'PROTOCOLO STG TRILUX SUPERIOR', 'JOSE LOURIVAL DAMASCENO', 1690, AMANDA_L),
  lap('2026-05-19', '2026-06-30', 'PROTOCOLO STG TRILUX INFERIOR', 'JOSE LOURIVAL DAMASCENO', 1690, AMANDA_L),
  lap('2026-05-25', '2026-06-30', 'PROTOCOLO STG TRILUX INFERIOR', 'ROSA EVANGELISTA FERREIRA FERNANDES', 1690, AMANDA_L),
  lap('2026-05-27', '2026-06-30', 'PT IMEDIATA INFERIOR', 'MARIA DAS GRAÇAS SILVA REIS', 400, AMANDA_L),
  lap('2026-05-27', '2026-06-30', 'PT IMEDIATA SUPERIOR', 'MARIA DAS GRAÇAS SILVA REIS', 400, AMANDA_L),
  lap('2026-05-29', '2026-06-25', 'PRÓTESE TOTAL COMUM SUPERIOR', 'SAMARONE LUCAS VIERA', 450, AMANDA_L),
  lap('2026-05-29', '2026-06-30', 'PRÓTESE TOTAL COMUM SUPERIOR', 'JOAO JOVINO DA SILVA', 450, AMANDA_L),
  lap('2026-05-29', '2026-06-30', 'PT IMEDIATA INFERIOR', 'JOAO JOVINO DA SILVA', 400, AMANDA_L),
  lap('2026-06-05', '2026-06-19', 'PLACA BRUXISMO', 'GILSON RENHE', 240, AMANDA_L),
  lap('2026-06-09', '2026-06-19', 'PLACA BRUXISMO', 'SONIA NATALINA DE SOUZA SILVA', 240, MATHEUS_L),
];

// ───────────────────────── Marcos Miranda — protético PF (março, R$ 1.710,00) ─────────────────────────
const marcosMirandaItens = [
  { data_entrada: '2026-02-25', data_entrega: '2026-02-27', paciente_nome: 'Maria Sebastiana', descricao_original: '01 coroa total e-max', dente: '45', quantidade: 1, valor_total: 285, dentista_nome: 'Dr. Joaquim' },
  { data_entrada: '2026-03-04', data_entrega: '2026-03-10', paciente_nome: 'Maria Lúcia Fort.', descricao_original: '01 coroa e-max', dente: '15', quantidade: 1, valor_total: 285, dentista_nome: 'Dr. Joaquim' },
  { data_entrada: '2026-03-12', data_entrega: '2026-03-17', paciente_nome: 'Maria Lúcia Fort.', descricao_original: '02 coroas e-max', dente: '34 e 35', quantidade: 2, valor_total: 570, dentista_nome: 'Dr. Joaquim' },
  { data_entrada: '2026-04-02', data_entrega: '2026-04-09', paciente_nome: 'Ronaldo Pitanguy', descricao_original: '01 onlay e-max', dente: '47', quantidade: 1, valor_total: 285, dentista_nome: 'Dr. Joaquim' },
  { data_entrada: '2026-04-25', data_entrega: '2026-04-27', paciente_nome: 'Virgílio Duarte', descricao_original: '01 onlay e-max', dente: '37', quantidade: 1, valor_total: 285, dentista_nome: 'Dr. Joaquim' },
];

// ───────────────────────── Lúcio — caderno manuscrito ─────────────────────────
const lucio0601 = [
  { data_entrada: '2025-10-28', paciente_nome: 'Maione Pires', descricao_original: '01 Rest EMAX', dente: '46', quantidade: 1, valor_total: 380 },
  { data_entrada: '2025-11-17', paciente_nome: 'Margarethe', descricao_original: '01 c/impl', dente: '24', quantidade: 1, valor_total: 380 },
  { data_entrada: '2025-11-17', paciente_nome: 'José Manças', descricao_original: '01 c/impl', dente: '36', quantidade: 1, valor_total: 380, conferir: true }, // rasura no valor
  { data_entrada: '2025-12-04', paciente_nome: 'Sueli Costa', descricao_original: '01 c/EMAX', dente: '45', quantidade: 1, valor_total: 430.10, conferir: true }, // valor sobrescrito; soma não bate com o total 1.580
];
const lucio0402 = [
  { data_entrada: '2025-10-28', paciente_nome: 'Marlon Gomes', descricao_original: '01 c/impl', dente: '36', quantidade: 1, valor_total: 380 },
  { paciente_nome: 'Marcio Ferreira', descricao_original: '02 c/impl', dente: '36/46', quantidade: 2, valor_total: 760, conferir: true }, // sem data na linha
];
const lucio0503 = [
  { paciente_nome: 'Eduardo', descricao_original: '01 c/impl', quantidade: 1, valor_total: 380, dentista_nome: 'Dr. Joaquim', conferir: true }, // data "28-10-26" ambígua no caderno
  { paciente_nome: 'Eduardo', descricao_original: '01 gengiva', quantidade: 1, valor_total: 85, dentista_nome: 'Dr. Joaquim' },
];
const lucio0705 = [
  { data_entrada: '2026-01-20', paciente_nome: 'Vera Araujo', descricao_original: '02 c/impl', dente: '36/36', quantidade: 2, valor_total: 820, dentista_nome: 'Dr. Joaquim' },
  { data_entrada: '2026-01-20', paciente_nome: 'Vera Araujo', descricao_original: '01 c/EMAX', dente: '38', quantidade: 1, valor_total: 465, dentista_nome: 'Dr. Joaquim' },
  { data_entrada: '2026-01-20', paciente_nome: 'Mª da Penha', descricao_original: '02 c/impl', dente: '35/36', quantidade: 2, valor_total: 820, dentista_nome: 'Dr. Joaquim' },
];

const NOTAS = [
  { laboratorio: 'Ateliê Odonto', referencia: 'Pedidos Finalizados 01/01–31/07/2026', periodo_inicio: '2026-01-01', periodo_fim: '2026-07-31', emitida_em: '2026-07-23', total_informado: 99621.46, origem: 'seed', itens: atelieItens },
  { laboratorio: 'Dente & Arte', referencia: 'Pedidos Finalizados 05/01–23/07/2026', periodo_inicio: '2026-01-05', periodo_fim: '2026-07-23', emitida_em: '2026-07-23', total_informado: 5942.00, origem: 'seed', itens: denteArteItens },
  { laboratorio: 'LAPROTEC', referencia: 'Nota 686', emitida_em: '2026-02-04', total_informado: 2100.00, origem: 'seed', itens: laprotec686 },
  { laboratorio: 'LAPROTEC', referencia: 'Nota 697', emitida_em: '2026-03-04', total_informado: 2170.00, origem: 'seed', itens: laprotec697 },
  { laboratorio: 'LAPROTEC', referencia: 'Nota 712', emitida_em: '2026-03-31', total_informado: 5490.00, origem: 'seed', itens: laprotec712 },
  { laboratorio: 'LAPROTEC', referencia: 'Nota 733', emitida_em: '2026-05-04', total_informado: 3925.00, origem: 'seed', itens: laprotec733 },
  { laboratorio: 'LAPROTEC', referencia: 'Nota 755', emitida_em: '2026-06-03', total_informado: 13000.00, origem: 'seed', itens: laprotec755 },
  { laboratorio: 'LAPROTEC', referencia: 'Nota 774', emitida_em: '2026-07-01', total_informado: 21990.00, origem: 'seed', itens: laprotec774 },
  { laboratorio: 'Marcos Miranda', referencia: 'Planilha MARÇO 2026', emitida_em: '2026-03-31', total_informado: 1710.00, origem: 'seed', itens: marcosMirandaItens },
  { laboratorio: 'Lúcio', referencia: 'Caderno 06/01/2026', emitida_em: '2026-01-06', total_informado: 1580.00, origem: 'seed', itens: lucio0601 },
  { laboratorio: 'Lúcio', referencia: 'Caderno 04/02/2026', emitida_em: '2026-02-04', total_informado: 1140.00, origem: 'seed', itens: lucio0402 },
  { laboratorio: 'Lúcio', referencia: 'Caderno 05/03/2026', emitida_em: '2026-03-05', total_informado: 465.00, origem: 'seed', itens: lucio0503 },
  { laboratorio: 'Lúcio', referencia: 'Caderno 07/05/2026', emitida_em: '2026-05-07', total_informado: 2105.00, origem: 'seed', itens: lucio0705 },
];

module.exports = { NOTAS };
