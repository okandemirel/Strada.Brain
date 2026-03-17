<p align="center">
  <img src="icon/strada-brain-icon.png" alt="Logo de Strada.Brain" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>Agente de Desarrollo con IA para Proyectos Unity / Strada.Core</strong><br/>
  Un agente de programacion autonomo que se conecta a un dashboard web, Telegram, Discord, Slack, WhatsApp o tu terminal &mdash; lee tu codigo fuente, escribe codigo, ejecuta builds, aprende de sus errores y opera de forma autonoma con un bucle daemon 24/7. Ahora con orquestacion multi-agente, delegacion de tareas, consolidacion de memoria, un subsistema de despliegue con puertas de aprobacion, comparticion de medios con soporte de vision LLM, un sistema de personalidad configurable via SOUL.md, herramientas de aclaracion interactivas, enrutamiento inteligente multi-proveedor con conmutacion dinamica segun tarea, verificacion de consenso basada en confianza, un Agent Core autonomo con bucle de razonamiento OODA e integracion con Strada.MCP.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/tests-3450%2B-brightgreen?style=flat-square" alt="Pruebas">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Licencia">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.tr.md">T&uuml;rk&ccedil;e</a> |
  <a href="README.zh.md">&#20013;&#25991;</a> |
  <a href="README.ja.md">&#26085;&#26412;&#35486;</a> |
  <a href="README.ko.md">&#54620;&#44397;&#50612;</a> |
  <a href="README.de.md">Deutsch</a> |
  <strong>Espa&ntilde;ol</strong> |
  <a href="README.fr.md">Fran&ccedil;ais</a>
</p>

---

## Que es esto?

Strada.Brain es un agente de IA con el que hablas a traves de un canal de chat. Describes lo que quieres -- "crea un nuevo sistema ECS para movimiento del jugador" o "encuentra todos los componentes que usan health" -- y el agente lee tu proyecto C#, escribe el codigo, ejecuta `dotnet build`, corrige errores automaticamente y te envia el resultado.

Tiene memoria persistente respaldada por SQLite + vectores HNSW, aprende de errores pasados usando puntuacion de confianza hibrida ponderada, descompone objetivos complejos en ejecucion paralela de DAGs, sintetiza automaticamente cadenas de herramientas multiples con saga rollback y puede ejecutarse como un daemon 24/7 con disparadores proactivos. Soporta orquestacion multi-agente con aislamiento de sesion por canal, delegacion jerarquica de tareas entre niveles de agentes, consolidacion automatica de memoria y un subsistema de despliegue con puertas de aprobacion humana y proteccion de disyuntor.

Nuevo en esta version: Strada.Brain ahora incluye un **Agent Core** -- un motor de razonamiento OODA autonomo que observa el entorno (cambios de archivos, estado de git, resultados de compilacion), razona sobre prioridades usando patrones aprendidos y actua proactivamente. El sistema de **enrutamiento multi-proveedor** selecciona dinamicamente el mejor proveedor de IA para cada tipo de tarea (planificacion, generacion de codigo, depuracion, revision) con presets configurables (budget/balanced/performance). Un sistema de **consenso basado en confianza** consulta automaticamente a un segundo proveedor cuando la confianza del agente es baja, previniendo errores en operaciones criticas. Todas las caracteristicas degradan de forma controlada -- con un solo proveedor, el sistema funciona de forma identica a antes sin ninguna sobrecarga.

**Esto no es una biblioteca ni una API.** Es una aplicacion independiente que ejecutas. Se conecta a tu plataforma de chat, lee tu proyecto Unity en disco y opera de forma autonoma dentro de los limites que configures.

---

## Inicio Rapido

### Requisitos Previos

- **Node.js 20+** y npm
- Una **clave de API de Anthropic** (Claude) -- otros proveedores son opcionales
- Un **proyecto Unity** con el framework Strada.Core (la ruta que le das al agente)

### 1. Instalacion

```bash
# Instalacion global (recomendado)
npm install -g strada-brain

# O clona desde el repositorio
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain
npm install
```

### 2. Configuracion

```bash
# Asistente de configuracion interactivo (terminal o navegador web)
strada setup
```

El asistente te pide la ruta de tu proyecto Unity, la clave de API del proveedor de IA, el canal por defecto e idioma. Elige **Terminal** para configuracion rapida o **Navegador Web** para la interfaz de configuracion completa.

Alternativamente, crea `.env` manualmente:

```env
ANTHROPIC_API_KEY=sk-ant-...      # Tu clave de API de Claude
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Debe contener Assets/
JWT_SECRET=<generar con: openssl rand -hex 64>
```

### 3. Ejecutar

```bash
# Comienza con canal web por defecto
strada start

# Modo CLI interactivo (la forma mas rapida de probar)
strada start --channel cli

# Modo daemon (operacion autonoma 24/7 con disparadores proactivos)
strada start --channel web --daemon

# Otros canales de chat
strada start --channel telegram
strada start --channel discord
strada start --channel slack
strada start --channel whatsapp

# Supervisor siempre activo con reinicio automatico
strada supervise --channel web
```

### 4. Comandos CLI

```bash
strada setup              # Asistente de configuracion interactivo
strada start              # Inicia el agente
strada supervise          # Ejecuta con supervisor de reinicio automatico
strada update             # Comprueba e aplica actualizaciones
strada update --check     # Comprueba actualizaciones sin aplicar
strada version-info       # Muestra version, metodo de instalacion, estado de actualización
```

### 5. Habla con el

Una vez en ejecucion, envia un mensaje a traves de tu canal configurado:

```
> Analiza la estructura del proyecto
> Crea un nuevo modulo llamado "Combat" con un DamageSystem y un HealthComponent
> Encuentra todos los sistemas que consultan PositionComponent
> Ejecuta el build y corrige cualquier error
```

**Canal web:** Sin necesidad de terminal -- interactua a traves del dashboard web en `localhost:3000`.

### 6. Actualizacion Automatica

