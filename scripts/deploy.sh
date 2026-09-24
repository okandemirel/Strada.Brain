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
#       --rollback       Restore the newest backup (volumes and env file)
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

# Read KEY from the env file WITHOUT executing it. `source` ran the file as
# bash, so an unquoted value with a space (or a command substitution) ran as a
# command. Takes the last assignment and strips one level of matching quotes.
env_file_value() {
    local key="$1" file="$2" line value
    line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null | tail -n 1)" || true
    [[ -n "$line" ]] || return 0
    value="${line#*=}"
    value="${value%$'\r'}"
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
        value="${BASH_REMATCH[1]}"
    fi
    printf '%s' "$value"
}

detect_compose() {
    if docker compose version &> /dev/null; then
        COMPOSE_CMD=(docker compose)
    elif docker-compose version &> /dev/null; then
        COMPOSE_CMD=(docker-compose)
    else
        error_exit "Docker Compose is not installed"
    fi
}

# Every compose call reads the same env file the checks read (-e/--env).
compose() {
    "${COMPOSE_CMD[@]}" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose_project_name() {
    local name
    name="$(compose config --no-interpolate 2>/dev/null | sed -n 's/^name:[[:space:]]*//p' | head -n 1)" || true
    if [[ -z "$name" ]]; then
        # Compose's own default: the directory name, lower-cased, [a-z0-9_-] only.
        name="$(basename "$PROJECT_ROOT" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
    fi
    printf '%s' "$name"
}

# Compose prefixes volume names with the project (`<project>_strada-memory`),
# so the bare name from docker-compose.yml never exists. Ask Docker for the
# volume compose labelled; fall back to compose's naming rule.
compose_volume_name() {
    local logical="$1" project found
    project="$(compose_project_name)"
    found="$(docker volume ls -q \
        --filter "label=com.docker.compose.project=${project}" \
        --filter "label=com.docker.compose.volume=${logical}" 2>/dev/null | head -n 1)" || true
    printf '%s' "${found:-${project}_${logical}}"
}

# Exactly "healthy": `grep healthy` also matched "unhealthy".
container_healthy() {
    [[ "$(docker inspect --format='{{.State.Health.Status}}' "$1" 2>/dev/null)" == "healthy" ]]
}

# Container names as docker-compose.yml's container_name declares them.
services_healthy() {
    container_healthy strada-brain && container_healthy strada-nginx
}

# Volumes that hold state: the config root (STRADA_HOME) and the memory store.
STATE_VOLUMES=(strada-home strada-memory)

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
    detect_compose

    # Check required files
    [[ -f "$COMPOSE_FILE" ]] || error_exit "docker-compose.yml not found"
    [[ -f "$ENV_FILE" ]] || error_exit ".env file not found at $ENV_FILE"

    # Check environment variables (read, never executed)
    log INFO "Checking required environment variables..."

    local required_vars=(
        "ANTHROPIC_API_KEY"
        "TELEGRAM_BOT_TOKEN"
    )

    local missing_vars=()
    for var in "${required_vars[@]}"; do
        if [[ -z "$(env_file_value "$var" "$ENV_FILE")" ]]; then
            missing_vars+=("$var")
        fi
    done

    if [[ ${#missing_vars[@]} -gt 0 ]]; then
        log WARN "Missing optional/required variables: ${missing_vars[*]}"
    fi

    # Validate Unity project path
    local unity_project_path
    unity_project_path="$(env_file_value UNITY_PROJECT_PATH "$ENV_FILE")"
    if [[ -n "$unity_project_path" && ! -d "$unity_project_path" ]]; then
        log WARN "UNITY_PROJECT_PATH does not exist: $unity_project_path"
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
    # Created here, not implicitly by the volume copy below: without a volume to
    # copy, every later `cp` into it failed and `set -e` aborted the deploy.
    mkdir -p "$backup_path"

    # Backup the state volumes under their real (project-prefixed) names
    local logical volume
    for logical in "${STATE_VOLUMES[@]}"; do
        volume="$(compose_volume_name "$logical")"
        if docker volume inspect "$volume" &> /dev/null; then
            log INFO "Backing up ${volume} volume..."
            docker run --rm \
                -v "${volume}:/data:ro" \
                -v "$backup_path:/backup" \
                alpine:latest \
                tar czf "/backup/${logical}.tar.gz" -C /data .
        else
            log WARN "Volume ${volume} not found; nothing to back up for ${logical}"
        fi
    done
    
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
    # compose pull
    
    # Build new images
    log INFO "Building Docker images..."
    compose build --no-cache --parallel

    # Stop and remove old containers gracefully
    log INFO "Stopping current containers..."
    compose down --timeout 30

    # Start new containers
    log INFO "Starting new containers..."
    compose up -d --remove-orphans

    # Wait for services to be healthy
    log INFO "Waiting for services to be healthy..."
    local timeout="${DEPLOY_HEALTH_TIMEOUT:-120}"
    local interval="${DEPLOY_HEALTH_INTERVAL:-5}"
    local elapsed=0
    local healthy=false

    while [[ $elapsed -lt $timeout ]]; do
        if services_healthy; then
            healthy=true
            log SUCCESS "All services are healthy!"
            break
        fi

        sleep "$interval"
        elapsed=$((elapsed + interval))
        log INFO "Waiting for services... (${elapsed}s/${timeout}s)"
    done

    if [[ "$healthy" != "true" ]]; then
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
    compose ps
    echo "================================================================================"
    echo ""
    log INFO "Web portal (host loopback): http://127.0.0.1:3000"
    log INFO "Metrics (host loopback): http://127.0.0.1:9090/metrics"
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
    compose logs --tail=50
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
    compose down

    # Restore the state volumes into the volumes the stack actually mounts
    # (a bare `strada-memory` was a fresh orphan volume nothing mounted).
    # memory.tar.gz is the archive name older backups used.
    local logical archive volume
    for logical in "${STATE_VOLUMES[@]}"; do
        archive="${logical}.tar.gz"
        if [[ "$logical" == "strada-memory" && ! -f "$BACKUP_DIR/$latest_backup/$archive" ]]; then
            archive="memory.tar.gz"
        fi
        [[ -f "$BACKUP_DIR/$latest_backup/$archive" ]] || continue
        volume="$(compose_volume_name "$logical")"
        log INFO "Restoring ${archive} into ${volume}..."
        docker run --rm \
            -v "${volume}:/data" \
            -v "$BACKUP_DIR/$latest_backup:/backup:ro" \
            alpine:latest \
            tar xzf "/backup/${archive}" -C /data
    done
    
    # Restore environment file
    if [[ -f "$BACKUP_DIR/$latest_backup/.env" ]]; then
        cp "$BACKUP_DIR/$latest_backup/.env" "$ENV_FILE"
    fi
    
    # Start services
    compose up -d

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
    ROLLBACK=false
    
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
                # Deferred until every option (e.g. -e) is parsed and compose
                # is detected; it used to run with COMPOSE_CMD unset.
                ROLLBACK=true
                shift
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

    if [[ "$ROLLBACK" == "true" ]]; then
        check_command docker
        detect_compose
        rollback
        exit 0
    fi

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
