<p align="center">
  <img src="icon/strada-brain-icon.png" alt="Strada.Brain-Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>KI-gesteuerter Entwicklungs-Agent fuer Unity / Strada.Core-Projekte</strong><br/>
  Ein autonomer Coding-Agent, der sich mit einem Web-Dashboard, Telegram, Discord, Slack, WhatsApp oder Ihrem Terminal verbindet &mdash; Ihre Codebasis liest, Code schreibt, Builds ausfuehrt, Fehler automatisch behebt und aus seinen Fehlern lernt &mdash; und mit einer 24/7-Daemon-Schleife autonom arbeitet.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/tests-2775-brightgreen?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Lizenz">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.tr.md">T&uuml;rk&ccedil;e</a> |
  <a href="README.zh.md">&#20013;&#25991;</a> |
  <a href="README.ja.md">&#26085;&#26412;&#35486;</a> |
  <a href="README.ko.md">&#54620;&#44397;&#50612;</a> |
  <strong>Deutsch</strong> |
  <a href="README.es.md">Espa&ntilde;ol</a> |
  <a href="README.fr.md">Fran&ccedil;ais</a>
</p>

---

## Was ist das?

Strada.Brain ist ein KI-Agent, mit dem Sie ueber einen Chat-Kanal kommunizieren. Sie beschreiben, was Sie moechten -- "erstelle ein neues ECS-System fuer Spielerbewegung" oder "finde alle Komponenten, die Health verwenden" -- und der Agent liest Ihr C#-Projekt, schreibt den Code, fuehrt `dotnet build` aus, behebt Fehler automatisch und sendet Ihnen das Ergebnis.

Er verfuegt ueber persistenten Speicher auf Basis von SQLite + HNSW-Vektoren, lernt aus vergangenen Fehlern mittels Bayesscher Konfidenzbewertung, zerlegt komplexe Ziele in parallele DAG-Ausfuehrung, synthetisiert automatisch mehrstufige Tool-Ketten und kann als 24/7-Daemon mit proaktiven Ausloesern betrieben werden.

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
# Web-Kanal (Standard) -- Setup-Assistent oeffnet sich unter localhost:3000
# Falls keine .env vorhanden ist, leitet der Assistent Sie durch die Ersteinrichtung
npm start

# Oder explizit mit Web-Kanal
npm run dev -- start --channel web

# Interaktiver CLI-Modus (schnellster Weg zum Testen)
npm run dev -- cli

# Daemon-Modus (24/7 autonomer Betrieb mit proaktiven Ausloesern)
npm run dev -- daemon --channel web

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
|  Orchestrator (PAOR-Agentenschleife)                             |
|  Planen -> Handeln -> Beobachten -> Reflektieren Zustandsmaschine|
|  Instinktabruf, Fehlerklassifikation, automatische Neuplanung   |
+-------+--------------+-------------+-----------+----------------+
        |              |             |           |
+-------v------+ +-----v------+ +---v--------+ +v-----------------+
| KI-Anbieter  | | 30+ Tools  | | Kontext    | | Lernsystem       |
| Claude (prim)| | Datei-I/O  | | AgentDB    | | TypedEventBus    |
| OpenAI, Kimi | | Git-Ops    | | (SQLite +  | | Bayessche Beta-  |
| DeepSeek,Qwen| | Shell-Ausf.| |  HNSW)     | |  Bewertung       |
| MiniMax, Groq| | .NET Build | | RAG-Vekt.  | | Instinkt-Lebens- |
| Ollama +mehr | | Strata-Gen | | Identitaet | |  zyklus          |
+--------------+ +------+-----+ +---+--------+ | Tool-Ketten      |
                        |           |           +--+---------------+
                +-------v-----------v--------------v------+
                |  GoalDecomposer + GoalExecutor           |
                |  DAG-basierte Zerlegung, wellenbasierte  |
                |  parallele Ausfuehrung, Fehlerbudgets    |
                +-----------------------------------------+
                               |
            +------------------v-------------------+
            |  Daemon (HeartbeatLoop)              |
            |  Cron, File-Watch, Checkliste,       |
            |  Webhook-Ausloeser                   |
            |  Circuit Breakers, Budget-Tracking,  |
            |  Ausloeser-Deduplizierung            |
            |  Benachrichtigungs-Router +           |
            |  Zusammenfassungsberichte            |
            +--------------------------------------+