Strada.Brain comprueba automaticamente las actualizaciones diariamente y las aplica cuando esta inactivo. Detecta su metodo de instalacion (npm global, npm local, o git clone) y utiliza la estrategia de actualizacion apropiada.

| Variable | Por Defecto | Descripcion |
|----------|-------------|-------------|
| `AUTO_UPDATE_ENABLED` | `true` | Habilitar/deshabilitar actualizacion automatica |
| `AUTO_UPDATE_INTERVAL_HOURS` | `24` | Frecuencia de comprobacion (horas) |
| `AUTO_UPDATE_IDLE_TIMEOUT_MIN` | `5` | Minutos inactivo antes de aplicar actualizacion |
| `AUTO_UPDATE_CHANNEL` | `stable` | npm dist-tag: `stable` o `latest` |
| `AUTO_UPDATE_AUTO_RESTART` | `true` | Reinicio automatico despues de actualizacion cuando esta inactivo |

---

## Arquitectura

```
+-----------------------------------------------------------------+
|  Canales de Chat                                                 |
|  Web | Telegram | Discord | Slack | WhatsApp | CLI              |
+------------------------------+----------------------------------+
                               |
                    Interfaz IChannelAdapter
                               |
+------------------------------v----------------------------------+
|  Orquestador (Bucle de Agente PAOR)                              |
|  Planificar -> Actuar -> Observar -> Reflexionar maquina estados |
|  Recuperacion de instintos, clasificacion de fallos, replan. aut.|
+-------+--------------+-------------+-----------+----------------+
        |              |             |           |
+-------v------+ +-----v------+ +---v--------+ +v-----------------+
| Proveedores  | | 30+ Herram.| | Contexto   | | Sistema de       |
| de IA        | | E/S Archiv.| | AgentDB    | |  Aprendizaje     |
| Claude (pri.)| | Ops. Git   | | (SQLite +  | | TypedEventBus    |
| OpenAI, Kimi | | Ejec. Shell| |  HNSW)     | | Hybrid ponderado |
| DeepSeek,Qwen| | .NET Build | | Vectores   | | Ciclo de vida    |
| MiniMax, Groq| | Strada Gen | | RAG        | |  de instintos    |
| Ollama + mas | |            | | Identidad  | | Cadenas herram.  |
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

### Como funciona el bucle del agente

1. **Mensaje recibido** desde un canal de chat
2. **Recuperacion de memoria** -- busqueda hibrida de AgentDB (70% semantica HNSW + 30% TF-IDF) encuentra las conversaciones pasadas mas relevantes
3. **Recuperacion RAG** -- busqueda semantica sobre tu codigo C# (vectores HNSW, top 6 resultados)
4. **Recuperacion de instintos** -- consulta proactivamente patrones aprendidos relevantes para la tarea (coincidencia semantica + palabras clave)
5. **Contexto de identidad** -- inyecta la identidad persistente del agente (UUID, conteo de arranques, tiempo activo, estado de recuperacion de fallos)
6. **Fase PLAN** -- el LLM crea un plan numerado, informado por conocimientos aprendidos y fallos pasados
7. **Fase ACTUAR** -- el LLM ejecuta llamadas a herramientas siguiendo el plan
8. **OBSERVAR** -- se registran resultados; recuperacion de errores analiza fallos; el clasificador de fallos categoriza errores
9. **REFLEXIONAR** -- cada 3 pasos (o en error), el LLM decide: **CONTINUAR**, **REPLANIFICAR** o **HECHO**
10. **Replanificacion automatica** -- si ocurren 3+ fallos consecutivos del mismo tipo, fuerza un nuevo enfoque evitando estrategias fallidas
11. **Repetir** hasta 50 iteraciones hasta completar
12. **Aprendizaje** -- los resultados de herramientas fluyen a traves del TypedEventBus al pipeline de aprendizaje para almacenamiento inmediato de patrones
13. **Respuesta enviada** al usuario a traves del canal (streaming si es compatible)

---

## Sistema de Memoria

El backend de memoria activo es `AgentDBMemory` -- SQLite con indexacion vectorial HNSW y una arquitectura de auto-clasificacion en tres niveles.

**Memoria de tres niveles:**
- **Memoria de trabajo** -- contexto de sesion activa, promovida automaticamente tras uso sostenido
- **Memoria efimera** -- almacenamiento a corto plazo, desalojada automaticamente al alcanzar umbrales de capacidad
- **Memoria persistente** -- almacenamiento a largo plazo, promovida desde la efimera segun frecuencia de acceso e importancia

**Como funciona:**
- Cuando el historial de sesion supera los 40 mensajes, los mensajes antiguos se resumen y almacenan como entradas de conversacion
- La recuperacion hibrida combina 70% de similitud semantica (vectores HNSW) con 30% de coincidencia de palabras clave TF-IDF
- La herramienta `strada_analyze_project` almacena en cache el analisis de estructura del proyecto para inyeccion instantanea de contexto
- La memoria persiste entre reinicios en el directorio `MEMORY_DB_PATH` (por defecto: `.strada-memory/`)
- La migracion automatica desde el legado FileMemoryManager se ejecuta en el primer inicio

**Respaldo:** Si la inicializacion de AgentDB falla, el sistema recurre automaticamente a `FileMemoryManager` (JSON + TF-IDF).

---

## Sistema de Aprendizaje

El sistema de aprendizaje observa el comportamiento del agente y aprende de los errores a traves de un pipeline orientado a eventos.

**Pipeline orientado a eventos:**
- Los resultados de herramientas fluyen a traves del `TypedEventBus` hacia un `LearningQueue` serial para procesamiento inmediato
- Sin procesamiento por lotes basado en temporizadores -- los patrones se detectan y almacenan a medida que ocurren
- El `LearningQueue` usa FIFO acotado con aislamiento de errores (los fallos de aprendizaje nunca provocan un fallo del agente)

**Puntuacion de confianza hibrida ponderada:**
- Confianza = suma ponderada de 5 factores: tasaExito (0.35), fuerza del patron (0.25), recencia (0.20), coincidencia de contexto (0.15), verificacion (0.05)
- Las puntuaciones de veredicto (0.0-1.0) actualizan contadores de evidencia alfa/beta para intervalos de confianza
- Los parametros alfa/beta se mantienen para estimacion de incertidumbre pero no se usan para el calculo principal de confianza

**Ciclo de vida de instintos:**
- **Propuesto** (nuevo) -- por debajo de 0.7 de confianza
- **Activo** -- entre 0.7 y 0.9 de confianza
- **Evolucionado** -- por encima de 0.9, propuesto para promocion a permanente
- **Obsoleto** -- por debajo de 0.3, marcado para eliminacion
- **Periodo de enfriamiento** -- ventana de 7 dias con requisitos minimos de observacion antes de cambios de estado
- **Permanente** -- congelado, sin mas actualizaciones de confianza

**Recuperacion activa:** Los instintos se consultan proactivamente al inicio de cada tarea usando el `InstinctRetriever`. Busca por similitud de palabras clave y embeddings vectoriales HNSW para encontrar patrones aprendidos relevantes, que se inyectan en el prompt de la fase PLAN.

**Aprendizaje entre sesiones:** Los instintos llevan metadatos de procedencia (sesion de origen, conteo de sesiones) para transferencia de conocimiento entre sesiones.

---

## Descomposicion de Objetivos

Las solicitudes complejas de multiples pasos se descomponen automaticamente en un grafo aciclico dirigido (DAG) de sub-objetivos.

**GoalDecomposer:**
- La verificacion previa heuristica evita llamadas al LLM para tareas simples (coincidencia de patrones para indicadores de complejidad)
- El LLM genera estructuras DAG con aristas de dependencia y profundidad recursiva opcional (hasta 3 niveles)
- El algoritmo de Kahn valida la estructura DAG libre de ciclos
- Re-descomposicion reactiva: cuando un nodo falla, puede dividirse en pasos de recuperacion mas pequenos

**GoalExecutor:**
- Ejecucion paralela por olas que respeta el orden de dependencias
- Limitacion de concurrencia basada en semaforo (`GOAL_MAX_PARALLEL`)
- Presupuestos de fallo (`GOAL_MAX_FAILURES`) con solicitudes de continuacion al usuario
- Evaluacion de criticidad por LLM para determinar si un nodo fallido debe bloquear a sus dependientes
- Logica de reintentos por nodo (`GOAL_MAX_RETRIES`) con descomposicion de recuperacion al agotarse
- Soporte de AbortSignal para cancelacion
- Estado persistente del arbol de objetivos via `GoalStorage` (SQLite) para reanudacion tras reinicio

---

## Sintesis de Cadenas de Herramientas

El agente detecta y sintetiza automaticamente patrones de cadenas de herramientas multiples en herramientas compuestas reutilizables. V2 agrega ejecucion paralela basada en DAG y saga rollback para cadenas complejas.

**Pipeline:**
1. **ChainDetector** -- analiza datos de trayectorias para encontrar secuencias recurrentes de herramientas (ej., `file_read` -> `file_edit` -> `dotnet_build`)
2. **ChainSynthesizer** -- usa el LLM para generar un `CompositeTool` con mapeo adecuado de entradas/salidas y descripcion
3. **ChainValidator** -- validacion post-sintesis con retroalimentacion en tiempo de ejecucion; rastrea el exito de ejecucion de cadenas via puntuacion de confianza ponderada
4. **ChainManager** -- orquestador de ciclo de vida: carga cadenas existentes al inicio, ejecuta deteccion periodica, invalida automaticamente cadenas cuando se eliminan herramientas componentes

**Mejoras V2:**
- **Ejecucion DAG** -- los pasos independientes se ejecutan en paralelo
- **Saga rollback** -- al fallar un paso, los pasos anteriores se deshacen en orden inverso
- **Versionado de cadenas** -- las versiones antiguas se archivan

**Seguridad:** Las herramientas compuestas heredan los indicadores de seguridad mas restrictivos de sus herramientas componentes.

**Cascada de confianza:** Los instintos de cadena siguen el mismo ciclo de vida de confianza que los instintos regulares. Las cadenas que caen por debajo del umbral de obsolescencia se desregistran automaticamente.

---

## Orquestacion Multi-Agente

Multiples instancias de agente pueden ejecutarse simultaneamente con aislamiento de sesion por canal.

**AgentManager:**
- Crea y gestiona instancias de agente por canal/sesion
- El aislamiento de sesion asegura que los agentes en diferentes canales no interfieran entre si
- Configurable via `MULTI_AGENT_ENABLED` (habilitado por defecto; usa `false` para volver al comportamiento legacy de agente unico)

**AgentBudgetTracker:**
- Seguimiento de tokens y costos por agente con limites de presupuesto configurables
- Topes de presupuesto diario/mensual compartidos entre todos los agentes
- El agotamiento del presupuesto activa degradacion controlada (modo solo lectura) en lugar de un fallo abrupto

**AgentRegistry:**
- Registro central de todas las instancias de agente activas
- Soporta verificaciones de salud y apagado controlado
- Multi-agente es completamente opcional: cuando esta deshabilitado, el sistema opera de forma identica a v2.0

---

## Delegacion de Tareas

Los agentes pueden delegar sub-tareas a otros agentes usando un sistema de enrutamiento por niveles.

**TierRouter (4 niveles):**
- **Nivel 1** -- tareas simples manejadas por el agente actual (sin delegacion)
- **Nivel 2** -- complejidad moderada, delegada a un agente secundario
- **Nivel 3** -- alta complejidad, delegada con presupuesto extendido
- **Nivel 4** -- tareas criticas que requieren capacidades de agente especializadas

**DelegationManager:**
- Gestiona el ciclo de vida de la delegacion: crear, rastrear, completar, cancelar
- Impone profundidad maxima de delegacion (por defecto: 2) para prevenir bucles infinitos de delegacion
- Consciente del presupuesto: las tareas delegadas heredan una porcion del presupuesto restante del padre

**DelegationTool:**
- Expuesta como una herramienta que el agente puede invocar para delegar trabajo
- Incluye agregacion de resultados de sub-tareas delegadas

---

## Decaimiento y Consolidacion de Memoria

Las entradas de memoria decaen naturalmente con el tiempo usando un modelo de decaimiento exponencial, mientras la consolidacion en inactividad reduce la redundancia.

**Decaimiento exponencial:**
- Cada entrada de memoria tiene una puntuacion de decaimiento que disminuye con el tiempo
- La frecuencia de acceso y la importancia aumentan la resistencia al decaimiento
- Los instintos estan exentos del decaimiento (nunca expiran)

**Consolidacion en inactividad:**
- Durante periodos de baja actividad, el motor de consolidacion identifica memorias semanticamente similares usando clustering HNSW
- Las memorias relacionadas se fusionan en resumenes consolidados, reduciendo el almacenamiento y mejorando la calidad de recuperacion
- Eliminacion suave con capacidad de deshacer: las memorias fuente consolidadas se marcan como consolidadas (no se eliminan fisicamente) y pueden restaurarse

**Motor de consolidacion:**
- Umbral de similitud configurable para deteccion de clusters
- Procesamiento por lotes con tamanos de fragmento configurables
- Registro completo de auditoria de operaciones de consolidacion

---

## Subsistema de Despliegue

Un sistema de despliegue opcional con puertas de aprobacion humana y proteccion de disyuntor.

**ReadinessChecker:**
- Valida la disponibilidad del sistema antes del despliegue (estado de compilacion, resultados de pruebas, disponibilidad de recursos)
- Criterios de disponibilidad configurables

**DeployTrigger:**
- Se integra con el sistema de disparadores del daemon como un nuevo tipo de disparador
- Se activa cuando se cumplen las condiciones de despliegue (ej., todas las pruebas pasan, aprobacion concedida)
- Incluye una cola de aprobacion: los despliegues requieren aprobacion humana explicita antes de la ejecucion

**DeploymentExecutor:**
- Ejecuta pasos de despliegue en secuencia con capacidad de rollback
- La sanitizacion de variables de entorno previene la filtracion de credenciales en los registros de despliegue
- Disyuntor: los fallos consecutivos de despliegue activan un enfriamiento automatico para prevenir fallos en cascada

**Seguridad:** El despliegue esta deshabilitado por defecto y requiere habilitacion explicita via configuracion. Todas las acciones de despliegue se registran y son auditables.

---

### Agent Core (Bucle OODA Autonomo)

Cuando el modo daemon esta activo, el Agent Core ejecuta un bucle continuo de observar-orientar-decidir-actuar:

- **Observar**: Recopila el estado del entorno de 6 observadores (cambios de archivos, estado de git, resultados de compilacion, eventos de disparadores, actividad del usuario, resultados de pruebas)
- **Orientar**: Puntua las observaciones usando prioridad informada por aprendizaje (PriorityScorer con integracion de instintos)
- **Decidir**: Razonamiento LLM con limitacion consciente del presupuesto (intervalo minimo de 30s, umbral de prioridad, piso de presupuesto)
- **Actuar**: Envia objetivos, notifica al usuario o espera (el agente puede decidir "nada que hacer")

Seguridad: proteccion tickInFlight, limitacion de tasa, piso de presupuesto (10%) y aplicacion de DaemonSecurityPolicy.

### Enrutamiento Inteligente Multi-Proveedor

Con 2+ proveedores configurados, Strada.Brain enruta automaticamente las tareas al proveedor optimo:

| Tipo de Tarea | Estrategia de Enrutamiento |
|---------------|---------------------------|
| Planificacion | Ventana de contexto mas amplia (Claude > GPT > Gemini) |
| Generacion de Codigo | Fuerte invocacion de herramientas (Claude > Kimi > OpenAI) |
| Revision de Codigo | Modelo diferente al executor (sesgo de diversidad) |
| Preguntas Simples | Mas rapido/economico (Groq > Kimi > Ollama) |
| Depuracion | Fuerte analisis de errores |

**Presets**: `budget` (optimizado en costos), `balanced` (por defecto), `performance` (calidad primero)
**Cambio de Fase PAOR**: Diferentes proveedores para las fases de planificacion vs ejecucion vs reflexion.
**Consenso**: Confianza baja → segunda opinion automatica de un proveedor diferente.

### Integracion con Strada.MCP

Strada.Brain detecta [Strada.MCP](https://github.com/okandemirel/Strada.MCP) (servidor MCP Unity de 76 herramientas) e informa al agente sobre las capacidades MCP disponibles, incluyendo control de tiempo de ejecucion, operaciones de archivos, git, compilacion .NET, analisis de codigo y gestion de escenas/prefabs.

---

## Modo Daemon

El daemon proporciona operacion autonoma 24/7 con un sistema de disparadores impulsado por latidos. Cuando el modo daemon esta activo, el **bucle OODA del Agent Core** se ejecuta dentro de los ticks del daemon, observando el entorno y actuando proactivamente entre las interacciones del usuario. El comando `/autonomous on` ahora se propaga a la DaemonSecurityPolicy, habilitando la operacion completamente autonoma sin solicitudes de aprobacion por accion.

```bash
npm run dev -- daemon --channel web
```

**HeartbeatLoop:**
- Intervalo de tick configurable que evalua los disparadores registrados en cada ciclo
- Evaluacion secuencial de disparadores que previene condiciones de carrera en el presupuesto
- Persiste el estado de ejecucion para recuperacion ante fallos

**Tipos de disparadores:**
- **Cron** -- tareas programadas usando expresiones cron
- **Vigilancia de archivos** -- monitorea cambios en el sistema de archivos en rutas configuradas
- **Checklist** -- se dispara cuando los items del checklist vencen
- **Webhook** -- endpoint HTTP POST que activa tareas ante solicitudes entrantes
- **Deploy** -- se activa cuando se cumplen las condiciones de despliegue (requiere puerta de aprobacion)

**Resiliencia:**
- **Circuit breakers** -- por disparador con enfriamiento por backoff exponencial, persistidos entre reinicios
- **Seguimiento de presupuesto** -- tope diario de gasto en USD con eventos de alerta de umbral
- **Deduplicacion de disparadores** -- supresion basada en contenido y en enfriamiento para prevenir disparos duplicados
- **Supresion de solapamiento** -- omite disparadores que ya tienen una tarea activa en ejecucion

**Seguridad:**
- `DaemonSecurityPolicy` controla que herramientas requieren aprobacion del usuario cuando son invocadas por disparadores del daemon
- `ApprovalQueue` con expiracion configurable para operaciones de escritura

**Reportes:**
- `NotificationRouter` enruta eventos a canales configurados segun nivel de urgencia (silencioso/bajo/medio/alto/critico)
- Limitacion de tasa por urgencia y soporte de horas de silencio (notificaciones no criticas se almacenan en buffer)
- `DigestReporter` genera reportes de resumen periodicos
- Todas las notificaciones se registran en el historial SQLite

---

## Sistema de Identidad

El agente mantiene una identidad persistente entre sesiones y reinicios.

**IdentityStateManager** (respaldado por SQLite):
- UUID unico del agente generado en el primer arranque
- Conteo de arranques, tiempo activo acumulado, marcas de tiempo de ultima actividad
- Contadores totales de mensajes y tareas
- Deteccion de apagado limpio para recuperacion ante fallos
- Cache de contadores en memoria con volcado periodico para minimizar escrituras en SQLite

**Recuperacion ante fallos:**
- Al iniciar, si la sesion anterior no se cerro limpiamente, construye un `CrashRecoveryContext`
- Incluye duracion de la inactividad, arboles de objetivos interrumpidos y conteo de arranques
- Se inyecta en el prompt del sistema para que el LLM reconozca naturalmente el fallo y pueda reanudar el trabajo interrumpido

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

Cualquier proveedor compatible con OpenAI funciona. Todos los proveedores listados a continuacion estan implementados y solo necesitan una clave de API para activarse.

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

**Web:**
| Variable | Descripcion |
|----------|-------------|
| `WEB_CHANNEL_PORT` | Puerto para el dashboard web (por defecto: `3000`) |

**Telegram:**
| Variable | Descripcion |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token de @BotFather |
| `ALLOWED_TELEGRAM_USER_IDS` | IDs de usuario de Telegram separados por comas (requerido, bloquea todo si esta vacio) |

**Discord:**
| Variable | Descripcion |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Token del bot de Discord |
| `DISCORD_GUILD_ID` | ID del servidor (guild) de Discord |
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
| `EMBEDDING_PROVIDER` | `auto` | Proveedor de embeddings: `auto`, `openai`, `gemini`, `mistral`, `together`, `fireworks`, `qwen`, `ollama` |
| `EMBEDDING_DIMENSIONS` | (proveedor por defecto) | Dimensiones del vector de salida (Matryoshka: 128-3072 para Gemini/OpenAI) |
| `MEMORY_ENABLED` | `true` | Habilitar memoria persistente de conversaciones |
| `MEMORY_DB_PATH` | `.strada-memory` | Directorio para archivos de base de datos de memoria |
| `WEB_CHANNEL_PORT` | `3000` | Puerto del dashboard web |
| `DASHBOARD_ENABLED` | `false` | Habilitar dashboard HTTP de monitoreo |
| `DASHBOARD_PORT` | `3001` | Puerto del servidor del dashboard |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | Habilitar dashboard en tiempo real via WebSocket |
| `ENABLE_PROMETHEUS` | `false` | Habilitar endpoint de metricas Prometheus (puerto 9090) |
| `MULTI_AGENT_ENABLED` | `true` | Habilitar orquestacion multi-agente |
| `TASK_DELEGATION_ENABLED` | `false` | Habilitar delegacion de tareas entre agentes |
| `AGENT_MAX_DELEGATION_DEPTH` | `2` | Profundidad maxima de cadena de delegacion |
| `DEPLOY_ENABLED` | `false` | Habilitar subsistema de despliegue |
| `SOUL_FILE` | `soul.md` | Ruta al archivo de personalidad del agente (recarga en caliente al cambiar) |
| `SOUL_FILE_WEB` | (no definido) | Anulacion de personalidad por canal para el canal web |
| `SOUL_FILE_TELEGRAM` | (no definido) | Anulacion de personalidad por canal para Telegram |
| `SOUL_FILE_DISCORD` | (no definido) | Anulacion de personalidad por canal para Discord |
| `SOUL_FILE_SLACK` | (no definido) | Anulacion de personalidad por canal para Slack |
| `SOUL_FILE_WHATSAPP` | (no definido) | Anulacion de personalidad por canal para WhatsApp |
| `READ_ONLY_MODE` | `false` | Bloquear todas las operaciones de escritura |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` o `debug` |

