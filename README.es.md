<p align="center">
  <img src="docs/assets/logo.svg" alt="Strada.Brain Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>Agente de Desarrollo con IA para Proyectos Unity / Strada.Core</strong><br/>
  Un agente de programacion autonomo que se conecta a Telegram, Discord, Slack, WhatsApp o tu terminal &mdash; lee tu codigo fuente, escribe codigo, ejecuta builds y aprende de sus errores.
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
  <a href="README.de.md">Deutsch</a> |
  <strong>Español</strong> |
  <a href="README.fr.md">Français</a>
</p>

---

## Que es esto?

Strada.Brain es un agente de IA con el que hablas a traves de un canal de chat. Describes lo que quieres -- "crea un nuevo sistema ECS para movimiento del jugador" o "encuentra todos los componentes que usan health" -- y el agente lee tu proyecto C#, escribe el codigo, ejecuta `dotnet build`, corrige errores automaticamente y te envia el resultado. Tiene memoria persistente, aprende de errores pasados y puede usar multiples proveedores de IA con failover automatico.

**Esto no es una biblioteca ni una API.** Es una aplicacion independiente que ejecutas. Se conecta a tu plataforma de chat, lee tu proyecto Unity en disco y opera de forma autonoma dentro de los limites que configures.

---

## Inicio Rapido

### Requisitos Previos

- **Node.js 20+** y npm
- Una **clave de API de Anthropic** (Claude) -- otros proveedores son opcionales
- Un **proyecto Unity** con el framework Strada.Core (la ruta que le das al agente)

### 1. Instalacion

```bash
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain
npm install
```

### 2. Configuracion

```bash
cp .env.example .env
```

Abre `.env` y configura como minimo:

```env
ANTHROPIC_API_KEY=sk-ant-...      # Tu clave de API de Claude
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Debe contener Assets/
JWT_SECRET=<generar con: openssl rand -hex 64>
```

### 3. Ejecutar

```bash
# Modo CLI interactivo (la forma mas rapida de probar)
npm run dev -- cli

# O con un canal de chat
npm run dev -- start --channel telegram
npm run dev -- start --channel discord
npm run dev -- start --channel slack
npm run dev -- start --channel whatsapp
```

### 4. Habla con el

Una vez en ejecucion, envia un mensaje a traves de tu canal configurado:

```
> Analiza la estructura del proyecto
> Crea un nuevo modulo llamado "Combat" con un DamageSystem y un HealthComponent
> Encuentra todos los sistemas que consultan PositionComponent
> Ejecuta el build y corrige cualquier error
```

---

## Arquitectura

```
+-----------------------------------------------------------------+
|  Canales de Chat                                                 |
|  Telegram | Discord | Slack | WhatsApp | CLI                    |
+------------------------------+----------------------------------+
                               |
                    Interfaz IChannelAdapter
                               |
+------------------------------v----------------------------------+
|  Orchestrator (Bucle del Agente)                                 |
|  System prompt + Memoria + Contexto RAG -> LLM -> Llamadas Tool  |
|  Hasta 50 iteraciones de herramientas por mensaje                |
|  Autonomia: recuperacion de errores, deteccion de bloqueos,      |
|  verificacion de builds                                          |
+------------------------------+----------------------------------+
                               |
          +--------------------+--------------------+
          |                    |                    |
+---------v------+  +---------v------+  +----------v---------+
| Proveedores IA |  | 30+ Tools      |  | Fuentes de Contexto|
| Claude (prim.) |  | E/S Archivos   |  | Memoria (TF-IDF)   |
| OpenAI, Kimi   |  | Ops. Git       |  | RAG (vectores HNSW)|
| DeepSeek, Qwen |  | Ejec. Shell    |  | Analisis proyecto  |
| MiniMax, Groq  |  | .NET Build/Test|  | Patrones aprendidos|
| Ollama (local) |  | Navegador      |  +--------------------+
| + 4 mas        |  | Strata Codegen |
+----------------+  +----------------+
```

### Como funciona el bucle del agente

