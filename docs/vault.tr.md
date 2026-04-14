# Codebase Memory Vault

> Ceviri notu: Guncel calisma zamani davranisi, ortam degiskenleri ve API semantigi icin kanonik kaynak [docs/vault.md](vault.md) dosyasidir. Bu dosya onun Turkce cevirisidir.

Proje basina kalici kod tabani bellegi. Her istekte dosyalari bastan okumak yerine, Strada.Brain sizin (Unity) projenizi ve kendi kaynak kodunu **hatirlar**: hibrit (BM25 + vector) ve sembolik (call/import grafigi uzerinde Personalized PageRank) arama saglar, watcher + write-hook ile guncel tutar, bagli dosyalari token butcesine gore paketler.

v4.2.69 (PR #11) ile iki fazda geldi:

- **Phase 1** — Hibrit geri getirim (BM25 + HNSW + RRF)
- **Phase 2** — Sembol grafigi, PPR, SelfVault, Graph UI

---

## 1. Genel bakis

### Problem

Klasik agent calisma sekli her gorevde ayni maliyetleri yeniden oder:

- `glob` + `grep` + tam dosya `read` kombinasyonlari
- Buyuk dosyalarin konusmaya tekrar tekrar yuklenmesi
- Genis baglamin gurultuyle dolmasi, token butcesinin kritik parcalara yetmemesi
- Projeye ozgu yapisal bilginin (kim kimi cagiriyor, hangi sinif nerede tanimli) oturumlar arasi kaybolmasi

### Cozum

Vault her projenin sahibi oldugu, yerel, kalici bir indekstir:

- **Proje basina SQLite** (`<proje>/.strada/vault/index.db`) — WAL, foreign keys acik
- **Hibrit retrieval** — FTS5 BM25 + HNSW vector + Reciprocal Rank Fusion (k=60)
- **Sembol grafigi** — tree-sitter ile TypeScript, C#, Markdown icin call/import/wikilink kenarlari
- **Personalized PageRank** — belirli dosyalara yakin parcalari one cikarir
- **SelfVault** — Strada.Brain kendi kaynagini da indeksler (`src/`, `docs/`, `AGENTS.md`...)
- **Canli guncelleme** — chokidar watcher + write-hook (agent kendi yazimlarini aninda indeksler)
- **Hash short-circuit** — xxhash64 sayesinde degismemis dosyalar embed yeniden uretmez

Sonuc: daha az token, daha cok alakaliligi yuksek baglam, oturumlar arasi kalici proje bellegi.

---

## 2. Hizli baslangic

```bash
# 1. Ozelligi acik hale getirin (varsayilan kapali)
export STRADA_VAULT_ENABLED=true

# 2. Strada.Brain'i baslatin
npm start
```

Sohbette (web portal, Telegram, Discord, CLI — hangi kanali kullaniyorsaniz):

```
/vault init /unity/projenin/mutlak/yolu
/vault sync
/vault status
```

`vault.enabled=true` iken **SelfVault** da baslangicta otomatik yuklenir — Strada.Brain kendi kaynak kodunu hatirlamaya hemen baslar.

Portal tarafinda `http://localhost:3000/admin/vaults` sayfasindan Files / Search / Graph sekmelerine erisirsiniz.

---

## 3. Mimari genel bakis

Vault uc katmanli bir hafiza gibi dusunulebilir:

| Katman | Ne tutar | Tablolar / dosyalar |
|--------|----------|---------------------|
| **L1 — Dosya metadata** | Dosya yolu, dil, boyut, hash, mtime | `vault_files` |
| **L2 — Sembol grafigi** | Sinif/fonksiyon/metot dugumleri, `calls` / `imports` / `wikilinks` kenarlari | `vault_symbols`, `vault_edges`, `vault_wikilinks`, `graph.canvas` |
| **L3 — Hibrit parcalar** | Chunk metni, FTS posting'i, embedding pointer'i | `vault_chunks`, `vault_chunks_fts`, `vault_embeddings` |

Meta bilgi (indexer versiyonu, son sync, istatistikler) `vault_meta` tablosunda tutulur. Phase 2 indexer versiyonu: `phase2.v1`.

Retrieval hatti:

```
sorgu
  -> BM25 (FTS5)       --\
  -> vector (HNSW)     --- > RRF birlestirme (k=60)
                                |
                    [opsiyonel] Personalized PageRank yeniden siralama
                                |
                          token butcesine gore packByBudget
                                |
                        orchestrator'a baglam olarak gider
```

---

## 4. Phase 1 — Hibrit geri getirim

Phase 1, vault'un iskeletidir: indekse al, sorgula, guncel tut.

### 4.1 Depolama

- Proje kok klasorunde `<proje>/.strada/vault/index.db`
- `better-sqlite3`, WAL modu, `foreign_keys=ON`
- Tablolar:
  - `vault_files` — dosya kayitlari
  - `vault_chunks` — kod/metin parcalari (satir aralikli)
  - `vault_chunks_fts` — FTS5 sanal tablosu (BM25 icin)
  - `vault_embeddings` — HNSW node pointer'lari
  - `vault_meta` — versiyon, sayaclar, son sync zamani

### 4.2 Hibrit retrieval

- **BM25** — FTS5 uzerinden lexical skor
- **Vector** — HNSW uzerinden semantik benzerlik
- **RRF** — iki sirali listeyi k=60 sabitiyle birlestirir, her iki tarafta zayif olan ama ortak cikan parcalar gercek degerinden uzakta kalmaz
- **packByBudget** — sonuc kumelerini verilen token butcesine gore diziye sokar; kirpma gerektiginde kenar parcalari cikarir, iskelet parcalari korur

### 4.3 Uc guncelleme yolu

| Yol | Ne zaman | Notlar |
|-----|----------|--------|
| **Watcher** | Kullanici veya harici arac dosya degistirdiginde | `chokidar`, varsayilan 800ms debounce |
| **Write-hook** | Strada.Brain kendi yazimini yaptiginda (`installWriteHook`) | 200ms senkron butce, sure asiminda asenkron kuyruga aktarilir |
| **Manuel `/vault sync`** | Kullanici tarafindan tetiklenir | Tam yeniden indeksleme; watcher kirli setini temizler |

Watcher kirli setini dagitim kanallari ile de bildirir: WebSocket uzerinden `vault:update` event'leri toplu (batched) olarak yayinlanir, boylece portal canli guncel kalir.

### 4.4 Hash short-circuit

Her indeksleme basina dosya icerigi icin `xxhash64` hesaplanir. Hash degismemisse:

- Yeniden parse yok
- Yeniden chunk yok
- **Yeniden embed yok** (en pahali adim)

Sonuc: `/vault sync` buyuk projelerde sadece gercekten degisen dosyalari dokunur.

### 4.5 Agent araclari

Tool registry'de kayitli ve herhangi bir kanaldan (slash komut veya LLM arac cagrisi olarak) cagrilabilir:

- `vault_init` — verilen dizin icin vault baslatir
- `vault_sync` — tam yeniden indeksleme yapar
- `vault_status` — ozet istatistikler dondurur

### 4.6 HTTP yuzeyi

Phase 1 ile gelen temel uc noktalar:

- `POST /api/vaults` — init / bootstrap
- `GET /api/vaults` — vault listesi
- `GET /api/vaults/:id/files` — agac / meta
- `POST /api/vaults/:id/search` — hibrit sorgu

---

## 5. Phase 2 — Sembol grafigi, PPR, SelfVault, Graph UI

Phase 2, vault'u duz bir arama indeksinden **yapisal proje bellegine** yukseltir.

### 5.1 Yeni tablolar

- `vault_symbols` — sembol dugumleri
- `vault_edges` — yonlu kenarlar (`calls`, `imports`, vb.)
- `vault_wikilinks` — Markdown `[[wikilink]]` baglantilari

`vault_meta.indexer_version` artik `phase2.v1`.

### 5.2 Sembol ID formati

```
<lang>::<relPath>::<qualifiedName>
```

Ornekler:

```
csharp::Assets/Scripts/Player.cs::Game.Player.Move
typescript::src/vault/ppr.ts::runPPR
markdown::docs/architecture.md::Agent Loop
```

Cozulemeyen externler (import'u baska bir paketten ama resolve edilmemis):

```
<lang>::unresolved::<label>
```

Sembol ID'leri butun API'lerde **ingilizce kalir** — dil agnostik, tekil, stabil string'lerdir.

### 5.3 Tree-sitter WASM extractor'lari

Konum: `src/vault/symbol-extractor/`

| Dil | Ne cikariyor |
|-----|--------------|
| **TypeScript** | class / function / method dugumleri, import kenarlari, method cagri kenarlari |
| **C#** | class / struct / method / property, `using`, method cagri kenarlari (Unity projeleri icin kritik) |
| **Markdown** | Baslik dugumleri, `[[wikilink]]` kenarlari |

Her cagri basina **yeni (taze) Parser instance** uretilir — tree-sitter state'i eszamanli indekslemede bozulmaz.

### 5.4 JSON Canvas dosyasi

`.strada/vault/graph.canvas` — [JSON Canvas 1.0](https://jsoncanvas.org/) formatinda yazilir.

- Cold start'ta, `/vault sync` sonrasinda ve watcher drain oldugunda yeniden uretilir
- Atomik yazim: **temp dosya + rename** (yarim yazim ve bozuk canvas durumunu engeller)

### 5.5 Personalized PageRank

`src/vault/ppr.ts` — sadece `VaultQuery.focusFiles` verildiginde devreye girer.

- Hibrit sonuclari (BM25 + vector + RRF) alir
- focus dosyalarindan damping ile PPR puanlari dagitir
- Sonuc sirasini grafa gore **yeniden siralar**

Damping formulu Phase 2 review'dan sonra normalize edildi (stationary distribution toplami = 1). Yani skorlar butun grafta karsilastirilabilir.

Kullanim senaryosu: "`PlayerController.cs`'i refactor ediyorum, ona baglanan her yeri goster" — focus olarak sadece o dosyayi verirsiniz, PPR call grafi uzerinden komsu dosyalari one cikarir.

### 5.6 SelfVault

`src/vault/self-vault.ts` — Strada.Brain **kendi kaynak kodunu** indeksler.

Indekslenen kokler:

- `src/`
- `web-portal/src/`
- `tests/`
- `docs/`
- `AGENTS.md`
- `CLAUDE.md`

Guvenlik: **symlink keshif sirasinda atlanir** (dizin kacisi / symlink loop onleme).

`vault.enabled=true` ise SelfVault baslangicta otomatik yuklenir — ajanin kendi davranisi, tool sozlesmesi veya mimariye dair sorular projenin vault'unu kirletmeden cevaplanabilir.

### 5.7 Graph tab (Portal)

Portal `/admin/vaults` sayfasina **Graph** sekmesi eklendi.

- Render: `@xyflow/react` + `@dagrejs/dagre` layout
- Kaynak: `GET /api/vaults/:id/canvas` ile sunulan `graph.canvas`
- Sembol uzerine tiklandiginda: gelen cagrilar (`/callers`) ve ad arama (`/symbols/by-name`) uc noktalari kullanilabilir

---

## 6. Konfigurasyon referansi

`config.vault` altindaki tum alanlar ve env karsiliklari:

| Alan | Varsayilan | Env | Aciklama |
|------|-----------|-----|----------|
| `enabled` | `false` | `STRADA_VAULT_ENABLED` | Vault alt sistemini ac/kapat |
| `writeHookBudgetMs` | `200` | `STRADA_VAULT_WRITE_HOOK_BUDGET_MS` | Write-hook senkron butcesi (ms). Asimda asenkron kuyruk. |
| `debounceMs` | `800` | `STRADA_VAULT_DEBOUNCE_MS` | Chokidar watcher debounce suresi (ms) |
| `embeddingFallback` | `'local'` | — | `'none'` veya `'local'`. Saglayici embedding dondurmezse davranis. |
| `self.enabled` | `true` | — | SelfVault'u devre disi birakmak icin `false` yapin |

Minimal acma:

```bash
export STRADA_VAULT_ENABLED=true
npm start
```

SelfVault'u kapatma (sadece kullanici projelerini indeksle):

```jsonc
// config/strada.json
{
  "vault": {
    "enabled": true,
    "self": { "enabled": false }
  }
}
```

---

## 7. HTTP API referansi

Tum vault uc noktalari `http://localhost:3000` altinda, `127.0.0.1` dinleyicisinde servis edilir (guvenlik icin).

### Phase 1

| Metod | Yol | Aciklama |
|-------|-----|----------|
| `POST` | `/api/vaults` | Vault init / bootstrap |
| `GET` | `/api/vaults` | Kayitli vault'lari listele |
| `GET` | `/api/vaults/:id/files` | Dosya agaci ve metadata |
| `POST` | `/api/vaults/:id/search` | Hibrit sorgu (BM25 + vector + RRF). **Request body maxBytes sinirli** (DoS koruma). |

### Phase 2

| Metod | Yol | Aciklama |
|-------|-----|----------|
| `GET` | `/api/vaults/:id/canvas` | JSON Canvas 1.0 graph.canvas dosyasini servis eder |
| `GET` | `/api/vaults/:id/symbols/by-name?q=X` | Kisa isimle sembol ara (ornegin `q=Move`) |
| `GET` | `/api/vaults/:id/symbols/:symbolId/callers` | Verilen sembole gelen cagri kenarlari. **Sonuc sayisi sinirli.** |

WebSocket: `vault:update` event'leri watcher debounce sonucu toplu (batched) olarak yayilir.

---

## 8. Portal UI rehberi

`http://localhost:3000/admin/vaults` uc sekme sunar:

### Files tab

- Sol: dosya agaci
- Sag: secilen dosya icin markdown ve raw onizleme
- Gostergeler: hash, son guncelleme, chunk sayisi

### Search tab

- Ustte: sorgu giris alani
- Altta: hibrit sonuc listesi (BM25 + vector + RRF birlesimi)
- Sonuc tiklandiginda ilgili dosya ve chunk onizlemesi acilir
- `focusFiles` parametresi verildiginde sonuclar PPR ile yeniden siralanir

### Graph tab

- `@xyflow/react` + `@dagrejs/dagre` ile render edilen proje call / import grafi
- Node tiklamasi ile sembole ait gelen cagrilar acilir
- Isimle sembol arama kutusu ile graf icinde hizlica gezinilir

---

## 9. Guvenlik durusu

Phase 2 code review sirasinda tespit edilen ve commit `5563d48` ile sikilastirilan noktalar:

- **Atomik canvas yazimi** — temp dosya + rename; yarim yazim / bozuk canvas yok
- **SelfVault symlink atlama** — dizin kacisi / symlink loop onleme
- **Taze tree-sitter Parser instance** — her cagrida yeni parser; eszamanlilik guvenligi
- **Search endpoint request body maxBytes** — DoS ve bellek sisirme korumasi
- **Yetim edge GC** — dosya silindiginde kenarlari temizle
- **PPR damping normalize** — stationary distribution toplami 1, skorlar grafta kiyaslanabilir
- **Dosya basina 2MB sembol cikarma siniri** — patolojik buyuk dosyalarda extractor kilitlenmesin
- **`reindexFile` edge cache invalidation** — guncel dosya icin eski kenarlar cache'te kalmasin
- **`findCallers` sonuc siniri** — hot sembollerde response patlamasini engeller

Diger alt yapi guvenligi:

- Portal ve vault HTTP uc noktalari **yalnizca `127.0.0.1`** dinler
- `.strada/vault/` dosyalari git gibi araclardan otomatik haric tutulur (proje `.gitignore` yonetimi size aittir)

---

## 10. Yol haritasi (Phase 3)

- **Haiku rolling ozetleri** — uzun parcalarda snapshot / ozet ureten Haiku tabanli katman
- **FrameworkVault yukseltmesi** — framework (Strada.Core, Unity) dokumantasyonu icin semantik arama + docstring cikarimi
- **Iki yonlu Learning pipeline baglantisi** — vault'tan cagri ve kullanim sinyalleri ogrenme sistemine beslenir, icguduler bunlarla guclenir

---

## 11. Kaynaklar

- Kaynak kod: [`src/vault/`](../src/vault/)
- Ingilizce referans: [`docs/vault.md`](vault.md)
- Mimari bagimli belgeler:
  - [`docs/architecture.md`](architecture.md)
  - [`docs/web-channel.md`](web-channel.md)
  - [`docs/agent-evolution.md`](agent-evolution.md)
