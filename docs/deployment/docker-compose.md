# Docker Compose Deployment Guide

Production-ready Docker Compose setup for Strada.Brain with SSL, monitoring, and automated deployment.

## Quick Start

```bash
# 1. Clone and enter directory
cd /path/to/strada-brain

# 2. Create environment file
cp .env.example .env
# Edit .env with your API keys

# 3. Generate self-signed SSL (or use real certs)
mkdir -p nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx/ssl/key.pem -out nginx/ssl/cert.pem \
  -subj "/CN=localhost"

# 4. Deploy
./scripts/deploy.sh
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Internet                            │
└──────────────────────┬──────────────────────────────────────┘
                       │
              ┌────────▼─────────┐
              │   Nginx (80/443) │  ← Reverse Proxy, SSL, Rate Limit
              │    nginx:1.27    │
              └────────┬─────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
   │Dashboard│   │Metrics  │   │WebSocket│
   │:3100    │   │:9090    │   │/ws      │
   └────┬────┘   └────┬────┘   └────┬────┘
        │              │              │
        └──────────────┴──────────────┘
                       │
              ┌────────▼─────────┐
              │  Strada.Brain    │  ← Main Application
              │  (Node.js 22)    │
              └────────┬─────────┘
                       │
              ┌────────▼─────────┐
              │  Redis 7 (opt)   │  ← Rate limiting, caching
              └──────────────────┘
```

## Requirements

- Docker 24.0+
- Docker Compose 2.20+
- 2GB+ RAM
- 10GB+ disk space
- Unity project directory

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Claude API key | `sk-ant-...` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | `123456:ABC...` |
| `UNITY_PROJECT_PATH` | Path to Unity project | `./project` or `/path/to/project` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | `3100` | Dashboard port |
| `METRICS_PORT` | `9090` | Prometheus metrics port |
| `MEMORY_ENABLED` | `true` | Enable persistent memory |
| `LOG_LEVEL` | `info` | Log verbosity |
| `READ_ONLY_MODE` | `false` | Disable write operations |
| `NGINX_HTTP_PORT` | `80` | Nginx HTTP port |
| `NGINX_HTTPS_PORT` | `443` | Nginx HTTPS port |
| `CPU_LIMIT` | `2` | CPU cores limit |
| `MEMORY_LIMIT` | `2G` | Memory limit |

### Bot Tokens (Optional)

| Variable | For | Required For |
|----------|-----|--------------|
| `DISCORD_BOT_TOKEN` | Discord bot | Discord channel |
| `SLACK_BOT_TOKEN` | Slack bot | Slack channel |
| `SLACK_SIGNING_SECRET` | Slack verification | Slack channel |
| `SLACK_APP_TOKEN` | Slack Socket Mode | Slack Socket Mode |

## SSL Certificate Setup

### Option 1: Self-Signed (Development)

```bash
mkdir -p nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx/ssl/key.pem -out nginx/ssl/cert.pem \
  -subj "/CN=localhost"
```

### Option 2: Let's Encrypt (Production)

```bash
# 1. Get certificates
docker run -it --rm \
  -v "$(pwd)/nginx/ssl:/etc/letsencrypt" \
  -v "$(pwd)/nginx/www:/var/www/certbot" \
  -p 80:80 \
  certbot/certbot certonly \
  --standalone \
  -d yourdomain.com

# 2. Update nginx.conf with correct paths:
# ssl_certificate /etc/nginx/ssl/live/yourdomain.com/fullchain.pem;
# ssl_certificate_key /etc/nginx/ssl/live/yourdomain.com/privkey.pem;

# 3. Mount correct path in docker-compose.yml:
# volumes:
#   - ./nginx/ssl:/etc/letsencrypt:ro
```

### Option 3: Custom Certificate

```bash
# Copy your certificates
cp your-cert.pem nginx/ssl/cert.pem
cp your-key.pem nginx/ssl/key.pem
```

## Deployment Commands

### Standard Deployment

```bash
./scripts/deploy.sh
```

### With Backup

```bash
./scripts/deploy.sh --backup
```

### Pre-deployment Checks Only

```bash
./scripts/deploy.sh --check
```

### Force (No Confirmation)

