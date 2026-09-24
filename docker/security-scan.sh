#!/bin/bash
#
# Security Scan Script for Strada.Brain Docker Image
#
# Usage: ./security-scan.sh [IMAGE_TAG]

set -euo pipefail

# Configuration
IMAGE_TAG="${1:-strada-brain:hardened}"
OUTPUT_DIR="security-reports"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=================================================="
echo "Strada.Brain Security Scan"
echo "Image: $IMAGE_TAG"
echo "Timestamp: $TIMESTAMP"
echo "=================================================="

# Create output directory
mkdir -p "$OUTPUT_DIR"

# =============================================================================
# CHECK DEPENDENCIES
# =============================================================================

check_dependency() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${RED}Error: $1 is required but not installed.${NC}"
        exit 1
    fi
}

echo "Checking dependencies..."
check_dependency docker
# The vulnerability scan IS this script's verdict: without trivy (and jq to read
# its report) nothing was scanned, and the script used to say PASSED anyway
# (OPS-20). Refuse up front instead.
check_dependency trivy
check_dependency jq

# =============================================================================
# BUILD IMAGE
# =============================================================================

echo ""
echo "Building Docker image..."
docker build -f Dockerfile.hardened -t "$IMAGE_TAG" ..

# =============================================================================
# DOCKER BENCH SECURITY
# =============================================================================

echo ""
echo "Running Docker Bench Security..."
if docker run --rm --net host --pid host --userns host \
    --cap-add audit_control \
    -e DOCKER_CONTENT_TRUST=1 \
    -v /etc:/etc:ro \
    -v /lib/systemd/system:/lib/systemd/system:ro \
    -v /usr/bin/docker-containerd:/usr/bin/docker-containerd:ro \
    -v /usr/bin/docker-runc:/usr/bin/docker-runc:ro \
    -v /usr/lib/systemd:/usr/lib/systemd:ro \
    -v /var/lib:/var/lib:ro \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    --label docker_bench_security \
    docker/docker-bench-security \
    -c container_images \
    > "$OUTPUT_DIR/docker-bench-$TIMESTAMP.log" 2>&1; then
    echo -e "${GREEN}Docker Bench Security completed${NC}"
else
    echo -e "${YELLOW}Docker Bench Security completed with warnings${NC}"
fi

# =============================================================================
# TRIVY VULNERABILITY SCAN
# =============================================================================

echo ""
echo "Running Trivy vulnerability scan..."
trivy image \
    --severity HIGH,CRITICAL \
    --format table \
    --output "$OUTPUT_DIR/trivy-$TIMESTAMP.txt" \
    "$IMAGE_TAG"

# JSON output for further processing
trivy image \
    --severity HIGH,CRITICAL \
    --format json \
    --output "$OUTPUT_DIR/trivy-$TIMESTAMP.json" \
    "$IMAGE_TAG"

echo -e "${GREEN}Trivy scan completed${NC}"

# =============================================================================
# DOCKERFILE LINTING (HADOLINT)
# =============================================================================

echo ""
echo "Linting Dockerfile..."
if command -v hadolint &> /dev/null; then
    hadolint Dockerfile.hardened > "$OUTPUT_DIR/hadolint-$TIMESTAMP.txt" 2>&1 || true
    echo -e "${GREEN}Dockerfile linting completed${NC}"
else
    echo -e "${YELLOW}Hadolint not installed, running basic checks...${NC}"
    
    # Basic Dockerfile checks
    echo "Checking Dockerfile best practices..." > "$OUTPUT_DIR/hadolint-$TIMESTAMP.txt"
    
    # Check for non-root user
    if ! grep -q "USER" Dockerfile.hardened; then
        echo "WARNING: Dockerfile does not specify USER" >> "$OUTPUT_DIR/hadolint-$TIMESTAMP.txt"
    fi
    
    # Check for HEALTHCHECK
    if ! grep -q "HEALTHCHECK" Dockerfile.hardened; then
        echo "WARNING: Dockerfile does not specify HEALTHCHECK" >> "$OUTPUT_DIR/hadolint-$TIMESTAMP.txt"
    fi
    
    echo -e "${GREEN}Basic checks completed${NC}"
