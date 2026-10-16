# Revisores

**Objetivo**: correr los advisors post-implementación sobre el diff resultante de Step 4. A.i: siempre se corren los aplicables al tipo de proyecto, sin flags para saltear.

## Inputs

- `modified_files`: lista de archivos modificados por BMAD (del Step 4)
- `repo_path`: path del repo

## Forma canónica (H17 §4) — `pipeline.js`, NO inferir a mano

**🔴 La AUTORIDAD del set de advisors es el script, no este markdown.** Antes de invocar,
corré:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js advisors \
  --repo <repo_path> --story <story_path> --files <modified_files...>
```

Devuelve JSON con `{ base, completitud, conditional, all, required_count, context_file, batch_rule, packs, story_path_para }`. **Invocá
EXACTAMENTE los advisors de `all`** — no los elijas, no infieras, no cherry-pickees.
El script además:

- **`packs`**: los paquetes de revisores cargados para este repo, con sus revisores.
  Los revisores de un producto o de un cliente (convenciones de plugins Bizuit; plugins hermanos;
  el adaptador de un cliente) no viven en el código del pipeline: viven en `packs/<nombre>/pack.json` de agent-skills
  (o `TYCON_PACKS_DIR`) y entran a `base`/`conditional` según su manifiesto. **El anuncio previo
  los muestra siempre** — y `packs: []` se dice explícito («sin paquetes instalados: corre sólo el
  núcleo»): que el equipo corra sin su paquete se ve en la primera corrida, no al mes. Si el comando
  sale con exit 2 nombrando un archivo, un revisor y un motivo, un paquete está roto o falta: se
  frena y se arregla; no se «sigue sin él».
- **Triggers de contenido sobre líneas AGREGADAS del diff** (`git diff -U0`), no sobre el
  archivo entero — el set típico baja de 10-13 a 6-8 advisors sin perder cobertura real.
- **`context_file`**: digest de story + file list + diff con hunks, generado en
  `~/.claude/.tycon-pipeline/advisor-context/<sid>-iter<N>.md`. Es el **INPUT PRIMARIO**
  de cada advisor — pasalo en el prompt en vez de hacer que cada subagente re-lea todo.
  Los que necesitan la story completa (`story_path_para` de la salida: el spec-first del núcleo
  y los revisores de paquetes con `needsStory`) reciben **además** `story_path`.
- **`context_file_overrides`** (2026-07-28): mapa `{advisor: path}`. **Si un advisor figura
  acá, pasale ESE archivo en vez del `context_file` compartido.** Hoy sólo lo usa
  `tycon-story-validator`: su superficie real es la story, no el diff, así que recibe el
  digest + la lista completa de archivos + **sólo los hunks con marcas de deuda diferida**
  (lo que VAL-C5 necesita). Medido: **-44% de tokens**, y en el A/B encontró un hallazgo MÁS
  que con el contexto completo. Es el ÚNICO recorte por advisor cableado — el recorte general
  se midió y **no paga en .NET** (0% de ahorro: todo el diff es código y le corresponde a
  todos). Evidencia y baseline: `~/.claude/.tycon-pipeline/baseline/`.
- **`reglas_revisores`** — **§Reglas del repo**: el estado de la sección
  `## Reglas para revisores` del `CLAUDE.md` del repo. Con `estado: 'presente'`, el `context_file`
  y cada override **ya empiezan** con esas reglas marcadas como «reglas a verificar» — no hay que
  hacer nada más: los revisores del paso 5 ya no cargan el `CLAUDE.md` (`omitClaudeMd: true`), y
  esas reglas les llegan sólo por acá. **Si el estado NO es `presente`, decíselo al dev en UNA
  línea, una vez por corrida, y seguí**: *«este repo no tiene «Reglas para revisores»: los
  revisores no ven sus reglas propias»* (con `no_medido`, agregá el `motivo`). Nunca frena. Por
  qué pegadas y no leídas del `CLAUDE.md`: con el archivo entero cargado el revisor detectó 10 de
  20 violaciones plantadas; con la sección pegada, 17 de 20 y la mitad de tokens. Cómo se
  escribe la sección: `~/.claude/tycon-harness/guides/reglas-para-revisores.md`.
