# Migración del harness TYCON a Codex

**Estado:** plan aprobado para ejecución · **Fecha:** 2026-08-15
**Decisión de arranque:** Claude Code y Codex **conviven** bajo **fuente única** — el harness se
escribe una sola vez y el instalador lo despliega a los dos.
**Inventario de divergencias (entregable de la Etapa 0):** [codex-divergence-inventory.md](codex-divergence-inventory.md)

> **Alcance:** la migración se hace **completa**. La mesa BMAD propuso dos veces recortarla a una
> rebanada de 8 días y quedó descartado; de esas rondas se conserva el diseño,
> el orden y las trampas concretas, no el recorte. Los dos motivos declarados —no depender de un
> solo proveedor, y poder venderlo como consultoría— se cumplen ambos al completarla.

---

## 1. Principios de diseño — no negociables durante toda la migración

| # | Principio | Por qué |
|---|---|---|
| 1 | **Canónico asimétrico**: el markdown de Claude Code manda, Codex traduce | Un formato "neutro" con dos consumidores reales degrada al mínimo común denominador; el día que una herramienta saque algo que la otra no tiene, se rompe la abstracción |
| 2 | **Un solo generador, una sola familia**: solo los advisors se generan | Si el generador toca más de dos familias de archivos se convirtió en un compilador, y se termina depurando el compilador en vez del arnés |
| 3 | **El criterio vive en la regla con ID, no en la prosa del advisor** | Si el criterio está escrito dentro del texto, migrar es reescribir. Aplica a **todo advisor que se toque**, y frena la deuda hacia adelante. La deuda actual está medida y concentrada en 5 advisors — ver inventario §G |
| 4 | **Ningún control se da por portado sin su caso que falla a propósito** | Un control que nunca corrió se ve idéntico a uno que salió limpio (un control que hay que acordarse de invocar es un control que no corre) |
| 5 | **Falla ruidosa, nunca silenciosa** | Las trampas del inventario fallan en silencio por defecto; hay que forzar que griten |
| 6 | **El pipeline no se porta: Codex entra como ejecutor** | El orquestador Node ya existe y es agnóstico; se le agrega un ejecutor más en vez de reescribirlo |

---

## 2. Definiciones a cerrar antes del día 1

Ninguna es técnica: son decisiones. Sin ellas el día 1 no cierra.
**Las 5 quedaron firmadas el 2026-08-19** — 1-3 tal como estaban propuestas; 4 y 5 con la decisión
anotada en su punto.

1. **Fuente de verdad de una regla.** Propuesto: el markdown canónico manda y las dos herramientas
   se generan/enlazan desde ahí.
2. **Qué significa "mismo veredicto"** entre las dos herramientas. Propuesto y firmable — con la
   lección de que los advisors son LLMs, no scripts (pedir "mismo conteo" fallaría incluso
   Claude-contra-Claude):
   - **Hooks** (deterministas): mismo bloquea/no-bloquea, mismo exit code.
   - **Advisors**: cada caso del banco es **quirúrgico** — un pecado → una regla → el pass es "el
     rule ID objetivo está presente (debe-bloquear) / ausente (no-debe-bloquear)", **nunca el
     conteo total**. Cada caso corre N veces (default 3) antes de declararse estable; un caso
     inestable se rediseña, no se promedia. Desacuerdo persistente tras rediseñar → asimetría
     declarada en el registro de §3, con el caso exceptuado y visible.
   El texto libre puede diferir siempre.
3. **Reemplazo del cuadro de opciones en Codex.** Propuesto: pregunta numerada en texto plano, con
   las mismas opciones y una opción por defecto explícita. Se decide **antes** de tocar código.
4. **Windows.** El equipo es multi-plataforma y Codex difiere por OS (campo `commandWindows` en
   hooks). **Firmado: por OS desde el arranque** — el "listo" de la Etapa F es una máquina limpia
   **por sistema operativo** (macOS y Windows); la estimación de F lo absorbe.
5. **Cuentas y billing de Codex por dev.** El instalador despliega config pero no autentica OpenAI
   ni paga la suscripción. **Firmado: TYCON paga; arranca un solo dev** (el que ejecuta la
   migración) y el resto del equipo se suma cuando la Etapa H dé verde.

---

## 3. Arquitectura