fi

# =============================================================================
# IMAGE ANALYSIS
# =============================================================================

echo ""
echo "Analyzing Docker image..."

# Image size
echo "Image size analysis:" > "$OUTPUT_DIR/image-analysis-$TIMESTAMP.txt"
docker images "$IMAGE_TAG" --format "Size: {{.Size}}" >> "$OUTPUT_DIR/image-analysis-$TIMESTAMP.txt"
echo "" >> "$OUTPUT_DIR/image-analysis-$TIMESTAMP.txt"

# Layer analysis
echo "Layer analysis:" >> "$OUTPUT_DIR/image-analysis-$TIMESTAMP.txt"
docker history "$IMAGE_TAG" >> "$OUTPUT_DIR/image-analysis-$TIMESTAMP.txt"
echo "" >> "$OUTPUT_DIR/image-analysis-$TIMESTAMP.txt"

# Check for secrets in image
echo "Checking for potential secrets..." >> "$OUTPUT_DIR/image-analysis-$TIMESTAMP.txt"
if command -v secretscanner &> /dev/null; then
    secretscanner -image "$IMAGE_TAG" >> "$OUTPUT_DIR/image-analysis-$TIMESTAMP.txt" 2>&1 || true
else
    echo "Secret scanner not available" >> "$OUTPUT_DIR/image-analysis-$TIMESTAMP.txt"
fi

echo -e "${GREEN}Image analysis completed${NC}"

# =============================================================================
# CIS DOCKER BENCHMARK
# =============================================================================

echo ""
echo "Checking CIS Docker Benchmark compliance..."

cat > "$OUTPUT_DIR/cis-checks-$TIMESTAMP.txt" << 'EOF'
CIS Docker Benchmark Checks
============================

4.1 - Image should be created with a specific user
4.6 - Health check should be configured
4.7 - Image should not have sensitive data
4.9 - Use COPY instead of ADD
4.10 - Do not store secrets in environment variables
EOF

# Posture checks, read structurally: the image's configured user (by name or
# id) and the hardened compose file's settings. The old greps looked for
# '"User": "1001"' in an image whose USER is `nodejs`, and for "cap_drop: ALL"
# in a file that writes it as a YAML list, so they could never pass.
image_user="$(docker inspect -f '{{.Config.User}}' "$IMAGE_TAG" 2>/dev/null || true)"
runs_non_root() { [[ -n "$image_user" && "$image_user" != "root" && "${image_user%%:*}" != "0" ]]; }
compose_has() { grep -Eq "^[[:space:]]*$1[[:space:]]*$" docker-compose.security.yml; }
drops_all_caps() { grep -A3 -E '^[[:space:]]*cap_drop:' docker-compose.security.yml | grep -Eq '^[[:space:]]*-[[:space:]]*ALL[[:space:]]*$'; }
has_healthcheck() { [[ "$(docker inspect -f '{{if .Config.Healthcheck}}yes{{end}}' "$IMAGE_TAG" 2>/dev/null || true)" == "yes" ]]; }
pass_fail() { if "$@"; then echo "✅ PASS"; else echo "❌ FAIL"; fi; }

# Verify non-root user
if runs_non_root; then
    echo "✓ PASS: Container runs as non-root user" >> "$OUTPUT_DIR/cis-checks-$TIMESTAMP.txt"
else
    echo "✗ FAIL: Container does not run as non-root user" >> "$OUTPUT_DIR/cis-checks-$TIMESTAMP.txt"
fi

# Verify read-only filesystem capability
if compose_has 'read_only:[[:space:]]*true'; then
    echo "✓ PASS: Read-only filesystem configured" >> "$OUTPUT_DIR/cis-checks-$TIMESTAMP.txt"