### Enrutamiento y Consenso

| Variable | Por Defecto | Descripcion |
|----------|-------------|-------------|
| `ROUTING_PRESET` | `balanced` | Preset de enrutamiento: `budget`, `balanced` o `performance` |
| `ROUTING_PHASE_SWITCHING` | `true` | Habilitar cambio de fases PAOR entre proveedores |
| `CONSENSUS_MODE` | `auto` | Modo de consenso: `auto`, `critical-only`, `always` o `disabled` |
| `CONSENSUS_THRESHOLD` | `0.5` | Umbral de confianza para activar consenso |
| `CONSENSUS_MAX_PROVIDERS` | `3` | Maximo de proveedores a consultar para consenso |
| `STRADA_DAEMON_DAILY_BUDGET` | `1.0` | Presupuesto diario (USD) para modo daemon |

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

El agente tiene mas de 40 herramientas integradas organizadas por categoria:

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
| `strada_analyze_project` | Escaneo completo del proyecto C# -- modulos, sistemas, componentes, servicios |
| `strada_create_module` | Generar scaffold completo de modulo (`.asmdef`, configuracion, directorios) |
| `strada_create_component` | Generar structs de componentes ECS con definiciones de campos |
| `strada_create_mediator` | Generar `EntityMediator<TView>` con bindings de componentes |
| `strada_create_system` | Generar esqueletos `SystemBase`/`JobSystemBase`/`BurstSystem` |

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