```

### Wie die Agent-Schleife funktioniert

1. **Nachricht eingeht** von einem Chat-Kanal
2. **Gedaechtnisabruf** -- AgentDB-Hybridsuche (70% semantisch HNSW + 30% TF-IDF) findet die relevantesten vergangenen Gespraeche
3. **RAG-Abruf** -- semantische Suche ueber Ihre C#-Codebasis (HNSW-Vektoren, Top 6 Ergebnisse)
4. **Instinktabruf** -- fragt proaktiv aufgabenrelevante gelernte Muster ab (semantisch + Schluesselwort-Abgleich)
5. **Identitaetskontext** -- injiziert persistente Agentenidentitaet (UUID, Startzaehler, Betriebszeit, Absturz-Wiederherstellungsstatus)
6. **PLAN-Phase** -- LLM erstellt einen nummerierten Plan, informiert durch gelernte Erkenntnisse und vergangene Fehler
7. **HANDELN-Phase** -- LLM fuehrt Werkzeugaufrufe gemaess dem Plan aus
8. **BEOBACHTEN** -- Ergebnisse werden aufgezeichnet; Fehlerwiederherstellung analysiert Ausfaelle; Fehlerklassifikator kategorisiert Fehler
9. **REFLEKTIEREN** -- alle 3 Schritte (oder bei Fehler) entscheidet das LLM: **FORTFAHREN**, **NEU PLANEN** oder **FERTIG**
10. **Automatische Neuplanung** -- bei 3+ aufeinanderfolgenden gleichartigen Fehlern wird ein neuer Ansatz erzwungen, der fehlgeschlagene Strategien vermeidet
11. **Wiederholung** bis zu 50 Iterationen bis zur Fertigstellung
12. **Lernen** -- Tool-Ergebnisse fliessen ueber TypedEventBus in die Lern-Pipeline zur sofortigen Musterspeicherung
13. **Antwort gesendet** an den Benutzer ueber den Kanal (Streaming wenn unterstuetzt)

---

## Speichersystem

Das aktive Speicher-Backend ist `AgentDBMemory` -- SQLite mit HNSW-Vektorindizierung und einer dreistufigen Auto-Tiering-Architektur.

**Dreistufiger Speicher:**
- **Arbeitsspeicher** -- aktiver Sitzungskontext, automatische Befoerderung nach anhaltender Nutzung
- **Ephemerer Speicher** -- Kurzzeitablage, automatische Bereinigung bei Erreichen der Kapazitaetsgrenzen
- **Persistenter Speicher** -- Langzeitablage, Befoerderung aus dem ephemeren Speicher basierend auf Zugriffshaeufigkeit und Wichtigkeit

**Funktionsweise:**
- Wenn der Sitzungsverlauf 40 Nachrichten ueberschreitet, werden alte Nachrichten zusammengefasst und als Konversationseintraege gespeichert
- Hybridabruf kombiniert 70% semantische Aehnlichkeit (HNSW-Vektoren) mit 30% TF-IDF-Schluesselwort-Abgleich
- Das Tool `strata_analyze_project` speichert die Projektstrukturanalyse im Cache fuer sofortige Kontexteinspeisung
- Der Speicher bleibt ueber Neustarts hinweg im Verzeichnis `MEMORY_DB_PATH` erhalten (Standard: `.strata-memory/`)
- Automatische Migration vom alten FileMemoryManager erfolgt beim ersten Start

**Fallback:** Falls die AgentDB-Initialisierung fehlschlaegt, wechselt das System automatisch zum `FileMemoryManager` (JSON + TF-IDF).

---

## Lernsystem

Das Lernsystem beobachtet das Agentenverhalten und lernt aus Fehlern durch eine ereignisgesteuerte Pipeline.

**Ereignisgesteuerte Pipeline:**
- Tool-Ergebnisse fliessen ueber `TypedEventBus` in eine serielle `LearningQueue` zur sofortigen Verarbeitung
- Keine Timer-basierte Stapelverarbeitung -- Muster werden erkannt und gespeichert, sobald sie auftreten
- Die `LearningQueue` verwendet begrenztes FIFO mit Fehlerisolation (Lernfehler bringen den Agenten nie zum Absturz)

**Bayessche Konfidenzbewertung:**
- Instinkte verwenden **Beta-Posterior-Inferenz** (`confidence = alpha / (alpha + beta)`) mit einem uninformativen `Beta(1,1)`-Prior
- Bewertungswerte (0.0-1.0) fungieren als fraktionale Evidenzgewichte fuer differenzierte Aktualisierungen
- Keine Mischung oder zeitliche Diskontierung -- reiner Bayesscher Posterior-Mittelwert

**Instinkt-Lebenszyklus:**
- **Vorgeschlagen** (neu) -- unter 0.7 Konfidenz
- **Aktiv** -- zwischen 0.7 und 0.9 Konfidenz
- **Entwickelt** -- ueber 0.9, zur Befoerderung auf permanent vorgeschlagen
- **Veraltet** -- unter 0.3, zur Entfernung markiert
- **Abkuehlphase** -- 7-Tage-Fenster mit Mindestbeobachtungsanforderungen vor Statusaenderungen
- **Permanent** -- eingefroren, keine weiteren Konfidenz-Aktualisierungen

**Aktiver Abruf:** Instinkte werden zu Beginn jeder Aufgabe ueber den `InstinctRetriever` proaktiv abgefragt. Er sucht mit Schluesselwort-Aehnlichkeit und HNSW-Vektor-Einbettungen nach relevanten gelernten Mustern, die in den PLAN-Phasen-Prompt injiziert werden.

**Sitzungsuebergreifendes Lernen:** Instinkte tragen Herkunftsmetadaten (Quellsitzung, Sitzungsanzahl) fuer den sitzungsuebergreifenden Wissenstransfer.

---

## Zielzerlegung

Komplexe mehrstufige Anfragen werden automatisch in einen gerichteten azyklischen Graphen (DAG) von Teilzielen zerlegt.

**GoalDecomposer:**
- Heuristische Vorpruefung vermeidet LLM-Aufrufe fuer einfache Aufgaben (Musterabgleich auf Komplexitaetsindikatoren)
- LLM generiert DAG-Strukturen mit Abhaengigkeitskanten und optionaler rekursiver Tiefe (bis zu 3 Ebenen)
- Kahn-Algorithmus validiert zyklenfreie DAG-Struktur
- Reaktive Neuzerlegung: Wenn ein Knoten fehlschlaegt, kann er in kleinere Wiederherstellungsschritte aufgeteilt werden

**GoalExecutor:**
- Wellenbasierte parallele Ausfuehrung respektiert die Abhaengigkeitsreihenfolge
- Semaphor-basierte Nebenlaeufigkeitsbegrenzung (`GOAL_MAX_PARALLEL`)
- Fehlerbudgets (`GOAL_MAX_FAILURES`) mit Benutzer-Fortsetzungsaufforderungen
- LLM-Kritikalitaetsbewertung bestimmt, ob ein fehlgeschlagener Knoten Abhaengige blockieren soll
- Knotenweise Wiederholungslogik (`GOAL_MAX_RETRIES`) mit Wiederherstellungszerlegung bei Erschoepfung
- AbortSignal-Unterstuetzung fuer Abbruch
- Persistenter Zielbaum-Status ueber `GoalStorage` (SQLite) fuer Wiederaufnahme nach Neustart

---

## Tool-Ketten-Synthese

Der Agent erkennt und synthetisiert automatisch mehrstufige Tool-Kettenmuster zu wiederverwendbaren zusammengesetzten Tools.

**Pipeline:**
1. **ChainDetector** -- analysiert Trajektoriendaten, um wiederkehrende Tool-Sequenzen zu finden (z.B. `file_read` -> `file_edit` -> `dotnet_build`)
2. **ChainSynthesizer** -- nutzt LLM zur Generierung eines `CompositeTool` mit korrektem Ein-/Ausgabe-Mapping und Beschreibung
3. **ChainValidator** -- Validierung nach der Synthese mit Laufzeit-Feedback; verfolgt den Ausfuehrungserfolg von Ketten ueber Bayessche Konfidenz
4. **ChainManager** -- Lebenszyklus-Orchestrator: laedt bestehende Ketten beim Start, fuehrt periodische Erkennung durch, invalidiert Ketten automatisch wenn Komponenten-Tools entfernt werden

**Sicherheit:** Zusammengesetzte Tools erben die restriktivsten Sicherheitsflags ihrer Komponenten-Tools.

**Konfidenz-Kaskade:** Ketten-Instinkte folgen demselben Bayesschen Lebenszyklus wie regulaere Instinkte. Ketten, die unter die Veraltungsschwelle fallen, werden automatisch deregistriert.

---

## Daemon-Modus

Der Daemon bietet 24/7-Autonombetrieb mit einem Heartbeat-gesteuerten Ausloesersystem.

```bash
npm run dev -- daemon --channel web
```

**HeartbeatLoop:**
- Konfigurierbares Tick-Intervall wertet registrierte Ausloeser in jedem Zyklus aus
- Sequentielle Ausloeserauswertung verhindert Budget-Wettlaufbedingungen
- Persistiert den Laufzustand fuer Absturz-Wiederherstellung

**Ausloesertypen:**
- **Cron** -- geplante Aufgaben mit Cron-Ausdruecken
- **File Watch** -- ueberwacht Dateisystemaenderungen in konfigurierten Pfaden
- **Checkliste** -- loest aus, wenn Checklisten-Eintraege faellig werden
- **Webhook** -- HTTP-POST-Endpunkt loest Aufgaben bei eingehenden Anfragen aus

**Widerstandsfaehigkeit:**
- **Circuit Breakers** -- pro Ausloeser mit exponentiellem Backoff-Cooldown, ueber Neustarts hinweg persistiert
- **Budget-Tracking** -- taegliche USD-Ausgabenobergrenze mit Warnschwellen-Ereignissen
- **Ausloeser-Deduplizierung** -- inhaltsbasierte und Cooldown-basierte Unterdrueckung verhindert doppelte Ausloesung
- **Ueberlappungsunterdrueckung** -- ueberspringt Ausloeser, die bereits eine aktive Aufgabe ausfuehren

**Sicherheit:**
- `DaemonSecurityPolicy` steuert, welche Tools bei Daemon-ausgeloesten Operationen eine Benutzergenehmigung erfordern
- `ApprovalQueue` mit konfigurierbarer Ablaufzeit fuer Schreiboperationen

**Berichtswesen:**
- `NotificationRouter` leitet Ereignisse basierend auf Dringlichkeitsstufe (still/niedrig/mittel/hoch/kritisch) an konfigurierte Kanaele weiter
- Ratenbegrenzung pro Dringlichkeit und Ruhezeitenunterstuetzung (nicht-kritische Benachrichtigungen werden gepuffert)
- `DigestReporter` generiert periodische Zusammenfassungsberichte
- Alle Benachrichtigungen werden im SQLite-Verlauf protokolliert

---

## Identitaetssystem

Der Agent pflegt eine persistente Identitaet ueber Sitzungen und Neustarts hinweg.

**IdentityStateManager** (SQLite-gestuetzt):
- Einzigartige Agenten-UUID, generiert beim ersten Start
- Startzaehler, kumulative Betriebszeit, Zeitstempel der letzten Aktivitaet
- Gesamtzaehler fuer Nachrichten und Aufgaben
- Erkennung sauberer Herunterfahrvorgaenge fuer Absturz-Wiederherstellung
- In-Memory-Zaehler-Cache mit periodischer Speicherung zur Minimierung von SQLite-Schreibvorgaengen

**Absturz-Wiederherstellung:**
- Beim Start wird, falls die vorherige Sitzung nicht sauber beendet wurde, ein `CrashRecoveryContext` erstellt
- Enthaelt Ausfallzeitdauer, unterbrochene Zielbaeume und Startzaehler
- Wird in den System-Prompt injiziert, damit das LLM den Absturz natuerlich bestaetigen und unterbrochene Arbeit fortsetzen kann

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

**Anbieter-Kette:** Setzen Sie `PROVIDER_CHAIN` auf eine kommagetrennte Liste von Anbieternamen. Das System probiert jeden der Reihe nach und faellt bei einem Fehler auf den naechsten zurueck. Beispiel: `PROVIDER_CHAIN=kimi,deepseek,claude` verwendet Kimi zuerst, DeepSeek wenn Kimi fehlschlaegt, dann Claude.

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
| `file_delete_directory` | Rekursive Verzeichnisloeschung (50-Dateien-Sicherheitsgrenze) |

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

## Kanal-Funktionen

| Funktion | Web | Telegram | Discord | Slack | WhatsApp | CLI |
|----------|-----|----------|---------|-------|----------|-----|
| Textnachrichten | Ja | Ja | Ja | Ja | Ja | Ja |
| Streaming (In-Place-Bearbeitung) | Ja | Ja | Ja | Ja | Ja | Ja |
| Tipp-Anzeige | Ja | Ja | Ja | Nein | Ja | Nein |
| Bestaetigungsdialoge | Ja (Modal) | Ja (Inline-Tastatur) | Ja (Buttons) | Ja (Block Kit) | Ja (nummerierte Antwort) | Ja (Readline) |
| Datei-Uploads | Ja | Nein | Nein | Ja | Ja | Nein |
| Thread-Unterstuetzung | Nein | Nein | Ja | Ja | Nein | Nein |
| Ratenbegrenzer (ausgehend) | Ja (pro Sitzung) | Nein | Ja (Token Bucket) | Ja (4-stufiges Schiebefenster) | Inline-Drosselung | Nein |

### Streaming

Alle Kanaele implementieren In-Place-Streaming. Die Antwort des Agenten erscheint progressiv, waehrend das LLM sie generiert. Updates werden plattformspezifisch gedrosselt, um Ratenlimits zu vermeiden (WhatsApp/Discord: 1/Sek., Slack: 2/Sek.).

### Authentifizierung

- **Telegram**: Standardmaessig alles blockiert. `ALLOWED_TELEGRAM_USER_IDS` muss gesetzt werden.
- **Discord**: Standardmaessig alles blockiert. `ALLOWED_DISCORD_USER_IDS` oder `ALLOWED_DISCORD_ROLE_IDS` muss gesetzt werden.
- **Slack**: **Standardmaessig offen.** Wenn `ALLOWED_SLACK_USER_IDS` leer ist, kann jeder Slack-Benutzer auf den Bot zugreifen. Setzen Sie die Erlaubnisliste fuer die Produktion.
- **WhatsApp**: Verwendet die `WHATSAPP_ALLOWED_NUMBERS`-Erlaubnisliste, die lokal im Adapter geprueft wird.

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

### Schicht 9: Daemon-Sicherheit
`DaemonSecurityPolicy` erzwingt Tool-spezifische Genehmigungsanforderungen fuer Daemon-ausgeloeste Operationen. Schreib-Tools erfordern eine ausdrueckliche Benutzergenehmigung ueber die `ApprovalQueue` vor der Ausfuehrung.

---

## Dashboard und Monitoring

### HTTP-Dashboard (`DASHBOARD_ENABLED=true`)
Erreichbar unter `http://localhost:3001` (nur Localhost). Zeigt: Betriebszeit, Nachrichtenanzahl, Token-Verbrauch, aktive Sitzungen, Tool-Nutzungstabelle, Sicherheitsstatistiken. Automatische Aktualisierung alle 3 Sekunden.

