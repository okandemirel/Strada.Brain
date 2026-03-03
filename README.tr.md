<p align="center">
  <img src="docs/assets/logo.svg" alt="Strada.Brain Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>Unity / Strada.Core Projeleri icin AI Destekli Gelistirme Ajani</strong><br/>
  Telegram, Discord, Slack, WhatsApp veya terminalinize baglanan otonom bir kodlama ajani &mdash; kod tabaninizi okur, kod yazar, derlemeleri calistirir ve hatalarindan ogrenir.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <strong>Türkçe</strong> |
  <a href="README.zh.md">中文</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a>
</p>

---

## Bu Nedir?

Strada.Brain, bir sohbet kanali uzerinden konustugu bir AI ajanidir. Ne istediginizi tanimlarsiniz -- "oyuncu hareketi icin yeni bir ECS sistemi olustur" veya "saglik kullanan tum bilesenleri bul" -- ve ajan C# projenizi okur, kodu yazar, `dotnet build` calistirir, hatalari otomatik olarak duzeltir ve sonucu size gonderir. Kalici hafizasi vardir, gecmis hatalardan ogrenir ve otomatik yedekleme ile birden fazla AI saglayici kullanabilir.

**Bu bir kutuphane veya API degildir.** Calistirdiginiz bagimsiz bir uygulamadir. Sohbet platformunuza baglanir, diskteki Unity projenizi okur ve yapilandirdiginiz sinirlar dahilinde otonom olarak calisir.

---

## Hizli Baslangic

### On Kosullar

- **Node.js 20+** ve npm
- Bir **Anthropic API anahtari** (Claude) -- diger saglayicilar istege baglidir
- **Strada.Core cercevesine sahip bir Unity projesi** (ajana verdiginiz yol)

### 1. Kurulum

```bash
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain
npm install
```

### 2. Yapilandirma

```bash
cp .env.example .env
```

`.env` dosyasini acin ve en azindan asagidakileri ayarlayin:

```env
ANTHROPIC_API_KEY=sk-ant-...      # Claude API anahtariniz
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Assets/ icermeli
JWT_SECRET=<su sekilde olusturun: openssl rand -hex 64>
```

### 3. Calistirma

```bash
# Etkilesimli CLI modu (test etmenin en hizli yolu)
npm run dev -- cli

# Veya bir sohbet kanali ile
npm run dev -- start --channel telegram
npm run dev -- start --channel discord
npm run dev -- start --channel slack
npm run dev -- start --channel whatsapp
```

### 4. Konusmaya Baslayin

Calistiktan sonra, yapilandirilmis kanaliniz uzerinden bir mesaj gonderin:

```
> Proje yapisini analiz et
> "Combat" adinda DamageSystem ve HealthComponent iceren yeni bir modul olustur
> PositionComponent'i sorgulayan tum sistemleri bul
> Derlemeyi calistir ve hatalari duzelt
```

---

## Mimari

```
+-----------------------------------------------------------------+
|  Sohbet Kanallari                                                |
|  Telegram | Discord | Slack | WhatsApp | CLI                    |
+------------------------------+----------------------------------+
                               |
                    IChannelAdapter arayuzu
                               |
+------------------------------v----------------------------------+
|  Orkestrator (Ajan Dongusu)                                      |
|  Sistem istemi + Hafiza + RAG baglami -> LLM -> Arac cagrilari   |
|  Mesaj basina 50 arac yinelemesine kadar                         |
|  Ozerklik: hata kurtarma, durma algilama, derleme dogrulama      |
+------------------------------+----------------------------------+
                               |
          +--------------------+--------------------+
          |                    |                    |
+---------v------+  +---------v------+  +----------v---------+
| AI Saglayicilar|  | 30+ Arac       |  | Baglam Kaynaklari  |
| Claude (birincl|  | Dosya I/O      |  | Hafiza (TF-IDF)    |
| OpenAI, Kimi   |  | Git islemleri  |  | RAG (HNSW vektorler|
| DeepSeek, Qwen |  | Kabuk calistirm|  | Proje analizi      |
| MiniMax, Groq  |  | .NET derleme/te|  | Ogrenme kaliplari  |
| Ollama (yerel) |  | Tarayici       |  +--------------------+
| + 4 fazlasi    |  | Strata kod ure |
+----------------+  +----------------+
```

