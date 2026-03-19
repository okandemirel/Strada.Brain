<p align="center">
  <img src="icon/strada-brain-icon.png" alt="Strada.Brain Logosu" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>Unity / Strada.Core Projeleri icin Yapay Zeka Destekli Gelistirme Ajani</strong><br/>
  Web paneline, Telegram, Discord, Slack, WhatsApp veya terminalinize baglanan otonom bir kodlama ajani &mdash; kod tabaninizi okur, kod yazar, derlemeleri calistirir, hatalarindan ogrenir ve 7/24 daemon dongusu ile otonom olarak calisir. Artik coklu ajan orkestrasyonu, gorev delegasyonu, bellek konsolidasyonu, onay kapili dagitim alt sistemi, LLM goruntu destegiyle medya paylasimi, SOUL.md uzerinden yapilandirilabilir kisilik sistemi, control-plane clarification review, gorev bilinclii dinamik gecis ile akilli coklu saglayici yonlendirme, guven tabanli konsensus dogrulamasi, OODA akil yurutme dongusune sahip otonom Agent Core ve Strada.MCP entegrasyonu ile.
</p>

> Ceviri notu: Guncel calisma zamani davranisi, ortam degiskeni varsayilanlari ve guvenlik semantigi icin kanonik kaynak [README.md](README.md) dosyasidir. Bu dosya onun cevirisidir.

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/tests-3300%2B-brightgreen?style=flat-square" alt="Testler">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Lisans">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <strong>T&uuml;rk&ccedil;e</strong> |
  <a href="README.zh.md">&#20013;&#25991;</a> |
  <a href="README.ja.md">&#26085;&#26412;&#35486;</a> |
  <a href="README.ko.md">&#54620;&#44397;&#50612;</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Espa&ntilde;ol</a> |
  <a href="README.fr.md">Fran&ccedil;ais</a>
</p>

---

## Bu Nedir?

Strada.Brain, bir sohbet kanali uzerinden konustugunuz bir yapay zeka ajanidir. Ne istediginizi tanimlayarak -- "oyuncu hareketi icin yeni bir ECS sistemi olustur" veya "saglik kullanan tum bilesenleri bul" -- ajanin C# projenizi okumasini, kodu yazmasini, `dotnet build` calistirmasini, hatalari otomatik olarak duzeltmesini ve sonucu size gondermesini saglayabilirsiniz.

Ajan, SQLite + HNSW vektorler ile desteklenen kalici hafizaya sahiptir; gecmis hatalardan hibrit agirlikli guven puanlamasi ile ogrenir; karmasik hedefleri paralel DAG yurutmesine ayristirir; cok aracli zincirleri saga geri alma destekli olarak otomatik sentezler; ve proaktif tetikleyicilerle 7/24 daemon olarak calisabilir. Kanal bazinda oturum izolasyonlu coklu ajan orkestrasyonunu, ajan seviyeleri arasi hiyerarsik gorev delegasyonunu, otomatik bellek konsolidasyonunu ve insan-dongu-icinde onay kapilari ile devre kesici korumali dagitim alt sistemini destekler.

Bu surumde yeni: Strada.Brain artik bir **Agent Core** iceriyor -- cevrevi (dosya degisiklikleri, git durumu, derleme sonuclari) gozlemleyen, ogrenilmis kaliplari kullanarak oncelikler hakkinda akil yuruten ve proaktif olarak eyleme gecen otonom bir OODA akil yurutme motoru. **Coklu saglayici yonlendirme** sistemi, her gorev tipi (planlama, kod uretimi, hata ayiklama, inceleme) icin yapilandirilabilir on ayarlarla (budget/balanced/performance) en iyi AI saglayiciyi dinamik olarak secer. **Guven tabanli konsensus** sistemi, ajanin guveni dusuk oldugunda otomatik olarak farkli bir saglayicidan ikinci bir gorus alir ve kritik islemlerde hatalari onler. Tum ozellikler duzgun bir sekilde degrade olur -- tek saglayici ile sistem onceki gibi sifir ek yuk ile calisir.

**Bu bir kutuphane veya API degildir.** Calistirdiginiz bagimsiz bir uygulamadir. Sohbet platformunuza baglanir, diskteki Unity projenizi okur ve yapilandirdiginiz sinirlar dahilinde otonom olarak calisir.

---

## Hizli Baslangic

### On Kosullar