```
                   FUENTE ÚNICA — se escribe una vez
        ┌──────────────────────────────────────────────────┐
        │  guías · reglas con ID · skills · scripts de los  │
        │  hooks · los 28 advisors                          │
        └──────────────────────────────────────────────────┘
               │                              │
      se comparte tal cual            se traduce (1 sola pieza)
      (symlink, no copia)             (solo los 28 advisors)
               │                              │
        ┌──────┴───────┐              ┌───────┴──────┐
        │ CLAUDE CODE  │              │    CODEX     │
        └──────┬───────┘              └───────┬──────┘
               └──────────┬───────────────────┘
                 BANCO DE PRUEBAS DE CONTROLES
        mismo caso en los dos → mismo veredicto
```

**Estructura del repo:**

```
<arnés>/
  guides/ · story-format.md · scripts/           ← ya son agnósticos, no se tocan
  adapters/
    claude/    ← fragmentos de settings.json, agents/*.md
    codex/     ← fragmentos de config.toml + hooks.json, agents/*.toml
  build/
    generate.js   ← markdown canónico → TOML. Única pieza de traducción
    check.js      ← "¿está al día?" para el pre-commit
    equivalences.json ← tabla de nombres (herramientas, eventos, modelos). Un solo archivo
  scripts/install-tycon-hooks.{sh,ps1}           ← despliegan el adaptador que corresponda
```

**Cómo se resuelve cada tipo de divergencia** (taxonomía usada por el inventario):

| Tipo | Mecanismo |
|---|---|
| ① Mismo concepto, distinto envoltorio | El traductor. Se escribe una vez, se genera la otra |
| ② Mismo concepto, distinto nombre | `build/equivalences.json`. **Un solo archivo**, nadie más lo toca |
| ③ No existe en una de las dos | Decisión, en este orden: **(a) nivelar hacia abajo** — usar la versión que funciona en ambas · **(b) sacarlo afuera** — implementarlo como script propio que las dos invocan (es lo que convierte una atadura en activo propio) · **(c) declarar la asimetría** en un registro con qué hace cada lado y qué caso de prueba queda exceptuado |

> **La asimetría se permite; el silencio no.** Una divergencia que existe y no está registrada es la
> que hace que el banco de pruebas dé verde sin significar nada.

---

## 4. Etapas

### Etapa 0 — Definiciones e inventario · 1 día
Las cinco decisiones de §2 (firmadas el 2026-08-19) + el barrido del inventario (§F/§G, completado
el 2026-08-15). Filas "a verificar" restantes del inventario se resuelven en la sonda de la Etapa A.

### Etapa A — Higiene y sonda · 1-2 días
- **Sonda primero (condiciona el resto del plan):** cuatro pruebas go/no-go, baratas a propósito:
  1. Verificar el binario de Codex y **probar empíricamente en qué ruta lee las skills** — la doc
     oficial dice `~/.agents/skills`, artículos de terceros dicen `~/.codex/skills`. Si el
     instalador apunta mal, todo lo demás falla en silencio.
  2. Habilitar la bandera `[features] codex_hooks` y confirmar que un hook trivial dispara.
  3. **stdout→contexto (media hora, condiciona la Etapa E):** un hook escribe un marcador único a
     stdout y en el turno siguiente el agente debe poder citarlo. Que un hook *dispare* no prueba
     que su salida se *inyecte como contexto* — y de ese segundo mecanismo dependen 14 de los 20
     hooks (ver el resumen del inventario). Si Codex no inyecta, la Etapa E no es un port de 5-7 días:
     es un rediseño, y hay que saberlo el día 1.
  4. **Smoke de BMAD (media jornada, condiciona la Etapa G):** `codex exec` + `bmad-dev-story`
     sobre una story de juguete. BMAD es el motor del Step 4 del pipeline, es de terceros y está
     escrito asumiendo Claude Code — si no corre aceptablemente en Codex, la Etapa G no tiene qué
     ejecutar, y eso no puede descubrirse a 3/4 del cronograma.
- **Frenar el drift**: hoy hay dos copias de las 526 líneas de reglas globales, ya difieren en 48, y
  `sync-claude-md-blocks.sh` solo escribe del lado Claude. Pasa a escribir en ambos — pero **la
  copia byte-idéntica está prohibida**: el bloque canónico nombra tools por su nombre exacto
  (`mcp__plugin_engram_engram__mem_search`, `AskUserQuestion`, las 10 de Clockify) y esos nombres
  cambian o no existen en Codex (ver el resumen del inventario) — copiarlo tal cual le entrega a Codex
  referencias rotas que fallan en silencio. El arreglo es **reescribir el canónico para que no
  dependa de nombres**: las tools se refieren por lo que hacen, y los nombres exactos viven en una
  sección corta de nombres-por-herramienta al final del bloque, distinta por lado. Así el sync
  sigue siendo copia tonta y el principio 2 (un solo generador) queda intacto.
