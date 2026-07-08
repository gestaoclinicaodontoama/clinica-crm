FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*
# ffmpeg-voice: build estático BtbN (libopus >=1.6) SÓ p/ a conversão de áudio de voz.
# O libopus da distro (1.5.x) e o do ffmpeg-static/jvs (1.3.1) geram Opus/SILK que o
# WhatsApp do iPHONE rejeita ("Este áudio não está mais disponível"). libopus 1.4 e 1.6
# tocam (comprovado 07-08/07). O download é tolerante a falha: se cair, o código usa o
# ffmpeg do sistema (áudio quebra no iOS, mas o app sobe) e o /api/version acusa.
RUN curl -fsSL https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz -o /tmp/ff.tar.xz \
  && tar -xf /tmp/ff.tar.xz -C /tmp \
  && cp /tmp/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg /usr/local/bin/ffmpeg-voice \
  && chmod +x /usr/local/bin/ffmpeg-voice \
  && rm -rf /tmp/ff.tar.xz /tmp/ffmpeg-master-latest-linux64-gpl \
  || echo "AVISO: download do ffmpeg-voice (BtbN) falhou; usando ffmpeg do sistema"
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
