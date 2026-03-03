<p align="center">
  <img src="docs/assets/logo.svg" alt="Strata.Brain Logo" width="200"/>
</p>

<h1 align="center">🧠 Strata.Brain</h1>

<p align="center">
  <strong>AI Destekli Unity Geliştirme Asistanı</strong><br/>
  Strata.Core iş akışlarınızı akıllı kod üretimi, analiz ve çok kanallı işbirliği ile otomatikleştirin.
</p>

<p align="center">
  <a href="https://github.com/yourusername/strata-brain/releases"><img src="https://img.shields.io/github/v/release/yourusername/strata-brain?style=flat-square&color=blue" alt="Release"></a>
  <a href="https://github.com/yourusername/strata-brain/actions"><img src="https://img.shields.io/github/actions/workflow/status/yourusername/strata-brain/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/test-600%2B-green?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/kapsama-85%25-brightgreen?style=flat-square" alt="Coverage">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
</p>

<p align="center">
  <a href="README.md">English</a> •
  <a href="README.zh.md">中文</a> •
  <a href="README.ja.md">日本語</a> •
  <a href="README.ko.md">한국어</a> •
  <a href="README.de.md">Deutsch</a> •
  <a href="README.es.md">Español</a> •
  <a href="README.fr.md">Français</a>
</p>

---

## ✨ Özellikler

