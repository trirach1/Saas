FROM node:18-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

# Railway healthchecks
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

EXPOSE 8080

CMD ["node", "server.js"]