### Interaccion del Agente
| Herramienta | Descripcion |
|-------------|-------------|
| `ask_user` | Hace al usuario una pregunta de aclaracion con opciones multiples y respuesta recomendada |
| `show_plan` | Muestra el plan de ejecucion y espera aprobacion del usuario (Aprobar/Modificar/Rechazar) |
| `switch_personality` | Cambia la personalidad del agente en tiempo de ejecucion (casual/formal/minimal/default) |

### Otros
| Herramienta | Descripcion |
|-------------|-------------|
| `shell_exec` | Ejecutar comandos shell (timeout 30s, lista de bloqueo de comandos peligrosos) |
| `code_quality` | Analisis de calidad de codigo por archivo o por proyecto |
| `rag_index` | Activar re-indexacion incremental o completa del proyecto |

---

## Comandos de Chat

Comandos slash disponibles en todos los canales de chat:

| Comando | Descripcion |
|---------|-------------|
| `/daemon` | Mostrar estado del daemon |
| `/daemon start` | Iniciar bucle de latido del daemon |
| `/daemon stop` | Detener bucle de latido del daemon |
| `/daemon triggers` | Mostrar disparadores activos |
| `/agent` | Mostrar estado del Agent Core |
| `/routing` | Mostrar estado de enrutamiento y preset |
| `/routing preset <nombre>` | Cambiar preset de enrutamiento (budget/balanced/performance) |
| `/routing info` | Mostrar decisiones de enrutamiento recientes |

