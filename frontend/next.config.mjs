// URL นี้ใช้เฉพาะฝั่ง server ของ Next.js ไม่ถูกส่งให้ browser
// browser เรียก /api/... แล้ว Next.js proxy ต่อไปยัง backend ภายใน network
const BACKEND_INTERNAL_URL =
  process.env.BACKEND_INTERNAL_URL || "http://backend:4000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_INTERNAL_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
