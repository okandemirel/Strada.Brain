<p align="center">
  <img src="docs/assets/logo.svg" alt="Strada.Brain Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>KI-gesteuerter Entwicklungs-Agent fuer Unity / Strada.Core-Projekte</strong><br/>
  Ein autonomer Coding-Agent, der sich mit einem Web-Dashboard, Telegram, Discord, Slack, WhatsApp oder Ihrem Terminal verbindet &mdash; Ihre Codebasis liest, Code schreibt, Builds ausfuehrt und aus seinen Fehlern lernt.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.zh.md">中文</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a> |
  <strong>Deutsch</strong> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a>
</p>

---

## Was ist das?

Strada.Brain ist ein KI-Agent, mit dem Sie ueber einen Chat-Kanal kommunizieren. Sie beschreiben, was Sie moechten -- "erstelle ein neues ECS-System fuer Spielerbewegung" oder "finde alle Komponenten, die Health verwenden" -- und der Agent liest Ihr C#-Projekt, schreibt den Code, fuehrt `dotnet build` aus, behebt Fehler automatisch und sendet Ihnen das Ergebnis. Er verfuegt ueber persistenten Speicher, lernt aus vergangenen Fehlern und kann mehrere KI-Anbieter mit automatischem Failover nutzen.

**Dies ist keine Bibliothek und keine API.** Es ist eine eigenstaendige Anwendung, die Sie ausfuehren. Sie verbindet sich mit Ihrer Chat-Plattform, liest Ihr Unity-Projekt von der Festplatte und arbeitet autonom innerhalb der von Ihnen konfigurierten Grenzen.

---

## Schnellstart

### Voraussetzungen

- **Node.js 20+** und npm
- Ein **Anthropic API-Schluessel** (Claude) -- andere Anbieter sind optional
- Ein **Unity-Projekt** mit dem Strada.Core-Framework (der Pfad, den Sie dem Agenten geben)

### 1. Installation

```bash
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain
npm install
```

### 2. Konfiguration

```bash
cp .env.example .env
```

Oeffnen Sie `.env` und setzen Sie mindestens:

```env
ANTHROPIC_API_KEY=sk-ant-...      # Ihr Claude API-Schluessel
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Muss Assets/ enthalten
JWT_SECRET=<generieren mit: openssl rand -hex 64>
```

### 3. Starten

```bash
# Web-Kanal (Standard) -- Setup-Assistent wird unter localhost:3000 oeffnet
# Falls keine .env vorhanden ist, leitet der Assistent Sie durch die Ersteinrichtung
npm start

# Oder explizit mit Web-Kanal
npm run dev -- start --channel web

# Interaktiver CLI-Modus (schnellster Weg zum Testen)
npm run dev -- cli

# Oder mit anderen Chat-Kanaelen
npm run dev -- start --channel telegram
npm run dev -- start --channel discord
npm run dev -- start --channel slack
npm run dev -- start --channel whatsapp
```

### 4. Kommunizieren

Sobald der Agent laeuft, senden Sie eine Nachricht ueber Ihren konfigurierten Kanal:

```
> Analysiere die Projektstruktur
> Erstelle ein neues Modul namens "Combat" mit einem DamageSystem und einer HealthComponent
> Finde alle Systeme, die PositionComponent abfragen
> Fuehre den Build aus und behebe alle Fehler
```

**Web-Kanal:** Kein Terminal erforderlich -- interagieren Sie ueber das Web-Dashboard unter `localhost:3000`.

---

## Architektur