### 🤖 AI Destekli Geliştirme
- **Akıllı Kod Üretimi** - Modül, Sistem, Bileşen ve Mediatör'leri otomatik oluşturur
- **Semantik Kod Arama** - HNSW vektör araması ile 150x daha hızlı (brute-force'a göre)
- **Experience Replay Öğrenimi** - Geçmiş etkileşimlerden öğrenerek sürekli gelişir
- **Çoklu AI Sağlayıcı** - Claude, OpenAI, DeepSeek, Groq ve 10+ uyumlu sağlayıcı

### 💬 Çok Kanallı Destek
Strata.Brain ile favori platformunuz üzerinden iletişim kurun:
- **Telegram** - Mobil öncelikli, her yerde geliştirme
- **Discord** - Zengin embed'lerle takım işbirliği
- **Slack** - Kurumsal iş akışı entegrasyonu
- **WhatsApp** - Hızlı düzeltmeler ve durum kontrolü
- **CLI** - Doğrudan terminal erişimi

### 🎮 Unity/Strata.Core Entegrasyonu
- **Proje Analizi** - Tüm kod tabanı yapısını haritalar
- **Build Otomasyonu** - Derleme hatalarını otomatik düzeltir
- **Kod Kalitesi** - Strata.Core kalıplarını ve en iyi pratikleri zorunlu kılar
- **Mimari Görselleştirme** - Karmaşık sistemleri anında anlayın

### 🔒 Kurumsal Güvenlik
- **RBAC** - Rol tabanlı erişim kontrolü (5 rol, 14 kaynak türü)
- **Secret Maskeleme** - 18 desen türü otomatik maskeleme
- **Audit Log** - Tam etkinlik takibi
- **Salt Okunur Mod** - Değişiklik yapmadan güvenli keşif

### 📊 İzleme ve Operasyon
- **Gerçek Zamanlı Dashboard** - WebSocket destekli canlı metrikler
- **Prometheus Entegrasyonu** - Metrikleri stack'inize aktarın
- **Akıllı Uyarı** - Discord, Slack, E-posta, Telegram, PagerDuty
- **Otomatik Yedekleme** - Zamanlanmış + talep üzerine yedekleme

---

## 🚀 Hızlı Başlangıç

### Gereksinimler
- Node.js >= 20.0.0
- Strata.Core kullanan Unity projesi
- ANTHROPIC_API_KEY (veya başka bir AI sağlayıcı anahtarı)

### Kurulum

```bash
# Depoyu klonlayın
git clone https://github.com/yourusername/strata-brain.git
cd strata-brain

# Bağımlılıkları yükleyin
npm install

# Ortamı yapılandırın
cp .env.example .env
# .env dosyasını ayarlarınızla düzenleyin

# Geliştirmeyi başlatın
npm run dev
```

### Docker (Üretim için Önerilir)

```bash
# Tek komutla dağıtım
./scripts/deploy.sh

# Veya manuel olarak
docker-compose up -d
```

---

## 📖 Kullanım Örnekleri

### Yeni Modül Oluşturma

**Telegram:**
```
@StrataBrain eşya, slot ve ağırlık sistemi içeren bir Envanter modülü oluştur
```

**Discord:**
```
!create-module PlayerStats Health, Mana, Stamina özellikleriyle
```

**CLI:**
```bash
npm run cli -- create-module EnemyAI patrol, attack, flee davranışlarıyla
```

### Proje Analizi

```
@StrataBrain projemi analiz et ve savaş sistemi hakkında bilgi ver
```

Yanıt:
```
📊 Proje Analizi

Savaş Sistemi konumu:
├── 📁 Modules/Combat/
│   ├── CombatModule.cs (giriş noktası)
│   ├── Systems/
│   │   ├── DamageSystem.cs (hasar uygula)
│   │   └── CombatStateSystem.cs (durum yönetimi)
│   └── Components/
│       ├── HealthComponent.cs
│       └── AttackComponent.cs

🔍 Temel İçgörüler:
• Health 3 konumda değiştiriliyor
• Hasar değerlerinde doğrulama yok
• CombatStateSystem'de null kontrolü eksik
```

### Semantik Arama

```
@StrataBrain ara "hasar alındığında oyuncu sağlığı nerede değiştiriliyor"
```

İlgili kod parçaları ve dosya konumlarıyla birlikte saniyeler içinde sonuçlar.

---

## 🏗️ Mimari

```
┌─────────────────────────────────────────┐
│  Sunum Katmanı (5 Kanal)               │
│  Telegram • Discord • Slack • WhatsApp │
├─────────────────────────────────────────┤
│  Orkestrasyon Katmanı                  │
│  Oturum Yöneticisi • Hız Sınırlayıcı   │
│  Özerklik: PLAN-ACT-VERIFY-RESPOND     │
├─────────────────────────────────────────┤
│  Hizmet Katmanı                        │
│  AI Sağlayıcı Zinciri • 25+ Araç       │
│  HNSW Vektör Araması • Öğrenim Sistemi │
├─────────────────────────────────────────┤
│  Altyapı Katmanı                       │
│  DI Konteyner • Güvenlik (RBAC)        │
│  Auth • Yapılandırma • Loglama         │
└─────────────────────────────────────────┘
```

---

## 🧪 Testler

```bash
# Tüm testleri çalıştır
npm test

# Kapsamla çalıştır
npm run test:coverage

# Entegrasyon testlerini çalıştır
npm run test:integration
```

**Test Kapsamı:**
- 600+ birim testi
- 51 entegrasyon testi (E2E)
- 85%+ kod kapsamı

---

## 📚 Dokümantasyon

- [📖 Başlangıç Rehberi](docs/getting-started.tr.md)
- [🏗️ Mimari Genel Bakış](docs/architecture.tr.md)
- [🔧 Yapılandırma Referansı](docs/configuration.tr.md)
- [🔒 Güvenlik Rehberi](docs/security/security-overview.tr.md)
- [🛠️ Araç Geliştirme](docs/tools.tr.md)
- [📊 API Referansı](docs/api.tr.md)

---

## 🛡️ Güvenlik

Strata.Brain kapsamlı güvenlik önlemleri uygular:

- ✅ **OWASP Top 10** uyumluluğu
- ✅ **RBAC** 5 rol ile (superadmin'den viewer'a)
- ✅ **18 Secret Deseni** tespiti ve maskeleme
- ✅ **Path Traversal** koruması
- ✅ **Rate Limiting** bütçe takibi ile
- ✅ **Audit Logging** tüm işlemler için
- ✅ **Pentest Scriptleri** dahil

Detaylar için [Güvenlik Dokümantasyonu](docs/security/security-overview.tr.md)'na bakın.

---

## 🌍 Çok Dilli Destek

Strata.Brain sizin dilinizi konuşur:

| Dil | Dosya | Durum |
|-----|-------|-------|
| 🇺🇸 English | [README.md](README.md) | ✅ Tamamlandı |
| 🇨🇳 中文 | [README.zh.md](README.zh.md) | ✅ Tamamlandı |
| 🇯🇵 日本語 | [README.ja.md](README.ja.md) | ✅ Tamamlandı |
| 🇰🇷 한국어 | [README.ko.md](README.ko.md) | ✅ Tamamlandı |
| 🇹🇷 Türkçe | [README.tr.md](README.tr.md) | ✅ Tamamlandı |
| 🇩🇪 Deutsch | [README.de.md](README.de.md) | ✅ Tamamlandı |
| 🇪🇸 Español | [README.es.md](README.es.md) | ✅ Tamamlandı |
| 🇫🇷 Français | [README.fr.md](README.fr.md) | ✅ Tamamlandı |

---

## 🤝 Katkıda Bulunma

Katkılar memnuniyetle karşılanır! Detaylar için [Katkı Rehberi](CONTRIBUTING.tr.md)'ne bakın.

```bash
# Fork ve klonla
git clone https://github.com/yourusername/strata-brain.git

# Dal oluştur
git checkout -b feature/harika-ozellik

# Değişiklikleri commit'le
git commit -m "Harika özellik ekle"

# Push yap ve PR oluştur
git push origin feature/harika-ozellik
```

---

## 📜 Lisans

MIT Lisansı - detaylar için [LICENSE](LICENSE) dosyasına bakın.

---

## 💖 Teşekkürler

- [Strata.Core](https://github.com/strata/core) - Her şeyi güçlendiren ECS çerçevesi
- [Grammy](https://grammy.dev) - Telegram bot çerçevesi
- [Discord.js](https://discord.js.org) - Discord entegrasyonu
- [HNSWLib](https://github.com/nmslib/hnswlib) - Yüksek performanslı vektör arama

---

<p align="center">
  <strong>🚀 Unity geliştirmenizi hızlandırmaya hazır mısınız?</strong><br/>
  <a href="https://github.com/yourusername/strata-brain/stargazers">⭐ GitHub'da Yıldız Ver</a> •
  <a href="https://twitter.com/stratabrain">🐦 Twitter'da Takip Et</a> •
  <a href="https://discord.gg/stratabrain">💬 Discord'a Katıl</a>
</p>

<p align="center">
  Strata Ekibi tarafından ❤️ ile geliştirildi
</p>
