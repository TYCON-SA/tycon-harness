# controls-bench — Banco de pruebas de controles del arnés

**Qué es**: la red que verifica que los controles del arnés (hoy: los ~20 hooks; en Etapa D: los
28 advisors) hacen lo que dicen — en Claude Code Y en Codex — antes de que una regresión llegue a
producción. Nace en la Etapa B del plan de migración (`codex-migration.md` §Etapa B); su primera
función es proteger **a los dos lados**: toda pieza que la migración reescribe debe seguir verde en
Claude antes de mirar Codex.

**Dónde vive**: `scripts/controls-bench/` — `runner.js` (casos de hooks fuera de banda),
`live-fire.js` (disparo real dentro de cada herramienta), `advisor-runner.js` (casos de advisors
contra el advisor real, Etapa C), `live-fire-guard.js` (el freno real frenando de verdad),
`cases/hooks/*.json` + `cases/advisors/*.json` (los casos), `baseline/claude.json` +
`baseline/claude-advisors.json` (líneas de base, commiteadas), `.bench/` (reportes locales,
gitignored).

---

## 1. Las dos capas

### 1.1 runner.js — la lógica de cada hook, fuera de banda (determinista, $0)

Alimenta cada script de hook REAL por stdin con el payload del evento en la forma de cada
herramienta, dentro de un sandbox (HOME temporal + fixture como cwd — el estado real de
`~/.claude` no se toca). Tres tipos de caso por control (§Etapa B del plan):

| Tipo | Qué verifica |
|---|---|
| `must-block` | el pecado que el control existe para atrapar — se asserta el **bloqueo real** (exit 2 / `decision:block`), no que el script haya terminado bien |
| `must-not-block` / `must-stay-quiet` | el caso legítimo parecido NO se frena — un freno que frena todo también está roto |
| `must-run` / `must-emit` | **constancia**: corrió y dejó evidencia (log, marker, aviso). Un caso de estos SIN aserción de evidencia falla por diseño: "salió limpio" sin constancia = falla |

```bash
node scripts/controls-bench/runner.js --tool claude              # lado Claude
node scripts/controls-bench/runner.js --tool both                # paridad claude↔codex por caso
node scripts/controls-bench/runner.js --tool claude --baseline write   # fijar línea de base
node scripts/controls-bench/runner.js --tool claude --baseline check   # detectar regresiones
node scripts/controls-bench/runner.js --list                     # inventario de casos
node scripts/controls-bench/runner.js --only safety-guard        # un solo hook
```

**Paridad (§2.2 del plan)**: con `--tool both` se compara el veredicto POR CASO entre
herramientas. Un caso puede excluir una herramienta SOLO con `"asymmetry": "<motivo>"` — la
asimetría se permite; el silencio no (excluir sin motivo es un rojo automático).