---

## Pipeline RAG

El pipeline RAG (Retrieval-Augmented Generation) indexa tu codigo fuente C# para busqueda semantica.

**Flujo de indexacion:**
1. Escanea archivos `**/*.cs` en tu proyecto Unity
2. Divide el codigo estructuralmente -- encabezados de archivo, clases, metodos, constructores
3. Genera embeddings via Gemini Embedding 2.0 (por defecto), OpenAI (`text-embedding-3-small`), Ollama (`nomic-embed-text`) u otros proveedores -- soporta dimensiones Matryoshka para control flexible de tamano vectorial
4. Almacena vectores en el indice HNSW para busqueda rapida de vecinos mas cercanos aproximados
5. Se ejecuta automaticamente al inicio (en segundo plano, no bloqueante)

**Flujo de busqueda:**
1. La consulta se convierte en embedding usando el mismo proveedor
2. La busqueda HNSW devuelve `topK * 3` candidatos
3. El reranker puntua: similitud vectorial (60%) + coincidencia de palabras clave (25%) + bonus estructural (15%)
4. Los 6 mejores resultados (por encima de puntuacion 0.2) se inyectan en el contexto del LLM

**Nota:** El pipeline RAG actualmente solo soporta archivos C#. El chunker es especifico para C#.

---

