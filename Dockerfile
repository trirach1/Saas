FROM node:20-alpine

# Install git (required by npm when dependencies use git repos)
RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "server.js"]
