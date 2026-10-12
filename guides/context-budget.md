# context-budget — auditoría de tokens del harness TYCON

Script que mide cuántos tokens consume **lo que se carga en cada sesión nueva** de Claude Code, ANTES de empezar a trabajar: descripciones de skills, descripciones de agents, schemas de MCPs, CLAUDE.md chain. Identifica heavy hitters + propone recortes.

Inspirado en [ECC context-budget](https://github.com/affaan-m/ECC/blob/main/skills/context-budget/SKILL.md), adaptado al stack TYCON (knowledge hardcoded de qué MCPs son core, qué skills son off-stack).

## Cuándo correrlo

- Al notar que las sesiones arrancan "pesadas" (output lento, context warnings tempranos).
- Después de instalar skills, agents o MCPs nuevos (para detectar creep).
- Cuando vas a agregar más componentes y querés saber si hay lugar.
- En la primera semana de un dev nuevo (calibrar su footprint vs el del equipo).
- Auditoría mensual del harness — entra en el ritmo del `tycon-retrospective-capturer`.

## Cómo correrlo

```bash
# Reporte estándar
node ~/.claude/tycon-harness/scripts/tools/context-budget.js

# Reporte con per-file breakdown (todos los skills + agents ordenados por tokens)
node ~/.claude/tycon-harness/scripts/tools/context-budget.js --verbose

# Output JSON crudo (para post-processing / scripts CI)
node ~/.claude/tycon-harness/scripts/tools/context-budget.js --json
```

No requiere instalación — el script vive en el repo y es Node puro (sin dependencias externas).

## Qué mide

| Categoría | Qué cuenta | Por qué importa |
|---|---|---|
| **Skills** | `description:` frontmatter de cada `~/.claude/agent-skills/skills/<name>/SKILL.md` | Las descripciones se cargan SIEMPRE para que el agente sepa cuándo invocar la skill. El body solo se carga al invocarla. |
| **Agents** | `description:` frontmatter de cada `~/.claude/agents/*.md` | Se cargan en CADA invocación de la tool `Task`/`Agent` (no solo cuando los usás). |
| **MCP servers** | Tool schemas de cada server (`~/.claude/settings.json` + `<cwd>/.mcp.json` + Anthropic Connectors detectados) | Cada tool schema cuesta ~500 tokens. Un server con 25 tools cuesta más que TODOS tus skills. |
| **CLAUDE.md chain** | `~/.claude/CLAUDE.md` + `CLAUDE.md` desde cwd hasta home | Se carga entero. Verbosidad cuesta. |

## Qué NO mide (todavía)

- **Engram observations en SessionStart**: rotan según contenido reciente, difícil de estimar.
- **Body de skills/agents**: solo se carga si el agente las invoca activamente, no es overhead fijo.
- **System prompt de Claude Code en sí**: out of scope (no editable por nosotros).
- **Mensaje del usuario + el historial de la conversación**: eso es el "uso real" del window, no el overhead del harness.

## Cómo interpretar el reporte

### Caso típico TYCON v1 (medido 2026-05-23 en una sesión real)

```
harness overhead: ~69,402 tokens (35% del presupuesto de 200K)

Breakdown:
  Skills (158):       7,596 tok   11%
  Agents (26):        2,503 tok    4%
  MCP servers (10):  57,500 tok   83%  ← biggest lever
  CLAUDE.md (1):      1,803 tok    3%
```

**Lectura**: MCPs son el 83% del overhead. Cualquier optimización sobre skills/agents es marginal — el lever real está en MCPs.

### Heavy hitters MCP típicos

Los siguientes son **Anthropic Connectors prendidos por default** que probablemente NO uses para TYCON:

| Server | Tools | Tokens | Veredicto TYCON |
|---|---|---|---|
| `claude_ai_Wix` | 19 | ~9,500 | ✗ irrelevante (Espinillo2 aparte usa Wix, no plugins Bizuit) |
| `claude_ai_Gmail` | 13 | ~6,500 | ✗ irrelevante (no manejás email desde el agent) |
| `claude_ai_Gamma` | 8 | ~4,000 | ✗ irrelevante (slides puntuales, no diario) |
| `claude_ai_Google_Calendar` | 8 | ~4,000 | ✗ irrelevante (calendar fuera del workflow dev) |
| `claude_ai_Google_Drive` | 8 | ~4,000 | ✗ irrelevante (specs viven en repo) |
| `chrome-devtools` | 25 | ~12,500 | — neutral (útil para debugging frontend; evaluá si lo usás cada sesión) |
| `engram` | 13 | ~6,500 | ✓ core (memoria persistente) |
| `codegraph-{backend,frontend}` | 9 cada uno | ~4,500 cada uno | ✓ core (índice de código TYCON) |

**Recorte recomendado**: desconectar los 5 Anthropic Connectors marcados `✗` libera ~28,000 tokens (40% del overhead). Bajás de 35% → 20% del presupuesto de 200K usado por el harness.

## Cómo desconectar un Anthropic Connector

Estos NO viven en `settings.json` — son connectors gestionados desde **claude.ai**:

1. Abrí [claude.ai/settings/connectors](https://claude.ai/settings/connectors) (o desde la app: Settings → Connectors).
2. Buscá Wix / Gmail / Gamma / Google Calendar / Google Drive.
3. Disconnect el que no uses.
4. Si lo necesitás más adelante (ej: redactar un mail puntual), lo re-conectás cuando lo necesites.

**Trade-off**: re-conectar tarda 30s. Tener prendidos 5 connectors que no usás te cuesta 28k tokens en CADA sesión. La cuenta da.

## Recortar descripciones largas (low-hanging fruit secundario)

Para skills/agents tuyos (no built-in), el target sano es **<200 chars** en `description:`. Más que eso indica que estás metiendo ejemplos largos o explicaciones de cómo funciona — eso va en el body, no en el frontmatter.

Top ofensores típicos (ver `--verbose` para la lista completa):

- `tycon-pipeline` (783 chars) — banner con 3 párrafos de cuándo invocar.
- `clocki` (575 chars) — descripción con ejemplos inline.
- Built-in Anthropic: `xlsx`/`docx`/`pptx`/`pdf` (>700 chars cada uno) — esos NO los toques, vienen así de Anthropic.

**Cómo recortar**: mantené 1 frase de qué hace + 1 frase de cuándo invocarla. Movés el resto al cuerpo de la SKILL.md. Ahorro per skill: ~50-150 tokens. Total: ~1-2k tokens si recortás 10-15 skills.

## Integración con el harness (roadmap v2)

- **CI gate**: agregar un check en `tycon-pipeline` que falle si el overhead total supera un threshold (ej: 40% del presupuesto de 200K).
- **Dashboard**: alimentar `tycon-retrospective-capturer` con el delta semanal de overhead — detectar creep automáticamente.
- **Pre-add advisor**: cuando vas a instalar un MCP o skill nueva, el script estima el impacto incremental.

## El piso MEDIDO, y por qué el estimado no alcanza (2026-09-17)

Todo lo de arriba es una **estimación**: `chars/4`. Medido con `claude -p` sobre el contenido del
arnés, esto tokeniza a **3,02–3,08 bytes/token**, así que la estimación queda **~30 % por debajo**.
El sesgo va hacia abajo —un rojo es rojo de verdad— pero el número no se puede citar como medido.

```bash
node scripts/tools/context-budget.js --measured            # + el piso REAL de los últimos 7 días
node scripts/tools/context-budget.js --measured --days 30  # otra ventana
```

`--measured` lee los tokens del **primer pedido** de cada transcripción de subagente
(`~/.claude/projects/<slug>/<sesión>/subagents/agent-*.jsonl`): lo que un revisor carga **antes de
leer un archivo**. Devuelve mediana, mínimo, máximo y el desglose por tipo de agente. Nunca imprime
una ruta de transcripción ni un prompt: sólo números y el tipo.

**Sin transcripciones dice «no medido» con el motivo, nunca 0**, y una transcripción ilegible se
cuenta aparte (`ilegibles`) sin cortar el reporte.

### La cadena del `CLAUDE.md` se sigue hasta el final

Por qué: leyendo sólo los archivos `CLAUDE.md` y **no sus `@imports`**, la herramienta reportaba
**4.724** tokens para una cadena de ~276 KB, con el README del arnés —235.771 bytes, el 61 % del piso
de un revisor— **invisible**. O sea que la herramienta con la que se decide qué recortar del arranque
no veía el ítem más grande. Ahora los resuelve (relativos, `~/`, absolutos), cuenta **una sola vez**
el archivo importado dos veces, y un import declarado que no existe se **lista** con 0 tokens en vez
de desaparecer. `harness-audit.js` ganó el chequeo «Cadena del CLAUDE.md con sus @imports < 30.000»
**importando** esta cuenta, no copiándola.

## Limitaciones v1

- **MCP tool counts hardcoded**: los servers conocidos (engram, codegraph, etc.) tienen tool counts hardcoded. Servers nuevos asumen default 8 tools. Si introducís un MCP nuevo, actualizar `MCP_KNOWN_TOOL_COUNTS` en el script.
- **No habla con el LLM**: las estimaciones son heurísticas (chars/4). Tokenizador real podría dar ±15%.
- **No diferencia user vs project MCPs por sesión**: si tu `<cwd>/.mcp.json` agrega 2 MCPs project-local, los suma al total (correcto, pero el reporte no lo separa explícito).
- **No cubre plugins de Claude Code via `enabledPlugins`**: si un plugin Anthropic Connector aporta MCPs no vistos en settings.json, los inferimos con una lista hardcoded.

## Referencias

- Script: [`scripts/tools/context-budget.js`](../scripts/tools/context-budget.js)
- Inspiración: [ECC skills/context-budget/SKILL.md](https://github.com/affaan-m/ECC/blob/main/skills/context-budget/SKILL.md)
- Análisis ECC → TYCON (sesión 2026-05-23): qué porteamos y por qué (engram observation `Portado context-budget ECC → TYCON v1`)

> **Asimetría declarada (2026-08-23)**: esta auditoría mide el contexto del lado CLAUDE (skills+agents+MCPs+CLAUDE.md de Claude Code). No tiene equivalente bajo Codex y no se porta: el presupuesto de contexto de Codex se administra con sus propios mecanismos (el warning de 'skills context budget' que el propio codex emite).
