#!/bin/bash
# Backup script for Strada.Brain
# Performs comprehensive backup of all critical data

set -euo pipefail

# Configuration
DEFAULT_BACKUP_DIR="/backups/strada-brain"
BACKUP_DIR="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
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
    # The log lives INSIDE BACKUP_DIR, and main() logs three lines before setup()
    # creates that directory. On any machine whose backup directory does not exist
    # yet — a clean install, the first scheduled run, a new volume — `tee` failed,
    # `set -o pipefail` turned that into a non-zero pipeline, and `set -e` killed
    # the backup before a single database was copied. The only trace was one
    # "tee: No such file or directory" line. Found by the release acceptance
    # runner, which performs a backup and a restore on a fresh root (plan 6.13).
    mkdir -p "$(dirname "$LOG_FILE")"
    echo -e "[${timestamp}] [${level}] ${message}" | tee -a "$LOG_FILE"
}

info() { log "INFO" "$1"; }
warn() { log "WARN" "${YELLOW}$1${NC}"; }
error() { log "ERROR" "${RED}$1${NC}"; }
success() { log "SUCCESS" "${GREEN}$1${NC}"; }

# Where the runtime keeps its data. MEMORY_DB_PATH is what the application
# reads (docker-compose sets it to /app/.strada-memory), so the backup must read
# the same variable: hardcoding ".strada-memory" backed up an empty relative
# directory whenever the deployment used a volume mounted anywhere else
# (14F3/D72).
get_memory_root() {
    echo "${MEMORY_DB_PATH:-.strada-memory}"
}

# The PROJECT whose .strada directory holds project-owned databases — today
# delivery-packages.db, every delivery revision a reviewer can still open. The
# runtime reads UNITY_PROJECT_PATH for exactly this path (config.unityProjectPath
# is what CampaignManager is handed), so the backup reads the same variable
# rather than inventing one: a path of our own would back up a directory the
# application does not use (round 11 #19).
get_project_root() {
    echo "${UNITY_PROJECT_PATH:-}"
}

# Repository/install root — this script lives in <root>/scripts.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="${STRADA_INSTALL_ROOT:-$(dirname "$SCRIPT_DIR")}"
DB_BACKUP_CLI="${INSTALL_ROOT}/dist/core/database-backup.js"

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

# Backup every SQLite database
#
# Was: `cp` of learning.db alone. Two defects in one function (14F3/D72) — the
# runtime keeps a dozen databases side by side (memory, campaigns, goals,
# daemon, tasks, identities, …) and `cp` of a live WAL database copies the main
# file without the -wal that holds the newest commits, so the copy opens and is
# quietly missing data.
#
# Now: dist/core/database-backup.js builds the list from the runtime path table
# — every root the runtime uses (the memory root AND the Strada home, which is
# where hub-owners.db and trusted-skills.db live) plus whatever *.db those
# directories hold — and copies each with SQLite's own online backup API
# (better-sqlite3 `db.backup()`), verifying integrity_check on every produced
# file. It prints one path per line, the restore manifest last; we checksum those.
backup_databases() {
    info "Backing up SQLite databases (online backup API)..."

    local memory_root
    memory_root="$(get_memory_root)"

    # A missing memory root is NOT "nothing to back up": hub bindings
    # (hub-owners.db) and skill approvals (trusted-skills.db) live in the Strada
    # home, and the helper inventories that root too (round 10 #22). Returning
    # here skipped them as well.
    if [[ ! -d "$memory_root" ]]; then
        warn "Memory root not found at $memory_root — backing up the Strada home only"
    fi

    if [[ ! -f "$DB_BACKUP_CLI" ]]; then
        error "Database backup helper missing at $DB_BACKUP_CLI (run 'npm run build')"
        return 1
    fi

    local project_root
    project_root="$(get_project_root)"

    local project_args=()
    if [[ -n "$project_root" ]]; then
        project_args=(--project-root "$project_root")
    else
        # Not a complete backup, and it says so: with no project root the
        # project-owned databases (<projectRoot>/.strada/delivery-packages.db —
        # every stored delivery-package revision) are NOT in this archive, and a
        # restore from it comes back with no delivery history (round 11 #19).
        warn "UNITY_PROJECT_PATH is not set — .strada/delivery-packages.db is NOT in this backup"
    fi

    local produced
    # No `|| true` here on purpose: a database that cannot be copied consistently
    # must fail the backup, not be skipped with a warning nobody reads.
    # The helper also prints the retained attachment blobs it copied — the bytes
    # the large-attachment rows point at — so they are checksummed like the rest.
    produced="$(node "$DB_BACKUP_CLI" --source "$memory_root" --dest "$BACKUP_TEMP_DIR" --timestamp "$TIMESTAMP" ${project_args[@]+"${project_args[@]}"})"

    if [[ -z "$produced" ]]; then
        warn "No databases found under $memory_root or the Strada home"
        return 0
    fi

    local count=0
    while IFS= read -r produced_file; do
        [[ -z "$produced_file" ]] && continue
        local name
        name="$(basename "$produced_file")"
        local checksum
        checksum="$(calculate_checksum "$produced_file")"
        echo "$checksum  ${name}" > "${produced_file}.sha256"
        success "Database backed up: ${name} ($(du -h "$produced_file" | cut -f1))"
        count=$((count + 1))
    done <<< "$produced"

    info "Backed up ${count} file(s) from ${memory_root}, the Strada home${project_root:+ and $project_root}"
}

