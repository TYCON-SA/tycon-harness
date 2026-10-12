# instinct-mining — grabador silencioso del harness

**Goal**: el harness aprende solo, sin depender de que el agente se acuerde de `mem_save`.

Cuando el dev corrige al agente ("no, así no, hacelo distinto") o cuando un workflow se repite varias veces, un grabador silencioso lo detecta, lo propone como **instinct** (regla atómica trigger/action), y vos aprobás o rechazás. Lo aprobado va a engram (memoria personal) y, si aplica, genera un draft para el catálogo team-wide.

Inspirado en [ECC continuous-learning-v2](https://github.com/affaan-m/ECC/blob/main/skills/continuous-learning-v2/SKILL.md), adaptado al stack TYCON.

---

## Mecánica completa

```
┌────────────────────────────────────────────────────────────────┐
│ Durante CADA sesión Claude Code (transparente, sin interv.):  │
│                                                                │
│   Tool call → PostToolUse hook → instinct-observe.sh           │
│                                          │                     │
│                                          ▼                     │
│              ~/.claude/tycon-observations/<YYYY-MM>.jsonl      │
│              (LOCAL por máquina, NO en git)                    │
│              { ts, session_id, tool, project, summary, status }│
└────────────────────────────────────────────────────────────────┘
                       │
                       ▼  (SessionStart hook, throttle 12h)
┌────────────────────────────────────────────────────────────────┐
│ Observer (Node + claude CLI con Haiku):                        │
│                                                                │
│   1. Lee JSONL local del mes actual + anterior                 │
│   2. Agrupa por (proyecto, tool, summary-prefix)               │
│   3. Filtra buckets con >=3 ocurrencias                        │
│   4. Envía a Haiku con prompt "encontrá rules no-triviales"    │
│      + los nombres de lo que ya existe                         │
│   5. Recibe YAML estructurado, filtra confidence >= 0.85       │
│   6. Dedup por hash                                            │
│   7. 2ª llamada: revisa lo que queda contra lo ya decidido y   │
│      el catálogo detallado; lo que cita algo mostrado va a     │
│      inbox/instincts/descartados/ (local) y no a la bandeja    │
│   8. Escribe a inbox/instincts/pending/ + Telegram si hay      │
│      nuevos                                                    │
└────────────────────────────────────────────────────────────────┘
                       │
                       ▼  (review HITL, vos)
┌────────────────────────────────────────────────────────────────┐
│ /tycon-instincts list → ver pending                            │
│ /tycon-instincts show <hash> → leer YAML completo              │
│ /tycon-instincts approve <hash>                                │
│   → mueve a promoted/                                          │
│   → emite mem_save() para engram                               │
│   → si hay artifact_suggestion: auto-genera draft a drafts/    │
│ /tycon-instincts reject <hash> --reason "X" → archived/        │
└────────────────────────────────────────────────────────────────┘
                       │
                       ▼  (vos, opcional, fuera del flow auto)
┌────────────────────────────────────────────────────────────────┐
│ Si hay draft en inbox/instincts/drafts/:                       │
│   → Revisar, editar a mano                                     │
│   → Copiar al destino real (catálogo, skill, hook, guide)     │
│   → Commitear cuando estés convencido                          │
│                                                                │
│ El observer NUNCA toca catálogo/skills/hooks/guides            │
│ directamente — solo genera drafts. Vos sos el aprobador final  │
│ para cualquier cambio team-wide.                               │
└────────────────────────────────────────────────────────────────┘
```

---

## Decisiones de diseño

Resueltas durante la implementación 2026-05-23 (cierre del [instinct-mining-v1-spec.md](decisions/instinct-mining-v1-spec.md)).

| Decisión | Resuelto |
|---|---|
| **Trigger** | SessionStart hook con throttle 12h. No cron (no hay razón para "de noche"). El hook spawna detached → no bloquea el inicio de sesión. |
| **Observer** | `scripts/instincts/instinct-observer.js` (Node) es **agnóstico de herramienta** (2026-08-24): usa el modelo de la que la máquina tenga — `claude`→Haiku, `codex`→gpt-5.4-mini, o `ollama`→modelo local. **No requiere API key separada** — usa la suscripción del dev. Costo marginal ~$0 con suscripción en cualquiera de las dos. Cada instinct guarda `proposed_by: <ejecutor>/<modelo>` para medir aceptación por ejecutor. |
| **Logging** | JSONL local por máquina en `~/.claude/tycon-observations/<YYYY-MM>.jsonl`. NO va al repo. Sanitization estricta igualmente (defense in depth): `$HOME` redact, regex de secrets, truncate 500 chars, exclusion de `specs/clients/*`. |
| **Storage** | `pending/promoted/archived/drafts/` viven en el **buzón**: `inbox/instincts/` _(del repo del equipo; no está en esta copia)_ del árbol del arnés **si ese árbol lo trae** (el clon de quien mantiene el arnés: ahí cruzan máquinas vía git pull/push normal), y si no lo trae (un arnés instalado desde una versión bajada), en la carpeta de usuario de la persona. Ver «Dónde viven las propuestas», abajo. `descartados/` es constancia local de lo que la revisión descartó en esa máquina. |
| **Threshold** | ≥3 ocurrencias en el JSONL + confidence ≥0.85 del LLM. |
| **Dedup** | Hash determinístico de `trigger + action`. Si ya existe en pending/promoted/archived, skip. |
| **Lo que ya existe** (2026-09-10 y 2026-09-14) | El hash sólo frena el texto idéntico: medido en una semana, 11 de 14 propuestas repetían algo ya decidido o un control que ya corre. Todo se lee del disco en cada corrida. El prompt que propone lleva sólo los **nombres** de revisores, hooks y skills (así desde el 2026-09-10): con los instintos decididos adentro, medido, el modelo los copiaba como ejemplos. Lo que pasa la confianza y el hash va a una **segunda llamada** que sólo clasifica, contra los instintos decididos (con su proyecto, la acción de los aprobados y el motivo de los rechazados) y el catálogo detallado (qué audita cada revisor, el pre-commit y `scripts/ci/`). Se descarta lo que la revisión cita empezando por un hash o una pieza que **su prompt mostró**; una categoría, una frase negativa, una salvedad justo después («[hash] — not the same») o algo que no mostró no descarta nada. Una variante del mismo hábito en **otro** proyecto no cuenta como repetición —se le pide al modelo y el guion lo verifica con el proyecto de cada decidido—: decidís vos si generalizarla. Lo descartado queda en `inbox/instincts/descartados/` (local, fuera de git), un archivo por propuesta con lo que lo cubre y cuántas veces se descartó, y `/tycon-instincts review` lo resume: sin eso, un descarte de más se vería igual que una semana sin nada nuevo. Si esa carpeta no se puede escribir, el observador lo dice y sigue. Si la revisión falla o no se entiende, lo propuesto llega igual, y el log lo dice. |
| **Aprobación** | Vos siempre. El comando approve mueve a promoted + emite `mem_save()` para engram. Si el YAML sugiere artifact (skill/advisor/hook/guide), también genera draft. Vos editás el draft y commiteás cuando te convenza. |
| **Notify** | Telegram push (`TYCON_INSTINCT_NOTIFY=1` + `TYCON_INSTINCT_TELEGRAM_BOT_TOKEN`). Solo si hay nuevos pending (post-dedup). |
| **Multi-máquina 50/50** | Hook activo en ambas (`TYCON_INSTINCT_MINING=1`). Observer activo en ambas (`TYCON_INSTINCT_OBSERVER=1`). Cada una analiza su JSONL local, escribe pending al repo. Dedup por hash evita duplicados cross-machine. Telegram desde la primera que escribe (la segunda ve hash existente, skip notify). |

---

## Setup

### En la máquina principal (y en cualquier máquina secundaria 50/50)

```bash
# 1. Clonar el arnés (si no estaba)
cd ~/SourceCode
git clone <repo-url>

# 2. Activar en ~/.zshrc:
export TYCON_INSTINCT_MINING=1     # hook PostToolUse (graba JSONL local)
export TYCON_INSTINCT_OBSERVER=1   # SessionStart hook (corre observer cada 12h)

# Opcional Telegram:
export TYCON_INSTINCT_NOTIFY=1
export TYCON_INSTINCT_TELEGRAM_BOT_TOKEN=<tu_bot_token>
# El chat no tiene default: sin él (acá, en TYCON_TELEGRAM_CHAT_ID o en ~/.claude/tycon.json → telegram.chat_id) no avisa.
export TYCON_INSTINCT_TELEGRAM_CHAT_ID=<tu_chat_id>

# 3. Registrar hooks en settings.json (idempotente):
~/.claude/tycon-harness/scripts/setup/install-instinct-mining.sh

# 4. source ~/.zshrc + reabrir Claude Code
```

### En máquinas donde solo querés loguear (no correr observer)

```bash
export TYCON_INSTINCT_MINING=1
# NO seteás TYCON_INSTINCT_OBSERVER
~/.claude/tycon-harness/scripts/setup/install-instinct-mining.sh
```

### Verificar instalación

```bash
~/.claude/tycon-harness/scripts/setup/install-instinct-mining.sh --check
```

### Desinstalar

```bash
~/.claude/tycon-harness/scripts/setup/install-instinct-mining.sh --uninstall
# Y remover las env vars de ~/.zshrc
```

---

## Sanitization

Aunque las observations son locales, el hook sanitiza igual (defense in depth, por si alguna vez se transfieren a debugging):

| Patrón | Redact |
|---|---|
| `/Users/<user>/...` (HOME absoluto) | `$HOME/...` |
| `api_key=XXXX`, `token=XXXX`, `password=XXXX`, `bearer=XXXX` | `<key>=[REDACTED]` |
| `sk-XXXXXXXXXX` (16+ chars) | `[REDACTED-SK]` |
| `ghp_XXXXXXXXXX` (16+ chars) | `[REDACTED-GHP]` |
| Body >500 chars | truncate `...` |
| Tool input contiene `specs/clients/` | observación se descarta entera |

Para validar la sanitización antes de habilitar:

```bash
export TYCON_INSTINCT_MINING=1
# Trabajar normal por 30 minutos
cat ~/.claude/tycon-observations/$(date -u +%Y-%m).jsonl | head -50
# Verificar que no haya secrets ni paths absolutos
```

---

## Costo

Con la suscripción del dev (Claude.ai vía `claude`, o ChatGPT vía `codex`):

| Componente | Costo marginal |
|---|---|
| Hook PostToolUse | $0 (no usa LLM, escritura local) |
| Observer corriendo | $0 (incluido en tu plan; cada 12h — Haiku, gpt-5.4-mini o modelo local, dentro del fair-use): ~5K tokens el prompt que propone, más ~9K la revisión cuando algo pasa el umbral (2026-09-14) |
| Telegram notify | $0 (curl directo al bot) |

**Ejecutor** (2026-08-24): el observer elige solo qué modelo usar según qué CLI tenga la máquina
(`auto`: claude→Haiku, luego codex→gpt-5.4-mini, luego ollama→local). Forzar con
`TYCON_OBSERVER_EXECUTOR=claude|codex|ollama`. El costo es ~$0 con suscripción en Claude o Codex;
con Ollama es local (0 red, ~6 GB de RAM mientras infiere). El local NO se justifica por plata
(Haiku/gpt-5.4-mini salen lo mismo) — solo por privacidad (las observaciones no salen de la máquina).

---

## Variables de entorno (ref)

| Var | Default | Descripción |
|---|---|---|
| `TYCON_INSTINCT_MINING` | unset | `=1` activa el hook PostToolUse (graba JSONL) |
| `TYCON_INSTINCT_OBSERVER` | unset | `=1` activa el SessionStart hook (corre observer) |
| `TYCON_INSTINCT_THROTTLE_SECONDS` | `43200` (12h) | Tiempo mínimo entre corridas del observer |
| `TYCON_INSTINCT_OBS_DIR` | `~/.claude/tycon-observations` | Path local del JSONL |
| `TYCON_INSTINCT_NOTIFY` | unset | `=1` activa Telegram notify post-corrida |
| `TYCON_INSTINCT_TELEGRAM_BOT_TOKEN` | unset | Bot token (sino skip notify) |
| `TYCON_INSTINCT_TELEGRAM_CHAT_ID` | unset | chat_id destino; sin él usa `TYCON_TELEGRAM_CHAT_ID`, `~/.claude/tycon.json` → `telegram.chat_id` o el plugin, y sin ninguno no avisa |
| `TYCON_OBSERVER_EXECUTOR` | `auto` | `auto`\|`claude`\|`codex`\|`ollama` — qué herramienta usa el observer |
| `TYCON_OBSERVER_MODEL` | `claude-haiku-4-5` | Model override del ejecutor `claude` |
| `TYCON_OBSERVER_CODEX_MODEL` | `gpt-5.4-mini` | Model override del ejecutor `codex` |
| `TYCON_OBSERVER_OLLAMA_MODEL` | `llama3.2:3b` | Model override del ejecutor `ollama` |
| `TYCON_OLLAMA_URL` | `http://localhost:11434` | Endpoint de Ollama |

## Bajo Codex (2026-08-24)

El observador **corre en Codex igual que en Claude** desde que es agnóstico de ejecutor. Requisitos,
ya cubiertos: los hooks (`instinct-observe.sh` grabador, `instinct-trigger.sh` observer) están
registrados en `adapters/codex/hooks.json`, y el observer usa `codex exec -m gpt-5.4-mini` cuando no
hay `claude`. Para PRENDERLO bajo Codex valen las MISMAS env vars (`TYCON_INSTINCT_MINING=1` +
`TYCON_INSTINCT_OBSERVER=1`):
- **Codex desde terminal**: hereda `~/.zshrc`, andan solas.
- **Codex en el panel de VSCode (macOS)**: el panel gráfico no pasa por el rc, así que
  `harness-env-publish.sh` (LaunchAgent, lo instala `install-tycon-hooks.sh`) publica esas flags con
  `launchctl setenv` en cada SessionStart. Sin eso el observador queda mudo en el panel aunque el rc
  las tenga.
| `TYCON_GUIDES_DIR` | `~/.claude/tycon-harness` | Override path del repo |

---

## Formato del instinct YAML

```yaml
hash: a1b2c3d4e5                           # determinístico de trigger+action
trigger: "user dice 'X' o situación X ocurre"
action: "hacer Y"
confidence: 0.92                           # 0.0 - 1.0 (LLM)
domain: "testing"                          # auth|testing|ui|build|story-format|...
scope: project                             # project | global
project: "Ceibo"                          # solo si scope=project
evidence_count: 5                          # ocurrencias en el JSONL
tycon_artifact_suggestion: "advisor:DOTNET-C7"   # null|skill:X|advisor:Y|hook:Z|guide:T
reasoning: "Por qué este pattern importa"
proposed_at: 2026-05-23T15:30:00Z
engram_promoted: false                     # true post-approve
approved_at: <ISO>                         # post-approve
rejected_at: <ISO>                         # post-reject
rejection_reason: "..."                    # post-reject
```

---

## Anti-patterns y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Observer dispara con basura (instincts triviales) | Threshold ≥3 ocurrencias + ≥0.85 confidence. Prompt al LLM explícito: "ignorá lo obvio". Vos rechazás los ruidosos → archive con reason. |
| Leak de secrets en JSONL local | Sanitization estricta + path-based exclusion + JSONL local (no git push automático). |
| Devs ignoran pending → feature dead | Telegram push diario. Métrica `instincts_promoted_per_month` en `harness-audit.js`. Si <2/mes durante 3 meses → desactivar. |
| Duplicados multi-máquina | Hash determinístico de `trigger+action`. La segunda máquina al chequear ve el hash existente, skip. |
| JSONL crece sin límite | Rotación mensual built-in (`<YYYY-MM>.jsonl`). Después de N meses, archivá los viejos a `~/.claude/tycon-observations.archive/` si querés. |
| Spam Telegram cross-machine | Notif solo cuando se escribe pending nuevo (post-dedup). |
| Observer rompe la sesión Claude Code | Fail-open en todos los scripts. Spawn detached (`nohup &`). El observer nunca corre en foreground del Claude Code. |

---

## Métricas (futuras — para harness-audit.js)

- `instincts_pending_count` — cuántos pending hay ahora mismo
- `instincts_promoted_per_month` — actividad real del loop (si <2/mes → feature dead)
- `instincts_rejected_per_month` — calidad del observer (si >>promoted → prompt necesita tuning)
- `instincts_draft_completion_rate` — drafts generados / drafts completados → si baja, el suggester está sugiriendo cosas que no valen

Agregar como nueva categoría en `scripts/lib/harness-audit.js` ("Learning Loop").

---

## Dónde viven las propuestas (2026-10-09)

Por qué: si el observador, el disparador del arranque y `/tycon-instincts` crean el buzón dentro del
árbol del arnés antes de mirar nada (también por ensayar con `--dry-run` o por listar), en un árbol que no trae esa
carpeta —una versión bajada, que se reemplaza entera en cada actualización— lo escrito se pierde.

La regla, que vive en una sola pieza (`scripts/instincts/instinct-dirs.js`):

| | Dónde se escribe | Cómo se reconoce |
|---|---|---|
| **Clon de quien mantiene el arnés** | `inbox/instincts/` _(del repo del equipo; no está en esta copia)_ del árbol, como siempre | El árbol **trae su buzón**: existe `inbox/instincts/README.md` _(del repo del equipo; no está en esta copia)_ (lo versiona el repo; ningún guion lo crea) |
| **Arnés instalado** (o cualquier árbol que no trae buzón) | La casa de la persona: `<estado>/inbox/instincts/` | No existe ese archivo. `<estado>` es la carpeta de estado del arnés en esa máquina (`~/.tycon/state`, o la de siempre dentro de la carpeta de Claude Code si la máquina todavía no se mudó) |

- **Se lee en todos los lugares**: donde se escribe, lo que haya quedado en el árbol, la casa, y el buzón del clon que la
  máquina declara que mantiene (`paths.maintained`). Lo ya decidido en cualquiera de ellos no se vuelve a proponer.
- **Nadie crea una carpeta por leer**: nacen al escribir el primer archivo.
- **Aprobar y rechazar** mueven el archivo dentro del lugar donde estaba; el observador escribe sólo donde se escribe.
- **Para ver dónde está cada cosa**: `/tycon-instincts status` (una línea por lugar con sus cuentas; el de escritura,
  marcado), o `node scripts/instincts/instinct-dirs.js`.
- **Lo que no se pudo leer, se dice.** Una carpeta que existe y no se deja leer nunca se muestra como vacía: `list` lo
  avisa, `status` pone «?» en vez de un número, y el observador lo anota en su registro. Y si un lugar entero quedó sin
  mirar (el clon declarado no existe o no trae su buzón, la configuración de la máquina está rota), `status` lo dice en
  un renglón que empieza con «!».
- **El registro del observador** (`observer.log`) vive en el lugar donde se escribe. Si el disparador del arranque no
  puede usarlo —falta la pieza, no se sabe dónde es la casa, el archivo no abre—, el observador corre igual y su registro
  va a uno de reserva al lado del sello del disparador (`instinct-observer.fallback.log`, en la carpeta de usuario), con
  el motivo en el primer renglón. Si el grabador «no propone nada», es el primer lugar donde mirar.

Lo que hay que saber de la casa de la persona:

1. **No viaja por git.** En un arnés instalado no tenía por dónde viajar.
2. **Desinstalar el arnés se la lleva** en una máquina que vive en `~/.tycon`: se borra la carpeta de estado, y con ella
   las pendientes y las rechazadas. Lo aprobado ya quedó en la memoria (es lo que hace `approve`) y las observaciones
   crudas viven aparte, así que el observador vuelve a proponer.
3. **Lo que una versión anterior escribió dentro de un árbol instalado se pierde** en la primera actualización (el árbol
   se reemplaza). Se vuelve a proponer solo.

## Referencias

- Spec original (decisiones abiertas): [instinct-mining-v1-spec.md](decisions/instinct-mining-v1-spec.md) — preservar como histórico, ya cerrado.
- ECC continuous-learning-v2: [github.com/affaan-m/ECC/blob/main/skills/continuous-learning-v2/SKILL.md](https://github.com/affaan-m/ECC/blob/main/skills/continuous-learning-v2/SKILL.md)
- Scripts: `scripts/instincts/instinct-{observer,promote,draft}.js`, `scripts/instincts/instinct-dirs.js` (dónde se escribe y dónde se lee) + hooks `scripts/hooks/instinct-{observe,trigger}.sh`
- Slash command: versionado en `commands/tycon-instincts.md`, enlazado a `~/.claude/commands/tycon-instincts.md` por el instalador. Verbos: `review` (alias de `list`, el que linkea el Telegram notify) · `show <hash>` · `approve <hash>` · `reject <hash> --reason "..."` · `status` · `run`.
- Instalador: `scripts/setup/install-instinct-mining.sh` (registra hooks + enlaza el slash command, idempotente)

> **Asimetría RESUELTA (2026-08-24)** — antes decía "bajo Codex no graba ni propone", y era un
> **defecto**, no una decisión: el grabador (PostToolUse) sí estaba registrado del lado Codex, pero
> el observer llamaba fijo al CLI `claude`, así que un dev que trabaja **solo en Codex** no recibía
> ninguna propuesta. El razonamiento viejo ("una máquina alcanza") confundía *dos máquinas* con *dos
> herramientas en la misma máquina*: el mismo dev en Claude y en Codex, con una de las dos ciega.
> Arreglado haciendo el observer **agnóstico de ejecutor** (`resolveExecutor()` → claude/codex/ollama;
> `codex exec -m gpt-5.4-mini --skip-git-repo-check -s read-only -o <file>`, verificado con llamada
> real 2026-08-24: 12 s, YAML válido). Red: `scripts/tests/instinct-executor.test.sh` (5 casos con
> stubs, incl. "solo-codex → propone"). Override manual: `TYCON_OBSERVER_EXECUTOR=claude|codex|ollama`.