## Capacidades de Canal

| Capacidad | Web | Telegram | Discord | Slack | WhatsApp | CLI |
|-----------|-----|----------|---------|-------|----------|-----|
| Mensajes de texto | Si | Si | Si | Si | Si | Si |
| Adjuntos multimedia | Si (base64) | Si (foto/doc/video/voz) | Si (cualquier adjunto) | Si (descarga de archivo) | Si (imagen/video/audio/doc) | No |
| Vision (imagen→LLM) | Si | Si | Si | Si | Si | No |
| Streaming (edicion in situ) | Si | Si | Si | Si | Si | Si |
| Indicador de escritura | Si | Si | Si | No | Si | No |
| Dialogos de confirmacion | Si (modal) | Si (teclado inline) | Si (botones) | Si (Block Kit) | Si (respuesta numerada) | Si (readline) |
| Soporte de hilos | No | No | Si | Si | No | No |
| Limitador de tasa (salida) | Si (por sesion) | No | Si (token bucket) | Si (ventana deslizante 4 niveles) | Limitacion inline | No |

### Streaming

Todos los canales implementan streaming con edicion in situ. La respuesta del agente aparece progresivamente mientras el LLM la genera. Las actualizaciones se regulan por plataforma para evitar limites de tasa (WhatsApp/Discord: 1/seg, Slack: 2/seg).

### Autenticacion

- **Telegram**: Bloquea todo por defecto. Se debe configurar `ALLOWED_TELEGRAM_USER_IDS`.
- **Discord**: Bloquea todo por defecto. Se debe configurar `ALLOWED_DISCORD_USER_IDS` o `ALLOWED_DISCORD_ROLE_IDS`.
- **Slack**: **Abierto por defecto.** Si `ALLOWED_SLACK_USER_IDS` esta vacio, cualquier usuario de Slack puede acceder al bot. Configura la lista de permitidos para produccion.
- **WhatsApp**: Usa la lista de permitidos `WHATSAPP_ALLOWED_NUMBERS` verificada localmente en el adaptador.

---

## Seguridad

### Capa 1: Autenticacion de Canal
Listas de permitidos especificas por plataforma verificadas al llegar el mensaje (antes de cualquier procesamiento).

### Capa 2: Limitacion de Tasa
Ventana deslizante por usuario (minuto/hora) + topes globales diarios/mensuales de tokens y presupuesto en USD.

### Capa 3: Proteccion de Rutas
Cada operacion de archivo resuelve symlinks y valida que la ruta permanezca dentro del directorio raiz del proyecto. Mas de 30 patrones sensibles estan bloqueados (`.env`, `.git/credentials`, claves SSH, certificados, `node_modules/`).

### Capa 4: Seguridad de Medios
Todos los adjuntos multimedia son validados antes de su procesamiento: lista de MIME permitidos, limites de tamano por tipo (20 MB imagen, 50 MB video, 25 MB audio, 10 MB documento), verificacion de bytes magicos y proteccion SSRF en URLs de descarga.

