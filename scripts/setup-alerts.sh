#!/bin/bash
# Alerting Setup Script for Strada.Brain
# Configures and tests alerting system

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ENV_FILE=".env"
CONFIG_FILE=".alerting-config.json"

# Logging functions
log() {
    echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

info() { log "${BLUE}ℹ️  $1${NC}"; }
success() { log "${GREEN}✅ $1${NC}"; }
warning() { log "${YELLOW}⚠️  $1${NC}"; }
error() { log "${RED}❌ $1${NC}"; }

# Print header
print_header() {
    echo -e "${BLUE}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║           Strada.Brain Alerting Setup                        ║"
    echo "║                                                              ║"
    echo "║   Configure Discord, Slack, Email, Telegram alerts          ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

# Check prerequisites
check_prerequisites() {
    info "Checking prerequisites..."
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        error "Node.js is not installed. Please install Node.js 20+."
        exit 1
    fi
    
    NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [[ "$NODE_VERSION" -lt 20 ]]; then
        error "Node.js version 20+ required. Found: $(node --version)"
        exit 1
    fi
    success "Node.js $(node --version) detected"
    
    # Check if .env exists
    if [[ ! -f "$ENV_FILE" ]]; then
        if [[ -f ".env.example" ]]; then
            warning ".env not found, copying from .env.example"
            cp .env.example "$ENV_FILE"
        else
            warning ".env not found, creating new file"
            touch "$ENV_FILE"
        fi
    fi
}

# Configure Discord
setup_discord() {
    echo
    info "Discord Webhook Configuration"
    echo "─────────────────────────────────────────"
    echo "To get a Discord webhook URL:"
    echo "1. Open your Discord server"
    echo "2. Go to Server Settings → Integrations → Webhooks"
    echo "3. Click 'New Webhook' and copy the URL"
    echo
    
    read -rp "Discord Webhook URL (press Enter to skip): " webhook_url
    
    if [[ -n "$webhook_url" ]]; then
        if [[ "$webhook_url" =~ ^https://discord(app)?\.com/api/webhooks/ ]]; then
            # Update .env file
            if grep -q "DISCORD_WEBHOOK_URL=" "$ENV_FILE"; then
                sed -i '' "s|DISCORD_WEBHOOK_URL=.*|DISCORD_WEBHOOK_URL=$webhook_url|" "$ENV_FILE" 2>/dev/null || \
                sed -i "s|DISCORD_WEBHOOK_URL=.*|DISCORD_WEBHOOK_URL=$webhook_url|" "$ENV_FILE"
            else
                echo "DISCORD_WEBHOOK_URL=$webhook_url" >> "$ENV_FILE"
            fi
            success "Discord webhook configured"
        else
            warning "Invalid Discord webhook URL format"
        fi
    else
        info "Discord webhook skipped"
    fi
}

# Configure Slack
setup_slack() {
    echo
    info "Slack Webhook Configuration"
    echo "─────────────────────────────────────────"
    echo "To get a Slack webhook URL:"
    echo "1. Go to https://api.slack.com/apps"
    echo "2. Create New App → From scratch"
    echo "3. Enable Incoming Webhooks and create one"
    echo
    
    read -rp "Slack Webhook URL (press Enter to skip): " webhook_url
    
    if [[ -n "$webhook_url" ]]; then
        if [[ "$webhook_url" =~ ^https://hooks\.slack\.com/services/ ]]; then
            if grep -q "SLACK_WEBHOOK_URL=" "$ENV_FILE"; then
                sed -i '' "s|SLACK_WEBHOOK_URL=.*|SLACK_WEBHOOK_URL=$webhook_url|" "$ENV_FILE" 2>/dev/null || \
                sed -i "s|SLACK_WEBHOOK_URL=.*|SLACK_WEBHOOK_URL=$webhook_url|" "$ENV_FILE"
            else
                echo "SLACK_WEBHOOK_URL=$webhook_url" >> "$ENV_FILE"
            fi
            success "Slack webhook configured"
        else
            warning "Invalid Slack webhook URL format"
        fi
    else
        info "Slack webhook skipped"
    fi
}

# Configure Telegram
setup_telegram() {
    echo
    info "Telegram Bot Configuration"
    echo "─────────────────────────────────────────"
    echo "To create a Telegram bot:"
    echo "1. Message @BotFather on Telegram"
    echo "2. Send /newbot and follow instructions"
    echo "3. Get your Chat ID from @userinfobot"
    echo
    
    read -rp "Telegram Bot Token (press Enter to skip): " bot_token
    
    if [[ -n "$bot_token" ]]; then
        read -rp "Telegram Chat ID: " chat_id
        
        if [[ -n "$chat_id" ]]; then
            if grep -q "TELEGRAM_BOT_TOKEN=" "$ENV_FILE"; then
                sed -i '' "s|TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$bot_token|" "$ENV_FILE" 2>/dev/null || \
                sed -i "s|TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$bot_token|" "$ENV_FILE"
            else
                echo "TELEGRAM_BOT_TOKEN=$bot_token" >> "$ENV_FILE"
            fi
            
            if grep -q "TELEGRAM_CHAT_ID=" "$ENV_FILE"; then
                sed -i '' "s|TELEGRAM_CHAT_ID=.*|TELEGRAM_CHAT_ID=$chat_id|" "$ENV_FILE" 2>/dev/null || \
                sed -i "s|TELEGRAM_CHAT_ID=.*|TELEGRAM_CHAT_ID=$chat_id|" "$ENV_FILE"
            else
                echo "TELEGRAM_CHAT_ID=$chat_id" >> "$ENV_FILE"
            fi
            
            success "Telegram bot configured"
        else
            warning "Chat ID is required"
        fi
    else
        info "Telegram configuration skipped"
    fi
}

# Configure Email
setup_email() {
    echo
    info "Email (SMTP) Configuration"
    echo "─────────────────────────────────────────"
    echo "Configure SMTP settings for email alerts"
    echo "Common providers: Gmail (smtp.gmail.com:587), SendGrid, AWS SES"
    echo
    
    read -rp "SMTP Host (press Enter to skip): " smtp_host
    
    if [[ -n "$smtp_host" ]]; then
        read -rp "SMTP Port [587]: " smtp_port
        smtp_port=${smtp_port:-587}
        
        read -rp "SMTP Username: " smtp_user
        read -rsp "SMTP Password: " smtp_pass
        echo
        read -rp "From Email: " from_email
        read -rp "To Email(s, comma-separated): " to_emails
        
        read -rp "Use TLS? [Y/n]: " use_tls
        use_tls=${use_tls:-Y}
        
        # Save to .env
        cat >> "$ENV_FILE" <<EOF

# Email Configuration
SMTP_HOST=$smtp_host
SMTP_PORT=$smtp_port
SMTP_USER=$smtp_user
SMTP_PASS=$smtp_pass
SMTP_FROM=$from_email
SMTP_TO=$to_emails
SMTP_TLS=$([[ "$use_tls" =~ ^[Yy] ]] && echo "true" || echo "false")
EOF
        success "Email configuration saved"
    else
        info "Email configuration skipped"
    fi
}

# Test Discord webhook
test_discord() {
    local webhook_url="$1"
    
    info "Testing Discord webhook..."
    
    local response=$(curl -s -w "\n%{http_code}" -X POST "$webhook_url" \
        -H "Content-Type: application/json" \
        -d '{
            "embeds": [{
                "title": "🔔 Strada.Brain Alert Test",
                "description": "This is a test alert from Strada.Brain alerting system.",
                "color": 3447003,
                "fields": [
                    {"name": "Status", "value": "✅ Configuration successful", "inline": true},
                    {"name": "Time", "value": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'", "inline": true}
                ]
            }]
        }' 2>/dev/null)
    
    local http_code=$(echo "$response" | tail -n1)
    
    if [[ "$http_code" == "204" ]] || [[ "$http_code" == "200" ]]; then
        success "Discord webhook test passed!"
        return 0
    else
        error "Discord webhook test failed (HTTP $http_code)"
        return 1
    fi
}

# Test Slack webhook
test_slack() {
    local webhook_url="$1"
    
    info "Testing Slack webhook..."
    
    local response=$(curl -s -w "\n%{http_code}" -X POST "$webhook_url" \
        -H "Content-Type: application/json" \
        -d '{
            "text": "🔔 Strada.Brain Alert Test",
            "attachments": [{
                "color": "good",
                "fields": [
                    {"title": "Status", "value": "✅ Configuration successful", "short": true},
                    {"title": "Time", "value": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'", "short": true}
                ]
            }]
        }' 2>/dev/null)
    
    local http_code=$(echo "$response" | tail -n1)
    
    if [[ "$http_code" == "200" ]]; then
        success "Slack webhook test passed!"
        return 0
    else
        error "Slack webhook test failed (HTTP $http_code)"
        return 1
    fi
}

# Test Telegram
test_telegram() {
    local bot_token="$1"
    local chat_id="$2"
    
    info "Testing Telegram bot..."
    
    local response=$(curl -s -w "\n%{http_code}" \
        "https://api.telegram.org/bot${bot_token}/sendMessage" \
        -d "chat_id=${chat_id}" \
        -d "text=🔔 Strada.Brain Alert Test%0A%0A✅ Configuration successful%0ATime: $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        2>/dev/null)
    
    local http_code=$(echo "$response" | tail -n1)
    
    if [[ "$http_code" == "200" ]]; then
        success "Telegram test passed!"
        return 0
    else
        error "Telegram test failed (HTTP $http_code)"
        return 1
    fi
}

# Run all tests
test_all() {
    echo
    info "Running webhook tests..."
    echo "─────────────────────────────────────────"
    
    local tests_passed=0
    local tests_failed=0
    
    # Test Discord
    if grep -q "DISCORD_WEBHOOK_URL=" "$ENV_FILE" 2>/dev/null; then
        local discord_url=$(grep "DISCORD_WEBHOOK_URL=" "$ENV_FILE" | cut -d'=' -f2-)
        if [[ -n "$discord_url" ]]; then
            if test_discord "$discord_url"; then
                ((tests_passed++))
            else
                ((tests_failed++))
            fi
        fi
    fi
    
    # Test Slack
    if grep -q "SLACK_WEBHOOK_URL=" "$ENV_FILE" 2>/dev/null; then
        local slack_url=$(grep "SLACK_WEBHOOK_URL=" "$ENV_FILE" | cut -d'=' -f2-)
        if [[ -n "$slack_url" ]]; then
            if test_slack "$slack_url"; then
                ((tests_passed++))
            else
                ((tests_failed++))
            fi
        fi
    fi
    
    # Test Telegram
    if grep -q "TELEGRAM_BOT_TOKEN=" "$ENV_FILE" 2>/dev/null; then
        local bot_token=$(grep "TELEGRAM_BOT_TOKEN=" "$ENV_FILE" | cut -d'=' -f2-)
        local chat_id=$(grep "TELEGRAM_CHAT_ID=" "$ENV_FILE" | cut -d'=' -f2-)
        if [[ -n "$bot_token" && -n "$chat_id" ]]; then
            if test_telegram "$bot_token" "$chat_id"; then
                ((tests_passed++))
            else
                ((tests_failed++))
            fi
        fi
    fi
    
    echo
    if [[ $tests_failed -eq 0 ]]; then
        success "All tests passed! ($tests_passed successful)"
    else
        warning "Some tests failed ($tests_passed passed, $tests_failed failed)"
    fi
}

# Validate configuration
validate_config() {
    echo
    info "Validating configuration..."
    echo "─────────────────────────────────────────"
    
    local has_config=false
    
    if grep -q "DISCORD_WEBHOOK_URL=" "$ENV_FILE" 2>/dev/null; then
        local url=$(grep "DISCORD_WEBHOOK_URL=" "$ENV_FILE" | cut -d'=' -f2-)
        if [[ -n "$url" ]]; then
            success "Discord: Configured"
            has_config=true
        fi
    fi
    
    if grep -q "SLACK_WEBHOOK_URL=" "$ENV_FILE" 2>/dev/null; then
        local url=$(grep "SLACK_WEBHOOK_URL=" "$ENV_FILE" | cut -d'=' -f2-)
        if [[ -n "$url" ]]; then
            success "Slack: Configured"
            has_config=true
        fi
    fi
    
    if grep -q "TELEGRAM_BOT_TOKEN=" "$ENV_FILE" 2>/dev/null; then
        success "Telegram: Configured"
        has_config=true
    fi
    
    if grep -q "SMTP_HOST=" "$ENV_FILE" 2>/dev/null; then
        success "Email: Configured"
        has_config=true
    fi
    
    if [[ "$has_config" == false ]]; then
        warning "No alerting channels configured!"
        return 1
    fi
    
    return 0
}

# Create example alerting config
create_example_config() {
    cat > "$CONFIG_FILE.example" <<'EOF'
{
  "minLevel": "warning",
  "rateLimitSeconds": 300,
  "channels": {
    "discord": true,
    "slack": true,
    "email": true,
    "telegram": true,
    "pagerDuty": false,
    "opsGenie": false,
    "customWebhook": false,
    "console": true
  },
  "monitors": {
    "system": {
      "enabled": true,
      "intervalMs": 60000,
      "thresholds": {
        "cpuPercent": 80,
        "memoryPercent": 85,
        "diskPercent": 85,
        "loadAverage": 4
      }
    },
    "error": {
      "enabled": true,
      "intervalMs": 60000,
      "thresholds": {
        "maxErrorsPerMinute": 10,
        "maxErrorRatePercent": 10,
        "maxConsecutiveErrors": 5
      }
    },
    "security": {
      "enabled": true,
      "intervalMs": 60000,
      "thresholds": {
        "maxFailedLoginsPerMinute": 5,
        "maxSuspiciousRequestsPerMinute": 10,
        "blockDurationMinutes": 30
      }
    },
    "backup": {
      "enabled": true,
      "intervalMs": 300000,
      "thresholds": {
        "maxBackupAgeHours": 25,
        "minBackupSuccessRate": 95
      }
    }
  }
}
EOF
    success "Example config created: $CONFIG_FILE.example"
}

# Main setup flow
main() {
    print_header
    
    check_prerequisites
    
    # Parse arguments
    local test_only=false
    local validate_only=false
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            --test)
                test_only=true
                shift
                ;;
            --validate)
                validate_only=true
                shift
                ;;
            --help|-h)
                echo "Usage: $0 [OPTIONS]"
                echo
                echo "Options:"
                echo "  --test       Run tests only"
                echo "  --validate   Validate configuration only"
                echo "  --help       Show this help"
                echo
                exit 0
                ;;
            *)
                shift
                ;;
        esac
    done
    
    if [[ "$validate_only" == true ]]; then
        validate_config
        exit $?
    fi
    
    if [[ "$test_only" == true ]]; then
        test_all
        exit 0
    fi
    
    # Interactive setup
    echo
    info "Starting interactive setup..."
    echo
    
    setup_discord
    setup_slack
    setup_telegram
    setup_email
    
    # Validate
    validate_config
    
    # Ask to test
    echo
    read -rp "Would you like to test the configured webhooks? [Y/n]: " test_webhooks
    if [[ ! "$test_webhooks" =~ ^[Nn]$ ]]; then
        test_all
    fi
    
    # Create example config
    create_example_config
    
    # Summary
    echo
    success "Alerting setup complete!"
    echo
    info "Configuration saved to: $ENV_FILE"
    info "Example config: $CONFIG_FILE.example"
    echo
    info "To start monitoring, use:"
    echo "  import { getSystemMonitor, getErrorMonitor } from './src/alerting';"
    echo "  getSystemMonitor().start();"
    echo "  getErrorMonitor().start();"
    echo
}

# Handle errors
trap 'error "Setup failed at line $LINENO"' ERR

# Run main
main "$@"