### Health-Endpunkte
- `GET /health` -- Liveness-Probe (`{"status":"ok"}`)
- `GET /ready` -- Tiefgehende Bereitschaftspruefung: prueft Speicher und Kanal-Gesundheit. Gibt 200 (bereit), 207 (eingeschraenkt) oder 503 (nicht bereit) zurueck

### Prometheus (`ENABLE_PROMETHEUS=true`)
Metriken unter `http://localhost:9090/metrics`. Zaehler fuer Nachrichten, Tool-Aufrufe, Tokens. Histogramme fuer Anfragedauer, Tool-Dauer, LLM-Latenz. Standard-Node.js-Metriken (CPU, Heap, GC, Event Loop).

### WebSocket-Dashboard (`ENABLE_WEBSOCKET_DASHBOARD=true`)
Echtzeit-Metriken, die jede Sekunde gepusht werden. Unterstuetzt authentifizierte Verbindungen und Remote-Befehle (Plugin-Neuladen, Cache-Leerung, Log-Abruf). Daemon-Ereignisse (Ausloeseraktivierungen, Budget-Warnungen, Zielfortschritt) werden ueber WebSocket uebertragen.

### Metrik-System
`MetricsStorage` (SQLite) zeichnet Aufgabenabschlussrate, Iterationszaehler, Tool-Nutzung und Musterwiederverwendung auf. `MetricsRecorder` erfasst Metriken pro Sitzung. Der `metrics`-CLI-Befehl zeigt historische Metriken an.

