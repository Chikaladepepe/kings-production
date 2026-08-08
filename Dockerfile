FROM node:24-slim

WORKDIR /app

# Dependencies first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install

COPY . .

# Runtime data lives on a volume in production
RUN mkdir -p data uploads
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

VOLUME ["/app/data", "/app/uploads"]

CMD ["node", "server.js"]
