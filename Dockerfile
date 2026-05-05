# syntax=docker/dockerfile:1.7
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --prefer-offline --no-audit --fund=false

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