### Ajan Dongusu Nasil Calisir

1. **Mesaj gelir** -- bir sohbet kanalindan
2. **Hafiza getirme** -- en alakali 3 gecmis konusmayi bulur (TF-IDF)
3. **RAG getirme** -- C# kod tabaniniz uzerinde semantik arama (HNSW vektorleri, en iyi 6 sonuc)
4. **Onbellekli analiz** -- daha once analiz edilmisse proje yapisini enjekte eder
5. **LLM cagrisi** -- sistem istemi + baglam + arac tanimlari ile
6. **Arac yurutme** -- LLM arac cagirirsa, calistirilir ve sonuclar LLM'e geri beslenir
7. **Ozerklik kontrolleri** -- hata kurtarma basarisizliklari analiz eder, durma algalayici takilirsa uyarir, oto-dogrulama `.cs` dosyalari degistirildiyse yanit vermeden once `dotnet build` zorlar
8. **Tekrar** -- LLM nihai bir metin yaniti uretemye kadar 50 yinelemeye kadar
9. **Yanit gonderilir** -- kanal uzerinden kullaniciya (destekleniyorsa akis halinde)

---

## Yapilandirma Referansi

Tum yapilandirma ortam degiskenleri araciligiyla yapilir. Tam liste icin `.env.example` dosyasina bakin.

### Zorunlu

| Degisken | Aciklama |
|----------|----------|
| `ANTHROPIC_API_KEY` | Claude API anahtari (birincil LLM saglayici) |
| `UNITY_PROJECT_PATH` | Unity proje kokunuzun mutlak yolu (`Assets/` icermeli) |
| `JWT_SECRET` | JWT imzalama icin gizli anahtar. Olusturun: `openssl rand -hex 64` |

### AI Saglayicilari

OpenAI uyumlu herhangi bir saglayici calisir. Asagidaki tum saglayicilar zaten uygulanmistir ve etkinlestirmek icin yalnizca bir API anahtari gerektirir.

| Degisken | Saglayici | Varsayilan Model |
|----------|-----------|------------------|
| `ANTHROPIC_API_KEY` | Claude (birincil) | `claude-sonnet-4-20250514` |
| `OPENAI_API_KEY` | OpenAI | `gpt-4o` |
| `DEEPSEEK_API_KEY` | DeepSeek | `deepseek-chat` |
| `GROQ_API_KEY` | Groq | `llama-3.3-70b-versatile` |
| `QWEN_API_KEY` | Alibaba Qwen | `qwen-plus` |
| `KIMI_API_KEY` | Moonshot Kimi | `moonshot-v1-8k` |
| `MINIMAX_API_KEY` | MiniMax | `abab6.5s-chat` |
| `MISTRAL_API_KEY` | Mistral AI | `mistral-large-latest` |
| `TOGETHER_API_KEY` | Together AI | `meta-llama/Llama-3-70b-chat-hf` |
| `FIREWORKS_API_KEY` | Fireworks AI | `accounts/fireworks/models/llama-v3p1-70b-instruct` |
| `GEMINI_API_KEY` | Google Gemini | `gemini-pro` |
| `OLLAMA_BASE_URL` | Ollama (yerel) | `llama3` |
| `PROVIDER_CHAIN` | Yedekleme sirasi | orn. `claude,kimi,deepseek,ollama` |

**Saglayici zinciri:** `PROVIDER_CHAIN` degiskenini virgule ayrilmis saglayici adlari listesi olarak ayarlayin. Sistem her birini sirayla dener, basarisizlik durumunda siradakine gecer. Ornek: `PROVIDER_CHAIN=kimi,deepseek,claude` once Kimi'yi kullanir, Kimi basarisiz olursa DeepSeek, sonra Claude.

