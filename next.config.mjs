/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A lockfile in the home directory above this repo makes Next infer the wrong workspace root.
  outputFileTracingRoot: import.meta.dirname,
};
export default nextConfig;