else
    echo "✗ FAIL: Read-only filesystem not configured" >> "$OUTPUT_DIR/cis-checks-$TIMESTAMP.txt"
fi

echo -e "${GREEN}CIS checks completed${NC}"

# =============================================================================
# SUMMARY REPORT
# =============================================================================

echo ""
echo "Generating summary report..."

CRITICAL_VULNS=0
HIGH_VULNS=0

# Parse Trivy results. A report that is missing or unreadable is a failed scan,
# never "0 vulnerabilities" (`|| echo 0` used to turn it into a PASS).
TRIVY_JSON="$OUTPUT_DIR/trivy-$TIMESTAMP.json"
if ! CRITICAL_VULNS=$(jq -e '[.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL")] | length' "$TRIVY_JSON") ||
   ! HIGH_VULNS=$(jq -e '[.Results[]?.Vulnerabilities[]? | select(.Severity == "HIGH")] | length' "$TRIVY_JSON"); then
    echo -e "${RED}❌ Security scan FAILED - could not read the Trivy report ($TRIVY_JSON)${NC}"
    exit 2
fi

cat > "$OUTPUT_DIR/summary-$TIMESTAMP.md" << EOF
# Security Scan Summary

**Image:** $IMAGE_TAG  
**Scan Date:** $(date -u +%Y-%m-%d\ %H:%M:%S\ UTC)  
**Scanner:** Strada.Brain Security Suite

## Vulnerabilities

| Severity | Count |
|----------|-------|
| CRITICAL | $CRITICAL_VULNS |
| HIGH     | $HIGH_VULNS |

## Compliance Status

| Check | Status |
|-------|--------|
| Non-root user | $(pass_fail runs_non_root) |
| Read-only rootfs | $(pass_fail compose_has 'read_only:[[:space:]]*true') |
| No new privileges | $(pass_fail compose_has '-[[:space:]]*no-new-privileges:true') |
| Dropped capabilities | $(pass_fail drops_all_caps) |
| Health check | $(pass_fail has_healthcheck) |

## Recommendations

1. $(if [ "$CRITICAL_VULNS" -gt 0 ]; then echo "**URGENT:** Fix $CRITICAL_VULNS critical vulnerabilities immediately"; else echo "No critical vulnerabilities found"; fi)
2. $(if [ "$HIGH_VULNS" -gt 0 ]; then echo "**HIGH:** Address $HIGH_VULNS high severity vulnerabilities"; else echo "No high severity vulnerabilities found"; fi)
3. Regularly update base images and dependencies
4. Enable content trust for Docker images
5. Implement runtime security monitoring

## Output Files

- \`docker-bench-$TIMESTAMP.log\` - Docker Bench Security results
- \`trivy-$TIMESTAMP.txt\` - Trivy vulnerability scan (table)
- \`trivy-$TIMESTAMP.json\` - Trivy vulnerability scan (JSON)
- \`hadolint-$TIMESTAMP.txt\` - Dockerfile linting results
- \`image-analysis-$TIMESTAMP.txt\` - Image analysis report
- \`cis-checks-$TIMESTAMP.txt\` - CIS benchmark checks

EOF

echo ""
echo "=================================================="
echo "Security Scan Complete"
echo "=================================================="
echo ""
echo "Reports generated in: $OUTPUT_DIR/"
echo ""
ls -la "$OUTPUT_DIR/"
echo ""

# Final status
if [ "$CRITICAL_VULNS" -gt 0 ]; then
    echo -e "${RED}❌ Security scan FAILED - $CRITICAL_VULNS critical vulnerabilities found${NC}"
    exit 1
elif [ "$HIGH_VULNS" -gt 5 ]; then
    echo -e "${YELLOW}⚠️  Security scan WARNING - $HIGH_VULNS high vulnerabilities found${NC}"
    exit 0
else
    echo -e "${GREEN}✅ Security scan PASSED${NC}"
    exit 0
fi