1. **Llega un mensaje** desde un canal de chat
2. **Recuperacion de memoria** -- encuentra las 3 conversaciones pasadas mas relevantes (TF-IDF)
3. **Recuperacion RAG** -- busqueda semantica sobre tu codigo C# (vectores HNSW, top 6 resultados)
4. **Analisis en cache** -- inyecta la estructura del proyecto si fue analizada previamente
5. **Llamada LLM** con system prompt + contexto + definiciones de herramientas
6. **Ejecucion de herramientas** -- si el LLM llama herramientas, se ejecutan y los resultados se devuelven al LLM
7. **Verificaciones de autonomia** -- la recuperacion de errores analiza fallos, el detector de bloqueos advierte si esta atascado, la auto-verificacion fuerza un `dotnet build` antes de responder si se modificaron archivos `.cs`
8. **Repeticion** hasta 50 iteraciones hasta que el LLM produzca una respuesta de texto final
9. **La respuesta se envia** al usuario a traves del canal (streaming si esta soportado)

---

## Referencia de Configuracion

Toda la configuracion se realiza mediante variables de entorno. Consulta `.env.example` para la lista completa.

### Requeridas

| Variable | Descripcion |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Clave de API de Claude (proveedor LLM principal) |
| `UNITY_PROJECT_PATH` | Ruta absoluta al directorio raiz de tu proyecto Unity (debe contener `Assets/`) |
| `JWT_SECRET` | Secreto para firma JWT. Generar: `openssl rand -hex 64` |

### Proveedores de IA

Cualquier proveedor compatible con OpenAI funciona. Todos los proveedores listados abajo estan implementados y solo necesitan una clave de API para activarse.

| Variable | Proveedor | Modelo por Defecto |
|----------|-----------|-------------------|
| `ANTHROPIC_API_KEY` | Claude (principal) | `claude-sonnet-4-20250514` |
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
| `OLLAMA_BASE_URL` | Ollama (local) | `llama3` |
| `PROVIDER_CHAIN` | Orden de failover | ej. `claude,kimi,deepseek,ollama` |

**Cadena de proveedores:** Configura `PROVIDER_CHAIN` con una lista de nombres de proveedores separados por comas. El sistema prueba cada uno en orden, recurriendo al siguiente en caso de fallo. Ejemplo: `PROVIDER_CHAIN=kimi,deepseek,claude` usa Kimi primero, DeepSeek si Kimi falla, luego Claude.

### Canales de Chat

**Telegram:**
| Variable | Descripcion |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token de @BotFather |
| `ALLOWED_TELEGRAM_USER_IDS` | IDs de usuario de Telegram separados por comas (requerido, bloquea todo si esta vacio) |

**Discord:**
| Variable | Descripcion |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Token del bot de Discord |
| `DISCORD_CLIENT_ID` | ID de cliente de la aplicacion Discord |
| `ALLOWED_DISCORD_USER_IDS` | IDs de usuario separados por comas (bloquea todo si esta vacio) |
| `ALLOWED_DISCORD_ROLE_IDS` | IDs de roles separados por comas para acceso basado en roles |

**Slack:**
| Variable | Descripcion |
|----------|-------------|
| `SLACK_BOT_TOKEN` | `xoxb-...` Token del bot |
| `SLACK_APP_TOKEN` | `xapp-...` Token a nivel de aplicacion (para modo socket) |
| `SLACK_SIGNING_SECRET` | Secreto de firma de la app de Slack |
| `ALLOWED_SLACK_USER_IDS` | IDs de usuario separados por comas (**abierto a todos si esta vacio**) |
| `ALLOWED_SLACK_WORKSPACES` | IDs de workspace separados por comas (**abierto a todos si esta vacio**) |

**WhatsApp:**
| Variable | Descripcion |
|----------|-------------|
| `WHATSAPP_SESSION_PATH` | Directorio para archivos de sesion (por defecto: `.whatsapp-session`) |
| `WHATSAPP_ALLOWED_NUMBERS` | Numeros de telefono separados por comas |

### Funcionalidades

