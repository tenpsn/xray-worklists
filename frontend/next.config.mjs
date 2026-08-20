// URL ภายใน network ของ backend (ฝั่ง server ของ frontend เป็นคนยิงเอง ไม่ใช่ browser)
// default ใช้ชื่อ service "backend" ตาม docker-compose ได้เลย ถ้ารันนอก Docker (npm run dev) override เป็น http://localhost:4000 ผ่าน .env.local
const BACKEND_INTERNAL_URL = process.env.BACKEND_INTERNAL_URL || 'http://backend:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${BACKEND_INTERNAL_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