### Sohbet Kanallari

**Telegram:**
| Degisken | Aciklama |
|----------|----------|
| `TELEGRAM_BOT_TOKEN` | @BotFather'dan alinan token |
| `ALLOWED_TELEGRAM_USER_IDS` | Virgule ayrilmis Telegram kullanici kimlikleri (zorunlu, bos ise tumu reddedilir) |

**Discord:**
| Degisken | Aciklama |
|----------|----------|
| `DISCORD_BOT_TOKEN` | Discord bot token'i |
| `DISCORD_CLIENT_ID` | Discord uygulama istemci kimligii |
| `ALLOWED_DISCORD_USER_IDS` | Virgule ayrilmis kullanici kimlikleri (bos ise tumu reddedilir) |
| `ALLOWED_DISCORD_ROLE_IDS` | Rol tabanli erisim icin virgule ayrilmis rol kimlikleri |

**Slack:**
| Degisken | Aciklama |
|----------|----------|
| `SLACK_BOT_TOKEN` | `xoxb-...` Bot token'i |
| `SLACK_APP_TOKEN` | `xapp-...` Uygulama duzeyi token (soket modu icin) |
| `SLACK_SIGNING_SECRET` | Slack uygulamasindan imzalama anahtari |
| `ALLOWED_SLACK_USER_IDS` | Virgule ayrilmis kullanici kimlikleri (**bos ise herkese acik**) |
| `ALLOWED_SLACK_WORKSPACES` | Virgule ayrilmis calisma alani kimlikleri (**bos ise herkese acik**) |

**WhatsApp:**
| Degisken | Aciklama |
|----------|----------|
| `WHATSAPP_SESSION_PATH` | Oturum dosyalari icin dizin (varsayilan: `.whatsapp-session`) |
| `WHATSAPP_ALLOWED_NUMBERS` | Virgule ayrilmis telefon numaralari |

### Ozellikler