### Capa 5: Sanitizacion de Secretos
24 patrones regex detectan y enmascaran credenciales en todas las salidas de herramientas antes de que lleguen al LLM. Cubre: claves OpenAI, tokens de GitHub, tokens de Slack/Discord/Telegram, claves AWS, JWTs, autenticacion Bearer, claves PEM, URLs de bases de datos y patrones genericos de secretos.

### Capa 6: Modo Solo Lectura
Cuando `READ_ONLY_MODE=true`, se eliminan 23 herramientas de escritura completamente de la lista de herramientas del agente -- el LLM ni siquiera puede intentar llamarlas.

### Capa 7: Confirmacion de Operaciones
Las operaciones de escritura (escritura de archivos, commits de Git, ejecucion de shell) pueden requerir confirmacion del usuario a traves de la interfaz interactiva del canal (botones, teclados inline, prompts de texto).

### Capa 8: Sanitizacion de Salida de Herramientas
Todos los resultados de herramientas se limitan a 8192 caracteres y se limpian de patrones de claves API antes de devolverse al LLM.

### Capa 9: RBAC (Interno)
5 roles (superadmin, admin, desarrollador, visualizador, servicio) con una matriz de permisos que cubre 9 tipos de recursos. El motor de politicas soporta condiciones basadas en tiempo, IP y condiciones personalizadas.

### Capa 10: Seguridad del Daemon
`DaemonSecurityPolicy` impone requisitos de aprobacion a nivel de herramienta para operaciones activadas por el daemon. Las herramientas de escritura requieren aprobacion explicita del usuario a traves del `ApprovalQueue` antes de su ejecucion.

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
Metricas en tiempo real enviadas cada segundo. Soporta conexiones autenticadas y comandos remotos (recarga de plugins, limpieza de cache, recuperacion de logs). Los eventos del daemon (disparos de disparadores, alertas de presupuesto, progreso de objetivos) se transmiten por WebSocket.

### Sistema de Metricas
`MetricsStorage` (SQLite) registra tasa de completitud de tareas, conteos de iteraciones, uso de herramientas y reutilizacion de patrones. `MetricsRecorder` captura metricas por sesion. El comando CLI `metrics` muestra metricas historicas.

---

## Despliegue

### Docker

```bash
docker-compose up -d
```

El `docker-compose.yml` incluye la aplicacion, el stack de monitoreo y el reverse proxy nginx.

### Modo Daemon

