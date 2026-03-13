#!/bin/bash
# =============================================================================
# Strada.Brain - SSL Certificate Generator
# =============================================================================
# Generates self-signed SSL certificates for development/testing
#
# Usage:
#   ./scripts/generate-ssl.sh [domain]
#
# Arguments:
#   domain    Domain name (default: localhost)
#
# Examples:
#   ./scripts/generate-ssl.sh
#   ./scripts/generate-ssl.sh yourdomain.com
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSL_DIR="$(dirname "$SCRIPT_DIR")/nginx/ssl"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

DOMAIN="${1:-localhost}"
DAYS=365
KEY_SIZE=2048

log() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

# Check if OpenSSL is installed
if ! command -v openssl &> /dev/null; then
    error "OpenSSL is not installed. Please install it first."
fi

# Create SSL directory
mkdir -p "$SSL_DIR"
log "SSL directory: $SSL_DIR"

# Check if certificates already exist
if [[ -f "$SSL_DIR/cert.pem" && -f "$SSL_DIR/key.pem" ]]; then
    warn "SSL certificates already exist!"
    read -p "Overwrite? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log "Aborted."
        exit 0
    fi
    log "Overwriting existing certificates..."
fi

# Generate private key and certificate
log "Generating ${KEY_SIZE}-bit RSA private key..."
openssl genrsa -out "$SSL_DIR/key.pem" $KEY_SIZE

log "Generating self-signed certificate for domain: $DOMAIN"
openssl req -new -x509 \
    -key "$SSL_DIR/key.pem" \
    -out "$SSL_DIR/cert.pem" \
    -days $DAYS \
    -subj "/C=US/ST=State/L=City/O=StradaBrain/OU=Development/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN,DNS:*.$DOMAIN,IP:127.0.0.1,IP:::1"

# Set proper permissions
chmod 600 "$SSL_DIR/key.pem"
chmod 644 "$SSL_DIR/cert.pem"

success "SSL certificates generated successfully!"

echo ""
echo "=============================================="
echo "Certificate Details:"
echo "=============================================="
openssl x509 -in "$SSL_DIR/cert.pem" -noout -subject -dates -fingerprint
echo "=============================================="
echo ""

log "Certificate location:"
echo "  Certificate: $SSL_DIR/cert.pem"
echo "  Private Key: $SSL_DIR/key.pem"
echo ""

warn "These are self-signed certificates. Browsers will show a warning."
warn "For production, use certificates from a trusted CA (e.g., Let's Encrypt)."
echo ""

log "To use with Docker Compose:"
echo "  docker compose up -d nginx"
