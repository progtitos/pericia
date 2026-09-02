/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: "25mb" }, // uploads de PDFs de processos grandes
  },
};

module.exports = nextConfig;