**Payload por herramienta**: verificado empíricamente 2026-08-21 — Codex manda por stdin LOS
MISMOS campos que Claude (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`,
`prompt`, `stop_hook_active`, `transcript_path`) más `turn_id`, `model` y `tool_use_id`. El
runner construye ambas formas; los scripts corren sin adaptador.

### 1.2 live-fire.js — el disparo real dentro de cada herramienta

Lo que el runner no puede probar: que la herramienta **dispare** el hook y que el matcher
matchee. Registra hooks marcadores (vuelcan el stdin recibido a un archivo por evento), corre una
sesión headless mínima y asserta un marcador por evento — más un **canary** (matcher
`NuncaJamasTool`) que NO debe disparar: un matcher que no matchea falla en silencio, y el banco lo
vigila explícitamente.

```bash
node scripts/controls-bench/live-fire.js --tool claude            # claude -p (haiku, hooks por --settings)
node scripts/controls-bench/live-fire.js --tool codex             # codex exec (hooks por <fixture>/.codex/hooks.json)
node scripts/controls-bench/live-fire.js --tool claude --prove-detection   # autotest del banco
```

`--prove-detection` planta a propósito un hook que no se dispara como si fuera esperado: la
corrida DEBE reportarlo en rojo. Es la prueba de que "hook que no dispara" no pasa desapercibido
(requisito del "listo" de B1 — probado verde el 2026-08-21 en Claude).

Gotchas operativos descubiertos al armarlo:
- `codex exec` **exige un repo git en el cwd** — sin `git init` no corre y ningún hook dispara
  (sin error que lo diga). El live-fire lo inicializa solo.
- Codex a nivel repo (`<repo>/.codex/hooks.json`) funciona con `--dangerously-bypass-hook-trust`;
  no hace falta tocar `~/.codex` (la auth queda intacta).
- El payload capturado por los marcadores queda en el reporte → es la referencia empírica de qué
  manda cada evento en cada herramienta.

**Veredictos live-fire 2026-08-21 (Claude Code 2.1.236 · Codex CLI 0.149.0):** los 5 eventos
usados por el arnés (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop) disparan en
AMBAS herramientas; el canary calla en ambas; y **el matcher `Bash` matchea en Codex** — la tool
de shell se llama literalmente `Bash`, o sea que los 5 hooks con matcher Bash (incluidos los 3
frenos duros) portan sin cambio de matcher (cierra la fila "a verificar" del inventario §A.2).

### 1.3a `--liveness` — el chequeo de vida, y por qué el examen dejó de correr 3 horas (2026-09-01)

**El nocturno de martes y viernes ya NO corre el examen completo: corre `--liveness`, y tarda ~12
minutos en vez de ~3 horas.** El examen profundo sigue existiendo, a pedido.

Qué es: por cada revisor, **un par de gemelos** —el caso que tiene que gritar y el que tiene que
callarse—, **una** corrida, **una** herramienta. Contesta una sola pregunta: *¿este revisor sigue
vivo?* Un revisor que se murió en silencio no emite su hallazgo crítico, el pipeline nunca frena
para preguntarle nada al dev, y el problema pasa de largo. Ése es el único fallo que ninguna otra
pieza del arnés caza.

```bash
node scripts/controls-bench/advisor-runner.js --liveness            # 52 casos · ~12 min · reporte: .bench/vida-claude.json
node scripts/controls-bench/advisor-runner.js --liveness --list     # qué correría, sin gastar nada
node scripts/controls-bench/advisor-runner.js --tool both --baseline check   # el examen profundo, a pedido
```

**Qué NO mide, a propósito**: si el revisor se contradice entre corridas (necesita N corridas) y si
las dos herramientas coinciden (necesita las dos). Las dos preguntas siguen teniendo respuesta en el
examen profundo — que es para cuando se migra de herramienta o se sospecha de algo puntual, no para
un martes cualquiera.

🔴 **Entonces un rojo del chequeo de vida es una SOSPECHA, no un veredicto.** Con una sola corrida
el modo **no puede distinguir un defecto de criterio de una moneda al aire** — es una limitación de
diseño, no un bug. Antes de tocarle la prosa a ningún revisor, confirmá:

```bash
node scripts/controls-bench/advisor-runner.js --tool claude --runs 3 --only <caso>
```

**Medido: los 2 rojos que dio el chequeo de vida desde que existe fueron los DOS variación entre
corridas, ninguno un defecto real** — el gemelo limpio de `tycon-sibling-pattern-reviewer` (que por
eso salió del canario el 2026-09-01) y `deftr-c1-deuda-fantasma` (que salió el mismo día, tras medir
`[true,true,false]` en 3 corridas). Sin esta advertencia el camino natural del que lee el informe a
las 2 de la mañana es editarle la prosa a un revisor sano, y eso rompe un revisor que andaba. Por
eso la frase **también la imprime el propio informe** cuando `--liveness` cierra en rojo, con el comando
de confirmación ya armado: una regla que sólo vive en una guía es una regla que nadie lee en el
momento en que hace falta.

**Cerrada (2026-09-01, la misma noche)**: `deftr-c1-deuda-fantasma` daba `[true,true,false]` y se
había leído como "el caso está mal diseñado". No lo estaba: **el margen vivía en la PROSA del
advisor**, que no decía que el `blocked_by` del frontmatter no documenta nada ni que un bloque
`[DEF-]` de otra story es irrelevante. Con la exclusión escrita pasó a **3/3**. Lección que vale más
que el caso: cuando un revisor se contradice, el primer lugar a mirar es su prosa, no el fixture —
sacarle el señuelo al caso le habría quitado justo el poder discriminante que existe para medir.

🔴 **Y el primer intento del arreglo empeoró la otra mitad**: la cláusula decía qué NO cuenta y no
decía qué SÍ, y con esa asimetría el gemelo limpio —que venía verde— pasó a `[false,true,false]`.
Emparejarla (decir explícitamente qué cierra la regla) lo devolvió a `[false,false,false]`. Un
criterio que sólo enumera exclusiones empuja al revisor a rechazar.

**La deuda que SÍ queda abierta ahí, y es otra**: el gemelo limpio tiene `expect_mcp` sobre
`mem_search`, y el advisor no la llama en ~1 de cada 3 corridas — con razón: cuando `tasks/todo.md`
ya documenta la deuda, consultar la memoria es redundante y saltearlo es lo sensato. O sea que la
aserción le exige un paso que sobra. Se cuenta como `artefactos` (bien), pero un canario que se pone
rojo 1 de cada 3 veces por un paso inútil grita en falso. Para cerrarlo hay que decidir si
`expect_mcp` puede ser condicional — y eso es una decisión sobre el **contrato del banco**, no sobre
este caso. Mientras tanto: la mitad que grita es canario (3/3), la limpia queda afuera con su motivo
en `canario_media_pareja`.

**Por qué se achicó.** El examen completo son 97 casos × 2 herramientas × 3 corridas = 582 consultas.
Medido sobre todas sus corridas, lo que encontró **de los revisores** fue casi nada, y lo que
encontró de **sí mismo** fue mucho (medido: una corrida
tituló *"92 razonan mal"* y el recuento dio **cero** — eran 93 fugas del corral). Un control
caro cuyo hallazgo típico es un defecto propio se achica hasta lo que sí paga.

**Cómo se marca un canario.** En `cases/advisors/<advisor>.json`, `"canario": true` en un caso
`must-flag` y en su gemelo `must-not-flag` de la MISMA regla. Reglas que sostienen esto:

- **Un revisor sin canario se denuncia** al arrancar `--liveness` — si no, un advisor nuevo saldría del
  examen sin un solo caso y la corrida cerraría en verde. Se puede declarar el hueco con
  `"canario_ausente": "<motivo>"` en el archivo: deuda con motivo, no silencio.
- **Media pareja no es una pareja** (`"canario_media_pareja"`): probar sólo que grita deja sin
  cubrir que sepa callarse, y un revisor que grita siempre se termina ignorando igual que uno mudo.
  🔴 **Se denuncian las DOS direcciones** (2026-09-01): que falte el gemelo limpio, y que falte el
  que grita. La segunda es la peor para el chequeo de vida —un revisor MUERTO sale verde en su caso
  limpio y el modo cierra sin decir nada, que es justo el fallo que `--liveness` existe para cazar— y
  hasta ese día pasaba en silencio. Lo destapó sacar del canario a `deftr-c1-deuda-fantasma`: el
  revisor quedó con sólo su mitad limpia y nada lo dijo.
- 🔴 **Un caso que ya se sabe inestable NO se marca canario.** Con una sola corrida, una moneda al
  aire se lee como defecto real. Pasó en el estreno: `limpio-userctx-parametro-sin-c2` reportó un
  criterio que no existía. Un canario que grita en falso se termina ignorando, y con él se ignora el
  día que grite de verdad.

**Y además corre CUANDO CAMBIA un revisor, no sólo por calendario** (`scripts/hooks/advisor-liveness-on-change.js`,
2026-09-01). El chequeo nocturno es martes y viernes; el momento en que un revisor se rompe es
cuando alguien le edita la prosa, y entre las dos cosas había hasta cuatro días con ese revisor
auditando código de verdad. Ahora el pre-commit del repo de los advisors (`~/.claude/agent-skills`,
sobre `agents/*.md`) corre el par canario del revisor tocado: ~40 s, 2 consultas.

🔴 **No frena por un solo rojo** — sería el gate gritando por una moneda al aire, y eso se desactiva
en una semana. Ante un rojo de criterio, el propio gate confirma con 3 corridas: **3 de 3 en rojo →
frena** (esa edición rompió el revisor); **mixto → avisa y deja pasar** (el problema es el caso).
Y nunca frena por plomería: sin red, sin sesión o con el corral escapándose, avisa y pasa — frenar
un commit porque no había internet es la vía rápida a `--no-verify`. Tope de 3 revisores por commit
(una edición masiva pide el barrido completo, no 2 consultas × N). Apagado:
`TYCON_NO_LIVENESS_PRECOMMIT=1`. Su tabla de decisión se ejerce sin gastar un modelo con `--selftest`.

### 1.3 advisor-runner.js — casos de advisors, el advisor REAL en ambas herramientas (Etapa C)

La capa que el plan difería a B2: casos **quirúrgicos** por advisor (`cases/advisors/*.json`) que
invocan al advisor real — en Claude, `claude -p` con el cuerpo del canónico `agents/<name>.md`
como system prompt; en Codex, `codex exec -p <name>` con el profile **generado por
`build/generate.js`** (o sea que cada corrida prueba también al generador: si el `.toml` no
inyecta las instrucciones, el reporte no cita rule IDs y el caso cae en rojo).

El contrato de veredicto es el firmado en §2.2 del plan — el sujeto es un LLM, no un script:

- un pecado → **una regla objetivo** → pass = el rule ID está presente (`must-flag`) / ausente
  (`must-not-flag`). **Nunca el conteo total** de findings.
- cada caso corre **N=3 veces con unanimidad exigida**: corridas mixtas = `INESTABLE` (el caso se
  rediseña, no se promedia).
- desacuerdo persistente entre herramientas → asimetría declarada en el caso, visible.

```bash
node scripts/controls-bench/advisor-runner.js --tool both                  # paridad por regla objetivo
node scripts/controls-bench/advisor-runner.js --tool claude --baseline write|check
node scripts/controls-bench/advisor-runner.js --only sec-c2 --runs 1      # smoke barato
node scripts/controls-bench/advisor-runner.js --tool both --runs 1 --save-output   # pasada ad-hoc + salidas crudas
```

**Qué cuenta como finding** (y por qué importa): el detector exige el rule ID **entre corchetes al
inicio de un bullet** (`- [SEC-C2] ...`, tolerando énfasis markdown: `- **[SEC-C2]**`). Los dos
extremos rompen el banco y los dos aparecieron de verdad en C y D: un grep suelto del ID cuenta la
**mención** que el advisor hace al DESCARTAR la regla en su sección "✅ OK" (falso rojo en los casos
limpios), y un patrón demasiado rígido descarta un finding legítimo escrito en negrita (falso rojo
en un `must-flag`). `--save-output` guarda las salidas crudas en `.bench/advisor-outputs/` — es lo
que permite decidir, ante un rojo, **si falló el advisor o falló el caso**.

**Escribir casos de un advisor nuevo** (patrón fijado en C-D, ver `cases/advisors/*.json`): 2
`must-flag` de reglas DISTINTAS + 1 `must-not-flag` que es el **gemelo legítimo** de una de ellas;
`prompt_template` idéntico en todas las suites (declara el contexto automatizado, sin el cual el
advisor devuelve su resumen ejecutivo y suprime los rule IDs); fixtures autocontenidos de 10-25
líneas que incluyan TODO lo que la regla necesita (el `.tycon/advisors.yaml` si el advisor es
project-gated, el `.advisors/tests-result.json` si lee ese artefacto, la story si valida stories).
Regla de oro aprendida en D: **el fixture debe aislar el pecado y el gemelo debe ser
inequívocamente correcto** — si el advisor tiene un motivo razonable para opinar distinto, el
defecto es del caso, no del advisor.

### 1.4 live-fire-guard.js — el freno real, frenando de verdad (Etapa C)

`live-fire.js` prueba con marcadores que los eventos disparan; el runner prueba la lógica del
guard fuera de banda. Lo que ninguno prueba es la **semántica de bloqueo de punta a punta**:
`safety-guard-pre.sh` registrado en la herramienta real, el modelo intenta
`git commit --no-verify` (GIT-C2), y se asserta el **efecto**: el repo queda sin el commit, el log
del guard suma la línea `BLOCK rule=GIT-C2`, y un comando benigno en la MISMA sesión sí ejecuta
(un freno que frena todo también está roto).

```bash
node scripts/controls-bench/live-fire-guard.js --tool both   # ~1-3 min por herramienta
```

### 1.5 live-fire-stop.js — ¿la herramienta honra el bloqueo del Stop? (Etapa H, 2026-08-23)

El runner prueba que `on-stop-dod-gate.js` EMITE `{"decision":"block"}`; live-fire prueba que
el evento Stop dispara. Lo que faltaba (fila A.3 del inventario: "verificar forma") es que la
herramienta **honre** el block: que no cierre el turno y le devuelva el reason al modelo. La
aserción es sobre el **efecto**, con un CONTADOR de eventos Stop propio del lab como
discriminador — no el `iter` del gate, porque en las máquinas del equipo el gate está
registrado también globalmente y corre ≥2 veces por Stop (su iter cuenta invocaciones, no
intentos; un block ignorado igual llegaría a iter=2 — algo que
`--prove-detection` reproduce exacto). Si el block se honra, el modelo reintenta cerrar →
stops ≥ 2, y el freno anti-thrashing escala solo (`needs_human`) — la sesión del lab termina
sola en pocos intentos, no puede colgarse. Si se ignora, muere en el primer evento → stops = 1
→ rojo. Sesión benigna aparte (marker con `autonomous: false`) asserta que el
portón NO traba lo que no debe. El marker se siembra con un hook de UserPromptSubmit del lab
(el session_id lo genera la herramienta; en SessionStart NO va — con hooks de proyecto codex
puede dispararlo antes de cargar el `.codex/hooks.json` del cwd, medido 2026-08-23); un sid
anotado sin marker se reporta como falla de infra del lab, no como veredicto. Resultado
2026-08-23: **verde en las DOS herramientas** (block honrado, iter=3, escalada sola, benigna
sin trabas) — la fila A.3 del inventario quedó cerrada.

```bash
node scripts/controls-bench/live-fire-stop.js --tool both      # 2 sesiones por herramienta
node scripts/controls-bench/live-fire-stop.js --prove-detection # autotest offline, sin LLM
```

### 1.x — Las dos auditorías del banco sobre sí mismo (estáticas, sin LLM)

El banco mide controles; estas dos miden al banco. Corren **a diario**, no gastan una sola llamada
al modelo, y existen porque las dos fallas que atrapan **no dan error: dan silencio**.

| Auditoría | La pregunta que contesta | Qué encontró en su primera corrida |
|---|---|---|
| `vacuity-audit.js` | ¿los casos prueban lo que dicen probar? Re-corre cada caso afirmativo con su control reemplazado por un script que no hace nada — si pasa igual, es vacuo. Si los casos de un hook corren **a propósito otro programa del arnés desde el setup** (la foto de iteración se prueba corriendo `marker.js snapshot-iter` ahí), el hook lo declara en `"controles": [...]` y el auditor lo neutraliza también; sin declararlo, el caso sale vacuo (2026-09-17: 9 falsos positivos de `40-foto-de-iteracion.json` desde el 15-09) | 1 caso vacuo entre 103 |
| `silence-audit.js` | ¿el arnés silencia sus propios avisos cuando lanza un agente? Toda invocación a `claude`/`codex` —del banco **y de los scripts sueltos**— tiene que pasar `TYCON_EVAL_SANDBOX=1` | **6 sitios** sin silenciar: 3 en el banco (los tres del lado Codex) + las 2 ramas del observador de instintos + el demo de advisors |

### 1.y — El corral no se escapa (aislamiento del fixture)

Un advisor puede tener escrito en su procedimiento que mire fuera del repo bajo revisión —
`tycon-sibling-pattern-reviewer` tiene `~/SourceCode/` con un `find -maxdepth 6`, porque en
producción eso es exactamente lo correcto. Bajo el banco no lo es: significa medirlo contra los
repos que este dev tiene clonados hoy, y **el veredicto del caso deja de ser reproducible en otra
máquina**. Medido: hasta 29 repos y 2,4 MB por corrida, con la corrida muerta por tiempo agotado.

Tres piezas lo cierran:

1. **`TYCON_REPOS_ROOT`** (hasta el 2026-09-05 `TYCON_SIBLINGS_ROOT`; hoy es UNA variable para todo el arnés, ver `scripts/lib/repos-root.js`) — la raíz de descubrimiento sale de esa variable si está definida. El
   banco la apunta a un corral de dos hermanos mínimos con el patrón canónico, **anidados a 4
   niveles** (el discovery full-depth sigue ejercitado) y con **las firmas copiadas del contrato
   real**, nunca inventadas: un corral inventado no mide al revisor, lo engaña. En producción la
   variable no existe y el comportamiento es el de siempre.
2. **Límite duro, no sugerencia** — con la variable definida, ningún repo fuera de esa raíz se
   consulta, *incluido el repo de referencia nombrado en la propia prosa del advisor*. Sin este
   límite el revisor se escapa por la puerta del nombre propio.
3. **`fugaDelCorral()`** — cada corrida se revisa contra rutas reales de la máquina. La lista de
   permitidos (las guías del arnés, la config de las herramientas, el PATH) está calibrada contra
   las ~330 salidas ya guardadas: dispara en los casos culpables y en ninguno de los otros.

**Por qué la segunda es un control y no una convención**: sin el silenciador, los hooks de arranque
disparan DENTRO del agente medido y le inyectan *"controls-bench EN ROJO — Correr: node
.../runner.js"*. El agente lo corre, choca contra el sandbox de solo lectura o contra el tope de
tiempo, y el caso muere con exit≠0 — que el banco leía como *"el revisor es inestable"*. **Un banco
en rojo se mantenía en rojo solo.** El grep a
ojo encontró 2 de los 3 sitios; la auditoría mecánica encontró el tercero — por eso es un script y
no un párrafo.

Excepción legítima: se **declara** en el código con `// silence-audit: exento — <motivo>` en la
línea previa (sin motivo no vale). Es a propósito: una escotilla que hay que escribir es una que
queda auditada; una auditoría que se puede apagar por config es el patrón que este arnés combate.

```bash
node scripts/controls-bench/silence-audit.js            # audita; sale ≠0 si hay un sitio sin silenciar
node scripts/controls-bench/silence-audit.js --selftest # 8 casos, sus dos direcciones
```

---

## 2. Cadencia, dueño y presupuesto

El plan lo exige escrito ANTES de fijar la cadencia — "el banco tiene horario, dueño y
presupuesto, o es el anti-patrón que combate".

| Capa | Cadencia | Cómo corre | Costo por corrida |
|---|---|---|---|
| runner lado Claude vs baseline | **diaria** (throttle en `install-tycon-hooks.sh`, mismo patrón que la suite del backfill) + manual en cada push que toque un hook | sincrónico en SessionStart, 1×/día | ~45 s de CPU, **$0 en tokens** (86 casos, todo scripts) |
| runner paridad `--tool both` | diaria **solo con `TYCON_CODEX=1`** | background (nohup) desde el instalador | ~90 s de CPU, $0 en tokens |
| live-fire (disparo real) | diaria solo con `TYCON_CODEX=1`; y SIEMPRE que se toque la registración de hooks o el propio banco | background desde el instalador | 1 sesión headless por herramienta: Claude haiku ~10-20K tokens + Codex ~17K tokens (medido) ≈ **centavos/día** |
| `--prove-detection` (autotest) | semanal, o tras tocar runner/live-fire | manual | 1 sesión haiku |
| auditorías del banco sobre sí mismo (`vacuity-audit`, `silence-audit`) | **diaria**, dentro de la tanda de suites en bash | background desde el instalador | ~2 s de CPU, **$0 en tokens** |
| frescura del generador (`build/check.js`) | **diaria** (dentro del bloque bench del instalador) + pre-commit | sincrónico, sin LLM | ~50 ms, $0 — un adapter viejo = Codex corre un advisor desactualizado en silencio |
| casos de advisors (`advisor-runner.js`, B2 — arrancó en C, 20 advisors / 61 casos en D) | **semanal** con `TYCON_CODEX=1` (stamp `controls-bench-advisors-last-run`), y siempre que se toque ese advisor. Regla dura: un advisor no entra a Codex sin sus casos | background desde el instalador · manual al tocar un advisor | medido: ~30K tokens por corrida. La pasada completa de D (61 casos × 2 herramientas, N=1) costó **~3,6M tokens**; con N=3 serían ~11M → por eso la corrida ad-hoc va con `--runs 1` y **la unanimidad N=3 la aporta la cadencia semanal**, que es para lo que existe |
| live-fire-guard (bloqueo real) | semanal junto con los advisors, y SIEMPRE que se toque `safety-guard-pre.sh` o la registración de hooks | manual (Etapa E lo suma al instalador al portar la familia) | 2 sesiones headless ≈ centavos |
| live-fire-stop (block del Stop honrado) | on-demand: es la verificación de una semántica de la herramienta, no un control de regresión — re-correr si cambia la versión de Codex/Claude Code o `on-stop-dod-gate.js` | manual (lado Codex la lanza el dev, misma gobernanza que live-fire-guard) | 4 sesiones headless ≈ centavos |

**Dueño**: quien toque un hook/advisor corre el banco sobre esa pieza antes del commit. El
instalador es el dueño de la corrida diaria; nadie tiene que acordarse.

## 3. Destino del reporte

Los reportes aterrizan en `scripts/controls-bench/.bench/*.json` (local por máquina, gitignored) y
los cobra **`scripts/hooks/bench-notice.js`** al arranque de sesión (SessionStart, mismo mecanismo
que los meters de estilo y bloqueo): si la última corrida dejó rojos —casos fallados, paridad rota
o regresiones vs baseline— lo grita sin que nadie se acuerde de mirar; en verde, silencio total.
Off: `TYCON_BENCH_NOTICE=0`. La corrida diaria: `TYCON_BENCH_DAILY=0`.

## 4. Línea de base Claude

`baseline/claude.json` (hooks) y `baseline/claude-advisors.json` (advisors) — commiteadas —
congelan el veredicto por caso del lado Claude. `--baseline check` (la corrida diaria/semanal)
falla si un caso que era verde se puso rojo o desapareció — así, toda
pieza que la migración reescribe (bloque canónico en A, advisors en D) tiene que seguir verde en
Claude antes de mirar Codex. Re-fijarla (`--baseline write`) es una decisión consciente que viaja
en un commit, no un efecto colateral.

## 5. Agregar un caso / una pieza nueva

Un archivo por familia en `cases/hooks/*.json`; schema: `{hooks:[{hook, script, event, cases:[{id,
type, files?, setup?, env?, stdin, expect}]}]}` con variables `${TCG}`, `${SKILLS}`, `${FIXTURE}`,
`${SANDBOX_HOME}`. Los paths de evidencia bajo `~/.claude/...` se assertan contra
`${SANDBOX_HOME}/.claude/...`. Hooks que resuelven paths por `__dirname` (branch-guard,
retro-staleness, bench-notice) se copian al fixture con `setup` y se apunta `script` a la copia.

Desde la Etapa H, **pieza nueva sin casos = commit rechazado** (`check.js`). Hasta entonces, la
regla es la misma pero manual — este banco es el que la hace barata de cumplir.

### 5.1 Casos de advisor con MCP — `expect_mcp` (decisión 4b, 2026-08-22)

Cuando la tool MCP falta, el advisor **no se detiene ni inventa: sustituye el método por un
comando de consola sin declararlo** (una sonda de la Etapa D — acá lo tapó el sandbox read-only,
no la honestidad del modelo). Un advisor que llega al veredicto correcto por un camino que no
declaró está roto igual, y el veredicto solo no lo nota. Por eso un caso de advisor que depende
de una tool MCP declara además:

```json
"expect_mcp": { "server": "codebase_memory", "tool": "search_graph" }
```

- **codex**: pasa si stdout trae `mcp: <server>/<tool> started`.
- **claude**: la corrida agrega `--output-format stream-json --verbose` y pasa si hay un
  `tool_use` llamado exactamente `mcp__<server>__<tool>` (el veredicto de rule IDs se extrae de
  los bloques de texto del stream).
- **Server no instalado en la máquina** (su `command` no está en el PATH): el caso se **saltea
  dejando constancia** — `skipped_mcp` en el reporte y contador propio en el cierre (`⏭️
  salteados-por-MCP-ausente=N`). Ni verde que miente ni rojo que no significa nada.
- El detector se prueba **sin gastar LLM**: `node scripts/controls-bench/advisor-runner.js
  --selftest-mcp` (outputs reales capturados; el caso negativo ES la sustitución de la sonda D —
  mismo patrón que `--prove-detection` del live-fire).

### 5.2 El caso "apps apagada" — `--check-apps-off` (decisión 3, 2026-08-22)

Codex trae prendida la feature `apps` (~160 tools de servicios externos: mergear PRs, borrar
archivos, mandar mails) y el sandbox de disco no las frena. Los perfiles de advisor la apagan
(`features.apps = false`); el caso que lo verifica es determinista y $0 (una cuota agotada de
Codex no puede dejarlo sin correr): **(a)** estática — los 24 `.toml` declaran la clave ANTES de
la primera tabla, independiente del generador a propósito (si `generate.js` dejara de emitirla,
el `--check` del pre-commit regeneraría sin la clave y "coincidiría" — esto no); **(b)**
comportamiento — `codex debug prompt-input` con y sin el override tienen que salir DISTINTOS
(guardia anti-falso-verde: un `--profile` inexistente devolvía el texto del error, que tampoco
contiene `codex_apps`, y daba 0 igual). La capa LLM (el modelo mismo reporta APPS=NO) quedó 4/4
en los canarios de la Etapa D y viaja implícita en toda corrida codex del banco.

```bash
node scripts/controls-bench/advisor-runner.js --check-apps-off
```

---

**Por qué**: "un control que hay que acordarse de invocar es un control que no corre"
(`packs/bizuit/guides/bizuit-bpmn-spec-contract.md`), aplicado al arnés entero: los controles ahora tienen su propio
control.