- **`batch_rule`** (ventana deslizante, 2026-07-30): **MÁXIMO 4 subagentes VIVOS a la
  vez** (máquina dev 8c/16GB — regla explícita acá, no solo en CLAUDE.md global). El cap
  es de CONCURRENCIA, no de orden: al llegar la notificación de que un advisor terminó,
  lanzar el siguiente del set **en ese mismo turno** — no esperar a que termine el grupo
  entero (antes: "tandas" discretas; con 3 advisors de 3 min y uno de 7, la espera por
  tanda dejaba 3 slots ociosos 4 minutos). **NUNCA** el set completo en un solo mensaje
  paralelo si supera 4. `check-count` no depende del orden (valida membership por nombre
  contra `expected[]`), así que la reposición por slot no toca el accounting.

  🔴 **Cap reducido con el 5b en vuelo (Fase B, 2026-07-30)**: si `marker.adversarial`
  existe (visible en el output de `pipeline.js next`, o con `marker.js get`) y **todavía
  no llegó la notificación de término del workflow en esta sesión**, el pase adversarial
  lanzado en el Step 4 sigue corriendo — y ese workflow NO es 1 proceso: son 6 hunters
  concurrentes + verificadores en ventana de 3. Mientras esté vivo, la ventana baja a **MÁXIMO
  2 vivos** (valor conservador A MEDIR — la primera corrida real cuenta procesos pesados
  simultáneos, no solo cronometra, y con esa medición se fija el cap definitivo).

  **La señal de término es la NOTIFICACIÓN del workflow, NO `deepReviewDone`** — ese flag
  lo marca recién el step-05b al procesar el output (después de este step): usarlo como
  condición dejaría el cap en 2 hasta el final aunque el workflow haya terminado hace 20
  minutos. `deepReviewDone` solo sirve como señal en un retome en frío (sesión nueva,
  donde la notificación ya no se puede observar); ahí, si `adversarial_is_ours: false`
  en `pipeline.js next`, el workflow está muerto → cap 4 (y el step-05b va a relanzarlo).

  🔴 **Al llegar la notificación del workflow durante este step**: la ventana vuelve a 4,
  y **en ese mismo turno se escribe el output crudo a `<RUN_DIR>/step-05b-adversarial.md`**
  (`confirmed[]` + `all_lenses[]` + runId). Es el ÚNICO momento en que ese contenido
  existe — una compactación de contexto en un Step 5 largo lo borra del transcript y el
  Step 6 consolidaría sin los findings adversariales sin que nadie se entere. El step-05b
  lo lee de ese archivo, no del transcript. NO procesar los findings acá (eso es del
  step-05b) ni marcar `deepReviewDone`.
- **Persiste `expected[]`** en la línea `step5-start` del log — es contra eso que
  `check-count` valida después.

## Paso PREVIO al fan-out — `mech-check` (determinista, ~ms, 0 tokens)

**ANTES de invocar cualquier subagente**, corré:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js mech-check \
  --repo <repo_path> --story <story_path> [--files <modified_files...>]
```

Checks deterministas: ACCOV-C1 (cada test de la tabla `### Tests` existe — por
Trait/tag/T-ID/nombre), ACCOV-C5 (AC sin test), DEFTR-C1/C2 (deferrals), WIRING-C1
(componente exportado sin uso). Output:

- `findings` **confirmados** → van DIRECTO al reporte consolidado de Step 6, sin advisor.
- `ambiguous` + `llm_escalation` → lista de advisors a invocar SOLO si hay ambiguos.

**Consecuencia (MECH-2, cableado 2026-06-11; recalibrado el mismo día por la
verificación adversarial — antes esto era doc sin wiring y el expected[] igual
exigía los 3 lean)**: `pipeline.js advisors`/`smart-reloop` corren mech-check
inline y DESCUENTAN del set/expected automáticamente:
- `tycon-deferral-tracker`: **iter 1 SIEMPRE corre** (per-item + engram +
  DEFTR-W1..W3 son juicio LLM — el `includes()` global del mech NO los cubre;
  la versión inicial que lo descontaba desde iter 1 lo mataba PERMANENTE,
  regresión CRITICAL atrapada por los verificadores); descontado en iter≥2 si
  DEFTR-* salió sin ambiguos (el delta lo cubre DEFTR-C2 mecánico).
- `tycon-ac-coverage-checker`: ídem — descontado SOLO en iter≥2 (sus checks de
  juicio C2/C3/C6 corren en iter 1; en re-loops el delta lo cubren C1/C5 mecánicos).
- `tycon-feature-wiring-checker`: **NUNCA descontado** — mech solo cubre WIRING-C1;
  los callsites/testids/endpoints sin caller (C2..C5) son del advisor (una acción
  del store sin UI que la llame vive exactamente ahí).
- Si mech-check NO pudo correr (story ilegible → ambiguo familia MECH) → CERO
  descuentos (fail-closed).
El output trae `mech_discounted` + `mech_findings`; los findings confirmados van
DIRECTO al reporte de Step 6. Anunciar el resultado junto al anuncio de la regla B.

Después de que todos devuelvan, en vez del count-check manual (Regla C), corré:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js check-count \
  --repo <repo_path> --story <story_path> --files <modified_files...>