```bash
# Operacion autonoma 24/7 con bucle de latido y disparadores proactivos
node dist/index.js daemon --channel web

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
- [ ] Configurar limites de presupuesto del daemon (`RATE_LIMIT_DAILY_BUDGET_USD`)

---

## Pruebas

```bash
npm test                         # Suite completa predeterminada (por lotes para estabilidad)
npm run test:watch               # Modo observacion
npm test -- --coverage           # Con cobertura
npm test -- src/agents/tools/file-read.test.ts  # Archivo individual / paso dirigido
npm test -- src/dashboard/prometheus.test.ts    # Suite dirigida con el runner predeterminado
LOCAL_SERVER_TESTS=1 npm test -- src/dashboard/prometheus.test.ts src/dashboard/websocket-server.test.ts
npm run sync:check -- --core-path /path/to/Strada.Core  # Validar drift de la API de Strada.Core
npm run test:file-build-flow     # Flujo local de integracion .NET opt-in
npm run test:unity-fixture       # Flujo local opt-in de fixture Unity compile/test
npm run test:hnsw-perf           # Suite opt-in de benchmark / recall HNSW
npm run typecheck                # Verificacion de tipos TypeScript
npm run lint                     # ESLint
```

Notas:
- `npm test` usa un runner por lotes de Vitest con workers `fork` para evitar la ruta anterior de OOM en la suite completa.
- Las pruebas del dashboard que dependen de `socket bind` se omiten por defecto; usa `LOCAL_SERVER_TESTS=1` para validacion local real.
- `sync:check` valida el conocimiento de Strada.Core en Strada.Brain contra un checkout real; CI lo obliga con `--max-drift-score 0`.
- `test:file-build-flow`, `test:unity-fixture` y `test:hnsw-perf` son opt-in a proposito porque requieren herramientas locales de compilacion, un editor Unity con licencia o cargas pesadas de benchmark.
- `test:unity-fixture` puede fallar aunque el codigo generado sea correcto si el entorno local de Unity batchmode / licencias no esta sano.

---

## Estructura del Proyecto

```
src/
  index.ts              # Punto de entrada CLI (Commander.js)
  core/
    bootstrap.ts        # Secuencia de inicializacion completa -- toda la configuracion ocurre aqui
    event-bus.ts        # TypedEventBus para comunicacion desacoplada orientada a eventos
    tool-registry.ts    # Instanciacion y registro de herramientas
  agents/
    orchestrator.ts     # Bucle de agente PAOR, gestion de sesiones, streaming
    agent-state.ts      # Maquina de estados de fase (Planificar/Actuar/Observar/Reflexionar)
    paor-prompts.ts     # Constructores de prompts conscientes de fase
    instinct-retriever.ts # Recuperacion proactiva de patrones aprendidos
    failure-classifier.ts # Categorizacion de errores y disparadores de replanificacion automatica
    autonomy/           # Recuperacion de errores, planificacion de tareas, auto-verificacion
    context/            # System prompt (base de conocimiento Strada.Core)
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq + mas
    tools/              # 30+ implementaciones de herramientas (ask_user, show_plan, switch_personality, ...)
    soul/               # Cargador de personalidad SOUL.md con recarga en caliente y anulaciones por canal
    plugins/            # Cargador de plugins externos
  profiles/             # Archivos de perfiles de personalidad: casual.md, formal.md, minimal.md
  channels/
    telegram/           # Bot basado en Grammy
    discord/            # Bot discord.js con comandos slash
    slack/              # Slack Bolt (modo socket) con Block Kit
    whatsapp/           # Cliente basado en Baileys con gestion de sesiones
    web/                # Canal web Express + WebSocket
    cli/                # REPL Readline
  web-portal/           # UI de chat React + Vite (tema oscuro/claro, carga de archivos, streaming, pestana dashboard, panel lateral)
  memory/
    file-memory-manager.ts   # Backend legado: JSON + TF-IDF (respaldo)
    unified/
      agentdb-memory.ts      # Backend activo: SQLite + HNSW, auto-clasificacion en 3 niveles
      agentdb-adapter.ts     # Adaptador IMemoryManager para AgentDBMemory
      migration.ts           # Migracion de FileMemoryManager legado -> AgentDB
      consolidation-engine.ts # Consolidacion de memoria en inactividad con clustering HNSW
      consolidation-types.ts  # Definiciones de tipos e interfaces de consolidacion
    decay/                    # Sistema de decaimiento exponencial de memoria
  rag/
    rag-pipeline.ts     # Orquestacion de indice + busqueda + formato
    chunker.ts          # Chunking estructural especifico para C#
    hnsw/               # Almacen de vectores HNSW (hnswlib-node)
    embeddings/         # Proveedores de embeddings OpenAI y Ollama
    reranker.ts         # Reranking ponderado (vector + palabra clave + estructura)
  learning/
    pipeline/
      learning-pipeline.ts  # Deteccion de patrones, creacion de instintos, propuestas de evolucion
      learning-queue.ts     # Procesador asincrono serial para aprendizaje orientado a eventos
      embedding-queue.ts    # Generacion asincrona acotada de embeddings
    scoring/
      confidence-scorer.ts  # Confianza hibrida ponderada (5 factores), Elo, intervalos de Wilson
    matching/
      pattern-matcher.ts    # Coincidencia de patrones por palabras clave + semantica
    hooks/
      error-learning-hooks.ts  # Hooks de captura de errores/resoluciones
    storage/
      learning-storage.ts  # Almacenamiento SQLite para instintos, trayectorias, patrones
      migrations/          # Migraciones de esquema (procedencia entre sesiones)
    chains/
      chain-detector.ts    # Deteccion de secuencias recurrentes de herramientas
      chain-synthesizer.ts # Generacion de herramientas compuestas basada en LLM
      composite-tool.ts    # Herramienta compuesta ejecutable
      chain-validator.ts   # Validacion post-sintesis, retroalimentacion en tiempo de ejecucion
      chain-manager.ts     # Orquestador de ciclo de vida completo
  multi-agent/
    agent-manager.ts    # Ciclo de vida multi-agente y aislamiento de sesion
    agent-budget-tracker.ts  # Seguimiento de presupuesto por agente
    agent-registry.ts   # Registro central de agentes activos
  delegation/
    delegation-manager.ts    # Gestion del ciclo de vida de delegacion
    delegation-tool.ts       # Herramienta de delegacion para agentes
    tier-router.ts           # Enrutamiento de tareas en 4 niveles
  goals/
    goal-decomposer.ts  # Descomposicion de objetivos basada en DAG (proactiva + reactiva)
    goal-executor.ts    # Ejecucion paralela por olas con presupuestos de fallo
    goal-validator.ts   # Deteccion de ciclos en DAG con algoritmo de Kahn
    goal-storage.ts     # Persistencia SQLite para arboles de objetivos
    goal-progress.ts    # Seguimiento y reporte de progreso
    goal-resume.ts      # Reanudacion de arboles de objetivos interrumpidos tras reinicio
    goal-renderer.ts    # Visualizacion del arbol de objetivos
  daemon/
    heartbeat-loop.ts   # Bucle central tick-evaluar-disparar
    trigger-registry.ts # Registro y ciclo de vida de disparadores
    daemon-storage.ts   # Persistencia SQLite para estado del daemon
    daemon-events.ts    # Definiciones de eventos tipados para el subsistema daemon
    daemon-cli.ts       # Comandos CLI para gestion del daemon
    budget/
      budget-tracker.ts # Seguimiento de presupuesto diario en USD
    resilience/
      circuit-breaker.ts # Circuit breaker por disparador con backoff exponencial
    security/
      daemon-security-policy.ts  # Requisitos de aprobacion de herramientas para el daemon
      approval-queue.ts          # Cola de solicitudes de aprobacion con expiracion
    dedup/
      trigger-deduplicator.ts    # Deduplicacion por contenido + enfriamiento
    triggers/
      cron-trigger.ts        # Programacion con expresiones cron
      file-watch-trigger.ts  # Monitoreo de cambios en el sistema de archivos
      checklist-trigger.ts   # Items de checklist con fecha de vencimiento
      webhook-trigger.ts     # Endpoint de webhook HTTP POST
      deploy-trigger.ts      # Disparador de condiciones de despliegue con puerta de aprobacion
    deployment/
      deployment-executor.ts # Ejecucion de despliegue con rollback
      readiness-checker.ts   # Validacion de disponibilidad pre-despliegue
    reporting/
      notification-router.ts # Enrutamiento de notificaciones basado en urgencia
      digest-reporter.ts     # Generacion de resumenes periodicos
      digest-formatter.ts    # Formateo de reportes de resumen para canales
      quiet-hours.ts         # Almacenamiento en buffer de notificaciones no criticas
  identity/
    identity-state.ts   # Identidad persistente del agente (UUID, conteo de arranques, tiempo activo)
    crash-recovery.ts   # Deteccion de fallos y contexto de recuperacion
  tasks/
    task-manager.ts     # Gestion del ciclo de vida de tareas
    task-storage.ts     # Persistencia SQLite de tareas
    background-executor.ts # Ejecucion de tareas en segundo plano con integracion de objetivos
    message-router.ts   # Enrutamiento de mensajes al orquestador
    command-detector.ts # Deteccion de comandos slash
    command-handler.ts  # Ejecucion de comandos
  metrics/
    metrics-storage.ts  # Almacenamiento SQLite de metricas
    metrics-recorder.ts # Captura de metricas por sesion
    metrics-cli.ts      # Comando CLI para visualizacion de metricas
  utils/
    media-processor.ts  # Descarga de medios, validacion (MIME/tamano/bytes magicos), proteccion SSRF
  security/             # Auth, RBAC, proteccion de rutas, limitador de tasa, sanitizacion de secretos
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
