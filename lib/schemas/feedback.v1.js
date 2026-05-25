'use strict';
const { z } = require('zod');
const { EtapaNome } = require('./analysis.v1');

const FeedbackV1 = z.object({
  schema_version: z.literal(1),
  nota_geral: z.number().int().min(1).max(5),
  comentario: z.string().max(2000).optional(),
  etapas: z.array(z.object({
    nome: EtapaNome,
    concordou: z.enum(['sim', 'parcial', 'nao']),
    comentario: z.string().max(1000).optional(),
  })).max(8),
});

module.exports = { FeedbackV1 };
