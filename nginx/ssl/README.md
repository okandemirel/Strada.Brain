# SSL Certificates

Place your SSL certificates here:

- `cert.pem` - SSL certificate (including intermediate certificates)
- `key.pem` - Private key

## Self-Signed Certificate (Development Only)

```bash
cd nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout key.pem -out cert.pem \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"
```

## Let's Encrypt (Production)

Use Certbot to obtain free SSL certificates:

```bash
# Install certbot
docker run -it --rm \
  -v "$(pwd)/nginx/ssl:/etc/letsencrypt" \
  -v "$(pwd)/nginx/www:/var/www/certbot" \
  certbot/certbot certonly \
  --webroot -w /var/www/certbot \
  -d yourdomain.com
```

Then update `docker-compose.yml` to mount the certificates:
```yaml
volumes:
  - ./nginx/ssl:/etc/nginx/ssl:ro
```

## Certificate Renewal

Let's Encrypt certificates expire every 90 days. Set up auto-renewal:

```bash
# Add to crontab (runs twice daily)
0 0,12 * * * docker run --rm \
  -v "$(pwd)/nginx/ssl:/etc/letsencrypt" \
  -v "$(pwd)/nginx/www:/var/www/certbot" \
  certbot/certbot renew --quiet && \
  docker compose exec nginx nginx -s reload
```
