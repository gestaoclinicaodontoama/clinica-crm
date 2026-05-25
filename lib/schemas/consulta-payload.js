'use strict';
const { z } = require('zod');
const { AnalysisV1 } = require('./analysis.v1');

const ConsultaPayload = z.object({
  id: z.string().uuid(),
  dentista_id: z.string().uuid(),
  paciente_id: z.string().uuid().nullable().optional(),
  paciente_nome: z.string().min(1).max(200),
  paciente_vinculado: z.boolean(),
  lead_id: z.number().int().nullable().optional(),
  modo: z.enum(['deepgram', 'audio', 'texto']),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable().optional(),
  transcript: z.any().nullable().optional(),
  analysis: AnalysisV1,
  analysis_schema_version: z.literal(1),
  uso: z.object({
    gemini_tokens_in: z.number().int().optional(),
    gemini_tokens_out: z.number().int().optional(),
    custo_usd: z.number().optional(),
    deepgram_seg: z.number().optional(),
  }).optional(),
  transcript_stats: z.any().optional(),
  tipo_tratamento_id: z.number().int().nullable().optional(),
  tipo_tratamento_outro: z.string().max(100).nullable().optional(),
  tratamento_valor_cents: z.number().int().min(0).nullable().optional(),
  tratamento_valor_label: z.string().max(80).nullable().optional(),
  consentimento_manual_versao: z.string().nullable().optional(),
  consentimento_manual_em: z.string().datetime().nullable().optional(),
});

module.exports = { ConsultaPayload };