```

`check-count` lee las invocaciones **REALES** de subagents (el hook `on-advisor-run.js` PreToolUse
Task loguea cada uno desde el `step5-start` que marca `advisors`), NO un `--ran` self-reportado —
así el LLM **no puede falsear el conteo** (CF-2 2026-05-21). Valida contra el **`expected[]`
persistido del último `step5-start`** — NO contra "el set completo": un subset legítimo tras
`smart-reloop` pasa, porque el expected de esa iteración ya es el reducido. **FALLA CERRADO
(exit 2) si hay `step5-start` con 0 spawns registrados** — sin log no hay verde. Override
consciente (queda auditable): `--trust-ran --ran a,b,c`. Exit 2 + lista de faltantes → NO avanzar
a Step 6 hasta exit 0. **Verifica la completitud del set de forma mecánica, no por disciplina**.
Residual: nada *fuerza* a invocar `pipeline.js`/correr los advisors — eso lo
cierra la máquina de estados del pipeline.

> ### 🔴 El silencio del registro NO significa "no corrieron" (2026-08-25)
>
> Hay **dos** registros de corridas de advisors y contestan cosas distintas:
>
> | Registro | Quién lo escribe | Qué prueba |
> |---|---|---|
> | `gates.log` (`check=advisors`) | el comando `run-check` — **si alguien lo tipea** | que el gate se corrió |
> | `advisor-runs/<sesión>.jsonl` | el hook, en **cada spawn real** | que los advisors se abrieron de verdad |
>
> El primero es **voluntario**: saltearse el marcador no deja rastro de haberse salteado. Caso
> medido: la corrida del 15-ago dejó **0 entradas** con un reporte consolidado de 6 hallazgos
> reales — o sea, los advisors **sí** corrieron. Por eso **una entrada faltante nunca se reporta
> como incumplimiento sin mirar el registro automático primero**:
>
> ```bash
> node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js advisor-runs --story <id>
> ```
>
> Ese comando lee las dos capas del registro automático: el detalle por spawn (7 días) y el
> **resumen durable** que la poda deja antes de borrar (repos, stories y conteo por advisor, para
> siempre). Desde el 2026-08-25 cada línea lleva `repo` y `story`; lo anterior a esa fecha no los
> tiene y el comando lo dice. **Escribe, nunca bloquea** — medir primero, bloquear después, si
> alguna vez.

> En re-loop (regla D.i): re-corré `pipeline.js advisors` sobre el diff actualizado — el set
> es el mismo (mismo diff → mismo set), así que NO hay excusa para cherry-pick **manual**.
>
> **SPEED-1 (2026-05-27; data-path reparado 2026-06-11) — alternativa determinística**: si querés
> ahorrar advisors cuya surface no fue tocada por los fixes, usá
> `pipeline.js smart-reloop --iter N`. El delta se computa desde **`fileEvents` con
> timestamp** (escritos por `on-edit.js` — fix 2026-06-11: antes el data-path estaba roto
> y degradaba a names-only) con **fallback por mtime de filesystem** para markers sin
> fileEvents, así que cubre también **RE-EDICIONES de archivos ya tocados**. Los `--files`
> se VALIDAN (paths fantasma por shell-quoting → abort exit 2, no fail-open).
> Devuelve `{rerun, skipped}` con razón mecánica por advisor — NO es cherry-pick
> por inferencia LLM, es decisión del script con tabla `ADVISOR_AUDITED_SURFACE` declarada
> en pipeline.js. TODA invocación con `--iter N>1` (smart-reloop, force-full, o `advisors`
> fallback) emite **`reloop_model_hints`**: advisors tier deep (Opus) → **pasar
> `model: sonnet` al Agent() es MANDATORY** — única excepción: el delta toca specs
> (anunciarlo). Persiste `expected=rerun` en el log (coherente con `check-count`).
> Requiere la FOTO de la iteración N-1, que el arnés toma SOLA al lanzar el último revisor de
> esa vuelta (aviso `📸`) — no hay que llamarla. Si el JSON trae `suspect_late_snapshot: true`
> (y su aviso por stderr), esa foto se fechó después del último revisor y tapó código: el delta ya
> se recalculó cortando por el último lanzamiento, así que ESTA vuelta lo incluye.
> Anunciá los `skipped` con razón (regla B verbosity) antes de invocar el set reducido.
> Si sospechás regresión silenciosa → `--force-full-reloop` devuelve set completo.
> Ver SKILL.md §D.i.1 detalle.

## Matriz de triggers — vive en pipeline.js, NO acá

La matriz completa (set base por framework + condicionales por trigger de contenido) vive en
`computeAdvisorSet()` / `computeConditional()` de `pipeline.js` — **única fuente editable**
(anti-CF-1; hay guard test `scripts/tests/test-pipeline-coverage.js` que detecta drift).
Referencia humana de la tabla anterior: este archivo en git history.

## Regla anti-olvido (hard requirement — B+C combinados)

### B — Pre-flight anuncio obligatorio

**Antes** de invocar los advisors, el orquestador DEBE anunciar explícitamente qué advisors va a correr y cuáles se saltean con razón. El anuncio DEBE listar los **3 sets**: base, completitud, condicionales. Sin el anuncio explícito de los 3 sets → bug.

```
Revisores:
  mech-check: X findings confirmados (→ directo a «Hallazgos» sin advisor);
              escala (llm_escalation): tycon-deferral-tracker [o "ninguno"].
  Paquetes: bizuit (3 revisores) · clients (2) [o "packs: [] — SIN paquetes instalados, corre sólo el núcleo";
            si `packs_declarados` no es null: "restringido por el repo a: <lista>" — un [] ahí es «restringido a ninguno», no «ninguno instalado»].
  Base (según stack, hasta 4): los de convenciones del paquete bizuit que aplican (×1-2 en monorepo),
            tycon-plugin-tests-coverage, tycon-plugin-security-basics.
            (tycon-story-validator post-impl pertenece a COMPLETITUD — el JSON del script manda.)
  Completitud: tycon-spec-first-checker [APLICA — Mary+GOLD];
               feature-wiring cuando el diff trae una pantalla (.tsx/.jsx, salvo app Next)
               o un endpoint .cs (mech no cubre C2..C5; no depende de detectar React);
               ac-coverage y deferral-tracker [iter 1 sí (si aplican);
               iter≥2 solo si mech-check los escaló] — citar mech_discounted.
  Condicionales: + signalr-hub-reviewer (matchea **/Hubs/*.cs)
                 + migration-impact-analyzer (database/*.sql)
                 [O "ninguno aplica para este diff" si no hay triggers].
  Skipped: <revisor de paquete> (su condición no se cumplió: no hay .cs) — solo si aplica.
  Total: N advisors a invocar en ventana deslizante de <cap> vivos (<4 | 2 — el pase adversarial está en vuelo>).
```

Si la detección resulta ambigua (ej: monorepo con `.cs` y `.tsx` pero ningún file cambiado en uno de los lados), **preguntar al usuario** qué advisors correr antes de seguir.

### C — Post-flight count check

Después de recibir reportes de todos los advisors invocados, **antes de avanzar a Step 6**, el orquestador DEBE chequear:

```
Revisores, verificación:
  Set base esperado: 4. Ejecutados: <count_base>.
  Set completitud esperado: spec-first + feature-wiring (pantalla o endpoint en el diff); ac-coverage y
  deferral-tracker según iter (1 sí si aplican / ≥2 solo escalados) — el expected[]
  persistido YA viene descontado (mech_discounted), validar contra ese.
  Condicionales esperados según triggers: <list>. Ejecutados: <list>.
  Total esperado: <N> (= expected[] persistido en step5-start). Total ejecutado: <M>.
  Diff: <none / faltan: X, Y, Z>.
```

El "esperado" NO se infiere: es el `expected[]` que `pipeline.js advisors` persistió en la
línea `step5-start` del log — lo mismo que `check-count` valida mecánicamente (un subset
legítimo tras `smart-reloop` es válido porque el expected de esa iteración ya es el reducido).

Si `M < N` (faltan advisors) → **STOP y NO avanzar a Step 6**. Reportar al user qué advisor falta + razón (olvido / técnico). Después invocar el/los faltantes en mensaje paralelo separado, esperar reportes, recontar. Solo avanzar a Step 6 cuando `M == N`.

**Anti-patrones**:

- Invocar advisors "a ojo" sin leer esta tabla saltea alguno (por ejemplo `react-conventions`). Lo cierra la regla B (anuncio explícito).
- Correr sólo el set base y saltear en silencio los de completitud (`tycon-story-validator post-impl`, `tycon-spec-first-checker`, `tycon-deferral-tracker`, `tycon-feature-wiring-checker`). Lo cierran la regla C (count check post-flight) y la sección hard-listed al top de SKILL.md, para no depender de que el agente lea el step-05 completo.

Dejar estos pasos implícitos es causa de bugs silenciosos (bypass de reglas de convenciones + completitud). NO se pueden inferir desde "el set base suficiente" o "esto parece simple". Las 3 reglas A+B+C son no-negociables.

**Anuncio de condicionales**: si un trigger condicional se cumple, agregar al anuncio una línea extra. Ejemplo:

```
Detección: .cs modificados, sin frontend en el diff → set base: dotnet-conventions + tests-coverage + security-basics.
Detección extra: diff incluye `Hubs/NoticesHub.cs` (matchea **/Hubs/*.cs) → + signalr-hub-reviewer.
Detección extra: `Workers/OrderSyncWorker.cs` declara `IHttpClientFactory` → + http-resilience-reviewer.
Set final paralelo: dotnet-conventions + tests-coverage + security-basics + signalr-hub-reviewer + http-resilience-reviewer.
```

Ejemplo Next.js / SaaS multi-tenant (Espinillo2):

```
Detección: package.json tiene "next" + .ts(x) modificados → set base: nextjs-conventions + tests-coverage + security-basics.
Detección extra: diff toca `src/db/schema.ts` y `drizzle/0008_xxx.sql` → + drizzle-migration-reviewer.
Detección extra: diff toca `src/db/repos/lists-repo.ts` (tabla con user_id) y `src/app/lists/actions.ts` → + multi-tenant-isolation-reviewer.
Detección extra: diff toca `src/app/api/auth/[...nextauth]/route.ts` y agrega callbacks → + auth-session-reviewer.
Detección extra: diff toca `src/app/api/compare/[listId]/route.ts` ('use server' / Route Handler) → + nextjs-app-router-security.
Detección extra: diff toca `src/matcher/llm-matcher.ts` (importa @anthropic-ai/sdk) → + llm-cost-reviewer.
Detección extra: diff toca `src/adapters/tienda/tienda-adapter.ts` → + el revisor de ese adaptador, del paquete `clients`.
Set final paralelo: nextjs-conventions (paquete bizuit) + tests-coverage + security-basics + drizzle-migration-reviewer + multi-tenant-isolation-reviewer + auth-session-reviewer + nextjs-app-router-security + llm-cost-reviewer + el revisor del adaptador de la tienda (paquete clients).
```

## Acción — invocación paralela

**Importante — ANTES del primer `Agent(...)`, resolver el CAP de esta corrida**: mirar
`adversarial` en el output de `pipeline.js next` (o `marker.js get`) → si `marker.adversarial`
existe y el workflow sigue en vuelo (ver §Cap reducido arriba), el cap es **2**; si no, **4**.
🔴 **El cap resuelto acá GANA sobre el número del `batch_rule` del script** — el script no conoce
el estado del 5b. Los advisors se invocan con tool calls `Agent(...)` en background (COMM.iii)
bajo **ventana deslizante de `<cap>` vivos**: los primeros `<cap>` salen en un solo mensaje
paralelo; al llegar cada notificación de término se lanza el siguiente del set en ese turno,
manteniendo ≤`<cap>` vivos hasta agotar el set. A cada uno se le pasa el `context_file` como
input primario.

**Avisos al dev bajo ventana deslizante**: con reposición continua no hay "tanda" discreta —
el corte del aviso agrupado es por HITO, no por conteo: UN aviso cuando el set va por la
mitad y UNO al completarse (2 por iteración, fijos). Nunca un mensaje por advisor.

**Opt-in `bmad-code-review` (2026-07-30)**: si el dev pidió code-review para esta story, sus
3 reviewers entran al MISMO pool de slots (≤4 vivos) como si fueran advisors del set — el
permiso de correrlo en paralelo con los advisors TYCON está en `bmad-contract.md` L99.

El set lo devuelve el script. Los cuatro de abajo son el **set de completitud** que arma
`pipeline.js advisors`, y no entran los cuatro siempre: `tycon-story-validator` y
`tycon-spec-first-checker` van siempre que haya story; `tycon-ac-coverage-checker`, sólo si la
story tiene `## Acceptance Criteria` o `### Tests`; `tycon-deferral-tracker`, sólo con bloque
`pipelines:` o skips agregados. Están acá para que sepas qué esperar en `all`, no para que los
agregues a mano. Si alguno NO aparece en `all`, el script lo descontó (condición no cumplida, o
MECH-2 en iter≥2): **no lo invoques igual**.

- `tycon-story-validator` en `phase: post-implementation` para chequear Gate 1 del DoD (VAL-C5 — deferrals abiertos en código + VAL-C6 — pipeline blocked sin `blocked_by` + VAL-W15 — la story no dice lo que se implementó). En los re-loops, el script lo saca del set después de dos veredictos limpios seguidos (ver §«Story-validator post-implementation»).
- `tycon-deferral-tracker` (CRITICAL inmediato) — **iter 1: SIEMPRE que aplique** (per-item + engram + DEFTR-W1..W3 son juicio LLM no mecanizable); **iter≥2: solo si `mech-check` lo escaló** (el descuento del expected lo aplica `pipeline.js` — MECH-2). Las condiciones de aplicación las evalúa el script.
- `tycon-ac-coverage-checker` (CRITICAL inmediato — Gate 1.5) — **iter 1: SIEMPRE que aplique** (ACCOV-C2/C3/C6 son juicio LLM); **iter≥2: solo si `mech-check` lo escaló** (descuento MECH-2 automático en el expected). Por qué: sin él, una story se marca `done` con ACs/Tests sin implementación que sólo detecta una revisión manual.
- `tycon-spec-first-checker` (CRITICAL inmediato — re-check post-implementation) sobre cada story Mary+GOLD. Cierra el loop **código → spec** detectando scope creep no documentado. Ejemplos de lo que atrapa: wiring implementado antes del spec, un error mapping sin AC, un filtro por tenant sin AC, un response shape decidido durante la implementación. El advisor también corre pre-coding en Step 4 — este re-check captura drift residual de coding phases sin pre-flight (spikes, runtime fixes).

### 🔴 Formato de salida de CADA advisor — obligatorio en el prompt (COMM.iii, 2026-07-27)

El usuario VE el bloque que devuelve cada subagente. Sin esta instrucción, seis advisors devuelven seis
reportes de 30+ renglones con rule IDs y `archivo:línea`, uno detrás de otro: un muro. **Todo `Agent(...)`
de este step cierra con este párrafo, con la ruta ya resuelta** (un subagente no puede inventar dónde
escribir; si no le das destino, el detalle vuelve al chat):

```
Formato de tu final report — el mensaje que devolvés, NO el archivo:
arrancá con 1-3 bullets en castellano llano: qué encontraste y si bloquea. Sin rule IDs, sin
archivo:línea, sin nombres de regla. Después, la acción, si la hay, en una línea. El DETALLE
COMPLETO (rule IDs, archivo:línea, tablas, repros) NO va en el reporte: escribilo a
`<RUN_DIR>/step-05-<advisor>.md` y cerrá con "detalle completo en <esa ruta>". Tu reporte
entero tiene que entrar en menos de 1000 caracteres de prosa. Si no hay hallazgos, "limpio,
0 hallazgos" alcanza y no hace falta escribir archivo — no enumeres lo que revisaste y salió bien.
```

`<RUN_DIR>` es `.advisors/pipeline-runs/<clave>-<sello>/`, la ruta que imprime
`pipeline.js run-dir --story <s> --repo <r> --create` (con un número repetido en el repo la clave es
`<tema>__<número>`; armarla a mano parte la corrida en dos carpetas). La regla completa y por qué se endureció
está en el bloque `TYCON_BLOCK:response-style` de `~/.claude/CLAUDE.md` §"Lo que devuelve un SUBAGENTE".

⚠️ **Es la 3ra vez que este problema se da por arreglado** (feedback del dev 2026-07-25, 2026-07-27 y
2026-07-27 otra vez). Las dos veces anteriores la regla vivía SOLO en el `CLAUDE.md` y dependía de que el
orquestador se acordara de copiarla a cada prompt. Por eso ahora vive acá, en el step que lanza el
fan-out: si se olvida, el reporte largo es responsabilidad de quien lo lanzó.

### Diversidad de modelo en la verificación (opt-in — sugerencia 2026-07-02)

**OPT-IN, default OFF.** `bmad-dev-story` cierra con un tip: *"run code-review using a **different**
LLM than the one that implemented"*. La correlación de errores entre implementador y revisor del
MISMO modelo es real: un blind spot del implementador tiende a ser blind spot del revisor si es el
mismo modelo. Los `reloop_model_hints` de TYCON hoy varían el modelo por **costo**, no por
diversidad.

Si el repo declara `advisor_model_diversity: true` en `.tycon/advisors.yaml` (o el user lo pide),
en **iter 1** correr AL MENOS un advisor CRITICAL de detección pura —`tycon-plugin-security-basics`
o `tycon-silent-failure-hunter`— con `model:` distinto al que implementó la story (Step 4). El
mecanismo ya existe (`model:` en `Agent()`); esto es una regla de proceso, no código nuevo.
Anunciarlo en la regla B. **No es mandatory** — se mantiene opt-in a propósito para no inflar la
superficie del pipeline (reglas mandatorias + opt-in mal calibradas degradan).

```
# Arranque de la ventana (<cap> tool calls paralelas en un response — 2 si el 5b está en vuelo;
# con cap 2, los dos primeros son los CRITICAL-inmediatos del set):
Agent(subagent_type: "tycon-plugin-{conventions}", prompt: "context_file: <path>. ...")
Agent(subagent_type: "tycon-plugin-tests-coverage", prompt: "context_file: <path>. ...")
Agent(subagent_type: "tycon-plugin-security-basics", prompt: "context_file: <path>. ...")
Agent(subagent_type: "tycon-story-validator", prompt: "context_file: <path>. post-implementation phase. Validar VAL-C5 (deferrals abiertos del propio story) y VAL-C6 (pipeline blocked sin blocked_by). modified_files: [...]")

# Siguientes (uno por cada notificación de término, manteniendo ≤4 vivos):
Agent(subagent_type: "tycon-spec-first-checker", prompt: "context_file: <path> + story_path, repo_path, modified_files, phase: post-implementation — cross-check diff vs spec. SPEC-C1 (endpoint REST nuevo sin AC), SPEC-C2 (componente UI nuevo sin AC), SPEC-C3 (response shape cambió sin update spec), SPEC-C4 (reinterpretación AC), SPEC-C5 (exception nueva sin AC), SPEC-W1 (TODO update spec en código), SPEC-W2 (spec menciona algo no en código). Fail con CRITICAL si hay scope creep no documentado.")
# + ac-coverage/deferral-tracker: en iter 1 SIEMPRE (si aplican); en iter≥2 SOLO si mech-check los escaló (el expected ya viene descontado):
Agent(subagent_type: "tycon-deferral-tracker", prompt: "context_file: <path> + story_path, repo_path, modified_files, engram_project — resolver los items `ambiguous` del mech-check. Fail con CRITICAL si deuda no documentada.")
Agent(subagent_type: "tycon-ac-coverage-checker", prompt: "context_file: <path> + story_path, repo_path, modified_files — resolver los items `ambiguous` del mech-check (ACCOV-C1 T-N declarado sin test, ACCOV-C2 AC keyword sin match, ACCOV-C3 test tautológico). Fail con CRITICAL si encuentra gap.")
```

### Habilitación condicional del `tycon-deferral-tracker`

**Post-2026-06-09 esta decisión la toma `pipeline.js mech-check`** (`llm_escalation`) — las
condiciones de abajo quedan como documentación del criterio que el script implementa:

1. **Story tiene bloque `pipelines:`**: leer frontmatter de `story_path`. Si tiene `pipelines:`, advisor APLICA.
2. **Diff tiene tests skipped**: grep en `modified_files` con extensiones de test (`.test.ts(x)`, `.spec.ts(x)`, `Tests.cs`, `Test.cs`, `_test.go`) por patrones `it.skip(`, `xit(`, `describe.skip(`, `test.skip(`, `[Fact(Skip=`, `[Theory(Skip=`. Si encuentra ≥1 match, advisor APLICA.

Si ninguna de las dos condiciones se cumple, **el script no lo pone en `all`** y lo anuncia así:

```
Skipped: tycon-deferral-tracker (story sin bloque `pipelines:` y diff sin `*.skip()`).
```

### Habilitación condicional del `tycon-ac-coverage-checker`

**Post-2026-06-09 esta decisión la toma `pipeline.js mech-check`** (`llm_escalation`) — las
condiciones de abajo quedan como documentación del criterio que el script implementa:

1. **Story tiene tabla `### Tests`** en formato Mary+GOLD (busca `^### Tests$` heading + tabla `| T... |` debajo). Si SÍ → advisor APLICA.
2. **Story tiene `## Acceptance Criteria`** con ≥1 AC declarado (cualquier story Mary+GOLD bien-formada). Si SÍ → advisor APLICA.

Si la story no tiene `### Tests` ni `## Acceptance Criteria` (ej: spike de descubrimiento sin formato GOLD), **el script no lo pone en `all`** y lo anuncia así:

```
Skipped: tycon-ac-coverage-checker (story sin tabla `### Tests` ni `## Acceptance Criteria` — formato no-GOLD).
```

Para stories Mary+GOLD estándar el criterio APLICA. La invocación efectiva: **iter 1
siempre** (juicio ACCOV-C2/C3/C6); **iter≥2** la decide `mech-check` vía el descuento
MECH-2 — si los ACCOV del delta se resolvieron mecánicamente (sin `ambiguous`), el advisor
no corre y los findings confirmados van directo a Step 6.

Para cada advisor, pasar en el prompt:
- `context_file` (INPUT PRIMARIO — digest de story + file list + diff con hunks; evita que cada subagente re-lea todo)
- `story_path` además del context_file **solo** para los que necesitan la story completa (la lista `story_path_para` de la salida de `pipeline.js advisors`: el spec-first del núcleo y los revisores de paquetes con `needsStory`)
- `repo_path`
- `modified_files` (para que audite solo lo cambiado, no todo el repo)
- Path a la guía que lee en runtime (ver cada advisor `.md` en `~/.claude/agent-skills/agents/`)
- **Instrucción explícita**: "Cada finding DEBE citar su rule ID entre corchetes según el catálogo en `~/.claude/tycon-harness/guides/advisor-rules-catalog.md`. Formato: `[<RULE-ID>] <file:line> <descripción>. Fix: <acción>.` Sin rule ID no es un finding válido."

### Story-validator post-implementation — VAL-C5, VAL-C6 y VAL-W15

El `tycon-story-validator` corre en **tres momentos** del pipeline:

1. **Step 1 (pre-implementación)**: valida el spec — VAL-C1, VAL-C2, VAL-C3, VAL-C8, VAL-W1..W14. NO chequea VAL-C5 (no hay código aún).
2. **Step 5, vuelta 1 (post-implementación, este step)**: re-corre con `phase: "post-implementation"` para VAL-C5 (deuda de la propia story en el código), VAL-C6 (tanda `blocked` sin causa) y VAL-W15 (la story no dice lo que se implementó). Corre **siempre**.
3. **Re-loops del Step 5 (vuelta 2 en adelante)**: corre **hasta que devuelve dos veredictos limpios seguidos después de implementar**. Desde ahí `pipeline.js advisors`/`smart-reloop` lo saca del set y del `expected` (lo dice en `validador_reloop` y, en `smart-reloop`, en `skipped`) y deja la línea `validador-reloop` en `gates.log`, también cuando decide invocarlo. **No lo lances a mano** si el script lo sacó: es una decisión mecánica, no del orquestador.

   Por qué, medido: después de dos veredictos limpios seguidos, el validador trajo algo nuevo en 2 de 24 lanzamientos, ninguno bloqueante; antes, en 62 de 125. Se sigue invocando si VAL-C5/VAL-C6 encuentran algo sin modelo (`runValidatorChecks`, que corre en cada re-loop), si la conversación no se puede leer, si falta el arnés o el arranque del paso 5, y con `--force-full-reloop`.

   🔴 El descuento lee el renglón `Veredicto:` con que el validador cierra cada informe (`agents/tycon-story-validator.md` §«El último renglón es SIEMPRE el veredicto»). Un informe sin renglón cuenta como «sin veredicto» y **corta la racha**: el validador se vuelve a lanzar.

Prompt template para la corrida post-implementación:

```
Validar la story en {story_path} contra el repo {repo_path} en phase post-implementation.

Files modified/created por la implementación de Story {N}:
- {file1}
- {file2}
- ...

Chequear VAL-C5: scan files for `TODO(Story-{N}-deferral)`, `FIXME: Story {N}`,
`HACK: Story {N}`, `[DEF-{N}-`, `DEFERRED-{N}`, `Story {N} deferred`,
`pendiente Story {N}` patterns. Si encuentra match → CRITICAL.

Excluir tasks/todo.md (cross-ref legítimo) + TODOs que referencian OTRA story
(dependency cruzada documentada).

Chequear VAL-W15: la story dice lo que se implementó (archivos declarados, conteo de
tests contra la tabla y el código, tareas, Dev Agent Record).

Reportar con rule IDs según `~/.claude/tycon-harness/guides/advisor-rules-catalog.md`.
Cerrar el informe con el renglón `Veredicto:` (limpio, o hallazgos con sus reglas y si bloquea).
```

## Esperar resultados

Los 3 subagentes devuelven sus reportes. Cada uno tiene su formato definido en su `.md`.

## Decisiones

- **Si algún advisor falla técnicamente** (timeout, error): registrarlo, continuar con los que sí corrieron. El reporte consolidado en Step 6 va a mostrar qué advisor falló y el usuario decide si proceder o re-correr.

- **A.i — no se saltean advisors a pedido**: si el usuario querría saltear un advisor específico, tiene que modificar el pipeline o pedir al dev que mantiene los advisors que ajuste la regla. No hay flag `--skip-advisor=X` en Camino B.

## Registrar check advisors — SIEMPRE (era sólo autónomo; desde 2026-08-19 es pre-condición de `complete-step 5`)

En TODOS los modos (autónomo y HITL). `marker.js complete-step 5` **bloquea** si `checks.advisors` no está en verde con provenance `run-check` **de esta iteración** (tras un loop D.i hay que re-correrlo; `--trust-ran` queda como `trust-ran` y no alcanza). Escape consciente y logueado: `set-check advisors green --force-manual`.

El check `advisors` mide **completitud del set** (¿corrieron TODOS los advisors esperados?), NO los findings. El status sale del exit code REAL de `pipeline.js check-count` — que lee el log de invocaciones reales (CF-2), no el `--ran` del LLM:

```bash
# run-check ejecuta check-count, captura su exit code REAL y setea el check él mismo
# (provenance=run-check, queda en gates.log — set-check directo es solo excepciones):
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js run-check advisors -- \
  node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js check-count \
  --repo <repo_path> --story <story_path> --files <modified_files...>
```

🔴 Si `advisors` queda `red:...`, el Stop-hook DoD gate bloquea el cierre → el agente corre los advisors faltantes y re-registra. **Los findings (CRITICAL/WARNING) NO ponen este check en rojo** — esos son decisión humana en Step 7 (waive/fix), no loop mecánico. El gate no traba la pausa HITL de Step 7 porque `advisors` ya está `green` (corrieron todos).

## Cierre del step

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js complete-step 5   # bloquea sin run-check advisors verde de esta iteración
```

🔴 **La foto de la iteración NO va acá.** Se toma sola al lanzar el último revisor (aviso `📸`), que
es el único momento correcto: entre ese lanzamiento y el primer arreglo no se toca código. **No la
repitas después de arreglar**: si la llamás con código editado, se niega o conserva la anterior y lo
deja en `gates.log`. Sólo si el aviso no apareció (foto automática apagada) corré `snapshot-iter N`
— antes de tocar código. Una llamada de más pisa las fotos automáticas de la corrida.

## Output de este step

- Reportes individuales de cada advisor (formato markdown definido en cada agent `.md`)
- Metadata: tiempo total, advisor que corrió, advisor que falló

Pasar al Step 6 para consolidar.
