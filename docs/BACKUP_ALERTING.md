# Backup & Alerting Sistemleri

Strata.Brain için kapsamlı backup ve alerting altyapısı.

## 📁 Dizin Yapısı

```
scripts/
├── backup.sh              # Bash backup script
├── setup-alerts.sh        # Alerting kurulum scripti
└── backup-scheduler.js    # Docker için JS scheduler

src/
├── backup/
│   ├── backup-scheduler.ts    # Node.js backup scheduler
│   └── backup-scheduler.test.ts
│
└── alerting/
    ├── types.ts                 # Alerting tip tanımları
    ├── alert-manager.ts         # Çok kanallı alert yönetimi
    ├── alert-manager.test.ts
    ├── index.ts                 # Ana export
    └── monitors/
        ├── system-monitor.ts    # CPU, memory, disk izleme
        ├── error-monitor.ts     # Hata oranı izleme
        ├── security-monitor.ts  # Güvenlik olayları izleme
        └── backup-monitor.ts    # Backup durumu izleme
```

## 🔧 Backup Sistemi

### Özellikler

- **SQLite Learning DB backup**: `.strata-memory/learning.db`
- **RAG Vector Store backup**: `vectors.bin`, `chunks.json`
- **HNSW Index backup**: `hnsw.index`, `hnsw.meta.json`
- **Config backup**: `.env.example`, `package.json`, vb.
- **Session memory backup**: Text index, reasoning bank
- **Otomatik compress**: `tar.gz` formatında
- **Checksum doğrulama**: SHA256
- **Retention policy**: Son N yedek tutma
- **Remote sync**: S3, MinIO, rclone desteği

### Kullanım

#### 1. Manuel Backup

```bash
./scripts/backup.sh
```

#### 2. Node.js Scheduler

```typescript
import { BackupScheduler, Schedule, getBackupScheduler } from './src/backup/backup-scheduler.js';

const scheduler = new BackupScheduler({
    backupDir: '/backups/strata-brain',
    retentionDays: 30,
    verifyBackups: true,
});

// Job ekleme
scheduler.addJob({
    name: 'Daily Backup',
    schedule: Schedule.DAILY,  // '0 2 * * *'
    command: './scripts/backup.sh',
});

// Scheduler'ı başlat
scheduler.start(60000);  // Her dakika kontrol

// Durum kontrolü
console.log(scheduler.getStatus());
```

#### 3. Docker Compose

```bash
# Backup servisini başlat
docker-compose -f docker-compose.backup.yml up -d backup

# MinIO ile birlikte
docker-compose -f docker-compose.backup.yml --profile minio up -d
```

#### 4. Environment Variables

```bash
# Backup konfigürasyonu
BACKUP_DIR=/backups/strata-brain
RETENTION_DAYS=30
KEEP_COUNT=30

# Schedule (cron format)
BACKUP_SCHEDULE=0 2 * * *

# S3/MinIO
AWS_S3_BUCKET=my-bucket
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx
AWS_ENDPOINT_URL=https://s3.amazonaws.com

# MinIO specific
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=strata-backups
```

## 🚨 Alerting Sistemi

### Özellikler

- **Discord**: Rich embeds, @mention for critical
- **Slack**: Attachment formatında alert'ler
- **Email**: SMTP desteği, HTML format
- **Telegram**: Markdown format
- **PagerDuty**: Incident management
- **OpsGenie**: Alert routing
- **Custom Webhook**: Generic HTTP POST
- **Console**: Geliştirme ortamı için

### Kurulum

```bash
./scripts/setup-alerts.sh
```

Interaktif kurulum:
- Discord webhook yapılandırma
- Slack webhook yapılandırma
- Telegram bot/token yapılandırma
- Email SMTP yapılandırma
- Webhook test etme

### Kullanım

#### Alert Manager

```typescript
import { AlertManager, getAlertManager } from './src/alerting/index.js';

const alertManager = new AlertManager({
    discordWebhook: process.env.DISCORD_WEBHOOK_URL,
    slackWebhook: process.env.SLACK_WEBHOOK_URL,
    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
    },
    minLevel: 'warning',  // info, warning, critical
    rateLimitSeconds: 300,
});

// Alert gönderme
await alertManager.sendAlert(
    'critical',
    'System Down',
    'Database connection failed',
    { 
        source: 'database',
        error: 'Connection timeout',
        retryCount: 3
    }
);

// Alert geçmişi
const history = alertManager.getHistory({ level: 'critical', limit: 10 });

// İstatistikler
const stats = alertManager.getStats();
```

#### System Monitor

```typescript
import { getSystemMonitor } from './src/alerting/index.js';

const monitor = getSystemMonitor({
    cpuPercent: 80,
    memoryPercent: 85,
    diskPercent: 85,
    loadAverage: 4,
});

monitor.start();

// Durum kontrolü
console.log(monitor.getStatus());

// Metrik geçmişi
const history = monitor.getMetricsHistory(60);  // Son 60 dakika
const avg = monitor.getAverageMetrics(5);       // Son 5 dakika ortalama
```

