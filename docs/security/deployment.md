# Secure Deployment Guide

This document provides guidance for securely deploying Strata Brain in production environments.

## Table of Contents

- [Overview](#overview)
- [Pre-Deployment Checklist](#pre-deployment-checklist)
- [Secrets Management](#secrets-management)
- [SSL/TLS Setup](#ssltls-setup)
- [Container Security](#container-security)
- [Server Hardening](#server-hardening)
- [Monitoring and Logging](#monitoring-and-logging)
- [Backup and Recovery](#backup-and-recovery)

## Overview

Deploying Strata Brain securely requires attention to multiple layers: application configuration, secrets management, network security, and operational practices.

```
┌─────────────────────────────────────────────────────────────────┐
│                   Deployment Security Layers                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Layer 1: Application                                           │
│  ├── Read-only mode configuration                               │
│  ├── User whitelist configuration                               │
│  └── Token security                                             │
│                                                                  │
│  Layer 2: Secrets Management                                    │
│  ├── Environment variables                                      │
│  ├── Secret managers (HashiCorp Vault, AWS Secrets Manager)     │
│  └── Encrypted configuration                                    │
│                                                                  │
│  Layer 3: Container/Host                                        │
│  ├── Minimal base image                                         │
│  ├── Non-root user                                              │
│  └── Read-only filesystem                                       │
│                                                                  │
│  Layer 4: Network                                               │
│  ├── TLS/SSL encryption                                         │
│  ├── Firewall rules                                             │
│  └── VPC/Network isolation                                      │
│                                                                  │
│  Layer 5: Infrastructure                                        │
│  ├── Cloud security groups                                      │
│  ├── DDoS protection                                            │
│  └── Audit logging                                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Pre-Deployment Checklist

### Security Configuration

- [ ] Read-only mode enabled (for analysis-only deployments)
- [ ] User whitelist configured for all channels
- [ ] Diff confirmation enabled for destructive operations
- [ ] Rate limiting configured
- [ ] Budget limits set

### Secrets

- [ ] All API tokens generated and secured
- [ ] Environment file permissions set to 600
- [ ] Secrets stored in secure vault (production)
- [ ] No secrets in code or logs
- [ ] Token rotation procedure documented

### Network

- [ ] TLS certificates obtained and configured
- [ ] Firewall rules configured
- [ ] Webhook URLs use HTTPS
- [ ] Internal services not exposed

### Monitoring

- [ ] Logging configured
- [ ] Alert rules set up
- [ ] Health checks enabled
- [ ] Audit trail configured

## Secrets Management

### Environment Variables

For development and simple deployments:

```bash
# .env file - Restrict permissions immediately
chmod 600 .env
chown strata-brain:strata-brain .env

# Contents
# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
ALLOWED_TELEGRAM_USER_IDS=123456789

# Discord
DISCORD_BOT_TOKEN=...
ALLOWED_DISCORD_USER_IDS=...

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
ALLOWED_SLACK_WORKSPACES=T1234567890

# AI Providers
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Security
READ_ONLY_MODE=false
REQUIRE_EDIT_CONFIRMATION=true
```

### Docker Secrets

For Docker Swarm deployments:

```yaml
# docker-compose.yml
version: '3.8'
services:
  strata-brain:
    image: strata-brain:latest
    secrets:
      - telegram_bot_token
      - anthropic_api_key
    environment:
      - TELEGRAM_BOT_TOKEN_FILE=/run/secrets/telegram_bot_token
      - ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic_api_key

secrets:
  telegram_bot_token:
    external: true
  anthropic_api_key:
    external: true
```

Create secrets:

```bash
# Create secrets
echo "123456:ABC-DEF..." | docker secret create telegram_bot_token -
echo "sk-ant-..." | docker secret create anthropic_api_key -

# Verify
docker secret ls
```

### HashiCorp Vault Integration

```typescript
// src/config/vault.ts
import { client } from "@hashicorp/vault-client";

export async function loadSecretsFromVault(): Promise<void> {
  const vault = client({
    address: process.env["VAULT_ADDR"],
    token: process.env["VAULT_TOKEN"],
  });

  const { data } = await vault.read("secret/strata-brain");
  
  // Set environment variables
  process.env["TELEGRAM_BOT_TOKEN"] = data.telegram_bot_token;
  process.env["ANTHROPIC_API_KEY"] = data.anthropic_api_key;
  // ...
}
```

### AWS Secrets Manager

```typescript
// src/config/aws-secrets.ts
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({ region: "us-east-1" });

export async function loadSecretsFromAWS(): Promise<void> {
  const command = new GetSecretValueCommand({
    SecretId: "strata-brain/production",
  });
  
  const response = await client.send(command);
  const secrets = JSON.parse(response.SecretString!);
  
  Object.assign(process.env, secrets);
}
```

### Secret Rotation

```bash
#!/bin/bash
# rotate-secrets.sh

set -e

# 1. Generate new tokens from platform dashboards
echo "Generate new tokens and update them in your secret manager"

# 2. Update secrets in vault/aws
# ... platform-specific commands

# 3. Rolling restart (zero downtime)
docker service update --force strata-brain_app

# 4. Revoke old tokens after verification
sleep 30
echo "Verify service is healthy, then revoke old tokens"
```

## SSL/TLS Setup

### Certificate Generation

Using Let's Encrypt:

```bash
# Install certbot
sudo apt-get install certbot

# Generate certificate
sudo certbot certonly --standalone -d your-domain.com

# Certificates location
# /etc/letsencrypt/live/your-domain.com/fullchain.pem
# /etc/letsencrypt/live/your-domain.com/privkey.pem

# Auto-renewal
echo "0 12 * * * /usr/bin/certbot renew --quiet" | sudo crontab -
```

### Nginx Configuration

```nginx
# /etc/nginx/sites-available/strata-brain
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL certificates
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # Security headers
    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}

# HTTP to HTTPS redirect
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

### Webhook SSL Requirements

For Telegram webhooks:

```typescript
// Must use HTTPS with valid certificate
bot.api.setWebhook("https://your-domain.com/webhook", {
  secret_token: process.env["TELEGRAM_WEBHOOK_SECRET"],
});
```

For Slack HTTP mode:

```bash
# Slack requires HTTPS for webhooks
SLACK_SOCKET_MODE=false
# Must configure public HTTPS URL
```

## Container Security

### Dockerfile Best Practices

```dockerfile
# Use minimal base image
FROM node:20-alpine

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S strata-brain -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY --chown=strata-brain:nodejs . .

# Build application
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# Switch to non-root user
USER strata-brain

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js

# Run application
CMD ["node", "dist/index.js"]
```

### Docker Security Options

```yaml
# docker-compose.yml
version: '3.8'
services:
  strata-brain:
    image: strata-brain:latest
    read_only: true  # Read-only root filesystem
    user: "1001:1001"  # Non-root user
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE  # Only if binding to low ports
    tmpfs:
      - /tmp:noexec,nosuid,size=100m
    volumes:
      - ./data:/app/data:rw
      - ./logs:/app/logs:rw
    environment:
      - NODE_ENV=production
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '0.5'
          memory: 512M
```

### Kubernetes Security

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: strata-brain
spec:
  replicas: 2
  selector:
    matchLabels:
      app: strata-brain
  template:
    metadata:
      labels:
        app: strata-brain
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        fsGroup: 1001
      containers:
        - name: strata-brain
          image: strata-brain:latest
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          resources:
            limits:
              cpu: "2"
              memory: "2Gi"
            requests:
              cpu: "500m"
              memory: "512Mi"
          env:
            - name: NODE_ENV
              value: "production"
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            - name: data
              mountPath: /app/data
      volumes:
        - name: tmp
          emptyDir: {}
        - name: data
          persistentVolumeClaim:
            claimName: strata-brain-data
```

## Server Hardening

### Firewall Configuration

```bash
# Using UFW (Ubuntu)
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH
sudo ufw allow 22/tcp

# Allow HTTPS
sudo ufw allow 443/tcp

# Allow HTTP (for redirect)
sudo ufw allow 80/tcp

# Enable firewall
sudo ufw enable

# Check status
sudo ufw status verbose
```

### SSH Hardening

```bash
# /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
Protocol 2
X11Forwarding no
AllowUsers strata-brain
```

### Automatic Updates

```bash
# Install unattended-upgrades
sudo apt-get install unattended-upgrades

# Configure
sudo dpkg-reconfigure -plow unattended-upgrades

# Or use cron
0 4 * * * /usr/bin/apt-get update && /usr/bin/apt-get -y upgrade
```

## Monitoring and Logging

### Log Configuration

```typescript
// src/utils/logger.ts
import winston from "winston";

export const logger = winston.createLogger({
  level: process.env["LOG_LEVEL"] || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ 
      filename: "logs/error.log", 
      level: "error" 
    }),
    new winston.transports.File({ 
      filename: "logs/combined.log" 
    }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// Sanitize logs
logger.addTransform((info) => {
  if (info.message) {
    info.message = sanitizeSecrets(info.message);
  }
  return info;
});
```

### Security Monitoring

```typescript
// Alert on security events
if (!auth.isUserAllowed(userId)) {
  logger.warn("Unauthorized access attempt", {
    userId,
    channel,
    ip: request.ip,
    timestamp: new Date().toISOString(),
  });
  
  // Send alert
  await sendSecurityAlert({
    type: "unauthorized_access",
    userId,
    channel,
  });
}
```

### Prometheus Metrics

```typescript
// src/dashboard/prometheus.ts
import prometheus from "prom-client";

// Security metrics
const unauthorizedAttempts = new prometheus.Counter({
  name: "strata_brain_unauthorized_attempts_total",
  help: "Total unauthorized access attempts",
  labelNames: ["channel"],
});

const blockedCommands = new prometheus.Counter({
  name: "strata_brain_blocked_commands_total",
  help: "Total blocked dangerous commands",
});

const rateLimitHits = new prometheus.Counter({
  name: "strata_brain_rate_limit_hits_total",
  help: "Total rate limit hits",
  labelNames: ["user_id"],
});
```

## Backup and Recovery

### Data Backup

```bash
#!/bin/bash
# backup.sh

BACKUP_DIR="/backups/strata-brain"
DATE=$(date +%Y%m%d_%H%M%S)

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Backup memory database
tar -czf "$BACKUP_DIR/memory_$DATE.tar.gz" .strata-memory/

# Backup configuration
cp .env "$BACKUP_DIR/env_$DATE.backup"

# Backup logs (optional)
tar -czf "$BACKUP_DIR/logs_$DATE.tar.gz" logs/

# Retention: Keep last 30 days
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +30 -delete
```

### Disaster Recovery

```bash
#!/bin/bash
# restore.sh

BACKUP_FILE=$1

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 <backup_file>"
  exit 1
fi

# Stop service
docker-compose down

# Restore memory database
tar -xzf "$BACKUP_FILE" -C /

# Restore configuration (review before applying)
cp .env.backup .env

# Start service
docker-compose up -d

# Verify health
curl -f http://localhost:3000/health || exit 1
```

---

Last updated: 2026-03-02
