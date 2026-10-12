---
name: tycon-skill-scout
description: Busca primero en el catálogo local TYCON (skills + agents + guides + hooks) ANTES de proponer crear algo nuevo. Trigger automático cuando el user dice "necesito una skill que", "crear una skill para", "falta un advisor", "agregar una guía", "skill nueva", "create skill", "add advisor", "new skill", "is there a skill for", "hay alguna skill que". Devuelve top matches con motivo + decisión 3-paths (usar / extender / crear). Stack-aware: distingue cuando hay un advisor que cubre el caso (no necesitás skill), una guía que ya documenta el patrón (no necesitás code), o un hook que ya enforza la regla. Adaptado de ECC skill-scout — scope LOCAL only (sin GitHub/web), porque el dolor TYCON es duplicar lo que ya tenemos en el harness.
---

# tycon-skill-scout

Antes de crear cualquier skill/agent/guide/hook nuevo en TYCON, buscás en el catálogo local. **Detiene la creación si ya existe equivalente.** El objetivo no es "encontrar algo parecido", es prevenir tejido cicatrizal: capas duplicadas que dividen el conocimiento del equipo y dejan ambos artifacts a medio mantener.

## Cuándo se dispara

**Automático** por estos triggers en el prompt del user:

- ES: "necesito una skill", "crear una skill", "agregar skill", "skill nueva", "hace falta un advisor", "agregar guía", "necesitamos un hook"
- EN: "create skill", "add a skill", "new skill", "is there a skill", "build a skill", "make a skill", "add advisor", "new advisor", "create guide"

**Manual**: el user puede invocarlo con `/tycon-skill-scout <intent>`.

**Excepciones** (cuándo NO disparar):

- El user explícitamente dice "skipea la búsqueda, sé que no existe" o "creemos uno nuevo igual".
- Estás ya implementando algo aprobado en el plan (no es el momento de re-cuestionar).
- El user te pasa un path concreto (`~/.claude/agents/X.md`) y pide editarlo — no estás creando, estás modificando.

## Cómo funciona

### Step 1 — Capturar intent

Extraé 4 datos en 1-2 líneas:

1. **Qué hace** (verbo + dominio): "bloquear", "validar", "generar", "buscar", "loggear"...
2. **Sobre qué** (target): "stories", "migrations SQL", "advisors", "endpoints .NET", "componentes React"...
3. **Cuándo** (trigger): "antes de cada commit", "al editar archivo X", "cuando el user pide Y"...
4. **3-5 keywords** + sinónimos español/inglés.

Si el intent es ambiguo (ej: "una skill para hooks"), **preguntá al user** antes de buscar. No inventes scope.

### Step 2 — Buscar en el catálogo TYCON local

4 lugares, en orden de relevancia para el tipo de intent:

```bash
# Skills (SKILL.md frontmatter description)
ls ~/.claude/agent-skills/skills/ | grep -iE "keyword1|keyword2|keyword3"
grep -rliE "keyword1|keyword2|keyword3" ~/.claude/agent-skills/skills/*/SKILL.md 2>/dev/null

# Agents (advisors)
ls ~/.claude/agents/ | grep -iE "keyword1|keyword2|keyword3"
grep -liE "keyword1|keyword2|keyword3" ~/.claude/agents/*.md 2>/dev/null

# Guides (el arnés)
ls ~/.claude/tycon-harness/guides/ | grep -iE "keyword1|keyword2|keyword3"
grep -rliE "keyword1|keyword2|keyword3" ~/.claude/tycon-harness/guides/*.md 2>/dev/null

# Hooks + scripts (~/.claude/tycon-harness/scripts)
find ~/.claude/tycon-harness/scripts -type f \( -name "*.sh" -o -name "*.js" -o -name "*.py" -o -name "*.ps1" \) | grep -iE "keyword1|keyword2|keyword3"
```

Para cada match, leé el frontmatter `description:` (skills/agents) o las primeras 40 líneas (guides/scripts) para confirmar relevancia. **No tomes el filename solo como evidencia** — el nombre puede ser engañoso (ej: `tycon-ado-story-wi` no es un advisor, es una skill para crear work items).

### Step 3 — Cross-referenciar el catálogo de reglas

Si el intent es "advisor que detecte X" → buscá también en `advisor-rules-catalog.md` por si la regla ya existe en otro advisor:

```bash
grep -iE "keyword1|keyword2" ~/.claude/tycon-harness/guides/advisor-rules-catalog.md
```

