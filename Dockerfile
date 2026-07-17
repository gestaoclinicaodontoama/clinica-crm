FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*
# ffmpeg-voice: binário estático PINADO (BtbN n7.1.5, snapshot 2026-07-17) SÓ p/ a
# conversão de áudio de voz do WhatsApp. O WhatsApp do iPHONE rejeita ("Este áudio não
# está mais disponível") o Opus de vários encoders: o ffmpeg da distro (libopus 1.5.x)
# falha SEMPRE, e o master-latest do BtbN OSCILA entre rebuilds — os snapshots de
# 08–16/07/2026 geravam áudio quebrado (bug "áudios voltaram a falhar"). Este binário
# específico foi validado AO VIVO no iPhone (bateria T1–T6, 17/07/2026, teste T5).
# Por isso: download PINADO em release do PRÓPRIO repo, sha256 conferido, e o build
# FALHA se o binário não vier íntegro (o fallback silencioso escondia o problema).
# NUNCA voltar a usar tag móvel (latest/master) aqui.
RUN curl -fsSL https://github.com/gestaoclinicaodontoama/clinica-crm/releases/download/ffmpeg-voice-n7.1-20260717/ffmpeg-voice-n7.1-20260717.xz -o /tmp/ffv.xz \
  && echo "f5128ffe5b645a989f4aa134aa09c11afa97880e24c4e94c8e19ac54d44ef8aa  /tmp/ffv.xz" | sha256sum -c - \
  && xz -d -c /tmp/ffv.xz > /usr/local/bin/ffmpeg-voice \
  && echo "0722ae90d6d2da9a11dc3b929eadd5bb0f20ea39055a7ec0378ca60c0b619aff  /usr/local/bin/ffmpeg-voice" | sha256sum -c - \
  && chmod +x /usr/local/bin/ffmpeg-voice \
  && /usr/local/bin/ffmpeg-voice -version | head -1 \
  && rm /tmp/ffv.xz
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