**Listo =** las 4 sondas con veredicto anotado (verde o rojo, nunca "no se probó") · cambiás una
regla, corrés el instalador y las dos copias quedan **semánticamente equivalentes** — idénticas
salvo la sección de nombres-por-herramienta — y ningún nombre de tool del lado Codex apunta a algo
que no existe.


### Etapa B — Banco de pruebas de controles · 2 días (B1) + casos de advisors durante D (B2)
Tres tipos de caso por control:
1. **Debe bloquear** — el pecado que ese control existe para atrapar. Se verifica el bloqueo **real**
   (la acción no se ejecutó), no que el script haya terminado bien.
2. **No debe bloquear** — el caso legítimo parecido. Un freno que frena todo también está roto, y es
   así como el equipo termina apagándolo.
3. **Debe haber corrido** — constancia: corrió, sobre qué archivos, cuánto tardó, con qué rule IDs.
   **"Salió limpio" sin constancia = falla, no verde.**

El mismo caso corre en las dos herramientas y debe dar el mismo veredicto según §2.2 (por regla
objetivo, no por conteo).

**Línea de base primero — el banco protege a los dos lados, no solo al nuevo:** los casos corren
sobre Claude **tal-como-está, antes de tocar ninguna pieza**. Toda pieza que la migración reescribe
(el bloque canónico de reglas en A, los 5 advisors con criterio en prosa en D) debe seguir verde en
Claude antes de mirar Codex — así lo que hoy anda no se rompe sin que suene.

**Partida en dos** — ~144 casos no caben en 2 días:
- **B1 (2 días):** el runner del banco + los casos de los 20 hooks (deterministas, baratos).
- **B2 (durante la Etapa D):** los casos de cada advisor se escriben cuando ese advisor entra, con
  regla dura: **un advisor no entra sin sus casos**. Fuente primaria: el registro de incidentes y los ejemplos
  de los propios advisors — los pecados "debe bloquear" ya existen a medias ahí; se cosechan antes
  de inventar.

**El banco tiene horario, dueño y presupuesto — o es el anti-patrón que combate:**
- **Cadencia por capa:** casos de hooks (scripts) → en cada push / diario · casos de advisors
  (LLM-caros) → semanal, y siempre que se toque ese advisor.
- **El reporte aterriza como aviso de SessionStart** (mismo mecanismo que los meters de estilo y
  bloqueo): el rojo se ve sin que nadie se acuerde de mirar.
- **Costo por corrida completa, estimado y escrito** antes de fijar la cadencia (~48 controles × 3
  casos × 2 herramientas × N corridas de estabilidad).

**Listo (B1) =** runner + casos de los 20 hooks corriendo en ambas, línea de base Claude fijada, el
banco **detecta a propósito** un hook que no se dispara, y cadencia + destino del reporte + costo
escritos. Diseñable en paralelo con A. (B2 se cierra con D.)


### Etapa C — La rebanada que fija el patrón · 5 días
Un advisor + un hook bloqueante en Codex desde fuente única, con el generador mínimo.
- **Advisor: el que más duele perder**, no el más fácil. Candidato: `tycon-plugin-security-basics`.
- **Hook: `safety-guard-pre.sh`** — el más crítico y el que más rápido revela si la semántica de
  bloqueo se conserva.
- Primera aplicación del principio 3: el criterio del advisor migra a reglas con ID.
**Listo =** mismo diff → mismos rule IDs y mismo conteo en ambas; y el freno frena en las dos.
**Es también el activo comercial**: la prueba en pantalla partida.


### Etapa D — Los 27 advisors restantes · 4-5 días (incluye los casos B2)
Mecánico si C dio verde. Cada advisor entra con sus casos (B2 — se escriben acá; regla dura: un
advisor no entra sin sus casos). Se aprovecha para sacar
criterio de la prosa hacia reglas con ID — concentrado en 5 advisors (inventario §G).
**Listo =** los 28 generan TOML válido, corren en Codex, y el banco reporta paridad.