Si encontrás una regla equivalente (ej: `MIGRATION-C3`, `SEC-W2`, `SILENT-C1`), **la respuesta correcta NO es crear un advisor nuevo**, es: (a) usar el advisor que ya cita esa regla, o (b) extender ese advisor con un sub-caso si el escenario es genuinamente distinto.

### Step 4 — Rankear (max 5)

Criterios en orden:

1. **Match exacto del verbo + target** (ej: "bloquear migración SQL" → `dotnet-hooks.md` Hook 1).
2. **Match parcial del verbo o target** (ej: "validar story" → `tycon-story-validator` advisor).
3. **Match por keyword en description** (ej: "tracking horas" → `clocki` SKILL).
4. **Mención en guide aunque no sea un artefacto invocable** (ej: la regla está documentada en `advisor-rules-catalog.md` pero no hay enforcement).

Si después de filtrar quedan >5 candidatos: priorizá los del Set Base del pipeline + los citados en guides actuales. Descartá deprecated o legacy.

### Step 5 — Presentar 3 paths

Output en este formato (corto, sin tabla larga):

```
Encontré en el catálogo TYCON:

[match 1]
  Path: ~/.claude/agents/tycon-X.md  (advisor)
  Cubre: <qué hace, 1 línea>
  Gap vs intent: <qué le falta o por qué no calza 100%>

[match 2]
  Path: ...
  Cubre: ...
  Gap: ...

→ 3 caminos:
  (A) USAR: invocar `tycon-X` directo en el próximo pipeline run / pedirle al agente que lo use ahora.
  (B) EXTENDER: agregar regla `XXX-Cn` al advisor `tycon-X` para cubrir el sub-caso del intent. Cambio en 1 archivo.
  (C) CREAR: crear skill/agent/guide nueva. Justificación: <por qué (A) y (B) no alcanzan>.

¿Cuál?
```

**STOP** acá. No avances a crear sin que el user elija. Si dudás: preguntá.

## Anti-patterns

- ❌ Crear skill nueva sin pasar por este check. Sobre todo si el user te empieza a pedir "y ahora hagamos otra que..."
- ❌ Listar 15 matches débiles. 5 fuertes > 15 débiles.
- ❌ Recomendar "crear" cuando un advisor existing tiene 80% del scope. Mejor extender con una sub-regla.
- ❌ Tratar a `advisor-rules-catalog.md` como solo documentación — es la **fuente de verdad** de qué reglas YA están cubiertas en algún lado.
- ❌ Pasar por alto el caso "hay una guide que documenta el patrón pero no hay enforcement". La respuesta NO siempre es crear advisor — a veces es agregar un hook que aplique la guía.
- ❌ Asumir que el nombre del filename refleja el scope. Siempre leer el frontmatter / top del archivo.

## Casos de uso reales (referencia)

**Caso 1**: User dice "necesito una skill que valide que las migrations no se editan después de commitearlas".
- Búsqueda: `migration` keyword → 4 matches:
  1. `migration-impact-analyzer` advisor (analiza diff de migration)
  2. `tycon-new-migration` skill (genera nueva migration)
  3. `dotnet-hooks.md` guide (Hook 1: PreToolUse bloquea edit de migrations commiteadas)
  4. Reglas `MIGRATION-C1..C5` en catalog
- Decisión correcta: USAR `dotnet-hooks.md` Hook 1 — ya existe y enforza el patrón. No hay nada que crear.

**Caso 2**: User dice "necesitamos un advisor que detecte que el `status:` del frontmatter se editó a mano sin pasar por tycon-pipeline".
- Búsqueda: `status frontmatter` → match en `dotnet-hooks.md` Hook 3 + `workflow-orchestration.md` §8.
- Decisión correcta: USAR Hook 3 ya existing. No es un advisor, es un hook PreToolUse — el user probablemente quiso decir "hook" no "advisor".

**Caso 3**: User dice "agregar un advisor que detecte uso de SafeQueryBuilder sin parámetros".
- Búsqueda: `SafeQueryBuilder` → match en `tycon-plugin-dotnet-conventions` (advisor existing) con regla `DOTNET-C2`.
- Decisión correcta: EXTENDER `tycon-plugin-dotnet-conventions` con sub-regla nueva. Cambio en 1 archivo. No crear advisor nuevo.

## Referencias

- ECC inspiration: [github.com/affaan-m/ECC/blob/main/skills/skill-scout/SKILL.md](https://github.com/affaan-m/ECC/blob/main/skills/skill-scout/SKILL.md)
- Catálogo de reglas: `~/.claude/tycon-harness/guides/advisor-rules-catalog.md`
- Anti-pattern raíz (tejido cicatrizal): engram observation `Auditoría harness TYCON 2026-05-21`
