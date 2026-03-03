#!/bin/bash
# Backup script for Strata.Brain
# Performs comprehensive backup of all critical data

set -euo pipefail

# Configuration
BACKUP_DIR="${BACKUP_DIR:-/backups/strata-brain}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="backup_${TIMESTAMP}"
BACKUP_TEMP_DIR="${BACKUP_DIR}/${BACKUP_NAME}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
LOG_FILE="${BACKUP_DIR}/backup.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging function
log() {
    local level="$1"
    local message="$2"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "[${timestamp}] [${level}] ${message}" | tee -a "$LOG_FILE"
}

info() { log "INFO" "$1"; }
warn() { log "WARN" "${YELLOW}$1${NC}"; }
error() { log "ERROR" "${RED}$1${NC}"; }
success() { log "SUCCESS" "${GREEN}$1${NC}"; }

# Create backup directory
setup() {
    mkdir -p "$BACKUP_TEMP_DIR"
    mkdir -p "$BACKUP_DIR"
    info "Starting backup: $BACKUP_NAME"
    info "Backup directory: $BACKUP_TEMP_DIR"
}

# Calculate checksum for a file
calculate_checksum() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print $1}'
    else
        md5sum "$file" | awk '{print $1}'
    fi
}

# Backup SQLite Learning DB
backup_learning_db() {
    info "Backing up SQLite Learning Database..."
    
    local source=".strata-memory/learning.db"
    local dest="${BACKUP_TEMP_DIR}/learning_${TIMESTAMP}.db"
    
    if [[ -f "$source" ]]; then
        cp "$source" "$dest"
        local checksum=$(calculate_checksum "$dest")
        echo "$checksum  learning_${TIMESTAMP}.db" > "${BACKUP_TEMP_DIR}/learning_${TIMESTAMP}.db.sha256"
        success "Learning DB backed up: $(du -h "$dest" | cut -f1)"
    else
        warn "Learning DB not found at $source"
    fi
}

# Backup RAG Vector Store
backup_vector_store() {
    info "Backing up RAG Vector Store..."
    
    local vectors_source=".strata-memory/vectors.bin"
    local chunks_source=".strata-memory/chunks.json"
    local metadata_source=".strata-memory/vector-metadata.json"
    
    if [[ -f "$vectors_source" ]]; then
        local dest="${BACKUP_TEMP_DIR}/vectors_${TIMESTAMP}.bin"
        cp "$vectors_source" "$dest"
        local checksum=$(calculate_checksum "$dest")
        echo "$checksum  vectors_${TIMESTAMP}.bin" > "${BACKUP_TEMP_DIR}/vectors_${TIMESTAMP}.bin.sha256"
        success "Vectors backed up: $(du -h "$dest" | cut -f1)"
    else
        warn "Vectors file not found at $vectors_source"
    fi
    
    if [[ -f "$chunks_source" ]]; then
        local dest="${BACKUP_TEMP_DIR}/chunks_${TIMESTAMP}.json"
        cp "$chunks_source" "$dest"
        local checksum=$(calculate_checksum "$dest")
        echo "$checksum  chunks_${TIMESTAMP}.json" > "${BACKUP_TEMP_DIR}/chunks_${TIMESTAMP}.json.sha256"
        success "Chunks backed up: $(du -h "$dest" | cut -f1)"
    else
        warn "Chunks file not found at $chunks_source"
    fi
    
    if [[ -f "$metadata_source" ]]; then
        local dest="${BACKUP_TEMP_DIR}/vector-metadata_${TIMESTAMP}.json"
        cp "$metadata_source" "$dest"
        success "Vector metadata backed up"
    fi
}