### Etapa E — Los ~20 hooks · 5-7 días
Capa de normalización de eventos (`lib/hook-io.js`) + registro en la config de Codex. Los scripts se
reusan tal cual: ya reciben JSON por stdin y ya usan exit 2. **El grueso del riesgo vive acá** —
inventario §A.
**Listo =** los 20 con caso negativo verde en ambas.


### Etapa F — Skills, MCPs e instaladores · 4-6 días (incluye Windows)
7 skills propias + las de terceros por symlink · 4 servidores MCP · las 6 skills BMAD que el pipeline
invoca, verificadas explícitamente · instaladores desplegando el adaptador correspondiente · Telegram
con su servidor aparte.
**Listo =** una máquina limpia **por OS** (macOS y Windows) corre el instalador y queda operativa
en las dos herramientas (definición §2.4).


### Etapa G — Pipeline · 5-7 días
No se porta: el orquestador Node suma `codex exec` como ejecutor. Trabajo real: rediseñar los
checkpoints con §2.3 · el pase adversarial invocando el ejecutor de Codex · mapear los hints de
modelo/esfuerzo (en Codex se declaran por subagente, no por invocación). La estimación es par a la
de C a propósito: el inventario (§F) mide al skill del pipeline como **la pieza más acoplada del
arnés** (124 rutas, 28 menciones de `Workflow`) — "el orquestador ya existe" es cierto para
`pipeline.js`, no para el SKILL.md que conduce el flujo.
**Mecánica de la comparación** (sin esto el "listo" no es medible):
- **Story sintética fija** + repos aislados por worktree (`guides/git-worktrees.md`) — la corrida
  en una herramienta no puede contaminar el repo de la otra.
- Se comparan **checkpoints dorados** (¿validó la story? ¿qué advisors corrió? ¿bloqueó donde
  debía? ¿qué rule IDs reportó?), no el diff resultante — comparar runs completos de dos LLMs es
  comparar no-determinismo.
**Listo =** la story sintética corrida punta a punta en Codex con todos los checkpoints dorados en
paridad (o su asimetría declarada), y una story real como validación final.


### Etapa H — Paridad continua y equipo · 2 días
`build/check.js` en el pre-commit · `harness-audit.js` corriendo en ambos y reportando paridad ·
onboarding + actualización de las 25 guías que mencionan Claude Code (inventario §F).
`check.js` verifica **tres** cosas, no una:
1. El TOML generado de los advisors está al día con su markdown canónico.
2. **Paridad de registro de hooks**: todo hook del adaptador Claude existe en el de Codex o está en
   el registro de asimetrías — ese par de fragmentos se mantiene a mano y es el mismo tipo de copia
   doble que ya driftó 48 líneas una vez.
3. **Pieza nueva sin casos del banco = commit rechazado.** El principio 4 cubre la migración; esta
   regla cubre el después — el advisor #29 o el hook #21 que se cree en octubre entra con sus 3
   casos o no entra. Es lo que mantiene la paridad viva cuando la migración termine.
**Listo =** el pre-commit falla en los tres escenarios, probado a propósito.



---

## 5. Cronograma y dependencias

| Etapa | Días | Depende de | Paralelizable con |
|---|---|---|---|
| 0 — Definiciones e inventario | 1 | — | — |
| A — Higiene y sonda | 1-2 | 0 | diseño de B |
| B — Banco de pruebas (B1) | 2 | 0 (diseño), A (ejecución) | A |
| C — Rebanada / patrón | 5 | A, B | — |
| D — 27 advisors + casos B2 | 4-5 | C | E |
| E — ~20 hooks | 5-7 | B, C | D |
| F — Skills, MCPs, instaladores (por OS) | 4-6 | A | D, E |
| G — Pipeline | 5-7 | D, E, F | — |
| H — Paridad y equipo | 2 | G | — |

**Total: 29-37 días netos**, o **~24-29** solapando D/E/F. En tiempo parcial: 6 a 8 semanas.

**Orden de corte si aprieta:** primero D (advisors de menor uso), después F (Telegram, BMAD
completo). **Nunca se corta B.** Dentro de C, si hay que elegir, **sobrevive el hook, no el
advisor**: el freno protege, el advisor opina.

