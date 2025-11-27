FROM node:18-slim

RUN apt-get update && apt-get install -y git wget && apt-get clean

WORKDIR /app

COPY package.json ./

RUN npm install

COPY . .

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

EXPOSE 8080

CMD ["node", "server.js"]
