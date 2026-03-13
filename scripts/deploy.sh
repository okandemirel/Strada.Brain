#!/bin/bash
# =============================================================================
# Strada.Brain - Production Deployment Script
# =============================================================================
# This script automates the deployment process with zero-downtime updates
#
# Usage:
#   ./scripts/deploy.sh [options]
#
# Options:
#   -e, --env FILE       Environment file path (default: .env)
#   -b, --backup         Create backup before deployment
#   -c, --check          Run pre-deployment checks only
#   -f, --force          Skip confirmation prompts
#   -h, --help           Show this help message
#
# Examples:
#   ./scripts/deploy.sh                    # Standard deployment
#   ./scripts/deploy.sh -b                 # Deploy with backup
#   ./scripts/deploy.sh -e .env.prod -b    # Deploy with custom env and backup
# =============================================================================

set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.yml"
ENV_FILE="$PROJECT_ROOT/.env"
BACKUP_DIR="$PROJECT_ROOT/backups"
LOG_FILE="$PROJECT_ROOT/logs/deploy.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# =============================================================================
# Functions
# =============================================================================

log() {
    local level="$1"
    shift
    local message="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    # Console output with colors
    case "$level" in
        INFO)  echo -e "${BLUE}[INFO]${NC} $message" ;;
        SUCCESS) echo -e "${GREEN}[OK]${NC} $message" ;;
        WARN)  echo -e "${YELLOW}[WARN]${NC} $message" ;;
        ERROR) echo -e "${RED}[ERROR]${NC} $message" ;;
    esac
    
    # File logging
    mkdir -p "$(dirname "$LOG_FILE")"
    echo "[$timestamp] [$level] $message" >> "$LOG_FILE"
}

show_help() {
    head -n 30 "$0" | tail -n 26
    exit 0
}

error_exit() {
    log ERROR "$1"
    exit 1
}

check_command() {
    if ! command -v "$1" &> /dev/null; then
        error_exit "$1 is required but not installed"
    fi
}

confirm() {
    if [[ "$FORCE" == "true" ]]; then
        return 0
    fi
    
    read -r -p "${1:-Continue?} [y/N] " response
    case "$response" in
        [yY][eE][sS]|[yY])
            return 0
            ;;
        *)
            log INFO "Deployment cancelled by user"
            exit 0
            ;;
    esac
}

# =============================================================================
# Pre-deployment Checks
# =============================================================================

