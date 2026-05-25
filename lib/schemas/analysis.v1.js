'use strict';
const { z } = require('zod');

const EtapaNome = z.enum([
  'Situação', 'Problema', 'Implicação', 'Necessidade',
  'Objeções', 'Compromisso', 'Fechamento', 'Pós-venda',
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

const AnalysisV1 = z.object({
  schema_version: z.literal(1),
  nota_final: z.number().min(0).max(10),
  veredito: z.string().max(2000),
  fechou: z.boolean().nullable(),
  etapas: z.array(Etapa).length(8),
  relatorios: z.object({
    comercial: z.string().max(5000).optional(),
    sucesso: z.string().max(5000).optional(),
  }).optional(),
});

module.exports = { EtapaNome, Etapa, AnalysisV1 };
