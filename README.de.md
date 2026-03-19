<p align="center">
  <img src="icon/strada-brain-icon.png" alt="Strada.Brain-Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>KI-gesteuerter Entwicklungs-Agent fuer Unity / Strada.Core-Projekte</strong><br/>
  Ein autonomer Coding-Agent, der sich mit einem Web-Dashboard, Telegram, Discord, Slack, WhatsApp oder Ihrem Terminal verbindet &mdash; Ihre Codebasis liest, Code schreibt, Builds ausfuehrt, Fehler automatisch behebt und aus seinen Fehlern lernt &mdash; und mit einer 24/7-Daemon-Schleife autonom arbeitet. Jetzt mit Multi-Agent-Orchestrierung, Aufgabendelegation, Ged&auml;chtniskonsolidierung, einem Deployment-Subsystem mit Genehmigungsgates, Medienfreigabe mit LLM-Vision-Unterstuetzung, einem konfigurierbaren Persoenlichkeitssystem ueber SOUL.md, interaktiven Klaerungstools, intelligentem Multi-Provider-Routing mit aufgabenbewusstem dynamischem Wechsel, konfidenzbasierter Konsensverifizierung, einem autonomen Agent Core mit OODA-Reasoning-Loop und Strada.MCP-Integration.
</p>

> Uebersetzungshinweis: Fuer aktuelles Laufzeitverhalten, Umgebungsvariablen-Defaults und Sicherheitssemantik ist [README.md](README.md) die kanonische Quelle. Diese Datei ist eine Uebersetzung davon.

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/tests-3300%2B-brightgreen?style=flat-square" alt="Tests">
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

Er verfuegt ueber persistenten Speicher auf Basis von SQLite + HNSW-Vektoren, lernt aus vergangenen Fehlern mittels hybrider gewichteter Konfidenzbewertung, zerlegt komplexe Ziele in parallele DAG-Ausfuehrung, synthetisiert automatisch mehrstufige Tool-Ketten mit Saga-Rollback und kann als 24/7-Daemon mit proaktiven Ausloesern betrieben werden. Er unterstuetzt Multi-Agent-Orchestrierung mit kanalbasierter Sitzungsisolation, hierarchische Aufgabendelegation ueber Agenten-Stufen, automatische Gedaechtniskonsolidierung und ein Deployment-Subsystem mit Human-in-the-Loop-Genehmigungsgates und Circuit-Breaker-Schutz.

Neu in dieser Version: Strada.Brain verfuegt jetzt ueber einen **Agent Core** -- eine autonome OODA-Reasoning-Engine, die die Umgebung beobachtet (Dateiaenderungen, Git-Status, Build-Ergebnisse), mittels gelernter Muster ueber Prioritaeten urteilt und proaktiv handelt. Das **Multi-Provider-Routing**-System waehlt dynamisch den besten KI-Anbieter fuer jeden Aufgabentyp (Planung, Code-Generierung, Debugging, Review) mit konfigurierbaren Presets (budget/balanced/performance). Ein **konfidenzbasiertes Konsenssystem** konsultiert automatisch einen zweiten Anbieter, wenn die Konfidenz des Agenten niedrig ist, und verhindert so Fehler bei kritischen Operationen. Alle Features degradieren graceful -- mit einem einzigen Anbieter funktioniert das System identisch wie zuvor ohne jeglichen Overhead.

**Dies ist keine Bibliothek und keine API.** Es ist eine eigenstaendige Anwendung, die Sie ausfuehren. Sie verbindet sich mit Ihrer Chat-Plattform, liest Ihr Unity-Projekt von der Festplatte und arbeitet autonom innerhalb der von Ihnen konfigurierten Grenzen.

---

## Schnellstart

### Voraussetzungen

