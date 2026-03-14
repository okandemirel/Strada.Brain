/**
 * PM2 Configuration for Strada.Brain
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 start ecosystem.config.cjs --only strada-brain
 *   pm2 start ecosystem.config.cjs --env production
 */

module.exports = {
  apps: [
    {
      name: "strada-brain",
      script: "dist/index.js",
      args: "start --channel web",
      cwd: __dirname,
      node_args: "--max-old-space-size=512",

      // Process management
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,

      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/pm2-error.log",
      out_file: "logs/pm2-out.log",
      merge_logs: true,
      log_type: "json",

      // Health
      max_memory_restart: "512M",

      // Environment
      env: {
        NODE_ENV: "production",
      },
      env_development: {
        NODE_ENV: "development",
      },
    },
  ],
};