# Backup HNSW Index
backup_hnsw_index() {
    info "Backing up HNSW Index..."
    
    local hnsw_index=".strata-memory/hnsw.index"
    local hnsw_meta=".strata-memory/hnsw.meta.json"
    
    if [[ -f "$hnsw_index" ]]; then
        local dest="${BACKUP_TEMP_DIR}/hnsw_${TIMESTAMP}.index"
        cp "$hnsw_index" "$dest"
        local checksum=$(calculate_checksum "$dest")
        echo "$checksum  hnsw_${TIMESTAMP}.index" > "${BACKUP_TEMP_DIR}/hnsw_${TIMESTAMP}.index.sha256"
        success "HNSW index backed up: $(du -h "$dest" | cut -f1)"
    else
        info "HNSW index not found (optional)"
    fi
    
    if [[ -f "$hnsw_meta" ]]; then
        cp "$hnsw_meta" "${BACKUP_TEMP_DIR}/hnsw_${TIMESTAMP}.meta.json"
        success "HNSW metadata backed up"
    fi
}

# Backup configuration files
backup_config() {
    info "Backing up configuration files..."
    
    local config_dir="${BACKUP_TEMP_DIR}/config"
    mkdir -p "$config_dir"
    
    # Backup non-sensitive config
    if [[ -f ".env.example" ]]; then
        cp ".env.example" "${config_dir}/env_${TIMESTAMP}.example"
        success ".env.example backed up"
    fi
    
    if [[ -f "package.json" ]]; then
        cp "package.json" "${config_dir}/package_${TIMESTAMP}.json"
        success "package.json backed up"
    fi
    
    if [[ -f "tsconfig.json" ]]; then
        cp "tsconfig.json" "${config_dir}/tsconfig_${TIMESTAMP}.json"
        success "tsconfig.json backed up"
    fi
    
    # Backup important directories structure
    if [[ -d "src" ]]; then
        find src -name "*.config.*" -o -name "*.yaml" -o -name "*.yml" 2>/dev/null | \
            tar -czf "${config_dir}/src-configs_${TIMESTAMP}.tar.gz" -T - 2>/dev/null || true
        success "Source configs backed up"
    fi
}

# Backup memory files
backup_memory() {
    info "Backing up memory files..."
    
    local memory_dir="${BACKUP_TEMP_DIR}/memory"
    mkdir -p "$memory_dir"
    
    if [[ -d ".strata-memory" ]]; then
        # Backup session memory
        if [[ -d ".strata-memory/sessions" ]]; then
            tar -czf "${memory_dir}/sessions_${TIMESTAMP}.tar.gz" -C ".strata-memory" sessions 2>/dev/null || true
            success "Session memory backed up"
        fi
        
        # Backup text index
        if [[ -f ".strata-memory/text-index.json" ]]; then
            cp ".strata-memory/text-index.json" "${memory_dir}/text-index_${TIMESTAMP}.json"
            success "Text index backed up"
        fi
        
        # Backup reasoning bank if exists
        if [[ -d ".strata-memory/reasoning" ]]; then
            tar -czf "${memory_dir}/reasoning_${TIMESTAMP}.tar.gz" -C ".strata-memory" reasoning 2>/dev/null || true
            success "Reasoning bank backed up"
        fi
    fi
}

# Create backup manifest
create_manifest() {
    info "Creating backup manifest..."
    
    local manifest="${BACKUP_TEMP_DIR}/manifest.json"
    
    cat > "$manifest" <<EOF
{
  "backup_name": "$BACKUP_NAME",
  "timestamp": "$TIMESTAMP",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hostname": "$(hostname)",
  "version": "$(git describe --tags --always 2>/dev/null || echo 'unknown')",
  "files": $(find "$BACKUP_TEMP_DIR" -type f -not -name "manifest.json" | wc -l),
  "size": "$(du -sh "$BACKUP_TEMP_DIR" | cut -f1)"
}
EOF
    
    success "Manifest created"
}

# Compress backup
compress_backup() {
    info "Compressing backup..."
    
    local archive="${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"
    
    # Create compressed archive
    tar -czf "$archive" -C "$BACKUP_DIR" "$BACKUP_NAME"
    
    # Create archive checksum
    local checksum=$(calculate_checksum "$archive")
    echo "$checksum  ${BACKUP_NAME}.tar.gz" > "${archive}.sha256"
    
    success "Backup compressed: $(du -h "$archive" | cut -f1)"
    
    # Cleanup temp directory
    rm -rf "$BACKUP_TEMP_DIR"
    info "Temp directory cleaned up"
}