**Alert Türleri:**
- High CPU Usage (>80%)
- High Memory Usage (>85%)
- Low Disk Space (<15% free)
- High Load Average (normalized > 4)

#### Error Monitor

```typescript
import { getErrorMonitor } from './src/alerting/index.js';

const monitor = getErrorMonitor({
    maxErrorsPerMinute: 10,
    maxConsecutiveErrors: 5,
});

monitor.start();

// Manuel hata kaydı
monitor.recordError(new Error('Something failed'), 'my-component');

// Fonksiyon izleme
const result = monitor.trackFunction(
    () => riskyOperation(),
    'riskyOperation'
);

// API çağrısı izleme
monitor.trackAPICall(
    response.ok,
    '/api/users',
    response.ok ? undefined : new Error('API Error')
);

// Async fonksiyon izleme
const data = await monitor.trackAsyncFunction(
    async () => fetchData(),
    'fetchData'
);
```

#### Security Monitor

```typescript
import { getSecurityMonitor } from './src/alerting/index.js';

const monitor = getSecurityMonitor({
    maxFailedLoginsPerMinute: 5,
    maxSuspiciousRequestsPerMinute: 10,
    blockDurationMinutes: 30,
});

monitor.start();

// Auth başarısızlığı kaydı
monitor.recordAuthFailure(ip, { 
    userId: 'user123',
    username: 'john',
    reason: 'Invalid password'
});

// Yetkisiz erişim kaydı
monitor.recordUnauthorizedAccess(ip, {
    userId: 'user123',
    resource: '/admin/settings',
    action: 'write'
});

// Şüpheli istek kaydı
monitor.recordSuspiciousRequest(ip, {
    type: 'sql_injection',
    path: '/api/users',
    details: 'Detected UNION SELECT'
});

// Rate limit kaydı
monitor.recordRateLimitExceeded(ip, {
    endpoint: '/api/login',
    limit: 10,
    window: '1m'
});

// IP engelleme kontrolü
if (monitor.isBlocked(clientIP)) {
    return res.status(403).send('Blocked');
}

// Manuel IP engelleme
monitor.blockIP(ip, 'Suspicious activity', 60);
```

**Otomatik Algılanan Durumlar:**
- Brute force attacks (5+ failed logins/min)
- Privilege escalation attempts
- SQL injection attempts
- XSS attempts
- Rate limit violations
- Suspicious IP activity

#### Backup Monitor

```typescript
import { getBackupMonitor } from './src/alerting/index.js';

const monitor = getBackupMonitor('/backups/strata-brain', {
    maxBackupAgeHours: 25,
    minBackupSuccessRate: 95,
});

monitor.start();

// Backup kaydı
monitor.recordBackup('backup_20240115_020000.tar.gz', 'success', {
    size: 1024 * 1024 * 100,
    checksum: 'sha256:abc123...',
    duration: 120,
});

// Backup doğrulama
await monitor.verifyBackup(backupId);

// Zamanlanmış backup
monitor.scheduleBackup('Hourly Backup', '0 * * * *');

// Durum kontrolü
console.log(monitor.getStatus());
console.log(monitor.getStats(24));  // Son 24 saat
```

**Alert Türleri:**
- Backup failed
- Backup verification failed
- Stale backup (>25 hours old)
- Low success rate (<95%)
- Missed scheduled backup

### Tüm Monitörleri Başlatma

```typescript
import { 
    getSystemMonitor, 
    getErrorMonitor, 
    getSecurityMonitor, 
    getBackupMonitor 
} from './src/alerting/index.js';

// Tüm monitörleri başlat
getSystemMonitor().start();
getErrorMonitor().start();
getSecurityMonitor().start();
getBackupMonitor().start();

// Uygulama kapanırken
dprocess.on('SIGTERM', () => {
    getSystemMonitor().stop();
    getErrorMonitor().stop();
    getSecurityMonitor().stop();
    getBackupMonitor().stop();
});
```

## 📊 Alert Seviyeleri

| Seviye | Renk | Kullanım | Discord @mention |
|--------|------|----------|------------------|
| info | Mavi | Bilgilendirme | Hayır |
| warning | Sarı | Dikkat gerektiren | Hayır |
| critical | Kırmızı | Acil müdahale | Evet |

## 🔒 Güvenlik

- Webhook URL'leri environment variable'dan alınır
- Sensitive bilgiler loglanmaz
- IP blocking ile otomatik koruma
- Rate limiting ile alert spam'ini önleme

## 🧪 Test

```bash
# Tüm testleri çalıştır
npm test -- --run src/alerting src/backup

# Sadece alert manager
npm test -- --run src/alerting/alert-manager.test.ts

# Sadece backup scheduler
npm test -- --run src/backup/backup-scheduler.test.ts
```

## 📈 Monitoring Dashboard

Metrikler ve alert geçmişi için Prometheus entegrasyonu:

```yaml
# docker-compose.backup.yml içinde
backup-metrics:
  image: prom/node-exporter:latest
  volumes:
    - backup-data:/backups:ro
```
