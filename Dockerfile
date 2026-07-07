FROM node:22-trixie-slim
# ffmpeg glibc (Debian) em vez do Alpine: o ffmpeg do Alpine gera Opus/SILK que o
# WhatsApp do iPHONE rejeita ("Este áudio não está mais disponível"). Build glibc com
# libopus recente produz voz tocável no iOS. (Diagnóstico 07/07 — testes A–M ao vivo.)
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