**Convención de trabajo (acordada 2026-08-19):** un **branch por etapa** (`codex/etapa-a`, `codex/
etapa-b`, …) en el repo que esa etapa toque, mergeado a main cuando el "listo" de la etapa dio
verde — nunca un branch único para toda la migración. Motivo: el arnés y
`agent-skills` se auto-propagan al equipo en cada arranque de sesión, o sea que su main es
"producción" del arnés. Lo que corre en cada máquina (instalador, sync) entra a main **apagado por
default** tras una llave (`TYCON_CODEX=1`) hasta la Etapa H — un branch no protege de eso: al
mergear le llega a todos igual. Worktrees en esos dos repos siguen prohibidos (regla existente);
branch clásico. Cambios de solo documentación van directo a main.

**Regla del clon compartido:** esos dos repos son UNA copia en el disco de cada dev, y las demás
sesiones leen las guías/skills de lo que esté checkouteado. La sesión que trabaja la migración
**vuelve a main al pausar o cerrar** — nunca deja el clon parado en `codex/etapa-*`, porque otra
sesión arrancaría leyendo el arnés del branch a medio hacer, sin error visible. No se confía en
memoria: **primera tarea de la Etapa A** = el chequeo de SessionStart (instalador) avisa a gritos
si el arnés o `agent-skills` no están en main.

---

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| Los hooks de Codex están detrás de bandera experimental, y ahí vive el safety-guard | Detección ≠ protección: **canary al arranque de cada sesión Codex** (un hook trivial debe bloquear un comando de prueba, tarda un segundo) + **política de degradación escrita** — canary o banco en rojo sobre un hook bloqueante → la sesión lo anuncia a gritos y el equipo cae a Claude Code hasta verde. La capa de normalización aísla el cambio a un archivo |
| Cada regla nueva pasa a costar más (canónico + traducción) | Generador acotado a una sola familia + `check.js` en pre-commit |
| Criterio nuevo escrito dentro de los prompts sigue creciendo | Principio 3 se aplica desde hoy, no al final |
| Retiro de gpt-5.4 / 5.4-mini el 31-ago-2026 | La config local ya usa `gpt-5.6-terra`; revisar scripts que nombren modelos |
| El equipo queda partido con distinta calidad de gate | La paridad de la Etapa H es métrica, no aspiración |

---

## 7. Qué soporta Codex hoy (verificado en documentación oficial, agosto 2026)

| Capacidad | Estado |
|---|---|
| Skills `SKILL.md` | Mismo formato estándar. Rutas: `~/.agents/skills` (usuario), `.agents/skills` (repo), `/etc/codex/skills` (admin). Disparo por `description` o explícito con `$nombre` |
| Subagentes propios | GA desde marzo 2026. TOML en `~/.codex/agents/` o `.codex/agents/`. Campos: `name`, `description`, `developer_instructions`; opcionales `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`. Paralelos, con tope configurable |
| Hooks | 11 eventos (SessionStart, SessionEnd, PreToolUse, PostToolUse, PermissionRequest, PreCompact, PostCompact, UserPromptSubmit, SubagentStart, SubagentStop, Stop). JSON por stdin; bloqueo con exit 2 o `{"decision":"block"}`. En `hooks.json` o `[hooks]` de `config.toml`. Bandera `[features] codex_hooks = true`. Timeout 600s, salida ~2.500 tokens, campo `commandWindows` |
| Servidores MCP | `[mcp_servers]` en `config.toml` |
| Instrucciones globales | `~/.codex/AGENTS.md` + cadena por repo (raíz git → cwd), con `project_doc_fallback_filenames` |
| Sin interfaz | `codex exec -m <modelo>` |
| Modelos / esfuerzo | `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`. Esfuerzo: minimal a xhigh |
| Comandos `/x` propios | Custom prompts **deprecados a favor de skills** |

**Sin equivalente:** el cuadro de preguntas con opciones · la orquestación determinística en
JavaScript · la delegación automática a subagentes · el canal de Telegram (plugin de Claude Code) ·
los permisos granulares por herramienta.

---

**Por qué fuente única:** al relevar (2026-08-15), la migración estaba en
~2% y ese 2% era una copia manual de `~/.claude/CLAUDE.md` en `~/.codex/AGENTS.md` hecha en julio
que **ya se había desincronizado en 48 líneas**, porque `sync-claude-md-blocks.sh` solo escribe del
lado Claude. Ese hecho es la evidencia empírica que sostiene la decisión de fuente única: dos copias
de la misma regla se separan solas, sin que nadie se entere.