# Backup RAG Vector Store
backup_vector_store() {
    info "Backing up RAG Vector Store..."
    
    local memory_root
    memory_root="$(get_memory_root)"
    local vectors_source="${memory_root}/vectors.bin"
    local chunks_source="${memory_root}/chunks.json"
    local metadata_source="${memory_root}/vector-metadata.json"
    
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
    
    local memory_root
    memory_root="$(get_memory_root)"
    local hnsw_index="${memory_root}/hnsw.index"
    local hnsw_meta="${memory_root}/hnsw.meta.json"
    
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
    
    local memory_root
    memory_root="$(get_memory_root)"

    if [[ -d "$memory_root" ]]; then
        # Backup session memory
        if [[ -d "${memory_root}/sessions" ]]; then
            tar -czf "${memory_dir}/sessions_${TIMESTAMP}.tar.gz" -C "$memory_root" sessions 2>/dev/null || true
            success "Session memory backed up"
        fi
        
        # Backup text index
        if [[ -f "${memory_root}/text-index.json" ]]; then
            cp "${memory_root}/text-index.json" "${memory_dir}/text-index_${TIMESTAMP}.json"
            success "Text index backed up"
        fi
        
        # Backup reasoning bank if exists
        if [[ -d "${memory_root}/reasoning" ]]; then
            tar -czf "${memory_dir}/reasoning_${TIMESTAMP}.tar.gz" -C "$memory_root" reasoning 2>/dev/null || true
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
    
    # `deleted=$((deleted + 1))`, never `((deleted++))`: the post-increment
    # evaluates to the OLD value, so 0 made the command "fail" and `set -e`
    # aborted the run after the first expired archive, before remote sync.
    local deleted=0
    while IFS= read -r file; do
        rm -f "$file"
        rm -f "${file}.sha256"
        deleted=$((deleted + 1))
    done < <(find "$BACKUP_DIR" -name "backup_*.tar.gz" -mtime +$RETENTION_DAYS 2>/dev/null)
    
    if [[ $deleted -gt 0 ]]; then
        info "Deleted $deleted old backup(s)"
    else
        info "No old backups to delete"
    fi
    
    # Keep only last N backups if specified
    local keep_count="${KEEP_COUNT:-0}"
    if [[ $keep_count -gt 0 ]]; then
        local to_delete
        to_delete=$(ls -t "$BACKUP_DIR"/backup_*.tar.gz 2>/dev/null | tail -n +$((keep_count + 1))) || true
        while IFS= read -r file; do
            [[ -n "$file" ]] || continue
            rm -f "$file"
            rm -f "${file}.sha256"
            deleted=$((deleted + 1))
        done <<< "$to_delete"
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
    info "Strada.Brain Backup Starting"
    info "================================"
    
    setup
    backup_databases
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
