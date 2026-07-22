module.exports = {
  apps: [
    {
      name: "xray-backend",
      script: "server.js",
      cwd: "./backend", // ชี้เข้าไปในโฟลเดอร์ backend
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      }
    },
    {
      name: "xray-frontend",
      script: "node_modules/next/dist/bin/next",
      args: "start",
      cwd: "./frontend", // ชี้เข้าไปในโฟลเดอร์ frontend
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "400M",
      env: {
        NODE_ENV: "production",
      }
    }
  ]
};