- **Node.js 20.19+** (oder **22.12+**) und npm
- Mindestens eine unterstuetzte AI-Provider-Credential (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` usw.), eine OpenAI ChatGPT/Codex-Subscription-Session (`OPENAI_AUTH_MODE=chatgpt-subscription`) oder eine reine `ollama`-`PROVIDER_CHAIN`
- Ein **Unity-Projekt** (der Pfad, den Sie dem Agenten geben). Fuer volle Strada-spezifische Hilfe wird Strada.Core empfohlen.

### 1. Installation

```bash
# Aus dem Quellcode klonen (derzeit der kanonische Installationsweg)
git clone https://github.com/okandemirel/Strada.Brain.git Strada.Brain

# Kein `cd` noetig: den Checkout direkt aus dem Elternordner verwenden
./Strada.Brain/strada install-command
./Strada.Brain/strada setup

# Optional fuer kuerzere Befehle
cd Strada.Brain
```

Fuehren Sie alle `npm` Befehle im Repository-Root aus, also in dem Ordner mit `package.json`. Wenn Sie einen Fehler wie `ENOENT ... /Strada/package.json` sehen, sind Sie eine Ebene zu hoch; wechseln Sie zuerst nach `Strada.Brain` oder fuehren Sie den Befehl als `cd Strada.Brain && ...` aus.

`./strada` ist der kanonische Launcher fuer den Source-Checkout. Beim ersten Start bereitet er den Checkout automatisch vor, sodass der normale Setup-Weg kein `npm link` mehr braucht.

Wenn Sie `./strada install-command` ueberspringen, verwenden Sie den Checkout weiter ueber `./Strada.Brain/strada ...` aus dem Elternordner oder `./strada ...` im Repository-Root. Nach der Installation funktioniert `strada ...` von ueberall.

`./strada install-command` aktualisiert auch Ihr Shell-Profil automatisch, damit neue Terminals `strada` ohne manuelle PATH-Aenderung finden.

`strada-brain` ist derzeit nicht in der öffentlichen npm-Registry veröffentlicht. Deshalb liefert `npm install -g strada-brain` aktuell `E404`. Bis es eine Registry-Veröffentlichung gibt, nutze bitte den obigen Source-Checkout-Weg.

Wenn Strada aus einer paketierten npm-/Tarball-Version installiert wird, liegt die Laufzeitkonfiguration standardmaessig unter `~/.strada` statt im aktuellen Arbeitsverzeichnis. Mit `STRADA_HOME=/eigener/pfad` koennen Sie ein anderes App-Home erzwingen.

### 2. Setup

```bash
# Interaktiver Setup-Assistent (Terminal oder Web-Browser)
./strada setup

# Den Auswahlschritt ueberspringen und direkt die gewuenschte Setup-Oberflaeche starten
./strada setup --web
./strada setup --terminal
```

Wenn `./strada setup --web` eine aeltere Node-Version erkennt, die das volle Portal-Bundle nicht bauen kann, bleibt Web der primaere Weg: Wenn `nvm` verfuegbar ist, kann Strada nach Ihrer Zustimmung eine kompatible Node-Version installieren und direkt zum Web-Setup zurueckkehren; dabei laeuft das gefuehrte Upgrade in einem temporaeren sauberen HOME, damit inkompatible npm-Einstellungen wie `prefix` / `globalconfig` `nvm` nicht blockieren. Andernfalls fuehrt es Sie durch den Upgrade/Download-Pfad. Falls Sie das Upgrade ablehnen, fragt Strada explizit, ob Sie stattdessen mit dem Terminal-Setup fortfahren moechten.
Wenn Node 22 bereits in `nvm` installiert ist, verwendet Strada diese Laufzeit erneut, statt sie nochmals herunterzuladen. Der Web-Setup-Flow oeffnet auf der lokalen Root-URL und behaelt dieselbe URL auch beim Handoff an die Haupt-App.
Der erste Browser-Start traegt zusaetzlich ein explizites Setup-Flag, damit selbst ein veralteter gecachter Portal-Tab wieder im Setup-Assistenten landet statt auf einer toten "Not Found"-Seite.

Der Assistent fragt nach Ihrem Unity-Projektpfad, AI-Anbieter-API-Schluessel, Standard-Kanal und Sprache. `./strada setup` bevorzugt jetzt standardmaessig den **Web-Browser**; waehlen Sie **Terminal** nur dann, wenn Sie den schnelleren Text-Flow bewusst moechten.
Nach dem Speichern des Web-Assistenten uebergibt Strada auf derselben URL an die Haupt-App weiter und spielt dabei auch den Onboarding-Turn sowie die erste Autonomy-Auswahl in die erste Chat-Sitzung ein, damit Begruessung und Settings sofort den Wizard-Stand widerspiegeln.
Wenn die erste echte Chat-Nachricht bereits eine technische Aufgabe ist, beginnt Strada jetzt sofort mit der Bearbeitung und reduziert das Onboarding auf hoechstens eine kurze Rueckfrage statt einen kompletten Intake-Dialog zu starten.
Das Terminal-Setup akzeptiert kommagetrennte Provider in einer einzigen Eingabe (z. B. `kimi,deepseek`) fuer Fallback- oder Multi-Agent-Orchestrierung; alternativ koennen Sie Provider auch einzeln interaktiv eingeben. Die Schleife "Einen weiteren hinzufuegen?" erscheint nur, wenn ein einzelner Provider eingegeben wird. Die Embedding-Provider-Wahl bleibt getrennt.
Sobald Sie im Web-Assistenten speichern, uebergibt Strada auf derselben URL an die eigentliche Web-App, damit ein Refresh waehrend des Uebergangs nicht auf einer toten Setup-Seite landet.
Wenn RAG aktiviert ist, aber kein nutzbarer Embedding-Provider konfiguriert wurde, laesst der Assistent Sie jetzt bis zum Review-Schritt weitergehen; Speichern bleibt jedoch blockiert, bis Sie einen gueltigen Embedding-Provider waehlen oder RAG deaktivieren.
Nach dem ersten erfolgreichen Setup wird `./strada` ohne Subcommand zum smarten Launcher:
- beim ersten Start oeffnet es das Setup automatisch, falls die Config fehlt
- spaeter zeigt es ein Terminal-Panel fuer Web, CLI, Daemon, Setup oder Doctor
Fuehren Sie danach einen Bereitschaftscheck aus, bevor Sie den Agenten starten:

```bash
# Im Source-Checkout
./strada doctor

# Oder nach `./strada install-command`
strada doctor
```

Alternativ erstellen Sie `.env` manuell:

```env
ANTHROPIC_API_KEY=sk-ant-...      # Ihr Claude API-Schluessel
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Muss Assets/ enthalten
JWT_SECRET=<generieren mit: openssl rand -hex 64>
```

### 3. Starten

```bash
# Smarter Launcher: startet bei Bedarf zuerst das Setup, sonst das Auswahlpanel
strada

# Gespeicherten Standardkanal direkt im Daemon-Modus starten
strada --daemon

# Mit Standard-Web-Kanal starten
strada start

# Interaktiver CLI-Modus (schnellster Weg zum Testen)
strada start --channel cli

# Daemon-Modus (24/7 autonomer Betrieb mit proaktiven Ausloesern)
strada start --channel web --daemon

# Andere Chat-Kanaele
strada start --channel telegram
strada start --channel discord
strada start --channel slack
strada start --channel whatsapp

# Staendiger Supervisor mit automatischem Neustart
strada supervise --channel web
```

### 4. CLI-Befehle

```bash
./strada                  # Kanonischer Launcher fuer den Source-Checkout
./strada install-command  # Benutzerlokalen bare `strada`-Befehl installieren
strada                    # Smarter Launcher nach install-command
strada --daemon           # Gespeicherten Standardkanal im Daemon-Modus starten
strada --web              # Web-Kanal oeffnen oder auf einer frischen Maschine web-gefuertetes Setup fortsetzen
strada --terminal         # Terminal-Kanal oeffnen oder auf einer frischen Maschine Terminal-Setup erzwingen
./strada setup --web      # Browser-Assistent direkt starten
./strada setup --terminal # Terminal-Assistent direkt verwenden
./strada doctor           # Installations-/Build-/Config-Bereitschaft pruefen
./strada start            # Agent starten
./strada supervise        # Mit Auto-Restart-Supervisor ausfuehren
./strada update           # Auf Updates pruefen und anwenden
./strada update --check   # Auf Updates pruefen ohne anzuwenden
./strada version-info     # Version, Installationsmethode und Update-Status anzeigen
```

### 5. Kommunizieren

Sobald der Agent laeuft, senden Sie eine Nachricht ueber Ihren konfigurierten Kanal:

```
> Analysiere die Projektstruktur
> Erstelle ein neues Modul namens "Combat" mit einem DamageSystem und einer HealthComponent
> Finde alle Systeme, die PositionComponent abfragen
> Fuehre den Build aus und behebe alle Fehler
```

**Web-Kanal:** Kein Terminal erforderlich -- interagieren Sie ueber das Web-Dashboard unter `localhost:3000`.

### 6. Automatische Updates

Strada.Brain prueft taeglich automatisch auf Updates und wendet diese an, wenn der Agent untaeutig ist. Source-Checkouts und `./strada install-command`-Installationen aktualisieren sich ueber git. npm-basierte Update-Befehle gelten erst, sobald eine öffentliche npm-Veroeffentlichung existiert.

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `AUTO_UPDATE_ENABLED` | `true` | Aktiviert/deaktiviert automatische Updates |
| `AUTO_UPDATE_INTERVAL_HOURS` | `24` | Prueffrequenz (Stunden) |
| `AUTO_UPDATE_IDLE_TIMEOUT_MIN` | `5` | Minuten Untaetigkeit vor Update-Anwendung |
| `AUTO_UPDATE_CHANNEL` | `stable` | npm dist-tag: `stable` oder `latest` |
| `AUTO_UPDATE_AUTO_RESTART` | `true` | Automatischer Neustart nach Update bei Untaetigkeit |

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
| OpenAI, Kimi | | Git-Ops    | | (SQLite +  | | Hybride gewich-  |
| DeepSeek,Qwen| | Shell-Ausf.| |  HNSW)     | |  tete Bewertung  |
| MiniMax, Groq| | .NET Build | | RAG-Vekt.  | | Instinkt-Lebens- |
| Ollama +mehr | | Strada-Gen | | Identitaet | |  zyklus          |
+--------------+ +------+-----+ +---+--------+ | Tool-Ketten      |
                        |           |           +--+---------------+
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
- Das Tool `strada_analyze_project` speichert die Projektstrukturanalyse im Cache fuer sofortige Kontexteinspeisung
- Der Speicher bleibt ueber Neustarts hinweg im Verzeichnis `MEMORY_DB_PATH` erhalten (Standard: `.strada-memory/`)
- Automatische Migration vom alten FileMemoryManager erfolgt beim ersten Start

**Fallback:** Falls die AgentDB-Initialisierung fehlschlaegt, wechselt das System automatisch zum `FileMemoryManager` (JSON + TF-IDF).

---

## Lernsystem

Das Lernsystem beobachtet das Agentenverhalten und lernt aus Fehlern durch eine ereignisgesteuerte Pipeline.

**Ereignisgesteuerte Pipeline:**
- Tool-Ergebnisse fliessen ueber `TypedEventBus` in eine serielle `LearningQueue` zur sofortigen Verarbeitung
- Keine Timer-basierte Stapelverarbeitung -- Muster werden erkannt und gespeichert, sobald sie auftreten
- Die `LearningQueue` verwendet begrenztes FIFO mit Fehlerisolation (Lernfehler bringen den Agenten nie zum Absturz)

**Hybride gewichtete Konfidenzbewertung:**
- Konfidenz = gewichtete Summe von 5 Faktoren: Erfolgsrate (0.35), Musterstaerke (0.25), Aktualitaet (0.20), Kontextübereinstimmung (0.15), Verifikation (0.05)
- Bewertungswerte (0.0-1.0) aktualisieren Alpha/Beta-Evidenzzaehler fuer Konfidenzintervalle
- Alpha/Beta-Parameter werden fuer Unsicherheitsschaetzung beibehalten, aber nicht fuer die primaere Konfidenzberechnung verwendet

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
3. **ChainValidator** -- Validierung nach der Synthese mit Laufzeit-Feedback; verfolgt den Ausfuehrungserfolg von Ketten ueber gewichtete Konfidenzbewertung
4. **ChainManager** -- Lebenszyklus-Orchestrator: laedt bestehende Ketten beim Start, fuehrt periodische Erkennung durch, invalidiert Ketten automatisch wenn Komponenten-Tools entfernt werden

**Sicherheit:** Zusammengesetzte Tools erben die restriktivsten Sicherheitsflags ihrer Komponenten-Tools.

**V2-Erweiterungen:**
- **DAG-Ausfuehrung** -- Ketten mit unabhaengigen Schritten laufen parallel
- **Saga-Rollback** -- bei Fehlern werden vorherige Schritte rueckgaengig gemacht
- **Ketten-Versionierung** -- alte Versionen werden archiviert

**Konfidenz-Kaskade:** Ketten-Instinkte folgen demselben Konfidenz-Lebenszyklus wie regulaere Instinkte. Ketten, die unter die Veraltungsschwelle fallen, werden automatisch deregistriert.

---

## Multi-Agent-Orchestrierung

Das Multi-Agent-System ermoeglicht die gleichzeitige Verwaltung mehrerer Agenten mit kanalbasierter Sitzungsisolation.

**Komponenten:**
- **AgentManager** -- verwaltet Agenten-Lebenszyklus mit kanalbasierter Sitzungsisolation
- **AgentBudgetTracker** -- agentbasiertes Budget-Tracking mit konfigurierbaren Limits
- **AgentRegistry** -- zentrale Registrierung aller aktiven Agenten

**Aktivierung:** Standardmaessig aktiviert. Setzen Sie `MULTI_AGENT_ENABLED=false`, um das Legacy-Single-Agent-Verhalten zu verwenden.

---

## Aufgabendelegation

Das Delegationssystem ermoeglicht es Agenten, Aufgaben an andere Agenten zu delegieren.

**Komponenten:**
- **TierRouter** -- 4-stufiges Routing zur Auswahl des optimalen Agenten fuer eine Aufgabe
- **DelegationManager** -- Lebenszyklus-Verwaltung delegierter Aufgaben mit maximaler Tiefe von 2
- **DelegationTool** -- Tool-Schnittstelle fuer die Agenten-zu-Agenten-Delegation
- Budgetbewusst -- delegierte Aufgaben werden gegen das Budget des delegierenden Agenten verrechnet

**Aktivierung:** Opt-in ueber `TASK_DELEGATION_ENABLED=true`.

---

## Gedaechtnisverfall und Konsolidierung

Das Gedaechtnissystem unterstuetzt nun automatischen Verfall und Konsolidierung von Eintraegen.

**Verfall:**
- Exponentieller Verfall basierend auf dem Alter und der Zugriffsfrequenz von Eintraegen
- Instinkte sind vom Verfall ausgenommen -- sie verfallen nie

**Konsolidierung:**
- Leerlauf-Konsolidierung mit HNSW-Clustering fasst aehnliche Eintraege zusammen
- Soft-Delete mit Rueckgaengig-Funktion -- konsolidierte Eintraege koennen wiederhergestellt werden

---

## Deployment-Subsystem

Das Deployment-Subsystem ermoeglicht automatisierte Deployments mit Sicherheitsgates.

**Komponenten:**
- **ReadinessChecker** -- prueft Deployment-Voraussetzungen (Tests, Build, Konfiguration)
- **DeployTrigger** -- Genehmigungswarteschlange fuer Deployment-Anfragen mit konfigurierbarer Ablaufzeit
- **DeploymentExecutor** -- fuehrt Deployments aus mit integriertem Rollback bei Fehlern
- **Circuit Breaker** -- unterbricht Deployments bei wiederholten Fehlern

**Aktivierung:** Standardmaessig deaktiviert. Opt-in ueber `DEPLOY_ENABLED=true`.

---

### Agent Core (Autonomer OODA-Loop)

Wenn der Daemon-Modus aktiv ist, fuehrt der Agent Core eine kontinuierliche Beobachten-Orientieren-Entscheiden-Handeln-Schleife aus:

- **Beobachten**: Sammelt den Umgebungsstatus von 6 Beobachtern (Dateiaenderungen, Git-Status, Build-Ergebnisse, Ausloeser-Ereignisse, Benutzeraktivitaet, Testergebnisse)
- **Orientieren**: Bewertet Beobachtungen mittels lernbasierter Priorisierung (PriorityScorer mit Instinkt-Integration)
- **Entscheiden**: LLM-Reasoning mit budgetbewusster Drosselung (30s Mindestintervall, Prioritaetsschwelle, Budget-Untergrenze)
- **Handeln**: Reicht Ziele ein, benachrichtigt den Benutzer oder wartet (der Agent kann entscheiden "nichts zu tun")

Sicherheit: tickInFlight-Schutz, Ratenbegrenzung, Budget-Untergrenze (10%) und DaemonSecurityPolicy-Durchsetzung.

### Multi-Provider Intelligentes Routing

Bei 2+ konfigurierten Anbietern routet Strada.Brain Aufgaben automatisch zum optimalen Anbieter:

| Aufgabentyp | Routing-Strategie |
|-------------|------------------|
| Planung | Groesstes Kontextfenster (Claude > GPT > Gemini) |
| Code-Generierung | Starke Tool-Aufrufe (Claude > Kimi > OpenAI) |
| Code-Review | Anderes Modell als der Executor (Diversitaets-Bias) |
| Einfache Fragen | Schnellstes/Guenstigstes (Groq > Kimi > Ollama) |
| Debugging | Starke Fehleranalyse |

**Presets**: `budget` (kostenoptimiert), `balanced` (Standard), `performance` (Qualitaet zuerst)
**PAOR-Phasen-Wechsel**: Verschiedene Anbieter fuer Planungs- vs. Ausfuehrungs- vs. Reflexionsphasen.
**Konsens**: Niedrige Konfidenz → automatische Zweitmeinung von einem anderen Anbieter.

### Strada.MCP-Integration

Strada.Brain erkennt [Strada.MCP](https://github.com/okandemirel/Strada.MCP) (76-Tool Unity MCP-Server) und informiert den Agenten ueber verfuegbare MCP-Faehigkeiten einschliesslich Laufzeitsteuerung, Dateioperationen, Git, .NET-Build, Code-Analyse und Szenen-/Prefab-Verwaltung.

---

## Daemon-Modus

Der Daemon bietet 24/7-Autonombetrieb mit einem Heartbeat-gesteuerten Ausloesersystem. Wenn der Daemon-Modus aktiv ist, laeuft der **Agent Core OODA-Loop** innerhalb der Daemon-Ticks, beobachtet die Umgebung und handelt proaktiv zwischen Benutzerinteraktionen. Der Befehl `/autonomous on` propagiert jetzt an die DaemonSecurityPolicy und ermoeglicht vollatonomen Betrieb ohne Genehmigungsaufforderungen pro Aktion.

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
- **Deploy** -- wird ausgeloest wenn Deployment-Bedingungen erfuellt sind (Genehmigungsgate erforderlich)

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

Jeder OpenAI-kompatible Anbieter funktioniert. Alle unten aufgefuehrten Anbieter sind bereits implementiert; die meisten benoetigen einen API-Schluessel zur Aktivierung, und OpenAI kann alternativ auch die lokale ChatGPT/Codex-Subscription dieser Maschine fuer Konversationen verwenden.

| Variable | Anbieter | Standard-Modell |
|----------|----------|-----------------|
| `ANTHROPIC_API_KEY` | Claude (primaer) | `claude-sonnet-4-20250514` |
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
| `OLLAMA_BASE_URL` | Ollama (lokal) | `llama3` |
| `PROVIDER_CHAIN` | Failover-Reihenfolge | z.B. `claude,kimi,deepseek,ollama` |
| `OPENAI_AUTH_MODE` | OpenAI-Authentifizierungsmodus | `api-key` (Standard) oder `chatgpt-subscription` |
| `OPENAI_CHATGPT_AUTH_FILE` | Optionale Codex-Auth-Datei | Standard: `~/.codex/auth.json` bei `OPENAI_AUTH_MODE=chatgpt-subscription` |

**Anbieter-Kette:** Setzen Sie `PROVIDER_CHAIN` auf eine kommagetrennte Liste von Anbieternamen. Strada bleibt die Control Plane und nutzt diese Kette als Standard-Orchestrierungspool fuer den primaeren Ausfuehrungs-Worker, das Supervisor-Routing und Fallbacks. Beispiel: `PROVIDER_CHAIN=kimi,deepseek,claude` verwendet Kimi zuerst, DeepSeek wenn Kimi fehlschlaegt, dann Claude.
Auch Klaerungen laufen jetzt ueber diese Control Plane. Ein Worker darf eine Rueckfrage vorschlagen, aber Strada fuehrt zuerst intern eine `clarification-review`-Phase aus, bevor daraus ein `ask_user`-Turn werden darf.
Auch der Abschluss laeuft jetzt ueber eine interne Verifier-Pipeline. Build-Verifikation, Targeted-Repro/Failing-Path-Pruefung, Log-Review, Strada-Conformance und Completion-Review muessen sauber sein, bevor Strada fertig ist. `/routing info` und das Dashboard zeigen jetzt sowohl Laufzeitspuren als auch Phase-Outcomes (`approved`, `continued`, `replanned`, `blocked`).
Strada fuehrt jetzt zudem pro Aufgabe ein internes execution journal und rollback memory. Replans koennen den letzten stabilen Checkpoint, erschoepfte Branches, einen project/world anchor und adaptive phase scores nutzen, die ohne hardcoded Provider-Lore in das Routing zurueckfliessen. Diese Scores beruecksichtigen jetzt auch verifier clean rate, rollback pressure, retry count, repeated failure fingerprints, repeated world-context failures, phase-local token cost, provider catalog freshness und official alignment / capability drift aus dem geteilten Provider-Katalog.
Der Speicher ist jetzt auch nach Rolle getrennt: user profile state haelt Namen/Preferences/Autonomy, task execution memory haelt session summaries/open items/rollback state, und project/world memory wird jetzt explizit aus dem aktiven Projektpfad plus gecachter AgentDB analysis in den Prompt injiziert. Task execution memory ist nur der `latest snapshot` fuer die aktive Identity; die `persisted chronology` eines exakten Task-Runs liegt nicht dort. Diese project/world-Schicht speist jetzt auch recovery memory und adaptive routing, waehrend semantic retrieval weiterhin lebende relevante Memory getrennt hinzufuegt.
Auch cross-session `execution replay` nutzt jetzt denselben Pfad: Strada schreibt project/world-aware recovery summaries in learning trajectories und injiziert die relevantesten frueheren success/failure branches als `Execution Replay`-Kontextschicht, bevor aehnliche Arbeit erneut versucht wird.
Die Replay-Korrelation wird jetzt auch mit chat-scoped `taskRunId` persistiert, damit gleichzeitige Tasks im selben Chat ihre Phase-Telemetrie und Recovery-History nicht vermischen. Die `persisted chronology` eines exakten Task-Runs liegt damit in learning trajectories / replay contexts mit demselben `taskRunId`.
Dieser replay context persistiert jetzt auch phase/provider telemetry, damit adaptive routing bei aehnlichen Aufgaben erfolgreiche Worker aus frueheren Trajectories wiederverwenden kann statt nur auf in-memory runtime history zu schauen.

**Wichtig:** `OPENAI_AUTH_MODE=chatgpt-subscription` gilt nur fuer OpenAI-Konversationszuege in Strada. Dadurch erhalten Sie kein OpenAI-API- oder Embedding-Kontingent. Wenn Sie `EMBEDDING_PROVIDER=openai` waehlen, brauchen Sie weiterhin `OPENAI_API_KEY`.
Strada gibt offensichtliche naechste Schritte nicht an den Benutzer zurueck. Wenn ein Provider eine unvollstaendige Analyse liefert, den Benutzer fragt, was als Naechstes zu tun ist, oder ohne genug Belege eine breite Abschlussbehauptung aufstellt, oeffnet Strada die Schleife erneut, fuehrt einen weiteren Inspektions-/Review-Durchlauf aus und antwortet erst wieder, wenn das Ergebnis verifiziert ist oder ein echter externer Blocker bleibt.

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
| `DISCORD_GUILD_ID` | Discord-Guild-ID |
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
| `WHATSAPP_ALLOWED_NUMBERS` | Kommagetrennte Telefonnummern (optional; leer = offen fuer alle) |

### Funktionen

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `RAG_ENABLED` | `true` | Semantische Code-Suche ueber Ihr C#-Projekt aktivieren |
| `EMBEDDING_PROVIDER` | `auto` | Embedding-Anbieter: `auto`, `openai`, `gemini`, `mistral`, `together`, `fireworks`, `qwen`, `ollama` |
| `EMBEDDING_DIMENSIONS` | (Anbieter-Standard) | Ausgabe-Vektordimensionen (Matryoshka: 128-3072 fuer Gemini/OpenAI) |
| `MEMORY_ENABLED` | `true` | Persistenten Konversationsspeicher aktivieren |
| `MEMORY_DB_PATH` | `.strada-memory` | Verzeichnis fuer Speicher-Datenbankdateien |
| `WEB_CHANNEL_PORT` | `3000` | Port fuer Web-Dashboard |
| `DASHBOARD_ENABLED` | `false` | HTTP-Monitoring-Dashboard aktivieren |
| `DASHBOARD_PORT` | `3100` | Dashboard-Server-Port |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | WebSocket-Echtzeit-Dashboard aktivieren |
| `ENABLE_PROMETHEUS` | `false` | Prometheus-Metriken-Endpunkt aktivieren (Port 9090) |
| `MULTI_AGENT_ENABLED` | `true` | Multi-Agent-Orchestrierung aktivieren |
| `TASK_DELEGATION_ENABLED` | `false` | Aufgabendelegation zwischen Agenten aktivieren |
| `AGENT_MAX_DELEGATION_DEPTH` | `2` | Maximale Delegationskettiefe |
| `DEPLOY_ENABLED` | `false` | Deployment-Subsystem aktivieren |
| `SOUL_FILE` | `soul.md` | Pfad zur Agenten-Persoenlichkeitsdatei (Hot-Reload bei Aenderung) |
| `SOUL_FILE_WEB` | (nicht gesetzt) | Kanalspezifische Persoenlichkeit fuer den Web-Kanal |
| `SOUL_FILE_TELEGRAM` | (nicht gesetzt) | Kanalspezifische Persoenlichkeit fuer Telegram |
| `SOUL_FILE_DISCORD` | (nicht gesetzt) | Kanalspezifische Persoenlichkeit fuer Discord |
| `SOUL_FILE_SLACK` | (nicht gesetzt) | Kanalspezifische Persoenlichkeit fuer Slack |
| `SOUL_FILE_WHATSAPP` | (nicht gesetzt) | Kanalspezifische Persoenlichkeit fuer WhatsApp |
| `READ_ONLY_MODE` | `false` | Alle Schreiboperationen blockieren |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` oder `debug` |

### Routing & Konsens

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `ROUTING_PRESET` | `balanced` | Routing-Preset: `budget`, `balanced` oder `performance` |
| `ROUTING_PHASE_SWITCHING` | `true` | PAOR-Phasen-Wechsel ueber Anbieter aktivieren |
| `CONSENSUS_MODE` | `auto` | Konsens-Modus: `auto`, `critical-only`, `always` oder `disabled` |
| `CONSENSUS_THRESHOLD` | `0.5` | Konfidenzschwelle fuer Konsens-Ausloesung |
| `CONSENSUS_MAX_PROVIDERS` | `3` | Maximale Anbieter fuer Konsensabfrage |
| `STRADA_DAEMON_DAILY_BUDGET` | `1.0` | Taegliches Budget (USD) fuer Daemon-Modus |

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

Der Agent verfuegt ueber mehr als 40 integrierte Tools, organisiert nach Kategorie:

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
| `strada_analyze_project` | Vollstaendiger C#-Projekt-Scan -- Module, Systeme, Komponenten, Services |
| `strada_create_module` | Vollstaendiges Modul-Geruest generieren (`.asmdef`, Konfiguration, Verzeichnisse) |
| `strada_create_component` | ECS-Komponentenstrukturen mit Felddefinitionen generieren |
| `strada_create_mediator` | `EntityMediator<TView>` mit Komponentenbindungen generieren |
| `strada_create_system` | `SystemBase`/`JobSystemBase`/`BurstSystem` generieren |

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

### Agenten-Interaktion
| Tool | Beschreibung |
|------|-------------|
| `ask_user` | Stellt dem Benutzer eine Klaerungsfrage mit Mehrfachauswahl und empfohlener Antwort, aber erst nachdem `clarification-review` sie als wirklich notwendig freigegeben hat |
| `show_plan` | Zeigt den Ausfuehrungsplan und wartet auf Benutzerfreigabe (Genehmigen/Aendern/Ablehnen) |
| `switch_personality` | Wechselt die Agenten-Persoenlichkeit zur Laufzeit (casual/formal/minimal/default) |

### Sonstiges
| Tool | Beschreibung |
|------|-------------|
| `shell_exec` | Shell-Befehle ausfuehren (30s Timeout, Sperrliste fuer gefaehrliche Befehle) |
| `code_quality` | Code-Qualitaetsanalyse pro Datei oder pro Projekt |
| `rag_index` | Inkrementelle oder vollstaendige Projekt-Neuindizierung ausloesen |

---

## Chat-Befehle

Slash-Befehle, die in allen Chat-Kanaelen verfuegbar sind:

| Befehl | Beschreibung |
|--------|-------------|
| `/daemon` | Daemon-Status anzeigen |
| `/daemon start` | Daemon-Heartbeat-Schleife starten |
| `/daemon stop` | Daemon-Heartbeat-Schleife stoppen |
| `/daemon triggers` | Aktive Ausloeser anzeigen |
| `/agent` | Agent-Core-Status anzeigen |
| `/routing` | Routing-Status und Preset anzeigen |
| `/routing preset <name>` | Routing-Preset wechseln (budget/balanced/performance) |
| `/routing info` | Letzte Routing-Entscheidungen, Laufzeit-Ausfuehrungsspuren, Phase-Outcomes und adaptive phase scores fuer die aktuelle Identitaet anzeigen, inklusive verifier clean rate, rollback pressure, retry count, token-cost telemetry, provider catalog freshness und official alignment / capability drift fuer Planning, Execution, Clarification-Review, Review und Synthesis |

---

## RAG-Pipeline

Die RAG-Pipeline (Retrieval-Augmented Generation) indiziert Ihren C#-Quellcode fuer die semantische Suche.

**Indizierungsablauf:**
1. Scannt `**/*.cs`-Dateien in Ihrem Unity-Projekt
2. Zerlegt Code strukturell -- Datei-Header, Klassen, Methoden, Konstruktoren
3. Generiert Embeddings ueber den konfigurierten Anbieter -- OpenAI (`text-embedding-3-small`), Gemini (`gemini-embedding-2-preview` mit Matryoshka-Dimensionen 128-3072), Mistral, Ollama oder andere. Steuern Sie die Ausgabegroesse mit `EMBEDDING_DIMENSIONS`.
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
| Medienanhänge | Ja (base64) | Ja (Foto/Dok/Video/Sprache) | Ja (beliebiger Anhang) | Ja (Datei-Download) | Ja (Bild/Video/Audio/Dok) | Nein |
| Vision (Bild→LLM) | Ja | Ja | Ja | Ja | Ja | Nein |
| Streaming (In-Place-Bearbeitung) | Ja | Ja | Ja | Ja | Ja | Ja |
| Tipp-Anzeige | Ja | Ja | Ja | Nein | Ja | Nein |
| Bestaetigungsdialoge | Ja (Modal) | Ja (Inline-Tastatur) | Ja (Buttons) | Ja (Block Kit) | Ja (nummerierte Antwort) | Ja (Readline) |
| Thread-Unterstuetzung | Nein | Nein | Ja | Ja | Nein | Nein |
| Ratenbegrenzer (ausgehend) | Ja (pro Sitzung) | Nein | Ja (Token Bucket) | Ja (4-stufiges Schiebefenster) | Inline-Drosselung | Nein |

### Streaming

Alle Kanaele implementieren In-Place-Streaming. Die Antwort des Agenten erscheint progressiv, waehrend das LLM sie generiert. Updates werden plattformspezifisch gedrosselt, um Ratenlimits zu vermeiden (WhatsApp/Discord: 1/Sek., Slack: 2/Sek.).

### Authentifizierung

- **Telegram**: Standardmaessig alles blockiert. `ALLOWED_TELEGRAM_USER_IDS` muss gesetzt werden.
- **Discord**: Standardmaessig alles blockiert. `ALLOWED_DISCORD_USER_IDS` oder `ALLOWED_DISCORD_ROLE_IDS` muss gesetzt werden.
- **Slack**: **Standardmaessig offen.** Wenn `ALLOWED_SLACK_USER_IDS` leer ist, kann jeder Slack-Benutzer auf den Bot zugreifen. Setzen Sie die Erlaubnisliste fuer die Produktion.
- **WhatsApp**: Standardmaessig offen. Wenn `WHATSAPP_ALLOWED_NUMBERS` gesetzt ist, beschraenkt der Adapter eingehende Nachrichten auf diese Erlaubnisliste.

---

## Sicherheit

### Schicht 1: Kanal-Authentifizierung
Plattformspezifische Erlaubnislisten, die beim Nachrichteneingang geprueft werden (vor jeder Verarbeitung).

### Schicht 2: Ratenbegrenzung
Pro-Benutzer-Schiebefenster (Minute/Stunde) + globale taegliche/monatliche Token- und USD-Budget-Obergrenzen.

### Schicht 3: Pfadschutz
Jede Dateioperation loest Symlinks auf und validiert, dass der Pfad innerhalb des Projektstammverzeichnisses bleibt. Ueber 30 sensible Muster werden blockiert (`.env`, `.git/credentials`, SSH-Schluessel, Zertifikate, `node_modules/`).

### Schicht 4: Mediensicherheit
Alle Medienanhänge werden vor der Verarbeitung validiert: MIME-Allowlist, typspezifische Groessenlimits (20 MB Bild, 50 MB Video, 25 MB Audio, 10 MB Dokument), Magic-Bytes-Verifizierung und SSRF-Schutz bei Download-URLs.

### Schicht 5: Geheimnis-Bereinigung
24 Regex-Muster erkennen und maskieren Anmeldeinformationen in allen Tool-Ausgaben, bevor sie das LLM erreichen. Abgedeckt: OpenAI-Schluessel, GitHub-Tokens, Slack-/Discord-/Telegram-Tokens, AWS-Schluessel, JWTs, Bearer-Auth, PEM-Schluessel, Datenbank-URLs und generische Geheimnis-Muster.

### Schicht 6: Nur-Lesen-Modus
Wenn `READ_ONLY_MODE=true`, werden 23 Schreib-Tools vollstaendig aus der Tool-Liste des Agenten entfernt -- das LLM kann nicht einmal versuchen, sie aufzurufen.

### Schicht 7: Operationsbestaetigung
Schreiboperationen (Dateischreibvorgaenge, Git-Commits, Shell-Ausfuehrung) koennen eine Benutzerbestaetigung ueber die interaktive Oberflaeche des Kanals erfordern (Buttons, Inline-Tastaturen, Text-Eingabeaufforderungen).

### Schicht 8: Tool-Ausgabe-Bereinigung
Alle Tool-Ergebnisse werden auf 8192 Zeichen begrenzt und vor der Rueckgabe an das LLM auf API-Schluessel-Muster geprueft.

### Schicht 9: RBAC (intern)
5 Rollen (Superadmin, Admin, Entwickler, Betrachter, Service) mit einer Berechtigungsmatrix fuer 9 Ressourcentypen. Die Richtlinien-Engine unterstuetzt zeit-, IP- und benutzerdefinierte Bedingungen.

### Schicht 10: Daemon-Sicherheit
`DaemonSecurityPolicy` erzwingt Tool-spezifische Genehmigungsanforderungen fuer Daemon-ausgeloeste Operationen. Schreib-Tools erfordern eine ausdrueckliche Benutzergenehmigung ueber die `ApprovalQueue` vor der Ausfuehrung.

---

## Dashboard und Monitoring

### HTTP-Dashboard (`DASHBOARD_ENABLED=true`)
Erreichbar unter `http://localhost:3100` (nur Localhost). Zeigt: Betriebszeit, Nachrichtenanzahl, Token-Verbrauch, aktive Sitzungen, Tool-Nutzungstabelle, Sicherheitsstatistiken. Automatische Aktualisierung alle 3 Sekunden.

### Health-Endpunkte
- `GET /health` -- Liveness-Probe (`{"status":"ok"}`)
- `GET /ready` -- Tiefgehende Bereitschaftspruefung: prueft Speicher und Kanal-Gesundheit. Gibt 200 (bereit), 207 (eingeschraenkt) oder 503 (nicht bereit) zurueck

### Prometheus (`ENABLE_PROMETHEUS=true`)
Metriken unter `http://localhost:9090/metrics`. Zaehler fuer Nachrichten, Tool-Aufrufe, Tokens. Histogramme fuer Anfragedauer, Tool-Dauer, LLM-Latenz. Standard-Node.js-Metriken (CPU, Heap, GC, Event Loop).

### WebSocket-Dashboard (`ENABLE_WEBSOCKET_DASHBOARD=true`)
Echtzeit-Metriken werden jede Sekunde gepusht. Unterstuetzt authentifizierte Verbindungen, Heartbeat-Ueberwachung sowie von der Anwendung registrierte Befehls- und Benachrichtigungs-Handler. Wenn `WEBSOCKET_DASHBOARD_AUTH_TOKEN` gesetzt ist, verwenden Sie dieses Bearer-Token; andernfalls bootstrappt das Same-Origin-Dashboard automatisch ein prozessgebundenes Token.

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
npm test                         # Standard-Komplettsuite (fuer Stabilitaet in Batches)
npm run test:watch               # Watch-Modus
npm test -- --coverage           # Mit Coverage
npm test -- src/agents/tools/file-read.test.ts  # Einzelne Datei / gezielter Durchlauf
npm test -- src/dashboard/prometheus.test.ts    # Gezielte Suite ueber den Standard-Runner
LOCAL_SERVER_TESTS=1 npm test -- src/dashboard/prometheus.test.ts src/dashboard/websocket-server.test.ts
npm run sync:check -- --core-path /path/to/Strada.Core  # Strada.Core-API-Drift validieren
npm run test:file-build-flow     # Opt-in lokaler .NET-Integrationsfluss
npm run test:unity-fixture       # Opt-in lokaler Unity-Compile/Test-Fixture-Flow
npm run test:hnsw-perf           # Opt-in HNSW-Benchmark / Recall-Suite
npm run typecheck                # TypeScript-Typpruefung
npm run lint                     # ESLint
```

Hinweise:
- `npm test` verwendet einen batch-basierten Vitest-Runner mit Fork-Workern, um den frueheren Full-Suite-OOM-Pfad zu vermeiden.
- Dashboard-Tests mit echtem Socket-Binding werden standardmaessig uebersprungen; fuer lokale Verifikation `LOCAL_SERVER_TESTS=1` setzen.
- `sync:check` validiert das Strada.Core-Wissen von Strada.Brain gegen einen echten Checkout; CI erzwingt dies mit `--max-drift-score 0`.
- `test:file-build-flow`, `test:unity-fixture` und `test:hnsw-perf` sind bewusst opt-in, weil sie lokale Build-Tools, einen lizenzierten Unity-Editor oder benchmarklastige Lasten brauchen.
- `test:unity-fixture` kann trotz korrektem generiertem Code fehlschlagen, wenn die lokale Unity-Batchmode-/Lizenzumgebung instabil ist.

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
    tools/              # 30+ Tool-Implementierungen (ask_user, show_plan, switch_personality, ...)
    soul/               # SOUL.md-Persoenlichkeitslader mit Hot-Reload und kanalspezifischen Overrides
    plugins/            # Externer Plugin-Loader
  profiles/             # Persoenlichkeitsprofile: casual.md, formal.md, minimal.md
  channels/
    telegram/           # Grammy-basierter Bot
    discord/            # discord.js-Bot mit Slash-Befehlen
    slack/              # Slack Bolt (Socket-Modus) mit Block Kit
    whatsapp/           # Baileys-basierter Client mit Sitzungsverwaltung
    web/                # Express + WebSocket Web-Kanal
    cli/                # Readline-REPL
  web-portal/           # React + Vite Chat-UI (Dunkel-/Hell-Theme, Datei-Upload, Streaming, Dashboard-Tab, Seitenpanel)
  memory/
    file-memory-manager.ts   # Altes Backend: JSON + TF-IDF (Fallback)
    unified/
      agentdb-memory.ts      # Aktives Backend: SQLite + HNSW, 3-stufiges Auto-Tiering
      agentdb-adapter.ts     # IMemoryManager-Adapter fuer AgentDBMemory
      migration.ts           # Legacy FileMemoryManager -> AgentDB-Migration
      consolidation-engine.ts # Leerlauf-Konsolidierung mit HNSW-Clustering
      consolidation-types.ts  # Konsolidierungs-Typdefinitionen und -Interfaces
    decay/                    # Exponentielles Gedaechtnisverfall-System
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
      confidence-scorer.ts  # Hybride gewichtete Konfidenz (5 Faktoren), Elo, Wilson-Intervalle
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
  multi-agent/
    agent-manager.ts     # Multi-Agent-Verwaltung mit Sitzungsisolation
    agent-budget-tracker.ts # Agentbasiertes Budget-Tracking
    agent-registry.ts    # Zentrale Agentenregistrierung
  delegation/
    delegation-manager.ts  # Delegations-Lebenszyklus-Verwaltung
    delegation-tool.ts     # Tool-Schnittstelle fuer Delegation
    tier-router.ts         # 4-stufiges Aufgaben-Routing
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
      deploy-trigger.ts      # Deployment-Ausloeser mit Genehmigungsgate
    deployment/
      deployment-executor.ts # Deployment-Ausfuehrung mit Rollback
      readiness-checker.ts   # Deployment-Voraussetzungspruefung
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
  utils/
    media-processor.ts  # Medien-Download, Validierung (MIME/Groesse/Magic Bytes), SSRF-Schutz
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
