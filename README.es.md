<p align="center">
  <img src="docs/assets/logo.svg" alt="Strata.Brain Logo" width="200"/>
</p>

<h1 align="center">🧠 Strata.Brain</h1>

<p align="center">
  <strong>Agente de Desarrollo Unity con IA</strong><br/>
  Automatiza tus flujos de trabajo Strata.Core con generación de código inteligente, análisis y colaboración multi-canal.
</p>

<p align="center">
  <a href="https://github.com/yourusername/strata-brain/releases"><img src="https://img.shields.io/github/v/release/yourusername/strata-brain?style=flat-square&color=blue" alt="Release"></a>
  <a href="https://github.com/yourusername/strata-brain/actions"><img src="https://img.shields.io/github/actions/workflow/status/yourusername/strata-brain/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/pruebas-600%2B-green?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/cobertura-85%25-brightgreen?style=flat-square" alt="Coverage">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
</p>

<p align="center">
  <a href="README.md">English</a> •
  <a href="README.zh.md">中文</a> •
  <a href="README.ja.md">日本語</a> •
  <a href="README.ko.md">한국어</a> •
  <a href="README.tr.md">Türkçe</a> •
  <a href="README.de.md">Deutsch</a> •
  <a href="README.fr.md">Français</a>
</p>

---

## ✨ Características

### 🤖 Desarrollo Impulsado por IA
- **Generación Inteligente de Código** - Genera automáticamente Módulos, Sistemas, Componentes y Mediadores
- **Búsqueda Semántica de Código** - 150x más rápido con búsqueda vectorial HNSW (vs fuerza bruta)
- **Aprendizaje por Repetición de Experiencias** - Aprende de interacciones pasadas para mejorar continuamente
- **IA Multi-Proveedor** - Claude, OpenAI, DeepSeek, Groq y 10+ proveedores compatibles

### 💬 Soporte Multi-Canal
Comunícate con Strata.Brain a través de tu plataforma favorita:
- **Telegram** - Desarrollo móvil-first en cualquier lugar
- **Discord** - Colaboración en equipo con embeds enriquecidos
- **Slack** - Integración con flujos de trabajo empresariales
- **WhatsApp** - Correcciones rápidas y verificaciones de estado
- **CLI** - Acceso directo al terminal

### 🎮 Integración Unity/Strata.Core
- **Análisis de Proyecto** - Mapea la estructura completa de tu base de código
- **Automatización de Builds** - Corrige automáticamente errores de compilación
- **Calidad de Código** - Aplica patrones de Strata.Core y mejores prácticas
- **Visualización de Arquitectura** - Entiende sistemas complejos al instante

### 🔒 Seguridad Empresarial
- **RBAC** - Control de acceso basado en roles (5 roles, 14 tipos de recursos)
- **Saneamiento de Secretos** - Enmascaramiento automático de 18 tipos de patrones
- **Registro de Auditoría** - Seguimiento completo de actividades
- **Modo Solo Lectura** - Exploración segura sin cambios

### 📊 Monitoreo y Operaciones
- **Dashboard en Tiempo Real** - Métricas en vivo impulsadas por WebSocket
- **Integración Prometheus** - Exporta métricas a tu stack
- **Alertas Inteligentes** - Discord, Slack, Email, Telegram, PagerDuty
- **Backups Automáticos** - Backups programados + bajo demanda

---

## 🚀 Inicio Rápido

### Requisitos Previos
- Node.js >= 20.0.0
- Proyecto Unity con Strata.Core
- ANTHROPIC_API_KEY (u otro proveedor de IA)

### Instalación

```bash
# Clonar el repositorio
git clone https://github.com/yourusername/strata-brain.git
cd strata-brain

# Instalar dependencias
npm install

# Configurar entorno
cp .env.example .env
# Editar .env con tus configuraciones

# Iniciar desarrollo
npm run dev
```

### Docker (Recomendado para Producción)

```bash
# Despliegue con un comando
./scripts/deploy.sh

# O manualmente
docker-compose up -d
```

---

## 📖 Ejemplos de Uso

### Generar un Nuevo Módulo

**Telegram:**
```
@StrataBrain crea un módulo de Inventario con items, slots y sistema de peso
```

**Discord:**
```
!create-module PlayerStats con atributos Health, Mana, Stamina
```

**CLI:**
```bash
npm run cli -- create-module EnemyAI con comportamientos patrol, attack, flee
```

### Analizar Proyecto

```
@StrataBrain analiza mi proyecto y dime sobre el sistema de combate
```

Respuesta:
```
📊 Análisis de Proyecto

Sistema de Combate encontrado en:
├── 📁 Modules/Combat/
│   ├── CombatModule.cs (punto de entrada)
│   ├── Systems/
│   │   ├── DamageSystem.cs (aplica daño)
│   │   └── CombatStateSystem.cs (gestiona estados)
│   └── Components/
│       ├── HealthComponent.cs
│       └── AttackComponent.cs

🔍 Ideas Clave:
• Health se modifica en 3 ubicaciones
• Sin validación en valores de daño
• Faltan verificaciones nulas en CombatStateSystem
```

