// lib/avaliacao/audio-format.js
// Decide o formato do áudio enviado e se precisa de conversão para um formato
// que o Deepgram aceita com folga (WAV PCM 16k mono).

const CT_MAP = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a',
  'audio/ogg': 'opus', 'audio/opus': 'opus',
  'audio/amr': 'amr', 'audio/3gpp': 'amr',
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/webm': 'webm', 'video/webm': 'webm', 'video/mp4': 'm4a',
};

const EXT_MAP = {
  mp3: 'mp3', wav: 'wav', m4a: 'm4a', aac: 'm4a', mp4: 'm4a',
  ogg: 'opus', opus: 'opus', amr: 'amr', flac: 'flac', webm: 'webm',
};

// Deepgram lida bem com estes; o resto convertemos.
const ACEITOS_SEM_CONVERSAO = new Set(['mp3', 'wav', 'flac']);

function detectFormat(contentType, filename) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (CT_MAP[ct]) return CT_MAP[ct];
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (EXT_MAP[ext]) return EXT_MAP[ext];
  return 'desconhecido';
}

function needsConversion(fmt) {
  return !ACEITOS_SEM_CONVERSAO.has(fmt);
}

function ffmpegArgsTo16kWav(_inputFmt) {
  // lê de stdin (pipe:0), escreve WAV PCM 16k mono em stdout (pipe:1)
  return ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'];
}

module.exports = { detectFormat, needsConversion, ffmpegArgsTo16kWav };