```
+-----------------------------------------------------------------+
|  Chat-Kanaele                                                    |
|  Web | Telegram | Discord | Slack | WhatsApp | CLI              |
+------------------------------+----------------------------------+
                               |
                    IChannelAdapter-Interface
                               |
+------------------------------v----------------------------------+
|  Orchestrator (Agent-Schleife)                                   |
|  System-Prompt + Speicher + RAG-Kontext -> LLM -> Tool-Aufrufe   |
|  Bis zu 50 Tool-Iterationen pro Nachricht                        |
|  Autonomie: Fehlerbehebung, Stall-Erkennung, Build-Verifikation |
+------------------------------+----------------------------------+
                               |
          +--------------------+--------------------+
          |                    |                    |
+---------v------+  +---------v------+  +----------v---------+
| KI-Anbieter    |  | 30+ Tools      |  | Kontextquellen     |
| Claude (prim.) |  | Datei-I/O      |  | Speicher (TF-IDF)  |
| OpenAI, Kimi   |  | Git-Operationen|  | RAG (HNSW-Vektoren)|
| DeepSeek, Qwen |  | Shell-Ausfuehr.|  | Projektanalyse     |
| MiniMax, Groq  |  | .NET Build/Test|  | Lernmuster         |
| Ollama (lokal) |  | Browser        |  +--------------------+
| + 4 weitere    |  | Strata Codegen |
+----------------+  +----------------+
```

### Wie die Agent-Schleife funktioniert

1. **Nachricht trifft ein** von einem Chat-Kanal
2. **Speicherabruf** -- findet die 3 relevantesten vergangenen Konversationen (TF-IDF)
3. **RAG-Abruf** -- semantische Suche ueber Ihre C#-Codebasis (HNSW-Vektoren, Top 6 Ergebnisse)
4. **Zwischengespeicherte Analyse** -- fuegt Projektstruktur ein, falls zuvor analysiert
5. **LLM-Aufruf** mit System-Prompt + Kontext + Tool-Definitionen
6. **Tool-Ausfuehrung** -- wenn das LLM Tools aufruft, werden diese ausgefuehrt und die Ergebnisse an das LLM zurueckgegeben
7. **Autonomie-Pruefungen** -- Fehlerbehebung analysiert Fehler, Stall-Detektor warnt bei Blockaden, Selbst-Verifikation erzwingt einen `dotnet build` vor der Antwort, wenn `.cs`-Dateien geaendert wurden
8. **Wiederholung** bis zu 50 Iterationen, bis das LLM eine finale Textantwort produziert
9. **Antwort wird gesendet** an den Benutzer ueber den Kanal (Streaming, falls unterstuetzt)

---

## Konfigurationsreferenz

Alle Konfigurationen erfolgen ueber Umgebungsvariablen. Siehe `.env.example` fuer die vollstaendige Liste.

### Erforderlich

| Variable | Beschreibung |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API-Schluessel (primaerer LLM-Anbieter) |
| `UNITY_PROJECT_PATH` | Absoluter Pfad zum Stammverzeichnis Ihres Unity-Projekts (muss `Assets/` enthalten) |
| `JWT_SECRET` | Geheimnis fuer JWT-Signierung. Generieren: `openssl rand -hex 64` |

### KI-Anbieter

Jeder OpenAI-kompatible Anbieter funktioniert. Alle unten aufgefuehrten Anbieter sind bereits implementiert und benoetigen nur einen API-Schluessel zur Aktivierung.

| Variable | Anbieter | Standard-Modell |
|----------|----------|-----------------|
| `ANTHROPIC_API_KEY` | Claude (primaer) | `claude-sonnet-4-20250514` |
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
| `OLLAMA_BASE_URL` | Ollama (lokal) | `llama3` |
| `PROVIDER_CHAIN` | Failover-Reihenfolge | z.B. `claude,kimi,deepseek,ollama` |

**Anbieter-Kette:** Setzen Sie `PROVIDER_CHAIN` auf eine kommagetrennte Liste von Anbieternamen. Das System probiert jeden der Reihe nach aus und faellt bei einem Fehler auf den naechsten zurueck. Beispiel: `PROVIDER_CHAIN=kimi,deepseek,claude` verwendet Kimi zuerst, DeepSeek wenn Kimi fehlschlaegt, dann Claude.

### Chat-Kanaele

**Web:**
| Variable | Beschreibung |
|----------|-------------|
| `WEB_CHANNEL_PORT` | Port fuer Web-Dashboard (Standard: `3000`) |

**Telegram:**
| Variable | Beschreibung |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token von @BotFather |
| `ALLOWED_TELEGRAM_USER_IDS` | Kommagetrennte Telegram-Benutzer-IDs (erforderlich, blockiert alle wenn leer) |