### Búsqueda Semántica

```
@StrataBrain busca "dónde se modifica la salud del jugador al recibir daño"
```

Resultados en segundos con fragmentos de código relevantes y ubicaciones de archivos.

---

## 🏗️ Arquitectura

```
┌─────────────────────────────────────────┐
│  Capa de Presentación (5 Canales)      │
│  Telegram • Discord • Slack • WhatsApp │
├─────────────────────────────────────────┤
│  Capa de Orquestación                   │
│  Gestor de Sesiones • Limitador de Tasa│
│  Autonomía: PLAN-ACT-VERIFY-RESPOND    │
├─────────────────────────────────────────┤
│  Capa de Servicios                      │
│  Cadena de Proveedores IA • 25+ Tools  │
│  Búsqueda Vectorial HNSW • Sistema de Aprendizaje │
├─────────────────────────────────────────┤
│  Capa de Infraestructura                │
│  Contenedor DI • Seguridad (RBAC)      │
│  Auth • Config • Logging               │
└─────────────────────────────────────────┘
```

---

## 🧪 Pruebas

```bash
# Ejecutar todas las pruebas
npm test

# Ejecutar con cobertura
npm run test:coverage

# Ejecutar pruebas de integración
npm run test:integration
```

**Cobertura de Pruebas:**
- 600+ pruebas unitarias
- 51 pruebas de integración (E2E)
- 85%+ cobertura de código

---

## 📚 Documentación

- [📖 Guía de Inicio](docs/getting-started.es.md)
- [🏗️ Visión General de Arquitectura](docs/architecture.es.md)
- [🔧 Referencia de Configuración](docs/configuration.es.md)
- [🔒 Guía de Seguridad](docs/security/security-overview.es.md)
- [🛠️ Desarrollo de Herramientas](docs/tools.es.md)
- [📊 Referencia de API](docs/api.es.md)

---

## 🛡️ Seguridad

Strata.Brain implementa medidas de seguridad integrales:

- ✅ **OWASP Top 10** cumplimiento
- ✅ **RBAC** con 5 roles (de superadmin a viewer)
- ✅ **18 Patrones de Secretos** detectados y enmascarados
- ✅ **Path Traversal** protección
- ✅ **Rate Limiting** con seguimiento de presupuesto
- ✅ **Audit Logging** para todas las acciones
- ✅ **Scripts de Pentest** incluidos

Ver [Documentación de Seguridad](docs/security/security-overview.es.md) para detalles.

---

## 🌍 Soporte Multi-Idioma

Strata.Brain habla tu idioma:

| Idioma | Archivo | Estado |
|--------|---------|--------|
| 🇺🇸 English | [README.md](README.md) | ✅ Completo |
| 🇨🇳 中文 | [README.zh.md](README.zh.md) | ✅ Completo |
| 🇯🇵 日本語 | [README.ja.md](README.ja.md) | ✅ Completo |
| 🇰🇷 한국어 | [README.ko.md](README.ko.md) | ✅ Completo |
| 🇹🇷 Türkçe | [README.tr.md](README.tr.md) | ✅ Completo |
| 🇩🇪 Deutsch | [README.de.md](README.de.md) | ✅ Completo |
| 🇪🇸 Español | [README.es.md](README.es.md) | ✅ Completo |
| 🇫🇷 Français | [README.fr.md](README.fr.md) | ✅ Completo |

---

## 🤝 Contribuir

¡Bienvenidas las contribuciones! Ver [Guía de Contribución](CONTRIBUTING.es.md) para detalles.

```bash
# Fork y clonar
git clone https://github.com/yourusername/strata-brain.git

# Crear rama
git checkout -b feature/funcion-increible

# Hacer cambios y commit
git commit -m "Añadir función increíble"

# Push y crear PR
git push origin feature/funcion-increible
```

---

## 📜 Licencia

Licencia MIT - ver archivo [LICENSE](LICENSE) para detalles.

---

## 💖 Agradecimientos

- [Strata.Core](https://github.com/strata/core) - El framework ECS que lo impulsa todo
- [Grammy](https://grammy.dev) - Framework de bots para Telegram
- [Discord.js](https://discord.js.org) - Integración con Discord
- [HNSWLib](https://github.com/nmslib/hnswlib) - Búsqueda vectorial de alto rendimiento

---

<p align="center">
  <strong>🚀 ¿Listo para potenciar tu desarrollo Unity?</strong><br/>
  <a href="https://github.com/yourusername/strata-brain/stargazers">⭐ Danos una estrella en GitHub</a> •
  <a href="https://twitter.com/stratabrain">🐦 Síguenos en Twitter</a> •
  <a href="https://discord.gg/stratabrain">💬 Únete a Discord</a>
</p>

<p align="center">
  Construido con ❤️ por el Equipo Strata
</p>
