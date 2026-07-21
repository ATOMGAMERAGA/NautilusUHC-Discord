# NautilusUHC Discord botu — Dokploy/Coolify üzerinde bu Dockerfile ile deploy edilir.
FROM node:22-bookworm-slim

WORKDIR /app

# Sadece bağımlılık dosyalarını kopyala (layer cache).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Kalıcı veri (SQLite) için volume: Dokploy/Coolify'da /app/data'ya bir volume bağla.
VOLUME ["/app/data"]

ENV NODE_ENV=production
# Köprü portu (plugin -> bot event akışı). PORT env'i ile değiştirilebilir.
EXPOSE 25000

CMD ["node", "src/index.js"]