- **Node.js 20.19+** (veya **22.12+**) ve npm
- En az bir desteklenen AI saglayici kimligi (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` vb.), bir OpenAI ChatGPT/Codex subscription oturumu (`OPENAI_AUTH_MODE=chatgpt-subscription`) veya yalnizca `ollama` kullanan bir `PROVIDER_CHAIN`
- Bir **Unity projesi** (ajana verdiginiz yol). Tam Strada-ozel yardim icin Strada.Core onerilir.

### 1. Kurulum

```bash
# Kaynaktan klonlayin (su an icin kanonik kurulum yolu)
git clone https://github.com/okandemirel/Strada.Brain.git Strada.Brain

# `cd` zorunlu degil: parent klasorden dogrudan kullanabilirsiniz
./Strada.Brain/strada install-command
./Strada.Brain/strada setup

# Daha kisa komutlar isterseniz opsiyonel
cd Strada.Brain
```

```powershell
# Windows PowerShell source checkout
git clone https://github.com/okandemirel/Strada.Brain.git Strada.Brain
.\Strada.Brain\strada.ps1 install-command
.\Strada.Brain\strada.ps1 setup
```

`./strada` kaynak checkout icin kanonik launcher'dir. Ilk calistirmada gerekli hazirligi kendi yapar; normal kurulumda artik manuel `npm install`, `npm run bootstrap` veya `npm link` gerekmez.

`./strada install-command` atlanirsa parent klasorden `./Strada.Brain/strada ...` veya repo kokunden `./strada ...` kullanmaya devam edin. Kurulduktan sonra yalniz `strada ...` komutu her yerden calisir.

`./strada install-command`, gelecekte acilacak terminallerin `strada` komutunu dogrudan gormesi icin shell profilinizi de otomatik gunceller; ayrica PATH export yazmaniz gerekmez.
Windows'ta checkout icinden `.\strada.ps1` kullanilir. `install-command`, `strada.cmd` ve `strada.ps1` dosyalarini `%LOCALAPPDATA%\Strada\bin` altina yazar ve kullanici PATH'ini gunceller.

Kullanici-local komutu kaldirmak icin daha sonra `strada uninstall` (veya checkout icinden `./strada uninstall` / `.\strada.ps1 uninstall`) calistirin. `--purge-config` eklerseniz `.env`, `.strada-memory`, `.whatsapp-session`, loglar ve `HEARTBEAT.md` gibi repo-ici runtime dosyalari da temizlenir. Repository checkout'unun kendisi otomatik olarak silinmez.

Eger bir gun `npm` komutunu manuel calistirmaniz gerekirse bunu `package.json` dosyasinin bulundugu repo kokunden yapin. `ENOENT ... /Strada/package.json` benzeri bir hata gorurseniz bir ust klasordesiniz; once `cd Strada.Brain` yapin veya komutu `cd Strada.Brain && ...` ile calistirin.

`strada-brain` paketi su anda public npm registry'de yayinli degil; bu nedenle `npm install -g strada-brain` komutu `E404` verir. Registry yayini gelene kadar yukaridaki kaynak checkout akisini kullanin.

Strada paketlenmis bir npm/tarball surumunden kuruldugunda runtime config'i varsayilan olarak macOS/Linux'ta `~/.strada`, Windows'ta `%LOCALAPPDATA%\Strada` altinda tutulur. Farkli bir app home gerekiyorsa `STRADA_HOME=/ozel/yol` ile ezebilirsiniz.

### 2. Yapilandirma

```bash
# Etkilesimli kurulum sihirbazi (terminal veya web tarayicisi)
./strada setup

# Secim ekranini atlayip dogrudan istediginiz setup yuzeyine gidin
./strada setup --web
./strada setup --terminal
```

```powershell
# Windows PowerShell source checkout
.\strada.ps1 setup
.\strada.ps1 setup --web
.\strada.ps1 setup --terminal
```

`./strada setup --web`, tam portal paketi icin yeterli olmayan daha eski bir Node surumu gorurse web yolunu birincil tutar: `nvm` varsa onayinizla uyumlu Node surumunu kurup sizi dogrudan web setup'a geri sokabilir; bu rehberli yukseltmeyi gecici temiz bir HOME icinde calistirarak uyumsuz `prefix` / `globalconfig` npm ayarlarinin `nvm`'i engellemesini onler. Yoksa Node yukleme/yukseltme akisina yonlendirir. Yukseltmeyi reddederseniz Strada, terminal setup ile devam etmek isteyip istemediginizi acikca sorar.
Windows'ta ayni akis once `nvm-windows`, sonra `winget`, en son da dogrudan Node indirme yolunu kullanir. Bu durumda gosterilen yeniden calistirma komutu `.\strada.ps1 setup --web` olur.
Node 22 `nvm` icinde zaten kuruluysa Strada yeniden indirmek yerine o kurulumu tekrar kullanir. Web setup akisi root local URL uzerinden acilir ve ana uygulamaya devredilirken de ayni URL korunur.
Ilk tarayici acilisi acik bir setup bayragi da tasir; boylece cache'te kalmis eski bir portal sekmesi bile olu bir "Not Found" sayfasina dusmek yerine setup sihirbazina gider.
Ilk web handoff restart ile yarisirsa Strada artik bu acilisi otomatik olarak tekrar dener. Config kaydedildikten sonra Strada ana uygulama hazir olana kadar ayni URL'de handoff ekranini ayakta tutar; setup'i tekrar calistirmayin.

Sihirbaz, Unity proje yolunuz, AI saglayici API anahtari, varsayilan kanal ve dili sorar. `./strada setup` artik varsayilan olarak **Web Tarayicisi** yolunu tercih eder; daha hizli metin akisina bilincli olarak ihtiyaciniz varsa **Terminal** secin.
Terminal setup, tek bir istemde virgule ayrilmis provider'lari kabul eder (ornegin `kimi,deepseek`) ya da bunlari tek tek etkilesimli olarak girebilirsiniz. "Baska eklensin mi?" dongusu yalnizca tek bir provider girildiginde gosterilir. Embedding provider secimi ayri kalir.
Secilen her response worker setup tamamlanmadan once preflight'tan gecmek zorundadir. Setup, `strada doctor` ve startup artik ayni kontrati kullanir; gecersiz provider zincirleri sessizce atlanmaz.
OpenAI `chatgpt-subscription` modunda setup artik kaydetmeden once gercek bir Responses probe'u ile yerel Codex/ChatGPT oturumunu dogrular. Suresi dolmus subscription oturumlari setup ve `strada doctor` seviyesinde raporlanir.
Web sihirbazinda kaydetme tamamlandiginda Strada ayni URL uzerinden acik handoff durumlariyla (`saved`, `booting`, `ready`, `failed`) ana web uygulamasina devreder; boylece refresh gecisi olu setup sayfasina dusmez ve bootstrap hatasi gorunur kalir.
Bu ilk devir sirasinda Strada onboarding turunu ve ilk autonomy tercihini de ilk chat oturumuna uygular; boylece acilis konusmasi ve Settings ekrani sihirbazda sectiginiz durumla hemen uyusur.
Ilk gercek chat mesaji teknik bir gorevse Strada artik ise hemen baslar ve uzun bir intake akisi acmak yerine onboarding'i en fazla tek kisa takip sorusuna indirir.
RAG acik ama kullanilabilir bir embedding provider yoksa sihirbaz artik review adimina gecmenize izin verir; ancak gecerli bir embedding provider secene kadar veya RAG'i kapatana kadar Save bloklu kalir.
Ilk basarili kurulumdan sonra `./strada` komutu artik akilli launcher olur:
- ilk kullanimda config yoksa setup'i otomatik acar
- sonraki kullanimlarda web, CLI, daemon, setup veya doctor secimi yapabileceginiz terminal paneli gosterir
Kurulumdan sonra, ajani baslatmadan once hazirlik kontrolu calistirin:

```bash
# Source checkout icinden
./strada doctor

# Kullanici-local komutu kurduysaniz
strada doctor
```

Git/source kurulumlarda `strada doctor`, source launcher zaten calisiyorsa eksik `dist/` klasorunu artik bloklayici hata saymaz; warning verir ve sadece paketli build artifact istediginizde tam repo kokundeki `npm run bootstrap` komutunu gosterir.

Alternatif olarak, `.env` dosyasini manuel olarak olusturun:

```env
ANTHROPIC_API_KEY=sk-ant-...      # Claude API anahtariniz
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Assets/ icermeli
JWT_SECRET=<su sekilde olusturun: openssl rand -hex 64>
```

### 3. Calistirma

```bash
# Source checkout icinden akilli launcher
./strada

# `./strada install-command` sonrasinda yalniz komut
strada

# Kayitli varsayilan kanali dogrudan daemon modunda baslat
./strada --daemon

# Varsayilan web kanali ile baslatin
./strada start

# Etkilesimli CLI modu (test etmenin en hizli yolu)
./strada start --channel cli

# Daemon modu (proaktif tetikleyicilerle 7/24 otonom calisma)
./strada start --channel web --daemon

# Diger sohbet kanallari ile
./strada start --channel telegram
./strada start --channel discord
./strada start --channel slack
./strada start --channel whatsapp

# Otomatik yeniden baslatma destekli her zaman acik denetcisi
./strada supervise --channel web
```

```powershell
# Windows PowerShell source launcher
.\strada.ps1
.\strada.ps1 --daemon
.\strada.ps1 start
.\strada.ps1 start --channel cli
.\strada.ps1 start --channel web --daemon
```

### 4. CLI Komutlari

```bash
./strada                  # Kaynak checkout icin kanonik launcher
.\strada.ps1             # Windows PowerShell source launcher
strada.cmd               # Windows Command Prompt yardimci launcher'i
./strada install-command  # Kullanici-local bare `strada` komutunu kur
./strada uninstall        # Kurulmus bare komutu ve yonetilen PATH/profile degisikliklerini kaldir
.\strada.ps1 uninstall   # Windows checkout icinden bare komutu kaldir
strada uninstall --purge-config # Strada'nin olusturdugu repo-ici runtime dosyalarini da temizle
strada                    # install-command sonrasinda akilli launcher
strada --daemon           # Kayitli varsayilan kanali daemon modunda baslat
strada --web              # Web kanalini ac veya yeni makinada web-oncelikli kuruluma devam et
strada --terminal         # Terminal kanalini ac veya yeni makinada terminal kurulumunu zorla
.\strada.ps1 setup --web # Windows PowerShell ile web sihirbazini dogrudan ac
.\strada.ps1 setup --terminal # Windows PowerShell ile terminal sihirbazini ac
.\strada.ps1 doctor      # Windows PowerShell ile kurulum/build/config hazirligini dogrula
./strada setup --web      # Web sihirbazini dogrudan ac
./strada setup --terminal # Terminal sihirbazini dogrudan kullan
./strada doctor           # Kurulum/build/config hazirligini dogrula
./strada start            # Ajani baslat
./strada supervise        # Otomatik yeniden baslatma destegi ile calistir
./strada update           # Guncellemeleri kontrol et ve uygula
./strada update --check   # Guncellemeleri kontrol et (uygulama)
./strada version-info     # Surum, kurulum yontemi ve guncelleme durumunu goster
```

### 5. Konusmaya Baslayin

Calistiktan sonra, yapilandirilmis kanaliniz uzerinden bir mesaj gonderin:

```
> Proje yapisini analiz et
> "Combat" adinda DamageSystem ve HealthComponent iceren yeni bir modul olustur
> PositionComponent'i sorgulayan tum sistemleri bul
> Derlemeyi calistir ve hatalari duzelt
```

**Web kanali:** Terminal gerekmez -- `localhost:3000` adresindeki web paneli uzerinden etkilesim kurun.

### 6. Oto-Guncelleme

Strada.Brain, her gun otomatik olarak guncellemeleri kontrol eder ve acil oldugunda uygular. Kaynak checkout ve `./strada install-command` kurulumlari guncellemeleri git uzerinden alir. Basarili bir git oto-guncellemesinden sonra Strada, bare `strada` wrapper'larini da yeniden yazar; boylece komut guncel checkout'u izlemeye devam eder. npm tabanli guncelleme komutlari ise ancak public npm yayini oldugunda kullanilabilir.

| Degisken | Varsayilan | Aciklama |
|----------|---------|-------------|
| `AUTO_UPDATE_ENABLED` | `true` | Oto-guncellemeyi etkinlestir/devre disi birak |
| `AUTO_UPDATE_INTERVAL_HOURS` | `24` | Kontrol sikliği (saatler) |
| `AUTO_UPDATE_IDLE_TIMEOUT_MIN` | `5` | Guncellemeleri uygulamadan onceki bekleme suresi (dakikalar) |
| `AUTO_UPDATE_CHANNEL` | `stable` | npm dist-tag: `stable` veya `latest` |
| `AUTO_UPDATE_AUTO_RESTART` | `true` | Guncelleme sonrasi acil oldugunda otomatik yeniden baslat |

---

## Mimari

```
+-----------------------------------------------------------------+
|  Sohbet Kanallari                                                |
|  Web | Telegram | Discord | Slack | WhatsApp | CLI              |
+------------------------------+----------------------------------+
                               |
                    IChannelAdapter arayuzu
                               |
+------------------------------v----------------------------------+
|  Orkestrator (PAOR Ajan Dongusu)                                 |
|  Plan -> Eylem -> Gozlem -> Yansima durum makinesi               |
|  Icgudu getirme, hata siniflandirma, otomatik yeniden planlama   |
+-------+--------------+-------------+-----------+----------------+
        |              |             |           |
+-------v------+ +-----v------+ +---v--------+ +v-----------------+
| AI Saglayici | | 30+ Arac   | | Baglam     | | Ogrenme Sistemi  |
| Claude (brnc)| | Dosya I/O  | | AgentDB    | | TypedEventBus    |
| OpenAI, Kimi | | Git islem  | | (SQLite +  | | Hibrit agirlik.  |
| DeepSeek,Qwen| | Kabuk cali | |  HNSW)     | | Icgudu yasam     |
| MiniMax, Groq| | .NET derle | | RAG vektor | |  dongusu          |
| Ollama +daha | | Strada ure | | Kimlik     | | Arac zincirleri  |
+--------------+ +------+-----+ +---+--------+ +--+---------------+
                        |           |              |
                +-------v-----------v--------------v------+
                |  Goal Decomposer + Goal Executor        |
                |  DAG-based decomposition, wave-based    |
                |  parallel execution, failure budgets    |
                +---------+------------------+------------+
                          |                  |
          +---------------v------+  +--------v--------------------+
          | Multi-Agent Manager  |  | Task Delegation             |
          | Per-channel sessions |  | TierRouter (4-tier)         |
          | AgentBudgetTracker   |  | DelegationTool + Manager    |
          | AgentRegistry        |  | Max depth 2, budget-aware   |
          +---------------+------+  +--------+--------------------+
                          |                  |
                +---------v------------------v------------+
                |  Memory Decay & Consolidation           |
                |  Exponential decay, idle consolidation   |
                |  HNSW clustering, soft-delete + undo     |
                +-----------------------------------------+
                               |
            +------------------v-------------------+
            |  Daemon (HeartbeatLoop)              |
            |  Cron, file-watch, checklist,        |
            |  webhook, deploy triggers            |
            |  Circuit breakers, budget tracking,  |
            |  trigger deduplication                |
            |  Notification router + digest reports |
            +------------------+-------------------+
                               |
            +------------------v-------------------+
            |  Deployment Subsystem                |
            |  ReadinessChecker, DeployTrigger      |
            |  DeploymentExecutor                   |
            |  Approval gate + circuit breaker      |
            +--------------------------------------+
```

### Ajan Dongusu Nasil Calisir

1. **Mesaj gelir** -- sohbet kanalindan (metin, gorseller, video, ses veya belgeler)
2. **Hafiza getirme** -- AgentDB hibrit aramasi (%70 anlamsal HNSW + %30 TF-IDF) en alakali gecmis konusmalari bulur
3. **RAG getirme** -- C# kod tabaninizda anlamsal arama (HNSW vektorler, ilk 6 sonuc)
4. **Icgudu getirme** -- goreve uygun ogrenilmis kaliplari proaktif olarak sorgular (anlamsal + anahtar kelime eslesmesi)
5. **Kimlik baglami** -- kalici ajan kimligini enjekte eder (UUID, baslangic sayisi, calisma suresi, cokme kurtarma durumu)
6. **PLAN asamasi** -- LLM, ogrenilmis icgoruler ve gecmis hatalarla bilgilendirilmis numarali bir plan olusturur
7. **EYLEM asamasi** -- LLM plana gore arac cagrilarini yurutur
8. **GOZLEM** -- sonuclar kaydedilir; hata kurtarma basarisizliklari analiz eder; hata siniflandirici hatalari kategorize eder
9. **YANSIMA** -- her 3 adimda (veya hata durumunda), LLM karar verir: **DEVAM**, **YENIDEN PLANLA** veya **TAMAMLANDI**
10. **Otomatik yeniden planlama** -- 3+ ardisik ayni turde hata olusursa, basarisiz stratejilerden kacinan yeni bir yaklasim zorlar
11. **50 iterasyona kadar tekrarla**
12. **Ogrenme** -- arac sonuclari, anlik kalip depolamasi icin TypedEventBus uzerinden ogrenme hattina akar
13. **Yanit** kullaniciya kanal uzerinden gonderilir (destekleniyorsa akis halinde)

---

## Hafiza Sistemi

Aktif hafiza arka ucu `AgentDBMemory`'dir -- HNSW vektor indeksleme ve uc katmanli otomatik kademelenme mimarisi ile SQLite.

**Uc katmanli hafiza:**
- **Calisma hafizasi** -- aktif oturum baglami, surekli kullanim sonrasi otomatik terfi edilir
- **Gecici hafiza** -- kisa sureli depolama, kapasite esikleri asildiginda otomatik olarak temizlenir
- **Kalici hafiza** -- uzun sureli depolama, erisim sikligi ve onem durumuna gore gecici hafizadan terfi edilir

**Nasil calisir:**
- Oturum gecmisi 40 mesaji astiginda, eski mesajlar ozetlenir ve konusma kayitlari olarak saklanir
- Hibrit getirme, %70 anlamsal benzerlik (HNSW vektorler) ile %30 TF-IDF anahtar kelime eslemesini birlestirir
- `strada_analyze_project` araci, anlik baglam enjeksiyonu icin proje yapisi analizini onbellege alir
- Hafiza, `MEMORY_DB_PATH` dizininde (varsayilan: `.strada-memory/`) yeniden baslatmalar arasinda kalicidir
- Eski FileMemoryManager'dan otomatik goc, ilk baslatmada calisir

**Yedek:** AgentDB baslatma islemi basarisiz olursa, sistem otomatik olarak `FileMemoryManager`'a (JSON + TF-IDF) geri doner.

---

## Ogrenme Sistemi

Ogrenme sistemi, ajan davranisini gozlemler ve hatalardan olay gudumlut bir hat uzerinden ogrenir.

**Olay gudumlu hat:**
- Arac sonuclari, anlik isleme icin `TypedEventBus` uzerinden seri `LearningQueue`'ya akar
- Zamanlayici tabanli toplu isleme yoktur -- kalipler olustukca tespit edilir ve depolanir
- `LearningQueue`, hata izolasyonlu sinirli FIFO kullanir (ogrenme hatalari ajani asla cokmesine neden olmaz)

**Hibrit agirlikli guven puanlamasi:**
- Guven = 5 faktor uzerinden agirlikli toplam: basariOrani (0.35), kalip gucu (0.25), yakinlik (0.20), baglam uyumu (0.15), dogrulama (0.05)
- Karar puanlari (0.0-1.0), guven araliklari icin alfa/beta kanit sayaclarini gunceller
- Alfa/beta parametreleri belirsizlik tahmini icin korunur ancak birincil guven hesaplamasi icin kullanilmaz

**Icgudu yasam dongusu:**
- **Onerilen** (yeni) -- 0.7 guvenin altinda
- **Aktif** -- 0.7 ile 0.9 guven arasinda
- **Gelismis** -- 0.9 uzerinde, kalici statiye terfi icin onerilir
- **Kullanim disi** -- 0.3 altinda, kaldirilmak uzere isaretlenir
- **Soguma donemi** -- durum degisikliklerinden once minimum gozlem gereksinimleri olan 7 gunluk pencere
- **Kalici** -- dondurulmus, daha fazla guven guncellemesi yapilmaz

**Aktif getirme:** Icguduler, her gorev basinda `InstinctRetriever` kullanilarak proaktif olarak sorgulanir. Anahtar kelime benzerligi ve HNSW vektor gommeleri ile alakali ogrenilmis kaliplari arar ve bunlar PLAN asamasi promptuna enjekte edilir.

**Oturumlar arasi ogrenme:** Icguduler, oturumlar arasi bilgi aktarimi icin koken meta verisi (kaynak oturum, oturum sayisi) tasir.

---

## Hedef Ayristirma

Karmasik cok adimli istekler, otomatik olarak yonlu dongusuz cizge (DAG) yapili alt hedeflere ayristirilir.

**GoalDecomposer:**
- Sezgisel on kontrol, basit gorevler icin LLM cagrilarindan kacinir (karmasiklik gostergeleri icin kalip eslesmesi)
- LLM, bagimlilik kenarlari ve istege bagli tekrarli derinlik (3 seviyeye kadar) ile DAG yapilari olusturur
- Kahn algoritmasi dongu icermeyen DAG yapisini dogrular
- Reaktif yeniden ayristirma: bir dugum basarisiz oldugunda, daha kucuk kurtarma adimlarina bolunebilir

**GoalExecutor:**
- Dalga tabanli paralel yurutme, bagimlilik siralamasina uyar
- Semafor tabanli es zamanlilik sinirlamasi (`GOAL_MAX_PARALLEL`)
- Basarisizlik butceleri (`GOAL_MAX_FAILURES`) ile kullaniciya yonelik devam ettirme istemleri
- LLM kritiklik degerlendirmesi, basarisiz bir dugumun bagimlilari engelleyip engellemeyecegini belirler
- Dugum basina yeniden deneme mantigi (`GOAL_MAX_RETRIES`) ve tukenmede kurtarma ayristirmasi
- AbortSignal ile iptal destegi
- Yeniden baslatma sonrasi devam icin `GoalStorage` (SQLite) ile kalici hedef agaci durumu

---

## Arac Zinciri Sentezi

Ajan, cok aracli zincir kaliplarini otomatik olarak tespit eder ve yeniden kullanilabilir bilesik araclara sentezler.

**Hat:**
1. **ChainDetector** -- yinelenen arac dizilerini bulmak icin yol verisini analiz eder (orn. `file_read` -> `file_edit` -> `dotnet_build`)
2. **ChainSynthesizer** -- uygun girdi/cikti esleme ve aciklamasiyla bir `CompositeTool` olusturmak icin LLM kullanir
3. **ChainValidator** -- calisma zamani geri bildirimi ile sentez sonrasi dogrulama; agirlikli guven puanlamasi araciligiyla zincir yurutme basarisini izler
4. **ChainManager** -- yasam dongusu orkestratorü: baslatmada mevcut zincirleri yukler, periyodik algilama calistirir, bilesen araclar kaldirildiginda zincirleri otomatik gecersiz kilar

**Guvenlik:** Bilesik araclar, bilesen araclarindan en kisitlayici guvenlik bayraklarini miras alir.

**Guven kademesi:** Zincir icguduleri, normal icgudularle ayni guven yasam dongusunu izler. Kullanim disi birakma esiginin altina dusen zincirler otomatik olarak kayittan silinir.

**V2 gelistirmeleri:**
- **DAG yurutme** -- bagimsiz adimlar paralel calisir
- **Saga geri alma** -- bir adim basarisiz oldugunda onceki adimlar geri alinir
- **Zincir versiyonlama** -- eski versiyonlar arsivlenir

---

## Coklu Ajan Orkestrasyonu

Coklu ajan orkestrasyonu, birden fazla ajanin es zamanli olarak farkli gorevler uzerinde calismasini saglar.

- **AgentManager** -- kanal ve oturum bazinda ajan olusturma ve yonetim, oturum izolasyonu
- **AgentBudgetTracker** -- ajan bazinda token ve maliyet takibi
- **AgentRegistry** -- aktif ajanlarin merkezi kaydi
- `MULTI_AGENT_ENABLED` ortam degiskeni varsayilan olarak etkindir; legacy tek ajan davranisina donmek icin `false` yapin

---

## Gorev Delegasyonu

Ajanlar, karmasik gorevleri diger ajanlara devredebilir.

- **TierRouter (4 seviye)** -- basit -> orta -> yuksek -> kritik gorev siniflandirmasi
- **DelegationManager** -- delegasyon yasam dongusu yonetimi, maksimum derinlik 2
- **DelegationTool** -- ajanin delegasyon yapabilmesi icin yerlesik arac
- **Butce-bilincli** -- delegasyon, ebeveyn ajanin butcesinden pay alir

---

## Bellek Bozunumu ve Konsolidasyon

Hafiza sistemi, zaman icinde kullanilmayan bellekleri otomatik olarak yonetir.

- **Ustel bozunum** -- zaman icinde azalan bozunum skoru
- **Bosta konsolidasyon** -- HNSW kumeleme ile benzer bellekleri birlestirme
- **Yumusak silme ve geri alma** -- silinen bellekler geri alinabilir

---

## Dagitim Alt Sistemi

Otonom dagitim alt sistemi, onay kapisi ve guvenlik mekanizmalari ile dagitim surecini yonetir.

- **ReadinessChecker** -- dagitim oncesi hazirlik kontrolu
- **DeployTrigger** -- onay kapisi ile dagitim tetikleyici
- **DeploymentExecutor** -- geri alma destekli dagitim yurutucusu
- **Devre kesici** -- ardisik hatalar otomatik bekleme tetikler
- Varsayilan olarak kapali, acik opt-in gerektirir

---

### Agent Core (Otonom OODA Dongusu)

Daemon modu aktif oldugunda, Agent Core surekli bir gozle-yonlendir-karar ver-eyle dongusu calistirir:

- **Gozlem**: 6 gozlemciden cevre durumunu toplar (dosya degisiklikleri, git durumu, derleme sonuclari, tetikleyici olaylari, kullanici aktivitesi, test sonuclari)
- **Yonlendirme**: Ogrenme bilgisi ile oncelik puanlamasi kullanarak gozlemleri degerlendirir (InstinctRetriever entegrasyonlu PriorityScorer)
- **Karar**: Butce bilincli kisitlama ile LLM akil yurutmesi (30sn minimum aralik, oncelik esigi, butce tabani)
- **Eylem**: Hedef gonderir, kullaniciyi bilgilendirir veya bekler (ajan "yapilacak bir sey yok" diye karar verebilir)

Guvenlik: tickInFlight korumasi, hiz sinirlamasi, butce tabani (%10) ve DaemonSecurityPolicy zorunlulugu.

### Coklu Saglayici Akilli Yonlendirme

2+ saglayici yapilandirildiginda, Strada.Brain gorevleri otomatik olarak en uygun saglayiciya yonlendirir:

| Gorev Tipi | Yonlendirme Stratejisi |
|------------|----------------------|
| Planlama | En genis baglam penceresi (Claude > GPT > Gemini) |
| Kod Uretimi | Guclu arac cagrisi (Claude > Kimi > OpenAI) |
| Kod Inceleme | Yurutucu modelden farkli model (cesitlilik yanliligi) |
| Basit Sorular | En hizli/en ucuz (Groq > Kimi > Ollama) |
| Hata Ayiklama | Guclu hata analizi |

**On Ayarlar**: `budget` (maliyet optimizeli), `balanced` (varsayilan), `performance` (kalite oncelikli)
**PAOR Faz Gecisi**: Planlama, yurutme ve yansima fazlari icin farkli saglayicilar.
**Konsensus**: Dusuk guven durumunda farkli saglayicidan otomatik ikinci gorus.

### Strada.MCP Entegrasyonu

Strada.Brain, [Strada.MCP](https://github.com/okandemirel/Strada.MCP)'yi (Unity MCP sunucusu) tespit eder ve ajani mevcut MCP yetenekleri hakkinda bilgilendirir: calisma zamani kontrolu, dosya islemleri, git, .NET derleme, kod analizi ve sahne/prefab yonetimi. Yalnizca mevcut Brain runtime'inda gercekten calistirilabilen MCP action tool'lari worker tool surface'e girer; bridge/runtime kisitli MCP yetenekleri ise yine authoritative docs/resources olarak kalir.

---

## Daemon Modu

Daemon, kalp atisi gudumlu tetikleyici sistemi ile 7/24 otonom calisma saglar. Daemon modu aktif oldugunda, **Agent Core OODA dongusu** daemon tick'leri icinde calisir, cevrevi gozlemler ve kullanici etkilesimleri arasinda proaktif olarak eyleme gecer. `/autonomous on` komutu artik DaemonSecurityPolicy'ye yayilir ve islem bazinda onay istemleri olmadan tam otonom calismaya olanak tanir.

```bash
npm run dev -- start --channel web --daemon
```

**HeartbeatLoop:**
- Yapilandirilabilir tik araligi, her dongude kayitli tetikleyicileri degerlendirir
- Sirayla tetikleyici degerlendirmesi, butce yarisi kosullarini onler
- Cokme kurtarmasi icin calisma durumunu kalici olarak saklar

**Tetikleyici turleri:**
- **Cron** -- cron ifadeleri ile zamanlanmis gorevler
- **Dosya izleme** -- yapilandirilmis yollardaki dosya sistemi degisikliklerini izler
- **Kontrol listesi** -- kontrol listesi ogeleri vadesi geldiginde tetiklenir
- **Webhook** -- gelen isteklerde gorev tetikleyen HTTP POST uc noktasi
- **Deploy** -- yenilenen readiness kontrolu proje hazir oldugunu dogruladiginda dagitim onerir (onay kapisi gerektirir)

**Dayaniklilik:**
- **Devre kesiciler** -- ustel geri cekilme soguma sureli, yeniden baslatmalar arasinda kalici, tetikleyici bazinda
- **Butce takibi** -- uyari esigi olaylariyla gunluk USD harcama siniri
- **Tetikleyici tekilestirme** -- tekrarlanan ateslemeleri onlemek icin icerik tabanli ve soguma tabanli bastirma
- **Cakisma bastirma** -- zaten aktif bir gorevi olan tetikleyicileri atlar

**Guvenlik:**
- `DaemonSecurityPolicy`, daemon tetikleyicileri tarafindan cagrilan araclarin hangilerinin kullanici onayi gerektirdigini kontrol eder
- Yazma islemleri icin yapilandirilabilir sure dolumu ile `ApprovalQueue`

**Raporlama:**
- `NotificationRouter`, olaylari aciliyet duzeyine gore (sessiz/dusuk/orta/yuksek/kritik) yapilandirilmis kanallara yonlendirir
- Aciliyet bazinda hiz sinirlamasi ve sessiz saat destegi (kritik olmayan bildirimler tamponlanir)
- `DigestReporter` periyodik ozet raporlar olusturur
- Tum bildirimler SQLite gecmisine kaydedilir

---

## Kimlik Sistemi

Ajan, oturumlar ve yeniden baslatmalar arasinda kalici bir kimlik surdurir.

**IdentityStateManager** (SQLite destekli):
- Ilk baslatmada olusturulan benzersiz ajan UUID'si
- Baslangic sayisi, kumulatif calisma suresi, son etkinlik zaman damgalari
- Toplam mesaj ve gorev sayaclari
- Cokme kurtarmasi icin temiz kapatma tespiti
- SQLite yazmalarini en aza indirmek icin periyodik temizleme ile bellek ici sayac onbellegi

**Cokme kurtarmasi:**
- Baslatmada, onceki oturum temiz bir sekilde kapatilmadiysa, bir `CrashRecoveryContext` olusturur
- Kesinti suresi, yarida kalan hedef agaclari ve baslangic sayisini icerir
- LLM'in cokmeyi dogal olarak kabul edip yarida kalan isi devam ettirebilmesi icin sistem promptuna enjekte edilir

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

OpenAI uyumlu herhangi bir saglayici calisir. Asagidaki tum saglayicilar zaten uygulanmistir; cogunlugu API anahtari ile etkinlesir, OpenAI ise bu makinedeki yerel ChatGPT/Codex abonelik oturumunu konusma icin yeniden kullanabilir.

| Degisken | Saglayici | Varsayilan Model |
|----------|-----------|------------------|
| `ANTHROPIC_API_KEY` | Claude (birincil) | `claude-sonnet-4-20250514` |
| `OPENAI_API_KEY` | OpenAI | `gpt-4o` |
| `DEEPSEEK_API_KEY` | DeepSeek | `deepseek-chat` |
| `GROQ_API_KEY` | Groq | `llama-3.3-70b-versatile` |
| `QWEN_API_KEY` | Alibaba Qwen | `qwen-plus` |
| `KIMI_API_KEY` | Moonshot Kimi | `moonshot-v1-8k` |
| `MINIMAX_API_KEY` | MiniMax | `MiniMax-M2.7` |
| `MISTRAL_API_KEY` | Mistral AI | `mistral-large-latest` |
| `TOGETHER_API_KEY` | Together AI | `meta-llama/Llama-3-70b-chat-hf` |
| `FIREWORKS_API_KEY` | Fireworks AI | `accounts/fireworks/models/llama-v3p1-70b-instruct` |
| `GEMINI_API_KEY` | Google Gemini | `gemini-pro` |
| `OLLAMA_BASE_URL` | Ollama (yerel) | `llama3` |
| `PROVIDER_CHAIN` | Yedekleme sirasi | orn. `claude,kimi,deepseek,ollama` |
| `OPENAI_AUTH_MODE` | OpenAI kimlik dogrulama modu | `api-key` (varsayilan) veya `chatgpt-subscription` |
| `OPENAI_CHATGPT_AUTH_FILE` | Opsiyonel Codex oturum dosyasi | `OPENAI_AUTH_MODE=chatgpt-subscription` iken varsayilan `~/.codex/auth.json` |

**Saglayici zinciri:** `PROVIDER_CHAIN` degiskenini virgule ayrilmis saglayici adlari listesi olarak ayarlayin. Strada control-plane olarak kalir ve bu zinciri birincil execution worker, supervisor routing ve fallback secimi icin varsayilan orkestrasyon havuzu olarak kullanir. Ornek: `PROVIDER_CHAIN=kimi,deepseek,claude` once Kimi'yi kullanir, Kimi basarisiz olursa DeepSeek, sonra Claude. Secilen response worker'lar startup preflight'ini gecmek zorundadir; setup, doctor ve bootstrap artik gecersiz girdileri sessizce zincirden dusurmez.
Aciklayici soru yonetimi de bu control-plane'in parcasi oldu. Bir worker kullaniciya soru onerebilir, ama Strada artik herhangi bir taslagi `ask_user` turune cevirmeden once iceride `clarification-review` asamasindan gecirir.
Tamamlama da artik dahili bir verifier pipeline uzerinden gecer. Build verification, targeted repro / failing-path kontrolleri, log review, Strada conformance ve completion review temiz olmadan Strada isi bitirmez. `/routing info` ve dashboard artik hem runtime execution trace'lerini hem de phase outcome'lari (`approved`, `continued`, `replanned`, `blocked`) gosterir.
Strada artik her gorev icin dahili bir execution journal ve rollback memory de tutar. Replan akislari son guvenli checkpoint'i, tukenen branch'leri, project/world anchor bilgisini ve hardcoded provider lore olmadan provider routing'e geri beslenen adaptive phase scores sinyalini kullanir. Bu skorlar artik verifier clean rate, rollback pressure, retry count, repeated failure fingerprints, repeated world-context failures, phase-local token cost, provider catalog freshness ve shared catalog icindeki official alignment / capability drift sinyalini de hesaba katar.
Hafiza artik role gore ayrilir: user profile state ad/tercih/autonomy bilgisini, task execution memory session summaries/open items/rollback state bilgisini tutar; project/world memory ise aktif proje root'u ve cached AgentDB analysis uzerinden explicit prompt katmani olarak enjekte edilir. Task execution memory yalnizca aktif identity icin `latest snapshot` tutar; exact bir task run'in `persisted chronology` kaydi burada degildir. Bu ayni project/world katmani artik recovery memory ve adaptive routing'i de besler; semantic retrieval ise canli ilgili hafizayi ayri ekler.
Cross-session `execution replay` de artik ayni hatti kullanir: Strada project/world-aware recovery ozetlerini learning trajectory'lerine yazar ve benzer isi tekrar denerken en ilgili eski success/failure branch'lerini `Execution Replay` context layer'i olarak prompt'a geri koyar.
Replay correlation artik chat-scope `taskRunId` ile de persist edilir; boylece ayni chat icindeki eszamanli task'lar phase telemetry ve recovery history tarafinda birbirine karismaz. Exact bir task run icin `persisted chronology` kaydi da bu `taskRunId` ile bagli learning trajectory / replay context tarafinda yasar.
Ayni learning hatti artik runtime self-improvement artifacts da uretir: tekrar eden yuksek-confidence pattern'ler once `skill`, `workflow` veya `knowledge_patch` olarak `shadow` durumda materialize edilir; yalniz verifier-backed clean shadow run'lar bunlari `active` guidance'a tasir. `/routing info` ve dashboard aktif proje icin identity-scoped artifact telemetry gosterir: state, sample count ve clean/retry/failure dagilimi.
Bu replay context artik phase/provider telemetry bilgisini de persist eder; boylece adaptive routing benzer gorevlerde yalnizca in-memory runtime history'e degil, basarili gecmis worker'lara da bakabilir.

**Onemli:** `OPENAI_AUTH_MODE=chatgpt-subscription` sadece Strada icindeki OpenAI konusma turlari icin gecerli olur. OpenAI API veya embedding kotasi saglamaz. `EMBEDDING_PROVIDER=openai` secersen yine `OPENAI_API_KEY` gerekir.
Strada bariz sonraki adimlari kullaniciya geri paslamaz. Bir saglayici eksik analiz donerse, "ne yapmaliyim?" diye sorarsa veya yeterli kanit olmadan genis kapsamli bir tamamlanma iddiasi kurarsa, Strada donguyu yeniden acar, ek inceleme/review turu yaptirir ve ancak sonuc dogrulandiginda ya da gercek bir dis engel kaldiginda kullaniciya doner.

### Sohbet Kanallari

**Web:**
| Degisken | Aciklama |
|----------|----------|
| `WEB_CHANNEL_PORT` | Web paneli icin port (varsayilan: `3000`) |

**Telegram:**
| Degisken | Aciklama |
|----------|----------|
| `TELEGRAM_BOT_TOKEN` | @BotFather'dan alinan token |
| `ALLOWED_TELEGRAM_USER_IDS` | Virgule ayrilmis Telegram kullanici kimlikleri (zorunlu, bos ise tumu reddedilir) |

**Discord:**
| Degisken | Aciklama |
|----------|----------|
| `DISCORD_BOT_TOKEN` | Discord bot token'i |
| `DISCORD_GUILD_ID` | Discord sunucu (guild) kimligi |
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
| `WHATSAPP_ALLOWED_NUMBERS` | Virgule ayrilmis telefon numaralari (opsiyonel; bos ise herkese acik) |

### Ozellikler

| Degisken | Varsayilan | Aciklama |
|----------|------------|----------|
| `RAG_ENABLED` | `true` | C# projeniz uzerinde anlamsal kod aramasini etkinlestir |
| `EMBEDDING_PROVIDER` | `auto` | Gomme saglayici: `auto`, `openai`, `gemini`, `mistral`, `together`, `fireworks`, `qwen`, `ollama` |
| `EMBEDDING_DIMENSIONS` | (provider varsayilan) | Cikti vektor boyutu (Matryoshka: Gemini/OpenAI icin 128-3072) |
| `MEMORY_ENABLED` | `true` | Kalici konusma hafizasini etkinlestir |
| `MEMORY_DB_PATH` | `.strada-memory` | Hafiza veritabani dosyalari icin dizin |
| `WEB_CHANNEL_PORT` | `3000` | Web paneli portu |
| `DASHBOARD_ENABLED` | `false` | HTTP izleme panelini etkinlestir |
| `DASHBOARD_PORT` | `3100` | Panel sunucu portu |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | WebSocket gercek zamanli paneli etkinlestir |
| `ENABLE_PROMETHEUS` | `false` | Prometheus metrik uc noktasini etkinlestir (port 9090) |
| `MULTI_AGENT_ENABLED` | `true` | Coklu ajan orkestrasyonunu etkinlestir |
| `TASK_DELEGATION_ENABLED` | `false` | Ajanlar arasi gorev delegasyonunu etkinlestir |
| `AGENT_MAX_DELEGATION_DEPTH` | `2` | Maksimum delegasyon zincir derinligi |
| `DEPLOY_ENABLED` | `false` | Dagitim alt sistemini etkinlestir |
| `SOUL_FILE` | `soul.md` | Ajan kisilik dosyasinin yolu (degisiklikte sicak yeniden yuklenir) |
| `SOUL_FILE_WEB` | (ayarsiz) | Web kanali icin kanal bazli kisilik gecikmesi |
| `SOUL_FILE_TELEGRAM` | (ayarsiz) | Telegram icin kanal bazli kisilik gecikmesi |
| `SOUL_FILE_DISCORD` | (ayarsiz) | Discord icin kanal bazli kisilik gecikmesi |
| `SOUL_FILE_SLACK` | (ayarsiz) | Slack icin kanal bazli kisilik gecikmesi |
| `SOUL_FILE_WHATSAPP` | (ayarsiz) | WhatsApp icin kanal bazli kisilik gecikmesi |
| `READ_ONLY_MODE` | `false` | Tum yazma islemlerini engelle |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` veya `debug` |

### Yonlendirme ve Konsensus

| Degisken | Varsayilan | Aciklama |
|----------|------------|----------|
| `ROUTING_PRESET` | `balanced` | Yonlendirme on ayari: `budget`, `balanced` veya `performance` |
| `ROUTING_PHASE_SWITCHING` | `true` | Saglayicilar arasi PAOR faz gecisini etkinlestir |
| `CONSENSUS_MODE` | `auto` | Konsensus modu: `auto`, `critical-only`, `always` veya `disabled` |
| `CONSENSUS_THRESHOLD` | `0.5` | Konsensusu tetiklemek icin guven esigi |
| `CONSENSUS_MAX_PROVIDERS` | `3` | Konsensus icin danisilan maksimum saglayici sayisi |
| `STRADA_DAEMON_DAILY_BUDGET` | `1.0` | Daemon modu icin gunluk butce (USD) |

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

Ajan, kategorilere gore duzenlenmis 40'dan fazla yerlesik araca sahiptir:

### Dosya Islemleri
| Arac | Aciklama |
|------|----------|
| `file_read` | Satir numaralari, ofset/limit sayfalama ile dosya okuma (512KB limit) |
| `file_write` | Dosya olusturma veya ustune yazma (256KB limit, dizinleri otomatik olusturur) |
| `file_edit` | Benzersizlik zorunlulugu ile bul-ve-degistir duzenleme |
| `file_delete` | Tek bir dosyayi silme |
| `file_rename` | Proje icinde dosya yeniden adlandirma veya tasima |
| `file_delete_directory` | Tekrarlamali dizin silme (50 dosya guvenlik siniri) |

### Arama
| Arac | Aciklama |
|------|----------|
| `glob_search` | Glob deseni ile dosya bulma (maksimum 50 sonuc) |
| `grep_search` | Dosyalar arasi regex icerik aramasi (maksimum 20 eslesme) |
| `list_directory` | Dosya boyutlari ile dizin listeleme |
| `code_search` | RAG uzerinden anlamsal/vektor arama -- dogal dil sorgulari |
| `memory_search` | Kalici gorunur konusma hafizasinda arama |

### Strada Kod Uretimi
| Arac | Aciklama |
|------|----------|
| `strada_analyze_project` | Tam C# proje taramasi -- moduller, sistemler, bilesenler, servisler |
| `strada_create_module` | Tam modul iskelesi olusturma (`.asmdef`, yapilandirma, dizinler) |
| `strada_create_component` | Alan tanimlari ile ECS bilesen struct'lari olusturma |
| `strada_create_mediator` | Bilesen baglantilari ile `EntityMediator<TView>` olusturma |
| `strada_create_system` | `SystemBase`/`JobSystemBase`/`BurstSystem` iskeleleri olusturma |

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

### Ajan Etkilesimi
| Arac | Aciklama |
|------|----------|
| `ask_user` | Normal worker action tool degildir; yalnizca `clarification-review` bunu gerekli gorurse control-plane tarafindan kullaniciya surface edilir |
| `show_plan` | Normal worker action tool degildir; yalnizca kullanici plani once gormeyi acikca isterse control-plane plan-review turn'u olarak surface edilir |
| `switch_personality` | Ajan kisiligini calisma zamaninda degistirir (casual/formal/minimal/default) |

### Diger
| Arac | Aciklama |
|------|----------|
| `shell_exec` | Kabuk komutlari calistirma (30sn zaman asimi, tehlikeli komut engelleme listesi) |
| `code_quality` | Dosya bazinda veya proje bazinda kod kalitesi analizi |
| `rag_index` | Artimli veya tam proje yeniden indekslemesini tetikleme |

---

## Sohbet Komutlari

Tum sohbet kanallarinda kullanilabilir slash komutlari:

| Komut | Aciklama |
|-------|----------|
| `/daemon` | Daemon durumunu goster |
| `/daemon start` | Daemon kalp atisi dongusunu baslat (`--daemon` ile baslatildiysa) |
| `/daemon stop` | Daemon kalp atisi dongusunu durdur |
| `/daemon triggers` | Aktif tetikleyicileri goster |
| `/agent` | Agent Core durumunu goster |
| `/routing` | Yonlendirme durumunu ve on ayarini goster |
| `/routing preset <ad>` | Yonlendirme on ayarini degistir (budget/balanced/performance) |
| `/routing info` | Son yonlendirme kararlarini, runtime execution trace'lerini, phase outcome'larini, adaptive phase scores ozetini ve aktif proje icin identity-scoped runtime self-improvement telemetry listesini goster; verifier clean rate, rollback pressure, retry count, token-cost telemetry, provider catalog freshness, official alignment / capability drift ve artifact promotion telemetry sinyallerini de icerir |

---

## RAG Boru Hatti

RAG (Retrieval-Augmented Generation) boru hatti, anlamsal arama icin C# kaynak kodunuzu indeksler.

**Indeksleme akisi:**
1. Unity projenizde `**/*.cs` dosyalarini tarar
2. Kodu yapisal olarak parcalar -- dosya baslikari, siniflar, metodlar, yapilandiricilar
3. Gemini Embedding 2.0 (varsayilan), OpenAI (`text-embedding-3-small`), veya Ollama (`nomic-embed-text`) ile gomme vektorleri olusturur -- Matryoshka boyutlari desteklenir (`EMBEDDING_DIMENSIONS` ile yapilandirilabilir)
4. Hizli yaklasik en yakin komsu aramasi icin vektorleri HNSW indeksinde saklar
5. Baslatmada otomatik olarak calisir (arka planda, engellemesiz)

**Arama akisi:**
1. Sorgu, ayni saglayici kullanilarak gomulur
2. HNSW aramasi `topK * 3` aday dondurur
3. Yeniden siralayici puanlar: vektor benzerligi (%60) + anahtar kelime eslesmesi (%25) + yapisal bonus (%15)
4. En iyi 6 sonuc (0.2 puanin uzerinde) LLM baglamina enjekte edilir

**Not:** RAG boru hatti su anda yalnizca C# dosyalarini destekler. Parcalayici C#'a ozeldir.

---

## Kanal Yetenekleri

| Yetenek | Web | Telegram | Discord | Slack | WhatsApp | CLI |
|---------|-----|----------|---------|-------|----------|-----|
| Metin mesajlasma | Evet | Evet | Evet | Evet | Evet | Evet |
| Medya ekleri | Evet (base64) | Evet (foto/belge/video/ses) | Evet (herhangi ek) | Evet (dosya indirme) | Evet (resim/video/ses/belge) | Hayir |
| Goruntu (resim->LLM) | Evet | Evet | Evet | Evet | Evet | Hayir |
| Akis (yerinde duzenleme) | Evet | Evet | Evet | Evet | Evet | Evet |
| Yazma gostergesi | Evet | Evet | Evet | Islevsiz | Evet | Hayir |
| Onay diyaloglari | Evet (modal) | Evet (satirici klavye) | Evet (butonlar) | Evet (Block Kit) | Evet (numarali yanit) | Evet (readline) |
| Konu destegi | Hayir | Hayir | Evet | Evet | Hayir | Hayir |
| Hiz sinirlamasi (giden) | Evet (oturum basina) | Hayir | Evet (token bucket) | Evet (4 katmanli kayar pencere) | Satirici kisitlama | Hayir |

### Akis

Tum kanallar yerinde duzenleme akisi uygular. Ajanin yaniti, LLM urettikce asama asama gorunur. Guncellemeler, hiz sinirlarini asmamak icin platforma gore kisitlanir (WhatsApp/Discord: 1/sn, Slack: 2/sn).

### Kimlik Dogrulama

- **Telegram**: Varsayilan olarak tumu reddeder. `ALLOWED_TELEGRAM_USER_IDS` ayarlanmalidir.
- **Discord**: Varsayilan olarak tumu reddeder. `ALLOWED_DISCORD_USER_IDS` veya `ALLOWED_DISCORD_ROLE_IDS` ayarlanmalidir.
- **Slack**: **Varsayilan olarak herkese aciktir.** `ALLOWED_SLACK_USER_IDS` bos ise, herhangi bir Slack kullanicisi bota erisebilir. Uretim ortami icin izin listesini ayarlayin.
- **WhatsApp**: Varsayilan olarak herkese aciktir. `WHATSAPP_ALLOWED_NUMBERS` ayarlanirsa adaptor yalnizca bu izin listesindeki numaralari kabul eder.

---

## Guvenlik

### Katman 1: Kanal Kimlik Dogrulamasi
Mesaj gelisinde (herhangi bir islemden once) kontrol edilen platforma ozel izin listeleri.

### Katman 2: Hiz Sinirlamasi
Kullanici basina kayar pencere (dakika/saat) + genel gunluk/aylik token ve USD butce sinirlari.

### Katman 3: Yol Korumasi
Her dosya islemi sembolik baglantilari cozer ve yolun proje koku icinde kaldigini dogrular. 30'dan fazla hassas desen engellenir (`.env`, `.git/credentials`, SSH anahtarlari, sertifikalar, `node_modules/`).

### Katman 4: Medya Guvenligi
Tum medya ekleri islenmeden once dogrulanir: MIME izin listesi, tur bazinda boyut sinirlari (20MB resim, 50MB video, 25MB ses, 10MB belge), sihirli bayt dorulamasi ve indirme URL'leri icin SSRF korumasi.

### Katman 5: Gizli Bilgi Temizleyici
24 regex deseni, tum arac ciktilarinda kimlik bilgilerini LLM'e ulasmadan once tespit eder ve maskeler. Kapsar: OpenAI anahtarlari, GitHub token'lari, Slack/Discord/Telegram token'lari, AWS anahtarlari, JWT'ler, Bearer kimlik dogrulama, PEM anahtarlari, veritabani URL'leri ve genel gizli bilgi desenleri.

### Katman 6: Salt Okunur Mod
`READ_ONLY_MODE=true` oldugunda, 23 yazma araci ajanin arac listesinden tamamen kaldirilir -- LLM bunlari cagirmayi bile deneyemez.

### Katman 7: Islem Onayi
Yazma islemleri (dosya yazma, git commit, kabuk calistirma) kanalin etkilesimli arayuzu (butonlar, satirici klavyeler, metin istemleri) araciligiyla kullanici onayi gerektirebilir.

### Katman 8: Arac Ciktisi Temizleme
Tum arac sonuclari 8192 karakter ile sinirlandirilir ve LLM'e geri beslenmeden once API anahtari desenleri icin taranir.

### Katman 9: RBAC (Dahili)
9 kaynak turunu kapsayan izin matrisi ile 5 rol (superadmin, admin, developer, viewer, service). Politika motoru zaman tabanli, IP tabanli ve ozel kosullari destekler.

### Katman 10: Daemon Guvenligi
`DaemonSecurityPolicy`, daemon tarafindan tetiklenen islemler icin arac duzeyli onay gereksinimlerini zorlar. Yazma araclari, yurutmeden once `ApprovalQueue` araciligiyla acik kullanici onayi gerektirir.

---

## Panel ve Izleme

### HTTP Paneli (`DASHBOARD_ENABLED=true`)
`http://localhost:3100` adresinden erisilebilir (yalnizca localhost). Gosterir: calisma suresi, mesaj sayisi, token kullanimi, aktif oturumlar, arac kullanim tablosu, guvenlik istatistikleri. Her 3 saniyede otomatik yenilenir.

### Saglik Uc Noktalari
- `GET /health` -- Canlilik probu (`{"status":"ok"}`)
- `GET /ready` -- Derin hazirlik: hafiza ve kanal sagligini kontrol eder. 200 (hazir), 207 (dusuk performans) veya 503 (hazir degil) dondurur

### Prometheus (`ENABLE_PROMETHEUS=true`)
`http://localhost:9090/metrics` adresinde metrikler. Mesajlar, arac cagrilari, token'lar icin sayaclar. Istek suresi, arac suresi, LLM gecikmesi icin histogramlar. Varsayilan Node.js metrikleri (CPU, heap, GC, olay dongusu).

### WebSocket Paneli (`ENABLE_WEBSOCKET_DASHBOARD=true`)
Her saniye gonderilen gercek zamanli metrikler. Kimlik dogrulanmis baglantilari, heartbeat izlemeyi ve uygulama tarafinda kaydedilen komut/notification handler'larini destekler. `WEBSOCKET_DASHBOARD_AUTH_TOKEN` ayarliysa o bearer token kullanilir; ayarli degilse ayni origin dashboard process-scope bir token bootstrap eder.

### Metrik Sistemi
`MetricsStorage` (SQLite) gorev tamamlama oranini, iterasyon sayilarini, arac kullanimini ve kalip yeniden kullanimini kaydeder. `MetricsRecorder` oturum basina metrikleri yakalar. `metrics` CLI komutu gecmis metrikleri goruntulur.

---

## Dagitim

### Docker

```bash
docker-compose up -d
```

`docker-compose.yml` uygulamayi, izleme yiginini ve nginx ters proxy'yi icerir.

### Daemon Modu

```bash
# Kalp atisi dongusu ve proaktif tetikleyicilerle 7/24 otonom calisma
node dist/index.js start --channel web --daemon

# Ustel geri cekilme ile cokme durumunda otomatik yeniden baslatma (1sn - 60sn, 10 yeniden baslatmaya kadar)
node dist/index.js supervise --channel telegram
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
- [ ] Daemon butce sinirlarini yapilandirin (`RATE_LIMIT_DAILY_BUDGET_USD`)

---

## Test

```bash
npm test                         # Varsayilan tam suite (stabilite icin batch'li)
npm run test:watch               # Izleme modu
npm test -- --coverage           # Kapsam ile
npm test -- src/agents/tools/file-read.test.ts  # Tekli dosya / hedefli gecis
npm test -- src/dashboard/prometheus.test.ts    # Varsayilan runner ile hedefli suite
LOCAL_SERVER_TESTS=1 npm test -- src/dashboard/prometheus.test.ts src/dashboard/websocket-server.test.ts
npm run sync:check -- --core-path /path/to/Strada.Core  # Strada.Core API drift dogrulamasi
npm run test:file-build-flow     # Opt-in local .NET entegrasyon akisi
npm run test:unity-fixture       # Opt-in local Unity fixture derleme/test akisi
npm run test:hnsw-perf           # Opt-in HNSW benchmark / recall suiti
npm run test:portal              # Web portal smoke testleri
npm run typecheck                # TypeScript tip kontrolu
npm run lint                     # ESLint
```

Notlar:
- `npm test`, onceki full-suite OOM yolunu onlemek icin batch'li Vitest runner ve fork worker'lar kullanir.
- Socket bind bagimli dashboard testleri varsayilan olarak skip edilir; gercek local dogrulama icin `LOCAL_SERVER_TESTS=1` kullanin.
- `sync:check`, Strada.Brain'in Strada.Core bilgisini gercek bir checkout'a karsi dogrular; CI bunu `--max-drift-score 0` ile zorlar.
- `test:file-build-flow`, `test:unity-fixture` ve `test:hnsw-perf`, local build araci, lisansli Unity editoru veya agir benchmark yukleri gerektirdigi icin bilincli olarak opt-in tutulur.
- `test:unity-fixture`, uretilen kod dogru olsa bile local Unity batchmode / lisans ortami sagliksizsa fail edebilir.

---

## Proje Yapisi

```
src/
  index.ts              # CLI giris noktasi (Commander.js)
  core/
    bootstrap.ts        # Tam baslatma sirasi -- tum baglanti burada yapilir
    event-bus.ts        # Ayrisik olay gudumlu iletisim icin TypedEventBus
    tool-registry.ts    # Arac ornekleme ve kayit
  agents/
    orchestrator.ts     # PAOR ajan dongusu, oturum yonetimi, akis
    agent-state.ts      # Asama durum makinesi (Plan/Eylem/Gozlem/Yansima)
    paor-prompts.ts     # Asama duyarli prompt olusturucular
    instinct-retriever.ts # Proaktif ogrenilmis kalip getirme
    failure-classifier.ts # Hata kategorilendirme ve otomatik yeniden planlama tetikleyicileri
    autonomy/           # Hata kurtarma, gorev planlama, oz-dogrulama
    context/            # Sistem istemi (Strada.Core bilgi tabani)
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq, + dahasi
    tools/              # 30+ arac uygulamasi (ask_user, show_plan, switch_personality, ...)
    soul/               # SOUL.md kisilik yukleyici, sicak yeniden yukleme ve kanal bazli gecikmeler ile
    plugins/            # Harici eklenti yukleyici
  profiles/             # Kisilik profil dosyalari: casual.md, formal.md, minimal.md
  channels/
    telegram/           # Grammy tabanli bot
    discord/            # discord.js bot, slash komutlari ile
    slack/              # Slack Bolt (soket modu) Block Kit ile
    whatsapp/           # Baileys tabanli istemci, oturum yonetimi ile
    web/                # Yerel HTTP + WebSocket web kanali
    cli/                # Readline REPL
  web-portal/           # React + Vite sohbet arayuzu (koyu/acik tema, dosya yukleme, akis, panel sekme, yan panel)
  memory/
    file-memory-manager.ts   # Eski arka uc: JSON + TF-IDF (yedek)
    unified/
      agentdb-memory.ts      # Aktif arka uc: SQLite + HNSW, 3 katmanli otomatik kademelenme
      agentdb-adapter.ts     # AgentDBMemory icin IMemoryManager adaptoru
      migration.ts           # Eski FileMemoryManager -> AgentDB gocu
      consolidation-engine.ts # HNSW kumeleme ile bellek konsolidasyonu
      consolidation-types.ts  # Konsolidasyon tip tanimlari
    decay/                   # Ustel bozunum ve bellek yasam dongusu
  rag/
    rag-pipeline.ts     # Indeksleme + arama + bicimlendirme orkestrasyonu
    chunker.ts          # C#'a ozel yapisal parcalama
    hnsw/               # HNSW vektor deposu (hnswlib-node)
    embeddings/         # OpenAI ve Ollama gomme saglayicilari
    reranker.ts         # Agirlikli yeniden siralama (vektor + anahtar kelime + yapisal)
  learning/
    pipeline/
      learning-pipeline.ts  # Kalip tespiti, icgudu olusturma, gelisim onerileri
      learning-queue.ts     # Olay gudumlu ogrenme icin seri asenkron isleyici
      embedding-queue.ts    # Sinirli asenkron gomme olusturma
    scoring/
      confidence-scorer.ts  # Hibrit agirlikli guven (5 faktor), Elo, Wilson araliklari
    matching/
      pattern-matcher.ts    # Anahtar kelime + anlamsal kalip esleme
    hooks/
      error-learning-hooks.ts  # Hata/cozum yakalama kancarilari
    storage/
      learning-storage.ts  # Icguduler, yollar, kalipler icin SQLite depolama
      migrations/          # Sema gocleri (oturumlar arasi koken)
    chains/
      chain-detector.ts    # Yinelenen arac dizisi tespiti
      chain-synthesizer.ts # LLM tabanli bilesik arac olusturma
      composite-tool.ts    # Yurutulebilir bilesik arac
      chain-validator.ts   # Sentez sonrasi dogrulama, calisma zamani geri bildirimi
      chain-manager.ts     # Tam yasam dongusu orkestrasyonu
  multi-agent/
    agent-manager.ts       # Kanal/oturum bazinda ajan olusturma ve yonetim
    agent-budget-tracker.ts # Ajan bazinda token ve maliyet takibi
    agent-registry.ts      # Aktif ajanlarin merkezi kaydi
  delegation/
    delegation-manager.ts  # Delegasyon yasam dongusu yonetimi
    delegation-tool.ts     # Ajan delegasyon araci
    tier-router.ts         # 4 seviyeli gorev siniflandirma yonlendiricisi
  goals/
    goal-decomposer.ts  # DAG tabanli hedef ayristirma (proaktif + reaktif)
    goal-executor.ts    # Basarisizlik butceli dalga tabanli paralel yurutme
    goal-validator.ts   # Kahn algoritmasi ile DAG dongu tespiti
    goal-storage.ts     # Hedef agaclari icin SQLite kaliciligi
    goal-progress.ts    # Ilerleme takibi ve raporlama
    goal-resume.ts      # Yeniden baslatma sonrasi yarida kalan hedef agaclarini devam ettirme
    goal-renderer.ts    # Hedef agaci gorselltestirmesi
  daemon/
    heartbeat-loop.ts   # Temel tik-degerlendir-atesle dongusu
    trigger-registry.ts # Tetikleyici kayit ve yasam dongusu
    daemon-storage.ts   # Daemon durumu icin SQLite kaliciligi
    daemon-events.ts    # Daemon alt sistemi icin tipli olay tanimlari
    daemon-cli.ts       # Daemon yonetimi icin CLI komutlari
    budget/
      budget-tracker.ts # Gunluk USD butce takibi
    resilience/
      circuit-breaker.ts # Ustel geri cekilmeli tetikleyici bazinda devre kesici
    security/
      daemon-security-policy.ts  # Daemon icin arac onay gereksinimleri
      approval-queue.ts          # Sure dolumlu onay istegi kuyrugu
    dedup/
      trigger-deduplicator.ts    # Icerik + soguma tekilestirmesi
    triggers/
      cron-trigger.ts        # Cron ifadesi zamanlama
      file-watch-trigger.ts  # Dosya sistemi degisiklik izleme
      checklist-trigger.ts   # Vadesi gelen kontrol listesi ogeleri
      webhook-trigger.ts     # HTTP POST webhook uc noktasi
      deploy-trigger.ts      # Dagitim kosulu tetikleyicisi
    deployment/
      deployment-executor.ts # Geri alma destekli dagitim yurutucusu
      readiness-checker.ts   # Dagitim oncesi hazirlik kontrolu
    reporting/
      notification-router.ts # Aciliyet tabanli bildirim yonlendirme
      digest-reporter.ts     # Periyodik ozet rapor olusturma
      digest-formatter.ts    # Kanallar icin ozet rapor bicimlendirme
      quiet-hours.ts         # Kritik olmayan bildirim tamponlama
  identity/
    identity-state.ts   # Kalici ajan kimligi (UUID, baslangic sayisi, calisma suresi)
    crash-recovery.ts   # Cokme tespiti ve kurtarma baglami
  tasks/
    task-manager.ts     # Gorev yasam dongusu yonetimi
    task-storage.ts     # SQLite gorev kaliciligi
    background-executor.ts # Hedef entegrasyonlu arka plan gorev yurutmesi
    message-router.ts   # Orkestratora mesaj yonlendirme
    command-detector.ts # Egikcizgi komut tespiti
    command-handler.ts  # Komut yurutme
  metrics/
    metrics-storage.ts  # SQLite metrik depolama
    metrics-recorder.ts # Oturum basina metrik yakalama
    metrics-cli.ts      # CLI metrik goruntuleme komutu
  utils/
    media-processor.ts  # Medya indirme, dogrulama (MIME/boyut/sihirli bayt), SSRF korumasi
  security/             # Kimlik dogrulama, RBAC, yol korumasi, hiz sinirlamasi, gizli bilgi temizleyici
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