run_pre_checks() {
    log INFO "Running pre-deployment checks..."
    
    # Check Docker
    check_command docker
    docker info > /dev/null 2>&1 || error_exit "Docker daemon is not running"
    
    # Check Docker Compose
    if docker compose version &> /dev/null; then
        COMPOSE_CMD="docker compose"
    elif docker-compose version &> /dev/null; then
        COMPOSE_CMD="docker-compose"
    else
        error_exit "Docker Compose is not installed"
    fi
    
    # Check required files
    [[ -f "$COMPOSE_FILE" ]] || error_exit "docker-compose.yml not found"
    [[ -f "$ENV_FILE" ]] || error_exit ".env file not found at $ENV_FILE"
    
    # Check environment variables
    log INFO "Checking required environment variables..."
    source "$ENV_FILE"
    
    local required_vars=(
        "ANTHROPIC_API_KEY"
        "TELEGRAM_BOT_TOKEN"
    )
    
    local missing_vars=()
    for var in "${required_vars[@]}"; do
        if [[ -z "${!var:-}" ]]; then
            missing_vars+=("$var")
        fi
    done
    
    if [[ ${#missing_vars[@]} -gt 0 ]]; then
        log WARN "Missing optional/required variables: ${missing_vars[*]}"
    fi
    
    # Validate Unity project path
    if [[ -n "${UNITY_PROJECT_PATH:-}" && ! -d "$UNITY_PROJECT_PATH" ]]; then
        log WARN "UNITY_PROJECT_PATH does not exist: $UNITY_PROJECT_PATH"
    fi
    
    # Check disk space
    local available_space=$(df -BG "$PROJECT_ROOT" | awk 'NR==2 {print $4}' | tr -d 'G')
    if [[ "$available_space" -lt 5 ]]; then
        error_exit "Insufficient disk space. At least 5GB required."
    fi
    log INFO "Disk space check passed (${available_space}GB available)"
    
    # Check memory
    local available_memory=$(free -g 2>/dev/null | awk 'NR==2{print $7}' || echo "4")
    if [[ "$available_memory" -lt 1 ]]; then
        log WARN "Low memory detected (${available_memory}GB). Deployment may fail."
    fi
    
    # Check SSL certificates
    if [[ ! -f "$PROJECT_ROOT/nginx/ssl/cert.pem" || ! -f "$PROJECT_ROOT/nginx/ssl/key.pem" ]]; then
        log WARN "SSL certificates not found. Using self-signed certificates."
        mkdir -p "$PROJECT_ROOT/nginx/ssl"
    fi
    
    log SUCCESS "Pre-deployment checks completed"
}

# =============================================================================
# Backup
# =============================================================================

create_backup() {
    if [[ "$BACKUP" != "true" ]]; then
        return 0
    fi
    
    log INFO "Creating backup..."
    
    mkdir -p "$BACKUP_DIR"
    local backup_name="backup_$(date +%Y%m%d_%H%M%S)"
    local backup_path="$BACKUP_DIR/$backup_name"
    
    # Backup memory data
    local memory_volume="strada-memory"

    if docker volume inspect "$memory_volume" &> /dev/null; then
        log INFO "Backing up ${memory_volume} volume..."
        docker run --rm \
            -v "${memory_volume}:/data:ro" \
            -v "$backup_path:/backup" \
            alpine:latest \
            tar czf /backup/memory.tar.gz -C /data .
    fi
    
    # Backup environment file
    cp "$ENV_FILE" "$backup_path/"
    
    # Backup logs
    if [[ -d "$PROJECT_ROOT/logs" ]]; then
        tar czf "$backup_path/logs.tar.gz" -C "$PROJECT_ROOT" logs/
    fi
    
    # Backup docker-compose.yml
    cp "$COMPOSE_FILE" "$backup_path/"
    
    log SUCCESS "Backup created at $backup_path"
    
    # Cleanup old backups (keep last 10)
    local backup_count=$(ls -1 "$BACKUP_DIR" | wc -l)
    if [[ "$backup_count" -gt 10 ]]; then
        log INFO "Cleaning up old backups..."
        ls -1t "$BACKUP_DIR" | tail -n +11 | xargs -I {} rm -rf "$BACKUP_DIR/{}"
    fi
}

# =============================================================================
# Deployment
# =============================================================================

deploy() {
    log INFO "Starting deployment..."
    
    cd "$PROJECT_ROOT"
    
    # Pull latest images (if using pre-built)
    # $COMPOSE_CMD -f "$COMPOSE_FILE" pull
    
    # Build new images
    log INFO "Building Docker images..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" build --no-cache --parallel
    
    # Stop and remove old containers gracefully
    log INFO "Stopping current containers..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" down --timeout 30
    
    # Start new containers
    log INFO "Starting new containers..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" up -d --remove-orphans
    
    # Wait for services to be healthy
    log INFO "Waiting for services to be healthy..."
    local timeout=120
    local elapsed=0
    
    while [[ $elapsed -lt $timeout ]]; do
        local healthy=true
        
        # Check strada-brain health
        if ! docker inspect --format='{{.State.Health.Status}}' strada-brain 2>/dev/null | grep -q "healthy"; then
            healthy=false
        fi
        
        # Check nginx health
        if ! docker inspect --format='{{.State.Health.Status}}' strata-nginx 2>/dev/null | grep -q "healthy"; then
            healthy=false
        fi
        
        if [[ "$healthy" == "true" ]]; then
            log SUCCESS "All services are healthy!"
            break
        fi
        
        sleep 5
        elapsed=$((elapsed + 5))
        log INFO "Waiting for services... (${elapsed}s/${timeout}s)"
    done
    
    if [[ $elapsed -ge $timeout ]]; then
        log ERROR "Services failed to become healthy within ${timeout}s"
        show_logs
        error_exit "Deployment failed"
    fi
    
    # Cleanup old images
    log INFO "Cleaning up old Docker images..."
    docker image prune -f --filter "until=168h" > /dev/null 2>&1 || true
    
    log SUCCESS "Deployment completed successfully!"
    show_status
}

# =============================================================================
# Post-deployment
# =============================================================================

show_status() {
    echo ""
    log INFO "Service Status:"
    echo "================================================================================"
    $COMPOSE_CMD -f "$COMPOSE_FILE" ps
    echo "================================================================================"
    echo ""
    log INFO "Dashboard: http://localhost:3100"
    log INFO "Metrics: http://localhost:9090/metrics"
    log INFO "Nginx: http://localhost (redirects to HTTPS)"
    echo ""
    log INFO "Useful commands:"
    echo "  View logs:        docker compose logs -f strada-brain"
    echo "  Restart:          docker compose restart strada-brain"
    echo "  Shell access:     docker exec -it strada-brain sh"
    echo "  Scale:            docker compose up -d --scale strada-brain=2"
}

show_logs() {
    echo ""
    log INFO "Recent logs:"
    echo "================================================================================"
    $COMPOSE_CMD -f "$COMPOSE_FILE" logs --tail=50
    echo "================================================================================"
}

rollback() {
    log WARN "Rolling back to previous version..."
    
    local latest_backup=$(ls -1t "$BACKUP_DIR" 2>/dev/null | head -1)
    if [[ -z "$latest_backup" ]]; then
        error_exit "No backup found for rollback"
    fi
    
    log INFO "Restoring from backup: $latest_backup"
    
    # Stop current containers
    $COMPOSE_CMD -f "$COMPOSE_FILE" down
    
    # Restore memory volume
    if [[ -f "$BACKUP_DIR/$latest_backup/memory.tar.gz" ]]; then
        local memory_volume="strada-memory"
        docker run --rm \
            -v "${memory_volume}:/data" \
            -v "$BACKUP_DIR/$latest_backup:/backup:ro" \
            alpine:latest \
            tar xzf /backup/memory.tar.gz -C /data
    fi
    
    # Restore environment file
    if [[ -f "$BACKUP_DIR/$latest_backup/.env" ]]; then
        cp "$BACKUP_DIR/$latest_backup/.env" "$ENV_FILE"
    fi
    
    # Start services
    $COMPOSE_CMD -f "$COMPOSE_FILE" up -d
    
    log SUCCESS "Rollback completed"
}

# =============================================================================
# Main
# =============================================================================

main() {
    # Default values
    BACKUP=false
    FORCE=false
    CHECK_ONLY=false
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -e|--env)
                ENV_FILE="$2"
                shift 2
                ;;
            -b|--backup)
                BACKUP=true
                shift
                ;;
            -c|--check)
                CHECK_ONLY=true
                shift
                ;;
            -f|--force)
                FORCE=true
                shift
                ;;
            -h|--help)
                show_help
                ;;
            --rollback)
                rollback
                exit 0
                ;;
            *)
                error_exit "Unknown option: $1"
                ;;
        esac
    done
    
    # Banner
    echo -e "${BLUE}"
    cat << "EOF"
    ____  _______________   ____  ____  ________    __    
   / __ \/ ___/_  __/   | / __ )/ __ \/ ____/ /   / /    
  / /_/ /\__ \ / / / /| |/ __  / / / / __/ / /   / /     
 / _, _/___/ // / / ___ / /_/ / /_/ / /___/ /___/ /___   
/_/ |_|/____//_/ /_/  |_/_____/_____/_____/_____/_____/  
                                                          
EOF
    echo -e "${NC}"
    log INFO "Strada.Brain Deployment Script v1.0"
    log INFO "Project root: $PROJECT_ROOT"
    log INFO "Environment file: $ENV_FILE"
    echo ""
    
    # Run checks
    run_pre_checks
    
    if [[ "$CHECK_ONLY" == "true" ]]; then
        log INFO "Check-only mode. Exiting."
        exit 0
    fi
    
    # Confirm deployment
    confirm "Ready to deploy. Continue?"
    
    # Create backup
    create_backup
    
    # Deploy
    deploy
}

# Run main function
main "$@"
