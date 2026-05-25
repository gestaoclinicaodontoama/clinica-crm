'use strict';
const { z } = require('zod');

const EtapaNome = z.enum([
  'Acolhimento', 'Anamnese', 'Diagnóstico', 'Implicação',
  'Solução', 'Preço', 'Objeções', 'Fechamento',
]);

const Etapa = z.object({
  nome: EtapaNome,
  nota: z.number().min(0).max(10),
  feedback: z.string().max(2000),
  melhoria: z.string().max(2000),
  trechos: z.array(z.string().max(500)).max(20),
  detalhe: z.object({
    momentos: z.array(z.object({
      trecho: z.string().max(500),
      problema: z.string().max(500),
      alternativa: z.string().max(500),
    })).max(10),
  }).nullable().default(null),
});

const CRCComercial = z.object({
  paciente: z.string().max(200).optional(),
  contato: z.string().max(200).optional(),
  queixa_principal: z.string().max(1000).optional(),
  tratamento_proposto: z.string().max(1000).optional(),
  valor: z.string().max(500).optional(),
  poder_de_compra: z.string().max(1000).optional(),
  abordagem_followup: z.string().max(1000).optional(),
  objecoes: z.array(z.string().max(500)).max(20).optional(),
  gatilhos_emocionais: z.array(z.string().max(500)).max(20).optional(),
});

const CRCSucesso = z.object({
  resumo_clinico: z.string().max(2000).optional(),
  jornada_paciente: z.string().max(2000).optional(),
  como_garantir_boa_experiencia: z.string().max(2000).optional(),
  plano_de_fases: z.array(z.string().max(500)).max(20).optional(),
  pontos_atencao_emocional: z.array(z.string().max(500)).max(20).optional(),
});

const AnalysisV1 = z.object({
  schema_version: z.literal(1),
  nota_final: z.number().min(0).max(10),
  veredito: z.string().max(2000),
  fechou: z.boolean().nullable(),
  etapas: z.array(Etapa).length(8),
  relatorios: z.object({
    comercial: z.union([CRCComercial, z.string().max(5000)]).optional(),
    sucesso: z.union([CRCSucesso, z.string().max(5000)]).optional(),
  }).optional(),
});

module.exports = { EtapaNome, Etapa, AnalysisV1, CRCComercial, CRCSucesso };