```bash
./scripts/deploy.sh --force
```

### Custom Environment

```bash
./scripts/deploy.sh --env .env.production
```

### Rollback

```bash
./scripts/deploy.sh --rollback
```

## Docker Compose Direct Usage

### Start Services

```bash
# All services
docker compose up -d

# Without monitoring
docker compose up -d strada-brain redis nginx

# With monitoring
docker compose --profile monitoring up -d
```

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f strada-brain

# Last 100 lines
docker compose logs --tail=100 strada-brain
```

### Scale

```bash
# Scale application instances
docker compose up -d --scale strada-brain=2
```

### Stop

```bash
# Stop all
docker compose down

# Stop and remove volumes (⚠️ data loss)
docker compose down -v

# Stop and remove images
docker compose down --rmi all
```

## Monitoring Stack

Start with monitoring:

```bash
docker compose --profile monitoring up -d
```

Access:
- Grafana: http://localhost:3000 (admin/admin)
- Prometheus: http://localhost:9091

### Default Grafana Dashboard

Includes panels for:
- Message count
- Token usage
- Tool usage
- Error rates
- Active sessions
- Response times

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose logs strada-brain

# Check exit code
docker compose ps

# Inspect container
docker inspect strada-brain
```

### Health Check Failing

```bash
# Test health endpoint
curl http://localhost:3100/health

# Check if ports are bound
netstat -tlnp | grep 3100
```

### SSL Errors

```bash
# Verify certificate
openssl x509 -in nginx/ssl/cert.pem -text -noout

# Check certificate dates
openssl x509 -in nginx/ssl/cert.pem -noout -dates

# Test SSL connection
openssl s_client -connect localhost:443
```

### Permission Errors

```bash
# Fix log directory permissions
sudo chown -R 1000:1000 logs/
sudo chown -R 1000:1000 .strada-memory/
```

### Memory Issues

```bash
# Check memory usage
docker stats

# Increase memory limit in docker-compose.yml:
deploy:
  resources:
    limits:
      memory: 4G
```

### Redis Connection Issues

```bash
# Check Redis status
docker compose exec redis redis-cli ping

# View Redis logs
docker compose logs redis
```

## Security Checklist

- [ ] Use strong API keys
- [ ] Set `ALLOWED_TELEGRAM_USER_IDS` to restrict access
- [ ] Enable `REQUIRE_EDIT_CONFIRMATION=true`
- [ ] Use real SSL certificates in production
- [ ] Restrict firewall rules (only 80/443 exposed)
- [ ] Regular security updates: `docker compose pull && docker compose up -d`
- [ ] Enable audit logging
- [ ] Review Grafana dashboard access

## Backup and Restore

### Automatic Backup

Backups are created in `./backups/` with timestamp:

```bash
./scripts/deploy.sh --backup
```

### Manual Backup

```bash
# Backup memory volume
docker run --rm \
  -v strada-memory:/data:ro \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/memory-$(date +%Y%m%d).tar.gz -C /data .

# Backup logs
tar czf backups/logs-$(date +%Y%m%d).tar.gz logs/
```

### Restore from Backup

```bash
./scripts/deploy.sh --rollback
```

## Updating

```bash
# Pull latest code
git pull origin main

# Rebuild and redeploy
./scripts/deploy.sh --backup
```

## Performance Tuning

### For High Traffic

```yaml
# docker-compose.yml
deploy:
  resources:
    limits:
      cpus: '4'
      memory: 8G
    reservations:
      cpus: '1'
      memory: 2G
```

### Redis Tuning

```yaml
# docker-compose.yml (defaults shown, adjust for high traffic)
redis:
  command: >
    redis-server
    --maxmemory 256mb
    --maxmemory-policy allkeys-lru
    --appendonly yes
    --appendfsync everysec
```

## Uninstall

```bash
# Stop and remove everything
docker compose down -v --rmi all

# Remove volumes
docker volume rm strada-memory strada-logs redis-data nginx-cache letsencrypt-data prometheus-data grafana-data

# Clean up
rm -rf logs/ backups/ .strada-memory/
```

## Support

- Issues: https://github.com/strata/brain/issues
- Documentation: https://docs.strata.dev/brain
- Discord: https://discord.gg/strata