| Variable | Por Defecto | Descripcion |
|----------|-------------|-------------|
| `RAG_ENABLED` | `true` | Habilitar busqueda semantica de codigo sobre tu proyecto C# |
| `EMBEDDING_PROVIDER` | `openai` | Proveedor de embeddings: `openai` u `ollama` |
| `MEMORY_ENABLED` | `true` | Habilitar memoria persistente de conversaciones |
| `MEMORY_DB_PATH` | `.strata-memory` | Directorio para archivos de base de datos de memoria |
| `DASHBOARD_ENABLED` | `false` | Habilitar dashboard HTTP de monitoreo |
| `DASHBOARD_PORT` | `3001` | Puerto del servidor del dashboard |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | Habilitar dashboard en tiempo real via WebSocket |
| `ENABLE_PROMETHEUS` | `false` | Habilitar endpoint de metricas Prometheus (puerto 9090) |
| `READ_ONLY_MODE` | `false` | Bloquear todas las operaciones de escritura |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` o `debug` |

### Limitacion de Tasa

| Variable | Por Defecto | Descripcion |
|----------|-------------|-------------|
| `RATE_LIMIT_ENABLED` | `false` | Habilitar limitacion de tasa |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | `0` | Limite de mensajes por usuario por minuto (0 = ilimitado) |
| `RATE_LIMIT_MESSAGES_PER_HOUR` | `0` | Limite por hora por usuario |
| `RATE_LIMIT_TOKENS_PER_DAY` | `0` | Cuota diaria global de tokens |
| `RATE_LIMIT_DAILY_BUDGET_USD` | `0` | Tope de gasto diario en USD |
| `RATE_LIMIT_MONTHLY_BUDGET_USD` | `0` | Tope de gasto mensual en USD |

### Seguridad

| Variable | Por Defecto | Descripcion |
|----------|-------------|-------------|
| `REQUIRE_MFA` | `false` | Requerir autenticacion multi-factor |
| `BROWSER_HEADLESS` | `true` | Ejecutar automatizacion del navegador en modo headless |
| `BROWSER_MAX_CONCURRENT` | `5` | Sesiones de navegador simultaneas maximas |

---

## Herramientas

El agente tiene mas de 30 herramientas integradas organizadas por categoria:

### Operaciones de Archivos
| Herramienta | Descripcion |
|-------------|-------------|
| `file_read` | Leer archivos con numeros de linea, paginacion offset/limit (limite 512KB) |
| `file_write` | Crear o sobrescribir archivos (limite 256KB, crea directorios automaticamente) |
| `file_edit` | Edicion buscar-y-reemplazar con verificacion de unicidad |
| `file_delete` | Eliminar un archivo individual |
| `file_rename` | Renombrar o mover archivos dentro del proyecto |
| `file_delete_directory` | Eliminacion recursiva de directorios (limite de seguridad de 50 archivos) |

### Busqueda
| Herramienta | Descripcion |
|-------------|-------------|
| `glob_search` | Buscar archivos por patron glob (max. 50 resultados) |
| `grep_search` | Busqueda de contenido con regex entre archivos (max. 20 coincidencias) |
| `list_directory` | Listado de directorio con tamanos de archivo |
| `code_search` | Busqueda semantica/vectorial via RAG -- consultas en lenguaje natural |
| `memory_search` | Buscar en la memoria persistente de conversaciones |

### Generacion de Codigo Strada
| Herramienta | Descripcion |
|-------------|-------------|
| `strata_analyze_project` | Escaneo completo del proyecto C# -- modulos, sistemas, componentes, servicios |
| `strata_create_module` | Generar scaffold completo de modulo (`.asmdef`, configuracion, directorios) |
| `strata_create_component` | Generar structs de componentes ECS con definiciones de campos |
| `strata_create_mediator` | Generar `EntityMediator<TView>` con bindings de componentes |
| `strata_create_system` | Generar `SystemBase`/`JobSystemBase`/`SystemGroup` |

### Git
| Herramienta | Descripcion |
|-------------|-------------|
| `git_status` | Estado del arbol de trabajo |
| `git_diff` | Mostrar cambios |
| `git_log` | Historial de commits |
| `git_commit` | Staging y commit |
| `git_push` | Push al remoto |
| `git_branch` | Listar, crear o cambiar de rama |
| `git_stash` | Crear, aplicar, listar o descartar stash |

### .NET / Unity
| Herramienta | Descripcion |
|-------------|-------------|
| `dotnet_build` | Ejecutar `dotnet build`, parsear errores MSBuild en salida estructurada |
| `dotnet_test` | Ejecutar `dotnet test`, parsear resultados aprobado/fallido/omitido |

### Otros
| Herramienta | Descripcion |
|-------------|-------------|
| `shell_exec` | Ejecutar comandos shell (timeout 30s, lista de bloqueo de comandos peligrosos) |
| `code_quality` | Analisis de calidad de codigo por archivo o por proyecto |
| `rag_index` | Activar re-indexacion incremental o completa del proyecto |

---

## Capacidades de Canal

| Capacidad | Telegram | Discord | Slack | WhatsApp | CLI |
|-----------|----------|---------|-------|----------|-----|
| Mensajes de texto | Si | Si | Si | Si | Si |
| Streaming (edicion in situ) | Si | Si | Si | Si | Si |
| Indicador de escritura | Si | Si | No | Si | No |
| Dialogos de confirmacion | Si (teclado inline) | Si (botones) | Si (Block Kit) | Si (respuesta numerada) | Si (readline) |
| Carga de archivos | No | No | Si | Si | No |
| Soporte de hilos | No | Si | Si | No | No |
| Limitador de tasa (salida) | No | Si (token bucket) | Si (ventana deslizante 4 niveles) | Limitacion inline | No |

### Streaming

Todos los canales implementan streaming con edicion in situ. La respuesta del agente aparece progresivamente mientras el LLM la genera. Las actualizaciones se regulan por plataforma para evitar limites de tasa (WhatsApp/Discord: 1/seg, Slack: 2/seg).

### Autenticacion

- **Telegram**: Bloquea todo por defecto. Se debe configurar `ALLOWED_TELEGRAM_USER_IDS`.
- **Discord**: Bloquea todo por defecto. Se debe configurar `ALLOWED_DISCORD_USER_IDS` o `ALLOWED_DISCORD_ROLE_IDS`.
- **Slack**: **Abierto por defecto.** Si `ALLOWED_SLACK_USER_IDS` esta vacio, cualquier usuario de Slack puede acceder al bot. Configura la lista de permitidos para produccion.
- **WhatsApp**: Usa la lista de permitidos `WHATSAPP_ALLOWED_NUMBERS` verificada localmente en el adaptador.

---

## Sistema de Memoria

El backend de memoria en produccion es `FileMemoryManager` -- archivos JSON con indexacion de texto TF-IDF para busqueda.

**Como funciona:**
- Cuando el historial de sesion supera los 40 mensajes, los mensajes antiguos se resumen y almacenan como entradas de conversacion
- El agente recupera automaticamente las 3 memorias mas relevantes antes de cada llamada al LLM
- La herramienta `strata_analyze_project` almacena en cache el analisis de estructura del proyecto para inyeccion instantanea de contexto
- La memoria persiste entre reinicios en el directorio `MEMORY_DB_PATH` (por defecto: `.strata-memory/`)

**Backend avanzado (implementado, aun no conectado):** `AgentDBMemory` con SQLite + busqueda vectorial HNSW, memoria de tres niveles (trabajo/efimera/persistente), recuperacion hibrida (70% semantica + 30% TF-IDF). Esta completamente programado pero no conectado en el bootstrap -- `FileMemoryManager` es el backend activo.

---

## Pipeline RAG

La pipeline RAG (Retrieval-Augmented Generation) indexa tu codigo fuente C# para busqueda semantica.

**Flujo de indexacion:**
1. Escanea archivos `**/*.cs` en tu proyecto Unity
2. Divide el codigo estructuralmente -- encabezados de archivo, clases, metodos, constructores
3. Genera embeddings via OpenAI (`text-embedding-3-small`) u Ollama (`nomic-embed-text`)
4. Almacena vectores en el indice HNSW para busqueda rapida de vecinos mas cercanos aproximados
5. Se ejecuta automaticamente al inicio (en segundo plano, no bloqueante)

**Flujo de busqueda:**
1. La consulta se convierte en embedding usando el mismo proveedor
2. La busqueda HNSW devuelve `topK * 3` candidatos
3. El reranker puntua: similitud vectorial (60%) + coincidencia de palabras clave (25%) + bonus estructural (15%)
4. Los 6 mejores resultados (por encima de puntuacion 0.2) se inyectan en el contexto del LLM

**Nota:** La pipeline RAG actualmente solo soporta archivos C#. El chunker es especifico para C#.

---

## Sistema de Aprendizaje

El sistema de aprendizaje observa el comportamiento del agente y aprende de los errores:

- Los **patrones de error** se capturan con indexacion de busqueda de texto completo
- Las **soluciones** se vinculan a patrones de error para recuperacion futura
- Los **instintos** son comportamientos aprendidos atomicos con puntuaciones de confianza bayesianas
- Las **trayectorias** registran secuencias de llamadas a herramientas con resultados
- Las puntuaciones de confianza usan **rating Elo** e **intervalos de puntuacion Wilson** para validez estadistica
- Los instintos por debajo de 0.3 de confianza se marcan como obsoletos; por encima de 0.9 se proponen para promocion

La pipeline de aprendizaje se ejecuta con temporizadores: deteccion de patrones cada 5 minutos, propuestas de evolucion cada hora. Los datos se almacenan en una base de datos SQLite separada (`learning.db`).

---

## Seguridad

### Capa 1: Autenticacion de Canal
Listas de permitidos especificas por plataforma verificadas al llegar el mensaje (antes de cualquier procesamiento).

### Capa 2: Limitacion de Tasa
Ventana deslizante por usuario (minuto/hora) + topes globales diarios/mensuales de tokens y presupuesto en USD.

### Capa 3: Proteccion de Rutas
Cada operacion de archivo resuelve symlinks y valida que la ruta permanezca dentro del directorio raiz del proyecto. Mas de 30 patrones sensibles estan bloqueados (`.env`, `.git/credentials`, claves SSH, certificados, `node_modules/`).

### Capa 4: Sanitizacion de Secretos
24 patrones regex detectan y enmascaran credenciales en todas las salidas de herramientas antes de que lleguen al LLM. Cubre: claves OpenAI, tokens de GitHub, tokens de Slack/Discord/Telegram, claves AWS, JWTs, autenticacion Bearer, claves PEM, URLs de bases de datos y patrones genericos de secretos.

### Capa 5: Modo Solo Lectura
Cuando `READ_ONLY_MODE=true`, se eliminan 23 herramientas de escritura completamente de la lista de herramientas del agente -- el LLM ni siquiera puede intentar llamarlas.

### Capa 6: Confirmacion de Operaciones
Las operaciones de escritura (escritura de archivos, commits de Git, ejecucion de shell) pueden requerir confirmacion del usuario a traves de la interfaz interactiva del canal (botones, teclados inline, prompts de texto).

### Capa 7: Sanitizacion de Salida de Herramientas
Todos los resultados de herramientas se limitan a 8192 caracteres y se limpian de patrones de claves API antes de devolverse al LLM.

### Capa 8: RBAC (Interno)
5 roles (superadmin, admin, desarrollador, visualizador, servicio) con una matriz de permisos que cubre 9 tipos de recursos. El motor de politicas soporta condiciones basadas en tiempo, IP y condiciones personalizadas.

---

## Dashboard y Monitoreo

### Dashboard HTTP (`DASHBOARD_ENABLED=true`)
Accesible en `http://localhost:3001` (solo localhost). Muestra: tiempo de actividad, conteo de mensajes, uso de tokens, sesiones activas, tabla de uso de herramientas, estadisticas de seguridad. Se actualiza automaticamente cada 3 segundos.

### Endpoints de Salud
- `GET /health` -- Sonda de actividad (`{"status":"ok"}`)
- `GET /ready` -- Verificacion profunda de disponibilidad: comprueba la salud de memoria y canales. Devuelve 200 (listo), 207 (degradado) o 503 (no listo)

### Prometheus (`ENABLE_PROMETHEUS=true`)
Metricas en `http://localhost:9090/metrics`. Contadores para mensajes, llamadas a herramientas, tokens. Histogramas para duracion de solicitudes, duracion de herramientas, latencia LLM. Metricas estandar de Node.js (CPU, heap, GC, event loop).

### Dashboard WebSocket (`ENABLE_WEBSOCKET_DASHBOARD=true`)
Metricas en tiempo real enviadas cada segundo. Soporta conexiones autenticadas y comandos remotos (recarga de plugins, limpieza de cache, recuperacion de logs).

---

## Despliegue

### Docker

```bash
docker-compose up -d
```

El `docker-compose.yml` incluye la aplicacion, el stack de monitoreo y el reverse proxy Nginx.

### Modo Daemon

```bash
# Auto-reinicio en caso de fallo con backoff exponencial (1s a 60s, hasta 10 reinicios)
node dist/index.js daemon --channel telegram
```

### Lista de Verificacion para Produccion

- [ ] Configurar `NODE_ENV=production`
- [ ] Configurar `LOG_LEVEL=warn` o `error`
- [ ] Configurar `RATE_LIMIT_ENABLED=true` con topes de presupuesto
- [ ] Configurar listas de permitidos de canales (especialmente Slack -- abierto por defecto)
- [ ] Configurar `READ_ONLY_MODE=true` si solo deseas exploracion segura
- [ ] Habilitar `DASHBOARD_ENABLED=true` para monitoreo
- [ ] Habilitar `ENABLE_PROMETHEUS=true` para recopilacion de metricas
- [ ] Generar un `JWT_SECRET` seguro

---

## Pruebas

```bash
npm test                         # Ejecutar las 1560+ pruebas
npm run test:watch               # Modo observacion
npm test -- --coverage           # Con cobertura
npm test -- src/agents/tools/file-read.test.ts  # Archivo individual
npm run typecheck                # Verificacion de tipos TypeScript
npm run lint                     # ESLint
```

94 archivos de prueba que cubren: agentes, canales, seguridad, RAG, memoria, aprendizaje, dashboard, flujos de integracion.

---

## Estructura del Proyecto

```
src/
  index.ts              # Punto de entrada CLI (Commander.js)
  core/
    bootstrap.ts        # Secuencia de inicializacion completa -- toda la configuracion ocurre aqui
    di-container.ts     # Contenedor DI (disponible pero la configuracion manual predomina)
    tool-registry.ts    # Instanciacion y registro de herramientas
  agents/
    orchestrator.ts     # Bucle principal del agente, gestion de sesiones, streaming
    autonomy/           # Recuperacion de errores, planificacion de tareas, auto-verificacion
    context/            # System prompt (base de conocimiento Strada.Core)
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq + mas
    tools/              # 30+ implementaciones de herramientas
    plugins/            # Cargador de plugins externos
  channels/
    telegram/           # Bot basado en Grammy
    discord/            # Bot discord.js con comandos slash
    slack/              # Slack Bolt (modo socket) con Block Kit
    whatsapp/           # Cliente basado en Baileys con gestion de sesiones
    cli/                # REPL Readline
  memory/
    file-memory-manager.ts   # Backend activo: JSON + TF-IDF
    unified/                 # Backend AgentDB: SQLite + HNSW (aun no conectado)
  rag/
    rag-pipeline.ts     # Orquestacion de indice + busqueda + formato
    chunker.ts          # Chunking estructural especifico para C#
    hnsw/               # Almacen de vectores HNSW (hnswlib-node)
    embeddings/         # Proveedores de embeddings OpenAI y Ollama
    reranker.ts         # Reranking ponderado (vector + palabra clave + estructura)
  security/             # Auth, RBAC, proteccion de rutas, limitador de tasa, sanitizacion de secretos
  learning/             # Coincidencia de patrones, puntuacion de confianza, ciclo de vida de instintos
  intelligence/         # Parsing C#, analisis de proyecto, calidad de codigo
  dashboard/            # Dashboards HTTP, WebSocket, Prometheus
  config/               # Configuracion de entorno validada con Zod
  validation/           # Esquemas de validacion de entrada
```

---

## Contribuir

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para la configuracion de desarrollo, convenciones de codigo y directrices para PR.

---

## Licencia

Licencia MIT - consulta [LICENSE](LICENSE) para mas detalles.