**Discord:**
| Variable | Beschreibung |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Discord-Bot-Token |
| `DISCORD_CLIENT_ID` | Discord-Anwendungs-Client-ID |
| `ALLOWED_DISCORD_USER_IDS` | Kommagetrennte Benutzer-IDs (blockiert alle wenn leer) |
| `ALLOWED_DISCORD_ROLE_IDS` | Kommagetrennte Rollen-IDs fuer rollenbasierten Zugriff |

**Slack:**
| Variable | Beschreibung |
|----------|-------------|
| `SLACK_BOT_TOKEN` | `xoxb-...` Bot-Token |
| `SLACK_APP_TOKEN` | `xapp-...` App-Level-Token (fuer Socket-Modus) |
| `SLACK_SIGNING_SECRET` | Signaturgeheimnis der Slack-App |
| `ALLOWED_SLACK_USER_IDS` | Kommagetrennte Benutzer-IDs (**offen fuer alle wenn leer**) |
| `ALLOWED_SLACK_WORKSPACES` | Kommagetrennte Workspace-IDs (**offen fuer alle wenn leer**) |

**WhatsApp:**
| Variable | Beschreibung |
|----------|-------------|
| `WHATSAPP_SESSION_PATH` | Verzeichnis fuer Sitzungsdateien (Standard: `.whatsapp-session`) |
| `WHATSAPP_ALLOWED_NUMBERS` | Kommagetrennte Telefonnummern |

