FROM node:22-bookworm-slim

# dcmtk ให้ dump2dcm ใช้แปลงไฟล์ .dump เป็น .wl (แทน dump2dcm.exe ที่ใช้ได้แค่บน Windows)
RUN apt-get update && apt-get install -y --no-install-recommends dcmtk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4000 7001

CMD ["node", "server.js"]