---

## Deployment

### Docker

```bash
docker-compose up -d
```

Die `docker-compose.yml` beinhaltet die Anwendung, den Monitoring-Stack und den Nginx-Reverse-Proxy.

### Daemon-Modus

```bash
# 24/7 autonomer Betrieb mit Heartbeat-Schleife und proaktiven Ausloesern
node dist/index.js daemon --channel web

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
- [ ] Daemon-Budget-Limits konfigurieren (`RATE_LIMIT_DAILY_BUDGET_USD`)

---

## Testen

```bash
npm test                         # Alle 2775 Tests ausfuehren
npm run test:watch               # Watch-Modus
npm test -- --coverage           # Mit Coverage
npm test -- src/agents/tools/file-read.test.ts  # Einzelne Datei
npm run typecheck                # TypeScript-Typpruefung
npm run lint                     # ESLint
```

---

## Projektstruktur

```
src/
  index.ts              # CLI-Einstiegspunkt (Commander.js)
  core/
    bootstrap.ts        # Vollstaendige Initialisierungssequenz -- gesamte Verdrahtung hier
    event-bus.ts        # TypedEventBus fuer entkoppelte ereignisgesteuerte Kommunikation
    tool-registry.ts    # Tool-Instanziierung und -Registrierung
  agents/
    orchestrator.ts     # PAOR-Agentenschleife, Sitzungsverwaltung, Streaming
    agent-state.ts      # Phasen-Zustandsmaschine (Planen/Handeln/Beobachten/Reflektieren)
    paor-prompts.ts     # Phasenbewusste Prompt-Builder
    instinct-retriever.ts # Proaktiver Abruf gelernter Muster
    failure-classifier.ts # Fehlerkategorisierung und Auto-Neuplanungs-Trigger
    autonomy/           # Fehlerwiederherstellung, Aufgabenplanung, Selbstverifizierung
    context/            # System-Prompt (Strada.Core-Wissensbasis)
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq + weitere
    tools/              # 30+ Tool-Implementierungen
    plugins/            # Externer Plugin-Loader
  channels/
    telegram/           # Grammy-basierter Bot
    discord/            # discord.js-Bot mit Slash-Befehlen
    slack/              # Slack Bolt (Socket-Modus) mit Block Kit
    whatsapp/           # Baileys-basierter Client mit Sitzungsverwaltung
    web/                # Express + WebSocket Web-Dashboard
    cli/                # Readline-REPL
  memory/
    file-memory-manager.ts   # Altes Backend: JSON + TF-IDF (Fallback)
    unified/
      agentdb-memory.ts      # Aktives Backend: SQLite + HNSW, 3-stufiges Auto-Tiering
      agentdb-adapter.ts     # IMemoryManager-Adapter fuer AgentDBMemory
      migration.ts           # Legacy FileMemoryManager -> AgentDB-Migration
  rag/
    rag-pipeline.ts     # Index + Suche + Format-Orchestrierung
    chunker.ts          # C#-spezifisches strukturelles Chunking
    hnsw/               # HNSW-Vektorspeicher (hnswlib-node)
    embeddings/         # OpenAI- und Ollama-Embedding-Anbieter
    reranker.ts         # Gewichtetes Reranking (Vektor + Schluesselwort + Struktur)
  learning/
    pipeline/
      learning-pipeline.ts  # Mustererkennung, Instinkt-Erstellung, Evolutionsvorschlaege
      learning-queue.ts     # Serieller Async-Prozessor fuer ereignisgesteuertes Lernen
      embedding-queue.ts    # Begrenzte asynchrone Embedding-Generierung
    scoring/
      confidence-scorer.ts  # Bayessche Beta-Posterior-Konfidenz, Elo, Wilson-Intervalle
    matching/
      pattern-matcher.ts    # Schluesselwort- + semantischer Musterabgleich
    hooks/
      error-learning-hooks.ts  # Fehler-/Loesungs-Erfassungs-Hooks
    storage/
      learning-storage.ts  # SQLite-Speicher fuer Instinkte, Trajektorien, Muster
      migrations/          # Schema-Migrationen (sitzungsuebergreifende Herkunft)
    chains/
      chain-detector.ts    # Erkennung wiederkehrender Tool-Sequenzen
      chain-synthesizer.ts # LLM-basierte Generierung zusammengesetzter Tools
      composite-tool.ts    # Ausfuehrbares zusammengesetztes Tool
      chain-validator.ts   # Validierung nach Synthese, Laufzeit-Feedback
      chain-manager.ts     # Vollstaendiger Lebenszyklus-Orchestrator
  goals/
    goal-decomposer.ts  # DAG-basierte Zielzerlegung (proaktiv + reaktiv)
    goal-executor.ts    # Wellenbasierte parallele Ausfuehrung mit Fehlerbudgets
    goal-validator.ts   # Kahn-Algorithmus DAG-Zykluserkennung
    goal-storage.ts     # SQLite-Persistenz fuer Zielbaeume
    goal-progress.ts    # Fortschrittsverfolgung und -berichterstattung
    goal-resume.ts      # Wiederaufnahme unterbrochener Zielbaeume nach Neustart
    goal-renderer.ts    # Zielbaum-Visualisierung
  daemon/
    heartbeat-loop.ts   # Kern-Tick-Auswertungs-Ausloeser-Schleife
    trigger-registry.ts # Ausloeser-Registrierung und -Lebenszyklus
    daemon-storage.ts   # SQLite-Persistenz fuer Daemon-Zustand
    daemon-events.ts    # Typisierte Ereignisdefinitionen fuer Daemon-Subsystem
    daemon-cli.ts       # CLI-Befehle fuer Daemon-Verwaltung
    budget/
      budget-tracker.ts # Taegliches USD-Budget-Tracking
    resilience/
      circuit-breaker.ts # Circuit Breaker pro Ausloeser mit exponentiellem Backoff
    security/
      daemon-security-policy.ts  # Tool-Genehmigungsanforderungen fuer Daemon
      approval-queue.ts          # Genehmigungswarteschlange mit Ablaufzeit
    dedup/
      trigger-deduplicator.ts    # Inhalts- + Cooldown-Deduplizierung
    triggers/
      cron-trigger.ts        # Cron-Ausdruck-Planung
      file-watch-trigger.ts  # Dateisystem-Aenderungsueberwachung
      checklist-trigger.ts   # Faellige Checklisten-Eintraege
      webhook-trigger.ts     # HTTP-POST-Webhook-Endpunkt
    reporting/
      notification-router.ts # Dringlichkeitsbasierte Benachrichtigungsweiterleitung
      digest-reporter.ts     # Periodische Zusammenfassungsgenerierung
      digest-formatter.ts    # Zusammenfassungsberichte fuer Kanaele formatieren
      quiet-hours.ts         # Nicht-kritische Benachrichtigungspufferung
  identity/
    identity-state.ts   # Persistente Agentenidentitaet (UUID, Startzaehler, Betriebszeit)
    crash-recovery.ts   # Absturzerkennung und Wiederherstellungskontext
  tasks/
    task-manager.ts     # Aufgaben-Lebenszyklus-Verwaltung
    task-storage.ts     # SQLite-Aufgabenpersistenz
    background-executor.ts # Hintergrund-Aufgabenausfuehrung mit Zielintegration
    message-router.ts   # Nachrichtenweiterleitung zum Orchestrator
    command-detector.ts # Slash-Befehl-Erkennung
    command-handler.ts  # Befehlsausfuehrung
  metrics/
    metrics-storage.ts  # SQLite-Metrik-Speicher
    metrics-recorder.ts # Metrik-Erfassung pro Sitzung
    metrics-cli.ts      # CLI-Befehl zur Metrikanzeige
  security/             # Auth, RBAC, Pfadschutz, Ratenbegrenzer, Geheimnis-Bereinigung
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
