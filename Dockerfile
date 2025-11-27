FROM node:18-slim

# Install git (required for some NPM packages)
RUN apt-get update && apt-get install -y git && apt-get clean

WORKDIR /app

COPY package.json ./

# Install deps normally (Railway automatically uses production mode)
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
