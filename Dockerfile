FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY testers.json ./

# Токен и настройки приходят переменными окружения (env_file в docker-compose.yml), состояние — в томе /app/data.
# Если сеть перехватывает HTTPS своим сертификатом, подмонтируйте корневой сертификат и задайте NODE_EXTRA_CA_CERTS.
CMD ["node", "src/bot.js"]
