FROM node:22-bookworm-slim AS builder
WORKDIR /app

ARG BACKEND_INTERNAL_URL=http://backend:4000
ENV BACKEND_INTERNAL_URL=$BACKEND_INTERNAL_URL

COPY package*.json ./
RUN npm ci

COPY . .

# โปรเจกต์นี้ไม่มีโฟลเดอร์ public/ แต่ COPY ขั้นถัดไปต้องการให้มีอยู่จริง
RUN mkdir -p public

RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000

CMD ["node", "server.js"]