# Verify backup integrity
verify_backup() {
    info "Verifying backup integrity..."
    
    local archive="${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"
    local checksum_file="${archive}.sha256"
    
    # Verify checksum
    if [[ -f "$checksum_file" ]]; then
        local expected=$(cat "$checksum_file" | awk '{print $1}')
        local actual=$(calculate_checksum "$archive")
        
        if [[ "$expected" == "$actual" ]]; then
            success "Backup checksum verified"
        else
            error "Backup checksum mismatch!"
            return 1
        fi
    fi
    
    # Test archive integrity
    if tar -tzf "$archive" >/dev/null 2>&1; then
        success "Archive integrity verified"
    else
        error "Archive is corrupted!"
        return 1
    fi
}

# Cleanup old backups
cleanup_old_backups() {
    info "Cleaning up old backups (retention: $RETENTION_DAYS days)..."
    
    local deleted=0
    while IFS= read -r file; do
        rm -f "$file"
        rm -f "${file}.sha256"
        ((deleted++))
    done < <(find "$BACKUP_DIR" -name "backup_*.tar.gz" -mtime +$RETENTION_DAYS 2>/dev/null)
    
    if [[ $deleted -gt 0 ]]; then
        info "Deleted $deleted old backup(s)"
    else
        info "No old backups to delete"
    fi
    
    # Keep only last N backups if specified
    local keep_count="${KEEP_COUNT:-0}"
    if [[ $keep_count -gt 0 ]]; then
        local to_delete=$(ls -t "$BACKUP_DIR"/backup_*.tar.gz 2>/dev/null | tail -n +$((keep_count + 1)))
        for file in $to_delete; do
            rm -f "$file"
            rm -f "${file}.sha256"
            ((deleted++))
        done
        info "Retention cleanup: deleted $deleted backup(s), keeping last $keep_count"
    fi
}

# Remote sync (optional)
remote_sync() {
    if [[ -n "${RCLONE_REMOTE:-}" ]]; then
        info "Syncing to remote: $RCLONE_REMOTE"
        
        if command -v rclone >/dev/null 2>&1; then
            rclone sync "$BACKUP_DIR" "$RCLONE_REMOTE" --transfers 4 --checksum
            success "Remote sync completed"
        else
            warn "rclone not found, skipping remote sync"
        fi
    fi
    
    if [[ -n "${AWS_S3_BUCKET:-}" ]]; then
        info "Syncing to S3: $AWS_S3_BUCKET"
        
        if command -v aws >/dev/null 2>&1; then
            aws s3 sync "$BACKUP_DIR" "s3://$AWS_S3_BUCKET" --storage-class STANDARD_IA
            success "S3 sync completed"
        else
            warn "AWS CLI not found, skipping S3 sync"
        fi
    fi
}

# Send notification
send_notification() {
    local status="$1"
    local message="$2"
    
    # Discord webhook
    if [[ -n "${DISCORD_WEBHOOK_URL:-}" ]]; then
        local color="$([[ "$status" == "success" ]] && echo "3066993" || echo "15158332")"
        curl -s -X POST "$DISCORD_WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -d "{
                \"embeds\": [{
                    \"title\": \"Backup $status\",
                    \"description\": \"$message\",
                    \"color\": $color,
                    \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
                }]
            }" >/dev/null 2>&1 || true
    fi
    
    # Slack webhook
    if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
        curl -s -X POST "$SLACK_WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -d "{\"text\": \"Backup $status: $message\"}" >/dev/null 2>&1 || true
    fi
}

# Main backup process
main() {
    local start_time=$(date +%s)
    
    info "================================"
    info "Strata.Brain Backup Starting"
    info "================================"
    
    setup
    backup_learning_db
    backup_vector_store
    backup_hnsw_index
    backup_config
    backup_memory
    create_manifest
    compress_backup
    verify_backup
    cleanup_old_backups
    remote_sync
    
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    
    success "Backup completed in ${duration}s: ${BACKUP_NAME}.tar.gz"
    send_notification "success" "Backup completed: $BACKUP_NAME (${duration}s)"
    
    return 0
}

# Handle errors
trap 'error "Backup failed at line $LINENO"' ERR

# Run main function
main "$@"