| Degisken | Varsayilan | Aciklama |
|----------|------------|----------|
| `RAG_ENABLED` | `true` | C# projeniz uzerinde semantik kod aramasini etkinlestir |
| `EMBEDDING_PROVIDER` | `openai` | Gomme saglayici: `openai` veya `ollama` |
| `MEMORY_ENABLED` | `true` | Kalici konusma hafizasini etkinlestir |
| `MEMORY_DB_PATH` | `.strata-memory` | Hafiza veritabani dosyalari icin dizin |
| `DASHBOARD_ENABLED` | `false` | HTTP izleme panelini etkinlestir |
| `DASHBOARD_PORT` | `3001` | Panel sunucu portu |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | WebSocket gercek zamanli paneli etkinlestir |
| `ENABLE_PROMETHEUS` | `false` | Prometheus metrik ucnoktasini etkinlestir (port 9090) |
| `READ_ONLY_MODE` | `false` | Tum yazma islemlerini engelle |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` veya `debug` |

### Hiz Sinirlamasi

| Degisken | Varsayilan | Aciklama |
|----------|------------|----------|
| `RATE_LIMIT_ENABLED` | `false` | Hiz sinirlamasini etkinlestir |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | `0` | Kullanici basina dakikalik mesaj limiti (0 = sinirsiz) |
| `RATE_LIMIT_MESSAGES_PER_HOUR` | `0` | Kullanici basina saatlik limit |
| `RATE_LIMIT_TOKENS_PER_DAY` | `0` | Genel gunluk token kotasi |
| `RATE_LIMIT_DAILY_BUDGET_USD` | `0` | USD cinsinden gunluk harcama limiti |
| `RATE_LIMIT_MONTHLY_BUDGET_USD` | `0` | USD cinsinden aylik harcama limiti |

### Guvenlik

| Degisken | Varsayilan | Aciklama |
|----------|------------|----------|
| `REQUIRE_MFA` | `false` | Cok faktorlu kimlik dogrulamayi zorunlu kil |
| `BROWSER_HEADLESS` | `true` | Tarayici otomasyonunu arayuzsuz calistir |
| `BROWSER_MAX_CONCURRENT` | `5` | Maksimum es zamanli tarayici oturumu |

---

## Araclar

Ajan, kategorilere gore duzenlenmis 30'dan fazla yerlesik araca sahiptir:

### Dosya Islemleri
| Arac | Aciklama |
|------|----------|
| `file_read` | Satir numaralari, ofset/limit sayfalama ile dosya okuma (512KB limit) |
| `file_write` | Dosya olusturma veya ustune yazma (256KB limit, dizinleri otomatik olusturur) |
| `file_edit` | Benzersizlik zorunlulugu ile bul-ve-degistir duzenleme |
| `file_delete` | Tek bir dosyayi silme |
| `file_rename` | Proje icinde dosya yeniden adlandirma veya tasima |
| `file_delete_directory` | Tekrarli dizin silme (50 dosya guvenlik siniri) |

### Arama
| Arac | Aciklama |
|------|----------|
| `glob_search` | Glob deseni ile dosya bulma (maksimum 50 sonuc) |
| `grep_search` | Dosyalar arasi regex icerik aramasi (maksimum 20 eslesme) |
| `list_directory` | Dosya boyutlari ile dizin listeleme |
| `code_search` | RAG uzerinden semantik/vektor arama -- dogal dil sorgulari |
| `memory_search` | Kalici konusma hafizasinda arama |

### Strada Kod Uretimi
| Arac | Aciklama |
|------|----------|
| `strata_analyze_project` | Tam C# proje taramasi -- moduller, sistemler, bilesenler, servisler |
| `strata_create_module` | Tam modul iskelesi olusturma (`.asmdef`, yapilandirma, dizinler) |
| `strata_create_component` | Alan tanimlari ile ECS bilesen struct'lari olusturma |
| `strata_create_mediator` | Bilesen baglantilari ile `EntityMediator<TView>` olusturma |
| `strata_create_system` | `SystemBase`/`JobSystemBase`/`SystemGroup` olusturma |

### Git
| Arac | Aciklama |
|------|----------|
| `git_status` | Calisma agaci durumu |
| `git_diff` | Degisiklikleri gosterme |
| `git_log` | Commit gecmisi |
| `git_commit` | Hazirlama ve commit |
| `git_push` | Uzak depoya gonderme |
| `git_branch` | Dal listeleme, olusturma veya gecis yapma |
| `git_stash` | Stash'a gonderme, cikarma, listeleme veya silme |

### .NET / Unity
| Arac | Aciklama |
|------|----------|
| `dotnet_build` | `dotnet build` calistirma, MSBuild hatalarini yapilandirilmis ciktiya donusturme |
| `dotnet_test` | `dotnet test` calistirma, basarili/basarisiz/atlanan sonuclari ayristirma |

### Diger
| Arac | Aciklama |
|------|----------|
| `shell_exec` | Kabuk komutlari calistirma (30sn zaman asimi, tehlikeli komut engelleme listesi) |
| `code_quality` | Dosya bazinda veya proje bazinda kod kalitesi analizi |
| `rag_index` | Artimli veya tam proje yeniden indekslemesini tetikleme |

---

## Kanal Yetenekleri

| Yetenek | Telegram | Discord | Slack | WhatsApp | CLI |
|---------|----------|---------|-------|----------|-----|
| Metin mesajlasma | Evet | Evet | Evet | Evet | Evet |
| Akis (yerinde duzenleme) | Evet | Evet | Evet | Evet | Evet |
| Yazma gostergesi | Evet | Evet | Islemsiz | Evet | Hayir |
| Onay diyaloglari | Evet (satirici klavye) | Evet (butonlar) | Evet (Block Kit) | Evet (numarali yanit) | Evet (readline) |
| Dosya yukleme | Hayir | Hayir | Evet | Evet | Hayir |
| Konu destegi | Hayir | Evet | Evet | Hayir | Hayir |
| Hiz sinirlamasi (giden) | Hayir | Evet (token bucket) | Evet (4 katmanli kayar pencere) | Satirici kisitlama | Hayir |

### Akis

Tum kanallar yerinde duzenleme akisi uygular. Ajanin yaniti, LLM urettikce asama asama gorunur. Guncellemeler, hiz sinirlarini asmamak icin platforma gore kisitlanir (WhatsApp/Discord: 1/sn, Slack: 2/sn).

### Kimlik Dogrulama

- **Telegram**: Varsayilan olarak tumu reddeder. `ALLOWED_TELEGRAM_USER_IDS` ayarlanmalidir.
- **Discord**: Varsayilan olarak tumu reddeder. `ALLOWED_DISCORD_USER_IDS` veya `ALLOWED_DISCORD_ROLE_IDS` ayarlanmalidir.
- **Slack**: **Varsayilan olarak herkese aciktir.** `ALLOWED_SLACK_USER_IDS` bos ise, herhangi bir Slack kullanicisi bota erisebilir. Uretim icin izin listesini ayarlayin.
- **WhatsApp**: Adaptorde yerel olarak kontrol edilen `WHATSAPP_ALLOWED_NUMBERS` izin listesini kullanir.

---

## Hafiza Sistemi

Uretim hafiza arka ucu `FileMemoryManager`'dir -- arama icin TF-IDF metin indeksleme ile JSON dosyalari.

**Nasil calisir:**
- Oturum gecmisi 40 mesaji astiginda, eski mesajlar ozetlenir ve konusma kayitlari olarak saklanir
- Ajan, her LLM cagrisindan once otomatik olarak en alakali 3 hafizayi getirir
- `strata_analyze_project` araci, aninda baglam enjeksiyonu icin proje yapisi analizini onbellege alir
- Hafiza, `MEMORY_DB_PATH` dizininde (varsayilan: `.strata-memory/`) yeniden baslatmalar arasinda kalicidir

**Gelismis arka uc (uygulanmis, henuz baglanmamis):** SQLite + HNSW vektor arama ile `AgentDBMemory`, uc katmanli hafiza (calisma/gecici/kalici), hibrit getirme (%70 semantik + %30 TF-IDF). Bu tamamen kodlanmistir ancak baslatma surecinde baglanmamistir -- `FileMemoryManager` aktif arka uctur.

---

## RAG Boru Hatti

RAG (Retrieval-Augmented Generation -- Getirme ile Zenginlestirilmis Uretim) boru hatti, semantik arama icin C# kaynak kodunuzu indeksler.

**Indeksleme akisi:**
1. Unity projenizde `**/*.cs` dosyalarini tarar
2. Kodu yapisal olarak parcalar -- dosya baslikari, siniflar, metodlar, yapilandiricilar
3. OpenAI (`text-embedding-3-small`) veya Ollama (`nomic-embed-text`) ile gomme vektorleri olusturur
4. Hizli yaklasik en yakin komsu aramasi icin vektorleri HNSW indeksinde saklar
5. Baslangitta otomatik olarak calisir (arka planda, engellemesiz)

**Arama akisi:**
1. Sorgu ayni saglayici kullanilarak gomulur
2. HNSW aramasi `topK * 3` aday dondurur
3. Yeniden siralayici puanlar: vektor benzerligi (%60) + anahtar kelime eslesmesi (%25) + yapisal bonus (%15)
4. En iyi 6 sonuc (0.2 puanin uzerinde) LLM baglamina enjekte edilir

**Not:** RAG boru hatti su anda yalnizca C# dosyalarini destekler. Parcalayici C#'a ozeldir.

---

## Ogrenme Sistemi

Ogrenme sistemi ajan davranisini gozlemler ve hatalardan ogrenir:

- **Hata kaliplari** tam metin arama indekslemesi ile yakalanir
- **Cozumler** gelecekte getirme icin hata kaliplarina baglanir
- **Icguduler** Bayesian guven puanlari ile atomik ogrenilmis davranislardir
- **Yollar** sonuclari ile arac cagrisi dizilerini kaydeder
- Guven puanlari istatistiksel gecerlilik icin **Elo degerlendirmesi** ve **Wilson puan araliklari** kullanir
- 0.3 guvenin altindaki icguduler kullanim disi birakilir; 0.9 uzeri terfi icin onerilir

Ogrenme boru hatti zamanlayicilarla calisir: her 5 dakikada kalip algilama, her saatte evrim onerileri. Veriler ayri bir SQLite veritabaninda (`learning.db`) saklanir.

---

## Guvenlik

### Katman 1: Kanal Kimlik Dogrulamasi
Mesaj gelisinde (herhangi bir islemden once) kontrol edilen platforma ozel izin listeleri.

### Katman 2: Hiz Sinirlamasi
Kullanici basina kayar pencere (dakika/saat) + genel gunluk/aylik token ve USD butce sinirlari.

### Katman 3: Yol Korumasi
Her dosya islemi sembolik baglantilari cozer ve yolun proje koku icinde kaldigini dogrular. 30'dan fazla hassas desen engellenir (`.env`, `.git/credentials`, SSH anahtarlari, sertifikalar, `node_modules/`).

### Katman 4: Gizli Bilgi Temizleyici
24 regex deseni, tum arac ciktilarinda kimlik bilgilerini LLM'e ulasmadan once tespit eder ve maskeler. Kapsar: OpenAI anahtarlari, GitHub token'lari, Slack/Discord/Telegram token'lari, AWS anahtarlari, JWT'ler, Bearer kimlik dogrulama, PEM anahtarlari, veritabani URL'leri ve genel gizli bilgi desenleri.

### Katman 5: Salt Okunur Mod
`READ_ONLY_MODE=true` oldugunda, 23 yazma araci ajanin arac listesinden tamamen kaldirilir -- LLM bunlari cagirmayi bile deneyemez.

### Katman 6: Islem Onayi
Yazma islemleri (dosya yazma, git commit, kabuk calistirma) kanalin etkilesimli arayuzu (butonlar, satirici klavyeler, metin istemleri) araciligiyla kullanici onayi gerektirebilir.

### Katman 7: Arac Ciktisi Temizleme
Tum arac sonuclari 8192 karakter ile sinirlandirilir ve LLM'e geri beslenmeden once API anahtari desenleri icin taranir.

### Katman 8: RBAC (Dahili)
9 kaynak turunu kapsayan izin matrisi ile 5 rol (superadmin, admin, developer, viewer, service). Politika motoru zaman tabanli, IP tabanli ve ozel kosullari destekler.

---

## Panel ve Izleme

### HTTP Paneli (`DASHBOARD_ENABLED=true`)
`http://localhost:3001` adresinden erisilebilir (yalnizca localhost). Gosterir: calisma suresi, mesaj sayisi, token kullanimi, aktif oturumlar, arac kullanim tablosu, guvenlik istatistikleri. Her 3 saniyede otomatik yenilenir.

### Saglik Uc Noktalari
- `GET /health` -- Canlilik probu (`{"status":"ok"}`)
- `GET /ready` -- Derin hazirlik: hafiza ve kanal sagligini kontrol eder. 200 (hazir), 207 (dusuk performans) veya 503 (hazir degil) dondurur

### Prometheus (`ENABLE_PROMETHEUS=true`)
`http://localhost:9090/metrics` adresinde metrikler. Mesajlar, arac cagrilari, token'lar icin sayaclar. Istek suresi, arac suresi, LLM gecikmesi icin histogramlar. Varsayilan Node.js metrikleri (CPU, heap, GC, olay dongusu).

### WebSocket Paneli (`ENABLE_WEBSOCKET_DASHBOARD=true`)
Her saniye gonderilen gercek zamanli metrikler. Kimlik dogrulanmis baglantilari ve uzak komutlari (eklenti yeniden yukleme, onbellek temizleme, log alma) destekler.

---

## Dagitim

### Docker

```bash
docker-compose up -d
```

`docker-compose.yml` uygulamayi, izleme yiginini ve nginx ters proxy'yi icerir.

### Daemon Modu

```bash
# Cokme durumunda ustel geri cekilme ile otomatik yeniden baslatma (1sn - 60sn, 10 yeniden baslatmaya kadar)
node dist/index.js daemon --channel telegram
```

### Uretim Kontrol Listesi

- [ ] `NODE_ENV=production` ayarlayin
- [ ] `LOG_LEVEL=warn` veya `error` ayarlayin
- [ ] Butce sinirlari ile `RATE_LIMIT_ENABLED=true` yapilandirin
- [ ] Kanal izin listelerini ayarlayin (ozellikle Slack -- varsayilan olarak acik)
- [ ] Yalnizca guvenli kesif istiyorsaniz `READ_ONLY_MODE=true` ayarlayin
- [ ] Izleme icin `DASHBOARD_ENABLED=true` etkinlestirin
- [ ] Metrik toplama icin `ENABLE_PROMETHEUS=true` etkinlestirin
- [ ] Guclu bir `JWT_SECRET` olusturun

---

## Test

```bash
npm test                         # Tum 1560+ testi calistir
npm run test:watch               # Izleme modu
npm test -- --coverage           # Kapsam ile
npm test -- src/agents/tools/file-read.test.ts  # Tekli dosya
npm run typecheck                # TypeScript tip kontrolu
npm run lint                     # ESLint
```

94 test dosyasi kapsam alani: ajanlar, kanallar, guvenlik, RAG, hafiza, ogrenme, panel, entegrasyon akislari.

---

## Proje Yapisi

```
src/
  index.ts              # CLI giris noktasi (Commander.js)
  core/
    bootstrap.ts        # Tam baslatma sirasi -- tum baglantiler burada yapilir
    di-container.ts     # DI konteyneri (mevcut ama manuel baglanti baskin)
    tool-registry.ts    # Arac ornekleme ve kayit
  agents/
    orchestrator.ts     # Cekirdek ajan dongusu, oturum yonetimi, akis
    autonomy/           # Hata kurtarma, gorev planlama, oto-dogrulama
    context/            # Sistem istemi (Strada.Core bilgi tabanli)
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq, + dahasi
    tools/              # 30+ arac uygulamasi
    plugins/            # Harici eklenti yukleyici
  channels/
    telegram/           # Grammy tabanli bot
    discord/            # discord.js bot, slash komutlari ile
    slack/              # Slack Bolt (soket modu) Block Kit ile
    whatsapp/           # Baileys tabanli istemci, oturum yonetimi ile
    cli/                # Readline REPL
  memory/
    file-memory-manager.ts   # Aktif arka uc: JSON + TF-IDF
    unified/                 # AgentDB arka ucu: SQLite + HNSW (henuz baglanmamis)
  rag/
    rag-pipeline.ts     # Indeksleme + arama + bicimlendirme orkestrasyonu
    chunker.ts          # C#'a ozel yapisal parcalama
    hnsw/               # HNSW vektor deposu (hnswlib-node)
    embeddings/         # OpenAI ve Ollama gomme saglayicilari
    reranker.ts         # Agirlikli yeniden siralama (vektor + anahtar kelime + yapisal)
  security/             # Kimlik dogrulama, RBAC, yol korumasi, hiz sinirlamasi, gizli bilgi temizleyici
  learning/             # Kalip esleme, guven puanlama, icgudu yasam dongusu
  intelligence/         # C# ayristirma, proje analizi, kod kalitesi
  dashboard/            # HTTP, WebSocket, Prometheus panelleri
  config/               # Zod ile dogrulanmis ortam yapilandirmasi
  validation/           # Girdi dogrulama semalari
```

---

## Katki

Gelistirme kurulumu, kod kurallari ve PR yonergeleri icin [CONTRIBUTING.md](CONTRIBUTING.md) dosyasina bakin.

---

## Lisans

MIT Lisansi - detaylar icin [LICENSE](LICENSE) dosyasina bakin.