### Funktionen

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `RAG_ENABLED` | `true` | Semantische Code-Suche ueber Ihr C#-Projekt aktivieren |
| `EMBEDDING_PROVIDER` | `openai` | Embedding-Anbieter: `openai` oder `ollama` |
| `MEMORY_ENABLED` | `true` | Persistenten Konversationsspeicher aktivieren |
| `MEMORY_DB_PATH` | `.strata-memory` | Verzeichnis fuer Speicher-Datenbankdateien |
| `WEB_CHANNEL_PORT` | `3000` | Port fuer Web-Dashboard |
| `DASHBOARD_ENABLED` | `false` | HTTP-Monitoring-Dashboard aktivieren |
| `DASHBOARD_PORT` | `3001` | Dashboard-Server-Port |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | WebSocket-Echtzeit-Dashboard aktivieren |
| `ENABLE_PROMETHEUS` | `false` | Prometheus-Metriken-Endpunkt aktivieren (Port 9090) |
| `READ_ONLY_MODE` | `false` | Alle Schreiboperationen blockieren |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` oder `debug` |

### Ratenbegrenzung

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `RATE_LIMIT_ENABLED` | `false` | Ratenbegrenzung aktivieren |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | `0` | Nachrichtenlimit pro Benutzer pro Minute (0 = unbegrenzt) |
| `RATE_LIMIT_MESSAGES_PER_HOUR` | `0` | Stuendliches Limit pro Benutzer |
| `RATE_LIMIT_TOKENS_PER_DAY` | `0` | Globales taegliches Token-Kontingent |
| `RATE_LIMIT_DAILY_BUDGET_USD` | `0` | Taegliche Ausgabenobergrenze in USD |
| `RATE_LIMIT_MONTHLY_BUDGET_USD` | `0` | Monatliche Ausgabenobergrenze in USD |

### Sicherheit

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `REQUIRE_MFA` | `false` | Multi-Faktor-Authentifizierung erfordern |
| `BROWSER_HEADLESS` | `true` | Browser-Automatisierung im Headless-Modus ausfuehren |
| `BROWSER_MAX_CONCURRENT` | `5` | Maximale gleichzeitige Browser-Sitzungen |

---

## Tools

Der Agent verfuegt ueber mehr als 30 integrierte Tools, organisiert nach Kategorie:

### Dateioperationen
| Tool | Beschreibung |
|------|-------------|
| `file_read` | Dateien lesen mit Zeilennummern, Offset/Limit-Paginierung (512KB-Limit) |
| `file_write` | Dateien erstellen oder ueberschreiben (256KB-Limit, erstellt Verzeichnisse automatisch) |
| `file_edit` | Suchen-und-Ersetzen-Bearbeitung mit Eindeutigkeitspruefung |
| `file_delete` | Eine einzelne Datei loeschen |
| `file_rename` | Dateien innerhalb des Projekts umbenennen oder verschieben |
| `file_delete_directory` | Rekursive Verzeichnislöschung (50-Dateien-Sicherheitsgrenze) |

### Suche
| Tool | Beschreibung |
|------|-------------|
| `glob_search` | Dateien nach Glob-Muster finden (max. 50 Ergebnisse) |
| `grep_search` | Regex-Inhaltssuche ueber Dateien (max. 20 Treffer) |
| `list_directory` | Verzeichnislisting mit Dateigroessen |
| `code_search` | Semantische/Vektorsuche via RAG -- natuerlichsprachliche Abfragen |
| `memory_search` | Persistenten Konversationsspeicher durchsuchen |

### Strada Code-Generierung
| Tool | Beschreibung |
|------|-------------|
| `strata_analyze_project` | Vollstaendiger C#-Projekt-Scan -- Module, Systeme, Komponenten, Services |
| `strata_create_module` | Vollstaendiges Modul-Geruest generieren (`.asmdef`, Konfiguration, Verzeichnisse) |
| `strata_create_component` | ECS-Komponentenstrukturen mit Felddefinitionen generieren |
| `strata_create_mediator` | `EntityMediator<TView>` mit Komponentenbindungen generieren |
| `strata_create_system` | `SystemBase`/`JobSystemBase`/`SystemGroup` generieren |

### Git
| Tool | Beschreibung |
|------|-------------|
| `git_status` | Arbeitsbaum-Status |
| `git_diff` | Aenderungen anzeigen |
| `git_log` | Commit-Verlauf |
| `git_commit` | Staging und Commit |
| `git_push` | Zum Remote pushen |
| `git_branch` | Branches auflisten, erstellen oder auschecken |
| `git_stash` | Stash erstellen, anwenden, auflisten oder verwerfen |

### .NET / Unity
| Tool | Beschreibung |
|------|-------------|
| `dotnet_build` | `dotnet build` ausfuehren, MSBuild-Fehler in strukturierte Ausgabe parsen |
| `dotnet_test` | `dotnet test` ausfuehren, Bestanden/Fehlgeschlagen/Uebersprungen-Ergebnisse parsen |

### Sonstiges
| Tool | Beschreibung |
|------|-------------|
| `shell_exec` | Shell-Befehle ausfuehren (30s Timeout, Sperrliste fuer gefaehrliche Befehle) |
| `code_quality` | Code-Qualitaetsanalyse pro Datei oder pro Projekt |
| `rag_index` | Inkrementelle oder vollstaendige Projekt-Neuindizierung ausloesen |

---

## Kanal-Funktionen

| Funktion | Web | Telegram | Discord | Slack | WhatsApp | CLI |
|----------|-----|----------|---------|-------|----------|-----|
| Textnachrichten | Ja | Ja | Ja | Ja | Ja | Ja |
| Streaming (In-Place-Bearbeitung) | Ja | Ja | Ja | Ja | Ja | Ja |
| Tipp-Anzeige | Ja | Ja | Ja | Nein | Ja | Nein |
| Bestaetigungsdialoge | Ja (Modal) | Ja (Inline-Tastatur) | Ja (Buttons) | Ja (Block Kit) | Ja (nummerierte Antwort) | Ja (Readline) |
| Datei-Uploads | Ja | Nein | Nein | Ja | Ja | Nein |
| Thread-Unterstuetzung | Nein | Nein | Ja | Ja | Nein | Nein |
| Ratenbegrenzer (ausgehend) | Ja (pro-Sitzung) | Nein | Ja (Token Bucket) | Ja (4-stufiges Schiebefenster) | Inline-Drosselung | Nein |

### Streaming

Alle Kanaele implementieren In-Place-Streaming. Die Antwort des Agenten erscheint progressiv, waehrend das LLM sie generiert. Updates werden plattformspezifisch gedrosselt, um Ratenlimits zu vermeiden (WhatsApp/Discord: 1/Sek., Slack: 2/Sek.).

### Authentifizierung

- **Telegram**: Standardmaessig alles blockiert. `ALLOWED_TELEGRAM_USER_IDS` muss gesetzt werden.
- **Discord**: Standardmaessig alles blockiert. `ALLOWED_DISCORD_USER_IDS` oder `ALLOWED_DISCORD_ROLE_IDS` muss gesetzt werden.
- **Slack**: **Standardmaessig offen.** Wenn `ALLOWED_SLACK_USER_IDS` leer ist, kann jeder Slack-Benutzer auf den Bot zugreifen. Setzen Sie die Erlaubnisliste fuer die Produktion.
- **WhatsApp**: Verwendet die `WHATSAPP_ALLOWED_NUMBERS`-Erlaubnisliste, die lokal im Adapter geprueft wird.

---

## Speichersystem

Das produktive Speicher-Backend ist `FileMemoryManager` -- JSON-Dateien mit TF-IDF-Textindizierung fuer die Suche.

**Funktionsweise:**
- Wenn der Sitzungsverlauf 40 Nachrichten ueberschreitet, werden alte Nachrichten zusammengefasst und als Konversationseintraege gespeichert
- Der Agent ruft automatisch die 3 relevantesten Erinnerungen vor jedem LLM-Aufruf ab
- Das Tool `strata_analyze_project` speichert die Projektstrukturanalyse im Cache fuer sofortige Kontexteinspeisung
- Der Speicher bleibt ueber Neustarts hinweg im Verzeichnis `MEMORY_DB_PATH` erhalten (Standard: `.strata-memory/`)

**Erweitertes Backend (implementiert, noch nicht verbunden):** `AgentDBMemory` mit SQLite + HNSW-Vektorsuche, dreistufiger Speicher (Arbeits-/Ephemer-/Persistentspeicher), hybride Abfrage (70% semantisch + 30% TF-IDF). Dies ist vollstaendig programmiert, aber nicht im Bootstrap verbunden -- `FileMemoryManager` ist das aktive Backend.

---

## RAG-Pipeline

Die RAG-Pipeline (Retrieval-Augmented Generation) indiziert Ihren C#-Quellcode fuer die semantische Suche.

**Indizierungsablauf:**
1. Scannt `**/*.cs`-Dateien in Ihrem Unity-Projekt
2. Zerlegt Code strukturell -- Datei-Header, Klassen, Methoden, Konstruktoren
3. Generiert Embeddings ueber OpenAI (`text-embedding-3-small`) oder Ollama (`nomic-embed-text`)
4. Speichert Vektoren im HNSW-Index fuer schnelle approximative Naechste-Nachbar-Suche
5. Laeuft automatisch beim Start (im Hintergrund, nicht-blockierend)

**Suchablauf:**
1. Die Abfrage wird mit demselben Anbieter eingebettet
2. Die HNSW-Suche liefert `topK * 3` Kandidaten
3. Reranker bewertet: Vektorsimilaritaet (60%) + Schluesselwort-Uebereinstimmung (25%) + Strukturbonus (15%)
4. Die besten 6 Ergebnisse (ueber Score 0.2) werden in den LLM-Kontext eingefuegt

**Hinweis:** Die RAG-Pipeline unterstuetzt derzeit nur C#-Dateien. Der Chunker ist C#-spezifisch.

---

## Lernsystem

Das Lernsystem beobachtet das Agentenverhalten und lernt aus Fehlern:

- **Fehlermuster** werden mit Volltextsuche-Indizierung erfasst
- **Loesungen** werden mit Fehlermustern fuer zukuenftige Abfragen verknuepft
- **Instinkte** sind atomare gelernte Verhaltensweisen mit Bayesschen Konfidenzwerten
- **Trajektorien** zeichnen Sequenzen von Tool-Aufrufen mit Ergebnissen auf
- Konfidenzwerte verwenden **Elo-Rating** und **Wilson-Score-Intervalle** fuer statistische Validitaet
- Instinkte unter 0.3 Konfidenz werden als veraltet markiert; ueber 0.9 werden zur Befoerderung vorgeschlagen

Die Lern-Pipeline laeuft auf Timern: Mustererkennung alle 5 Minuten, Evolutionsvorschlaege jede Stunde. Die Daten werden in einer separaten SQLite-Datenbank (`learning.db`) gespeichert.

---

## Sicherheit

### Schicht 1: Kanal-Authentifizierung
Plattformspezifische Erlaubnislisten, die beim Nachrichteneingang geprueft werden (vor jeder Verarbeitung).

### Schicht 2: Ratenbegrenzung
Pro-Benutzer-Schiebefenster (Minute/Stunde) + globale taegliche/monatliche Token- und USD-Budget-Obergrenzen.

### Schicht 3: Pfadschutz
Jede Dateioperation loest Symlinks auf und validiert, dass der Pfad innerhalb des Projektstammverzeichnisses bleibt. Ueber 30 sensible Muster werden blockiert (`.env`, `.git/credentials`, SSH-Schluessel, Zertifikate, `node_modules/`).

### Schicht 4: Geheimnis-Bereinigung
24 Regex-Muster erkennen und maskieren Anmeldeinformationen in allen Tool-Ausgaben, bevor sie das LLM erreichen. Abgedeckt: OpenAI-Schluessel, GitHub-Tokens, Slack-/Discord-/Telegram-Tokens, AWS-Schluessel, JWTs, Bearer-Auth, PEM-Schluessel, Datenbank-URLs und generische Geheimnis-Muster.

### Schicht 5: Nur-Lesen-Modus
Wenn `READ_ONLY_MODE=true`, werden 23 Schreib-Tools vollstaendig aus der Tool-Liste des Agenten entfernt -- das LLM kann nicht einmal versuchen, sie aufzurufen.

### Schicht 6: Operationsbestaetigung
Schreiboperationen (Dateischreibvorgaenge, Git-Commits, Shell-Ausfuehrung) koennen eine Benutzerbestaetigung ueber die interaktive Oberflaeche des Kanals erfordern (Buttons, Inline-Tastaturen, Text-Eingabeaufforderungen).

### Schicht 7: Tool-Ausgabe-Bereinigung
Alle Tool-Ergebnisse werden auf 8192 Zeichen begrenzt und vor der Rueckgabe an das LLM auf API-Schluessel-Muster geprueft.

### Schicht 8: RBAC (intern)
5 Rollen (Superadmin, Admin, Entwickler, Betrachter, Service) mit einer Berechtigungsmatrix fuer 9 Ressourcentypen. Die Richtlinien-Engine unterstuetzt zeit-, IP- und benutzerdefinierte Bedingungen.

---

## Dashboard & Monitoring

### HTTP-Dashboard (`DASHBOARD_ENABLED=true`)
Erreichbar unter `http://localhost:3001` (nur Localhost). Zeigt: Betriebszeit, Nachrichtenanzahl, Token-Verbrauch, aktive Sitzungen, Tool-Nutzungstabelle, Sicherheitsstatistiken. Automatische Aktualisierung alle 3 Sekunden.

### Health-Endpunkte
- `GET /health` -- Liveness-Probe (`{"status":"ok"}`)
- `GET /ready` -- Tiefgehende Bereitschaftspruefung: prueft Speicher und Kanal-Gesundheit. Gibt 200 (bereit), 207 (eingeschraenkt) oder 503 (nicht bereit) zurueck

### Prometheus (`ENABLE_PROMETHEUS=true`)
Metriken unter `http://localhost:9090/metrics`. Zaehler fuer Nachrichten, Tool-Aufrufe, Tokens. Histogramme fuer Anfragedauer, Tool-Dauer, LLM-Latenz. Standard-Node.js-Metriken (CPU, Heap, GC, Event Loop).

### WebSocket-Dashboard (`ENABLE_WEBSOCKET_DASHBOARD=true`)
Echtzeit-Metriken, die jede Sekunde gepusht werden. Unterstuetzt authentifizierte Verbindungen und Remote-Befehle (Plugin-Neuladen, Cache-Leerung, Log-Abruf).

---

## Deployment

### Docker

```bash
docker-compose up -d
```

Die `docker-compose.yml` beinhaltet die Anwendung, den Monitoring-Stack und den Nginx-Reverse-Proxy.

### Daemon-Modus

```bash
# Automatischer Neustart bei Absturz mit exponentiellem Backoff (1s bis 60s, bis zu 10 Neustarts)
node dist/index.js daemon --channel telegram
```

### Produktions-Checkliste

- [ ] `NODE_ENV=production` setzen
- [ ] `LOG_LEVEL=warn` oder `error` setzen
- [ ] `RATE_LIMIT_ENABLED=true` mit Budget-Obergrenzen konfigurieren
- [ ] Kanal-Erlaubnislisten setzen (besonders Slack -- standardmaessig offen)
- [ ] `READ_ONLY_MODE=true` setzen, wenn nur sichere Erkundung gewuenscht ist
- [ ] `DASHBOARD_ENABLED=true` fuer Monitoring aktivieren
- [ ] `ENABLE_PROMETHEUS=true` fuer Metrik-Erfassung aktivieren
- [ ] Einen starken `JWT_SECRET` generieren

---

## Testen

```bash
npm test                         # Alle 1560+ Tests ausfuehren
npm run test:watch               # Watch-Modus
npm test -- --coverage           # Mit Coverage
npm test -- src/agents/tools/file-read.test.ts  # Einzelne Datei
npm run typecheck                # TypeScript-Typpruefung
npm run lint                     # ESLint
```

94 Testdateien, die abdecken: Agenten, Kanaele, Sicherheit, RAG, Speicher, Lernen, Dashboard, Integrationsablaeufe.

---

## Projektstruktur

```
src/
  index.ts              # CLI-Einstiegspunkt (Commander.js)
  core/
    bootstrap.ts        # Vollstaendige Initialisierungssequenz -- gesamte Verdrahtung hier
    di-container.ts     # DI-Container (verfuegbar, aber manuelle Verdrahtung dominiert)
    tool-registry.ts    # Tool-Instanziierung und -Registrierung
  agents/
    orchestrator.ts     # Kern-Agent-Schleife, Sitzungsverwaltung, Streaming
    autonomy/           # Fehlerbehebung, Aufgabenplanung, Selbst-Verifikation
    context/            # System-Prompt (Strada.Core-Wissensbasis)
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq + weitere
    tools/              # 30+ Tool-Implementierungen
    plugins/            # Externer Plugin-Loader
  channels/
    telegram/           # Grammy-basierter Bot
    discord/            # discord.js-Bot mit Slash-Befehlen
    slack/              # Slack Bolt (Socket-Modus) mit Block Kit
    whatsapp/           # Baileys-basierter Client mit Sitzungsverwaltung
    cli/                # Readline-REPL
  memory/
    file-memory-manager.ts   # Aktives Backend: JSON + TF-IDF
    unified/                 # AgentDB-Backend: SQLite + HNSW (noch nicht verbunden)
  rag/
    rag-pipeline.ts     # Index + Suche + Format-Orchestrierung
    chunker.ts          # C#-spezifisches strukturelles Chunking
    hnsw/               # HNSW-Vektorspeicher (hnswlib-node)
    embeddings/         # OpenAI- und Ollama-Embedding-Anbieter
    reranker.ts         # Gewichtetes Reranking (Vektor + Schluesselwort + Struktur)
  security/             # Auth, RBAC, Pfadschutz, Ratenbegrenzer, Geheimnis-Bereinigung
  learning/             # Mustererkennung, Konfidenzbewertung, Instinkt-Lebenszyklus
  intelligence/         # C#-Parsing, Projektanalyse, Code-Qualitaet
  dashboard/            # HTTP-, WebSocket-, Prometheus-Dashboards
  config/               # Zod-validierte Umgebungskonfiguration
  validation/           # Eingabevalidierungsschemas
```

---

## Mitwirken

Siehe [CONTRIBUTING.md](CONTRIBUTING.md) fuer Entwicklungs-Setup, Code-Konventionen und PR-Richtlinien.

---

## Lizenz

MIT-Lizenz - siehe [LICENSE](LICENSE) fuer Details.
