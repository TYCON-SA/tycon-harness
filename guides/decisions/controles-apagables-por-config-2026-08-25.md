---
estado: COMPLETO — las 5 tandas (0 a 4), hechas
origen: auditoría del 2026-08-25
decide: el dev
---


# Plan de auditoría del arnés — 2026-08-25

> **Para quien decide.** Cada punto arranca con **qué se rompe en la práctica**. El detalle técnico
> viene después, en letra chica. No hace falta leer el detalle para decidir.

---

## El hallazgo de fondo, en una frase

**Casi todos los frenos automáticos del arnés se pueden desactivar editando un archivo de
configuración que ellos mismos no miran** — y como el archivo no es código, tampoco dispara a los
revisores automáticos ni al freno de commit. El resultado no es un error: es **silencio**. Todo sale
verde y nadie se entera de que el control no corrió.

Se barrieron 4 superficies (el orquestador del pipeline, los revisores automáticos, los hooks del
arnés y los 13 repos del equipo). **11 casos confirmados con reproducción real** en laboratorios
aislados y clones locales de los repos; **7 candidatos descartados** (5 de ellos por no ser este
patrón, pero **3 dejaron una acción concreta igual**).

Lo que sigue es el plan.

Aparte, el **Tema 2** (que las corridas de revisores automáticos dejen rastro) tiene recomendación
cerrada y es la acción con mejor relación valor/riesgo de todo el documento.

---

## Tabla de decisión — todo lo confirmado, ordenado por impacto

| # | Qué se rompe en la práctica | Gravedad | ¿Pasa hoy? | Costo del arreglo | Estado |
|---|---|---|---|---|---|
| **C1** | Editar un archivo de config (sin siquiera guardarlo en el historial) **apaga el freno que impide cerrar una story sin evidencia** — las dos capas, la del commit y la de la edición | 🔴 Alta | Latente, activable en 1 línea | Bajo (~100 líneas, 3 archivos) | ✅ **HECHO** (FIX-1) |
| **C2** | Una palabra (`off`) en un archivo suelto apaga **dos** frenos, y el segundo no está documentado en ningún lado | 🔴 Alta | Latente (ningún repo lo usa hoy) | Bajo + **1 decisión de diseño** | ✅ **HECHO** (FIX-2, D1) |
| **C3** | Declarar un repo "hermano" hace que la evidencia de OTRO repo cuente como propia; ya pasó y está documentado en un repo real | 🟠 Media-alta | Sí, con atenuante | Bajo (~40 líneas) | ✅ **HECHO** (FIX-1) |
| **C4** | El control que vigila que "toda pieza nueva entre con sus pruebas" **no puede ver las piezas nuevas**: se fija en listas escritas a mano | 🟠 Media-alta | Sí | Bajo + **arranque escalonado** | ✅ **HECHO** (FIX-7, D3) |
| **C5** | Tocar el script que ejecuta las pruebas de navegador **no dispara esas pruebas** | 🟠 Media | Sí, en 3 repos | 2 líneas | ✅ **HECHO** |
| **C6** | El arnés declara como "superficie vigilada" archivos que su propia selección **no puede entregar nunca** (config de plugins, secretos, dependencias) | 🟡 Media-baja | Sí | Bajo (~145 líneas en total) | ✅ **HECHO** (FIX-4 a/b/c) |
| **C7** | Cambiar el mapa de navegación de la app **no vuelve a revisar** las pantallas ya escritas | 🟡 Media-baja | Sí | Bajo (~30 líneas) | ✅ **HECHO** (FIX-8) |
| **C8** | `qa_guide: off` apaga el aviso de guía de pruebas — y el mismo texto **puesto por error en el lugar equivocado apaga igual** | 🟢 Baja (es aviso, no freno) | Latente | Muy bajo (~10 líneas) | ✅ **HECHO** (partes 1 y 2) |
| **Tema 2** | No se podía contestar mecánicamente "¿corrieron los revisores de la story X?": el registro voluntario sin repo (142/149) y el automático sin repo ni story, borrado a los 7 días | 🟠 Media-alta | Sí | Bajo (~230 líneas) | ✅ **HECHO** |
| **C9** | Sacar un nombre de carpeta de la config apaga la exigencia de prueba de navegador para esa app | 🟢 Baja | Latente | **Cero** (sale gratis con C1) | ✅ **HECHO** (FIX-1) |
| **C10** | Un recordatorio de "compilá antes de verificar" queda pegado pidiendo un comando que ya no existe | ⚪ Muy baja | Sí, se auto-cura | Muy bajo (~8 líneas) | ✅ **HECHO** |

**Total del código nuevo**: ~350-400 líneas repartidas en ~10 archivos, más ~30 casos de prueba en el
banco de controles. **Costo por commit**: prácticamente nulo (ver cada ítem). **Decisiones que
necesitan al dev**: 3, listadas al final del §4.

---

## 1. Qué se confirmó

### C1 — El freno de "no cierres una story sin evidencia" se apaga editando un archivo que él no mira 🔴

**Qué se rompe hoy.** El arnés tiene dos frenos que impiden marcar una story como terminada sin dejar
evidencia de que se probó: uno al intentar commitear y otro al intentar editar la story. **Los dos
consultan un archivo de configuración del repo para saber qué archivos son stories.** Ese archivo se
lee **como está en la carpeta de trabajo** — o sea, alcanza con escribirlo, sin guardarlo en el
historial de git y sin que quede rastro en ningún commit. Si ese archivo dice que las stories se
llaman de otra manera, **ninguna story es una story** y los dos frenos dejan de existir en silencio.

Esto es exactamente lo que el arnés ya decidió NO permitir en un freno hermano: el código que lee la
llave `pipeline.story_gate` la busca **en la última versión guardada** y su comentario explica por
qué: *"si apagarlo fuera un Write a un yaml, el agente lo apagaría en un turno"*. Esa disciplina no
se extendió al resto de las llaves que apagan frenos.

<details><summary>Detalle técnico</summary>

- Capa 1: `on-pre-commit.js:781` (`selectStorySpecs`). Capa 2: `on-frontmatter-write.js:244`. Las dos
  vía `lib/story-discovery.js:141`, que lee `.tycon/advisors.yaml → stories.id_pattern` del working tree.
- **Reproducción** (repo de laboratorio en `scratchpad/adv/lab1`, una story pasando a `done` sin
  evidencia, `HOME` aislado): sin el yaml → bloquea (`exit 2`, *"🚨 BLOQUEADO — evidencia de cierre
  faltante"*). Con `stories.id_pattern: '^ZZZ-[0-9]+$'` escrito **sólo en la carpeta, sin stagear** →
  `exit 0`, cero mensajes. Idéntico para la capa de edición.
- Nada ejerce ese archivo: `.tycon` está en `NEVER_CODE_SEGMENTS` (`lib/story-gate.js:88-91`), así que
  no cuenta como código; y la primera línea de `selectStorySpecs` es `if (!f.endsWith('.md')) return false`
  — un `.yaml` **no puede** entrar nunca a la selección.
- **Arreglo (FIX-1)**: función `storiesConfigForGate(repoRoot)` que lea **la última versión guardada Y
  la de la carpeta**, y use la **unión** (una story se gatea si matchea cualquiera de los dos
  patrones), con aviso ruidoso cuando difieren. **La unión, no "manda lo guardado"**: el commit que
  *introduce* un patrón nuevo (medido en el backend de un producto: uno así hace visibles 18 stories `AP-*`/`CO-*`)
  dejaría esas stories fuera del freno justo en ese commit. Se cambian 2 puntos de llamada; el tercero
  (descubrimiento de stories, `story-discovery.js:350`) **no se toca** — ahí mirar la carpeta es lo correcto.
- **Costo**: ~80-120 líneas en 3 archivos + 6-8 casos de prueba. Runtime: una lectura de git (~10ms) que
  el freno hermano ya paga y se puede compartir. El comportamiento sólo cambia cuando la carpeta difiere
  de lo guardado: medido, `.tycon/` se toca entre **2 y 15 veces cada 6 meses** por repo
  (el repo del framework, 2/125 commits · CeiboFrontEnd 5/730 · Totora/Backend 15/440 · URUTAU/FrontEnd 2/44).
</details>

---

### C2 — Un archivo de una palabra apaga dos frenos, y el segundo no está documentado 🔴

**Qué se rompe hoy.** Existe una escotilla de emergencia: un archivo suelto con la palabra `off`
apaga el control que exige "la prueba antes que el código". **Lo que nadie escribió en ningún lado
es que ese mismo `off` apaga también, de yapa, el control de evidencia de la story completo** — el
que avisa "estos criterios de aceptación no están verificados". Un dev que apaga lo primero se lleva
lo segundo puesto sin saberlo. Y el archivo, otra vez, se lee de la carpeta: no hace falta commitearlo.

**Impacto hoy: bajo, riesgo latente alto.** Ningún repo del equipo tiene ese archivo (verificado con
un barrido de `~/SourceCode`), así que todos están en el modo por defecto. Es una escotilla sin usar
— pero abierta y con más alcance del que dice su nombre.

<details><summary>Detalle técnico</summary>

- `.tycon/atdd-gate` con `block|off`, leído por `resolveMode` (`lib/atdd-commit-gate.js:120`) del working
  tree. El modo resuelto se pasa tal cual a `computeStoryEvidenceGate` — de ahí la herencia no documentada.
- **Reproducción**: baseline → aviso `⚠ tycon-story-evidence` con 3 viñetas + bloqueo de evidencia de
  cierre. Con `echo off > .tycon/atdd-gate` **sin commitear** → `tycon-story-evidence` desaparece por
  completo (el bloqueo de cierre sobrevive). Con `block` → pasa de aviso a **bloqueo** antes de llegar al
  otro freno. Crear ese archivo tampoco genera evento de implementación (`.tycon` está en
  `NEVER_CODE_SEGMENTS` y los archivos sin extensión no están en `CODE_EXTS`).
- **Arreglo (FIX-2)**: (a) leer el archivo de la última versión guardada, igual que el freno hermano;
  (b) **separar los dos modos**, dándole al control de evidencia su propia llave.
- **Costo**: ~30 líneas + 3 casos, pero **(b) es una decisión de diseño, no una línea** — ver §4.
</details>

---

### C3 — La evidencia de un repo hermano puede contarse como propia 🟠

**Qué se rompe hoy.** Hay una llave de configuración que permite decir *"la evidencia de esta story
puede estar en el repo de al lado"* — necesaria y legítima cuando la story vive en el backend y la
prueba de navegador corre en el frontend. El problema es que **agregar un hermano afloja el control,
y ese aflojamiento se puede escribir en la carpeta sin commitear ni pasar por ninguna revisión.**

**Atenuante importante (corrige al candidato original): el verde falso NO se completa hoy.** Una capa
posterior recalcula en vivo qué criterios de aceptación se probaron y sigue bloqueando con *"🔴 SIN
CORRER"*. Lo que sí se rompe son las dos capas anteriores. Y el riesgo es real y ya ocurrió: la config
de Totora documenta a mano que *"Backend NO se declara: sus ids de story colisionan — la matriz le
atribuía evidencia ajena"*.

<details><summary>Detalle técnico</summary>

- `.tycon/advisors.yaml → evidence.companion_repos`, `lib/evidence-config.js`.
- **Reproducción**: sin hermano declarado, el freno corta con motivo `no-evidence`. Con el hermano
  declarado en la carpeta, `productEvidenceRoots` devuelve los dos repos y la **evidencia ajena se
  encuentra** — el mensaje pasa a *"Evidencia encontrada: `<sibling>/.advisors/dod-runtime/1.1-...md`"*.
  Un hermano con registro completo de pruebas sí satisface también la capa que hoy ataja.
- **Arreglo (parte de FIX-1)**: `parseEvidenceConfig` en modo freno lee de la última versión guardada.
  Acá **sí** corresponde "manda lo guardado": declarar un hermano **afloja**, y aflojar tiene que estar
  commiteado. 1 función + 3 puntos de llamada (`on-pre-commit.js:56,:279` · `on-frontmatter-write.js:179`).
- **Complemento barato y de alto valor**: el reporte de matriz de runtime ya avisa cuando el bloque
  `evidence:` existe y no aporta nada; extender ese aviso a *"la evidencia de esta story la aportó un
  repo hermano"*, para que la atribución cruzada **se vea** en vez de pasar como verde.
- **Efecto de borde a documentar**: Totora/Backend y Ceibo **dependen** de esta llave para no dar rojo
  falso. Leer de lo guardado es seguro ahí (ya está commiteado), pero **el primer commit que declare un
  hermano nuevo dará rojo hasta commitearlo**. Es la dirección correcta de falla; hay que decirlo en el
  mensaje del freno.
- **Costo**: ~40 líneas + 3 casos. Cero costo por commit.
</details>

---

### C4 — El control que vigila los controles no puede ver lo que hay que vigilar 🟠

**Qué se rompe hoy.** El arnés tiene una regla explícita: *"una pieza nueva entra CON sus casos de
prueba o no entra"*. El control que la hace cumplir **compara contra listas escritas a mano**. O sea:
sólo puede detectar las piezas que alguien ya se acordó de anotar — justamente lo contrario del caso
que la regla existe para atrapar. Además, **el propio control no se dispara cuando se edita su propia
lista de disparo**: se puede recortar esa lista y commitear el recorte sin que el control corra.

**Medido durante esta consolidación: 11 scripts de hooks que existen en disco no aparecen nombrados
en ningún caso del banco de pruebas** — 7 de ellos son frenos del pipeline que sí bloquean
(`on-frontmatter-write.js`, `on-dod-evidence-guard.js`, `on-story-gate.js`, `on-atdd-preedit.js`,
`on-edit.js`, `on-write-collision.js`, `on-planning-artifact.js`). Ése es el tamaño de la deuda del
día uno y **es la razón por la que este arreglo necesita arranque escalonado, no un interruptor**.

<details><summary>Detalle técnico</summary>

- `.githooks/pre-commit` de `tycon-claude-guides`, línea 24:
  `RELEVANTES='^(adapters/|build/|scripts/controls-bench/cases/|agents/)'`. Sin match → `exit 0` sin
  correr `build/check.js` (cuyo control #3 es la regla "entra con sus casos").
- **Reproducción** (clon local del repo real con `core.hooksPath=.githooks`): (A) commit que agrega
  `scripts/hooks/nuevo-control.js` → `exit 0`, el control no corrió. (B) commit que **recorta la propia
  lista** a `^(adapters/)` → `exit 0`, commiteado.
- Los tres enumeradores de `build/check.js` son (a) los casos del banco, (b) `adapters/codex/hooks.json`,
  (c) el manifiesto de revisores automáticos. **Ninguno recorre `scripts/hooks/` en disco**.
- **Corrección al candidato original**: `agents/` en esa lista es una **rama muerta** — no existe
  `agents/` en ese repo (los revisores canónicos viven en `~/.claude/agent-skills/agents`). El
  pre-commit de AgentSkills cubre `agents/*.md` y **hereda el mismo hueco** para los `on-*.js`.
- **Arreglo (FIX-7)**: (1) ampliar la lista a `\.githooks/`, `^scripts/hooks/`,
  `^scripts/install-tycon-hooks\.sh`, `^scripts/controls-bench/` y sacar (o documentar) `agents/`;
  (2) lo importante: que el verificador de registro **enumere `scripts/hooks/*.{js,sh}` en disco** y
  falle con *"hook sin casos en el banco"*.
- **Costo**: 1 línea + ~40 líneas + 2 casos. El control tarda ~2s y pasaría a correr en los commits que
  tocan hooks — el público correcto. **Arranque**: con 11 scripts sin casos, entrar con una lista de deuda
  declarada (mismo patrón `pending_e2`/`divergences` que ya usa el registro de Codex), no bloqueando a todos.
</details>

---

### C5 — Tocar el script que corre las pruebas de navegador no dispara esas pruebas 🟠

**Qué se rompe hoy.** Cada repo puede declarar su propio script para correr las pruebas de punta a
punta (las que manejan un navegador de verdad). **Ese script no está en la lista de "archivos
compartidos"**, así que un commit que lo modifica no selecciona ninguna app y sale el aviso *"ninguna
de las apps declaradas fue tocada"*. Se puede romper el ejecutor de las pruebas sin que ninguna prueba
corra.

<details><summary>Detalle técnico</summary>

- `selectE2eApps` (`pipeline.js:320`); la lista `propios` (`pipeline.js:414`) ya incluye
  `.tycon/advisors.yaml` y el manifiesto de specs críticos (fix del 2026-08-24) pero **no** `cfg.gate`.
- **Reproducción**: sandbox → `--changed scripts/e2e-gate.sh` da `[]` + aviso; en el mismo repo
  `--changed .tycon/advisors.yaml` da `[app]` y `--changed app/src/x.tsx` da `[app]`. Contra repos reales:
  El repo del framework `[]` · URUTAU/FrontEnd `[]` · Ceibo/CeiboFrontEnd `[CeiboFrontEnd]` **por accidente**
  (declara `frontend_dir: .`, así que cualquier cambio la selecciona). Son exactamente los 3 repos con
  script propio.
- **Arreglo (FIX-6)**: sumar el script propio a `propios` cuando no es el default del arnés. **Mejor y
  más barato de mantener**: cambiar `propios` de rutas exactas a **prefijos** y usar `.tycon/` entero + el
  script. Así una precondición, un manifiesto nuevo o cualquier config futura entran **sin que nadie se
  acuerde de agregarlos** — que es el modo de falla que documenta ese fix del 2026-08-24.
- **Costo**: 2 líneas + 1 caso. Costo por commit medible pero despreciable: **~7 corridas extra de suite
  en 6 meses en todo el equipo** (el repo del framework, 2 · CeiboFrontEnd 4 · URUTAU 1 · Totora/Backend 0).
</details>

---

### C6 — El arnés dice vigilar archivos que su propia selección no puede entregar nunca 🟡

**Qué se rompe hoy.** El arnés publica una tabla de "superficie vigilada" que incluye la config de
plugins, los archivos de settings de .NET y los `.env`. **Esos archivos nunca llegan a los revisores
automáticos**: un commit que sólo toca archivos de configuración se clasifica como "sólo documentación"
y el set de revisores queda vacío. Es una contradicción interna: la tabla promete algo que la selección
no puede cumplir. En criollo: **reglas escritas sobre secretos, cadenas de conexión y settings faltantes
existen, están documentadas, y no pueden dispararse por su propio objeto.**

Tres variantes del mismo hueco:

1. **Dependencias** — cambiar una dependencia de `package.json` no dispara nada, y hay una regla cuyo
   objeto de auditoría **es literalmente ese archivo** (REACT-W14).
2. **Config de plugins y secretos** — `plugin.json`, `appsettings*.json`, `.env*` → 0 revisores.
   Reglas afectadas: DOTNET-C6 (un setting usado en código y faltante en el ejemplo → **en producción
   resuelve a nulo en silencio**), DOTNET-W7, DOTNET-W10; y SEC-C2/C8/C9 (secretos, cadenas de conexión,
   fallbacks silenciosos).
3. **La config de un revisor concreto** (el que verifica que las pruebas de navegador sean de verdad):
   una de sus llaves es el **interruptor total** de una regla crítica y otra **afloja dos reglas
   críticas**. Editarlas no ejerce nada. Y la que afloja **ni siquiera figura en el catálogo de reglas**.

<details><summary>Detalle técnico</summary>

- `detectStack()` (`pipeline.js:475`) + `computeBase()`: un diff de sólo `package.json` es `onlyDocs: true`
  → `[]`. Reproducido: `--files package.json` en un repo con react y next → `required_count: 0` con
  `detection: {hasNext:true, hasReact:true, onlyDocs:true}` (leyó el stack **de ese mismo archivo** y no
  seleccionó nada). `--files plugin.json` → 0. `--files appsettings.json` → 0.
  `--files .tycon/advisors.yaml` → 0.
- **Corrección al candidato original**: las reglas .NET afectadas **no** son W9/W10 sino DOTNET-C6/W7/W10.
- **Arreglo (FIX-4)**, en tres piezas independientes:
  - (a) **Disparador acotado por dependencias**: seleccionar **un** revisor de convenciones sólo cuando el
    diff de un `package.json` toca una **línea de dependencia** (`^[+-]\s*"<pkg>"\s*:` dentro de
    `dependencies`/`peerDependencies`/`devDependencies`), no cuando cambia la versión o un script.
    **Medido en CeiboFrontEnd, 6 meses: 730 commits, 115 tocan `package.json` (16% — meter el set base ahí
    sería caro), pero sólo 8 cambian una línea de dependencia (7% de esos) y sólo 3 tocan react/next.**
    O sea ~1% de los commits, con 1 revisor extra. ~40 líneas + 3 casos.
  - (b) **Rama de superficie de config**: `plugin.json`/`plugin.json.example` → revisor .NET;
    `appsettings*.json`/`.env*` → revisor de seguridad. **Un** revisor por tipo, no el set base.
    Esto **no agrega reglas nuevas: hace verdadera una declaración que el arnés ya publica.** ~25 líneas + 4 casos.
    Vigilar un repo que regenere `appsettings` en cada build (mitigable excluyendo el `.Development.json` local).
  - (c) **`pipeline.js lint-config`**: chequeo determinístico (sin modelo, ~50ms, cero tokens) disparado por
    editar `.tycon/advisors.yaml`. Verifica: llaves desconocidas, un patrón de "costura de desarrollo" que ya
    no matchea nada del repo (o sea, **regla muerta sin que nadie se entere**), y una lista de exclusiones que
    **crece** — que es el diff que hay que mirar. ~80 líneas + tests. Se dispara en ~1-3% de los commits.
  - (d) **10 minutos, gratis**: documentar `business_endpoint_excludes` en `advisor-rules-catalog.md`
    junto a REAL-C2/C7. Hoy afloja dos reglas críticas y **no figura**.
</details>

---

### C7 — Cambiar el mapa de navegación no vuelve a revisar las pantallas ya escritas 🟡

**Qué se rompe hoy.** Hay una regla que compara el layout y la navegación del código contra el
documento de arquitectura de información del repo. La revisión funciona en un solo sentido:
**código nuevo → se compara contra el documento**. Al revés no: si el documento cambia, el código ya
escrito **no se vuelve a revisar nunca**. La mitigación que existe no cierra el hueco: sólo se dispara
al **crear** el documento, no al **editarlo**; es un aviso que nunca bloquea; y pide otra cosa (declarar
qué reconcilia), no volver a correr la regla.

<details><summary>Detalle técnico</summary>

- WIRING-C5 / `tycon-feature-wiring-checker`. Reproducido: `--files specs/planning-artifacts/navigation-map.md`
  → `required_count: 0`. `on-planning-artifact.js` arranca con
  `if (!event || event.tool_name !== 'Write') return null` y cierra con `process.exit(0) // advisory`.
- **Arreglo (FIX-8), opción barata y recomendada**: que el hook dispare también en `Edit` y, cuando el
  documento cambia, **deje una marca** en `.advisors/` que el freno de cierre de la próxima story de
  interfaz lea: *"el modelo de navegación cambió después del último layout auditado"*. ~30 líneas + 2 casos,
  cero revisores extra.
- **Opción cara, no recomendada**: seleccionar el revisor cuando el diff toca el documento → un revisor caro
  sobre código que el commit no tocó = ruido probable.
</details>

---

### C8 — `qa_guide: off` apaga un aviso, y apaga igual si está mal puesto 🟢

**Qué se rompe hoy.** Poner `qa_guide: off` hace desaparecer el aviso de guía de pruebas manuales y,
además, **un tercio del aviso de evidencia de story** (la viñeta *"sin pasos de tester"*). Lo peor no es
el apagado deliberado sino que **el mismo texto anidado por error, dentro de otro bloque, apaga
exactamente igual** — porque la búsqueda ignora la indentación. Un error de tipeo es indistinguible de
una decisión.

**Corrección al candidato original**: no "apaga los dos chequeos de una". Apaga uno entero y un tercio
del otro, y **ninguno de los dos bloquea** en el modo por defecto (salen como aviso).

<details><summary>Detalle técnico</summary>

- `on-pre-commit.js:670` y `:734`; `qaGuideMode` en `lib/atdd-commit-gate.js:216` usa `/^\s*qa_guide\s*:.../mi`.
- Reproducido en las tres variantes (ausente / top-level / anidado dentro de `e2e:`) con efecto idéntico.
- **Arreglo**: (1) anclar la búsqueda al primer nivel (`/^qa_guide\s*:/m`); (2) sumar la llave a la lectura
  desde lo guardado de FIX-1. ~10 líneas + 2 casos (uno: *"anidado NO apaga"*).
- **Riesgo de regresión: cero** — verificado que ninguno de los 13 archivos de config del equipo declara la llave.
</details>

---

### C9 — Sacar un nombre de carpeta apaga la exigencia de prueba de navegador 🟢

**Qué se rompe hoy.** El detector de "esta story toca la interfaz" (que es el que exige prueba de
navegador real y prohíbe cerrar el chequeo a mano) clasifica por la **ruta** de los archivos, sumando
nombres de carpeta que declara cada repo. Sacar un nombre de esa lista apaga la exigencia para esa app.

**Techo del daño acotado**: los nombres **suman, nunca restan** — la señal genérica (rutas tipo
`frontend`, `src/app/`, `src/components/`, y extensiones `.tsx/.jsx/.vue/.svelte`) cubre la mayoría.
El daño se limita a **carpetas con nombres no adivinables** (`ceibo-deposito`, `totora-encargos`, etc.).

**Arreglo: ninguno propio.** Entra gratis en FIX-1 y no vale la pena más. Es la prioridad más baja de
la familia.

---

### C10 — Un recordatorio queda pidiendo un comando que ya no existe ⚪

**Qué se rompe hoy.** El recordatorio de "compilá el frontend antes de pedir verificación visual"
guarda el comando **del momento en que se marcó**. Si después se cambia el comando en la config, correr
el comando nuevo y correcto **no limpia la marca**, y el recordatorio sigue pidiendo el viejo.

**No deja pasar nada malo** — es ruido que se auto-cura en la próxima edición de un componente. Se
reporta por completitud de la superficie, no como acción. Arreglo: releer la config y comparar contra el
comando actual (~8 líneas + 1 caso). Único repo del equipo con esta config: Ceibo/CeiboFrontEnd.

---

## 2. Qué se descartó, y por qué

> **Esta sección vale lo mismo que la anterior.** Está para que nadie vuelva a auditar esto en tres
> meses — y porque **3 de los 7 descartados dejaron una acción concreta igual**.

| Candidato | Veredicto | ¿Deja acción? |
|---|---|---|
| **Config anidada que se traga llaves desconocidas** (URUTAU) | **No es el patrón** — el lector relee el archivo entero, no tiene zona ciega. **Pero el bug es real y está reproducido.** | ✅ **Sí** — FIX-3 (arnés, ~20 líneas) + config de URUTAU (15 min) |
| **Lista de pruebas críticas de URUTAU** | **Duplicado** del anterior, contado desde el otro extremo | ✅ mismo FIX-3 |
| **Selección de apps en URUTAU** | **Refutado en su afirmación central**: medido, la config **sí** está cubierta por su propia selección. Lo que hay es una **mala configuración del repo**, no una zona ciega | ✅ **Sí** — config del repo, 15 min, cero código |
| **Detector de "tenés pruebas y no declaraste ejecutor"** (Ebano) | **No es el patrón** — camina el repo entero en cada corrida. Tiene un patrón de búsqueda demasiado angosto | ✅ **Sí** — FIX-5, **1 línea** |
| **Lista `advisors:` en los 5 archivos de Bigua** | **No es el patrón** — es **config muerta**: ninguna parte del arnés lee esa llave. El modo de falla es humano (creer que el repo está configurado) | ✅ **Sí** — lo cubre el `lint-config` de FIX-4 |
| **Pruebas críticas en el repo del framework** | **Refutado**: la config **sí** está cubierta. Lo que hay es config **ausente** | ✅ **Sí** — config del repo |
| **Recordatorio de compilación en Ceibo** | **Duplicado exacto** de C10 | — |

**Los tres hechos que quedan del descarte, con su gravedad real:**

1. **URUTAU/FrontEnd tiene las pruebas de un formulario apuntando al otro.** El bloque anidado por
   error hace que la lista de pruebas críticas de un formulario se use para el otro, donde ese archivo
   no existe. **La falla es ruidosa, no un verde falso**: el merge a main aborta con "no tests found".
   Además el primero tiene sus propias pruebas de navegador y **no se corren nunca**, y los archivos
   compartidos entre los dos formularios no seleccionan nada. Es el mismo bug que ya se arregló en
   otro producto, con el arreglo disponible desde 2026-08-15 y **no adoptado**. *Acción: config del repo,
   15 minutos, cero código de arnés.*
2. **El repo del framework no tiene lista de pruebas críticas declarada**, así que **ningún E2E frena el
   merge a main**. *Acción: declarar la lista apuntando a los specs de `custom-forms/runtime-app/tests/e2e/`.*
   (La parte de archivos compartidos pesa poco: el repo no tiene workspaces y consume el SDK por versión
   publicada.)
3. **Ebano/EbanoPluginfrontend tiene 9 pruebas de navegador reales y el arnés no lo detecta**
   — el patrón exige la carpeta `tests/e2e/` y el repo usa `calden-tablero/e2e/`. *Acción: FIX-5, aceptar
   también `e2e/`. 1 línea + 1 caso.* (Corrección al candidato: ese repo **no** está adoptado; el que
   tiene los hooks es el repo hermano del backend.)

---

## 3. Tema 2 — que las corridas de revisores automáticos dejen rastro

### El problema, en una frase

**Hoy no se puede contestar mecánicamente "¿corrieron los revisores automáticos de la story X?".** El
registro sólo se escribe si alguien tipea el comando que lo escribe. Y como no hay diferencia entre
"no corrieron" y "corrieron sin registrarse", **el silencio se lee como incumplimiento**.

El experimento natural está en este mismo repo: la corrida del 15-ago dejó **0 entradas** en el
registro pese a tener un reporte consolidado con 6 hallazgos reales (o sea: **los revisores corrieron
de verdad**); la corrida de hoy, conducida con el marcador del pipeline, dejó 4 entradas correctamente
atribuidas. Además, **142 de las 149 entradas históricas no tienen repo atribuido**.

**No es un bug ni una evasión**: el control está río abajo de una llamada voluntaria. Pero a diferencia
de las evasiones reales (que sí quedan registradas en su propio archivo), **saltearse el marcador no
deja rastro de haberse salteado**.

### Recomendación: **opción (a)** — completar el registro de arranques que ya existe

> ✅ **IMPLEMENTADA.** Todo lo de la tabla "El cambio mínimo" está cableado, con el
> **sub-ítem** incluido (atribución por raíz de git cuando no hay marker) y el párrafo de (c) en el
> step-05. La retención se resolvió con **D2 = resumen durable**. Lo nuevo respecto del plan: el
> resumen es una **precondición del borrado** — si no se pudo escribir, el archivo sobrevive hasta
> la próxima pasada (perder unos KB es reversible; borrar la constancia en silencio, no).

**Por qué (a) y no las otras, en orden de peso:**

1. **Es la única que produce el dato que falta.** Las otras dos dejan la pregunta sin respuesta mecánica.
2. **Su costo de falso positivo es estructuralmente cero**: escribe, no bloquea. Con la lección de hoy
   sobre la mesa (**se revirtió un hook bloqueante por dos bloqueos equivocados en cinco minutos**), eso
   es decisivo: **un control que no interrumpe a nadie no se apaga por molesto, y por eso sigue estando
   cuando importa.**
3. **El 90% ya está construido, desplegado y probado.** El hook que registra cada arranque real de
   revisor existe, corre en toda sesión y ya se usa como prueba anti-falsificación. Le faltan dos cosas.
4. **El precedente ya corre en el arnés**: otro hook combina exactamente estas dos piezas (registro
   propio con repo + lectura de los arranques como fuente de verdad).
5. **Habilita un freno futuro bien hecho**: con datos por repo y durables se vuelve posible un aviso
   **no bloqueante** ("este repo tiene un reporte consolidado sin corrida registrada"). **Medir primero,
   bloquear después — si alguna vez.**

**Las otras dos, para el registro:**

- **(b) que el freno de fin de turno exija revisores** → **descartado, y ya estaba descartado por
  escrito.** Es la semántica que el propio archivo rechaza ("un chequeo ausente no es rojo") porque
  trabaría cada pausa legítima para preguntarle al humano. **Riesgo medido: en 7 días hay 2601 sesiones
  en la máquina; sólo 24 tuvieron una corrida real de revisores.** Se equivocaría en la abrumadora
  mayoría, y el desenlace conocido es apagar el control entero.
- **(c) documentarlo y aceptarlo** → **necesario pero no suficiente.** Convierte un problema de
  medición en una convención, y el propio arnés tiene escrito que *"lo que hay que acordarse de hacer,
  no se hace"*. **Va como acompañante de (a), no como alternativa.**

### El cambio mínimo, y qué archivos toca

| Qué | Dónde |
|---|---|
| Estampar el repo (del dato que el hook **ya lee**) y la story en cada línea del registro | `~/.claude/agent-skills/skills/tycon-pipeline/scripts/on-advisor-run.js` (~3 líneas) |
| **Decisión**: subir la retención de 7 días a ~90, o volcar una línea-resumen a un archivo durable antes de borrar | `.../scripts/marker.js` (`pruneStale`, 146-158) |
| Un comando lector que conteste la pregunta | nuevo, en el pipeline |
| Casos en el banco de controles (regla "entra con sus casos") | `tycon-claude-guides/scripts/controls-bench/cases/hooks/` |
| Párrafo de (c): que el silencio no se lea como "no corrieron" | `.../steps/step-05-advisors-parallel.md` + `tycon-claude-guides/guides/incident-log.md` |
| **Sub-ítem barato y ortogonal**: cuando no hay marcador, atribuir el repo por la raíz de git del directorio actual | `marker.js:165` (`appendLog`, 2 líneas, sin efectos sobre el bloqueo) |
| Referencia del patrón ya en producción | `tycon-claude-guides/scripts/hooks/retro-pending.js` |

**Volumen**: ~10 KB por semana. **Un año entra en menos de un megabyte** — o sea, la retención es una
decisión, no un costo.

---

## 4. Orden sugerido de ejecución

> Separado por **tipo de esfuerzo**, no por gravedad: lo de una línea no debería esperar a que se
> resuelva una decisión de diseño.

### Tanda 0 — Config de repos, sin tocar código del arnés (~45 min en total)

Son arreglos de configuración en repos concretos, independientes entre sí y del resto del plan.

1. **URUTAU/FrontEnd** — declarar las dos apps y las carpetas compartidas, borrar el bloque anidado que
   se está tragando la config. Hoy las pruebas de un formulario apuntan al otro y el merge aborta.
2. **El repo del framework** — declarar la lista de pruebas críticas. Hoy ningún E2E frena el merge a main.
3. **Bigua** — sacar (o migrar) la lista `advisors:` de sus 5 archivos: no la lee nadie y hace
   creer que el repo está configurado.

### Tanda 1 — Una línea o dos, sin decisiones (≈1 hora, todo junto)

4. **FIX-5** — el detector de pruebas acepta también `e2e/` (1 línea + 1 caso). *Efecto: más repos
   empiezan a ver el aviso, que es el punto.*
5. **FIX-6** — el script propio de pruebas cuenta como compartido (2 líneas + 1 caso). **Hacerlo con
   prefijos, no con rutas exactas** — así la próxima config futura entra sola.
6. **C8 (parte 1)** — anclar `qa_guide` al primer nivel (~10 líneas + 2 casos). Riesgo de regresión: cero.
7. **C10** — releer el comando de compilación actual (~8 líneas + 1 caso).
8. **Documentación** — la exclusión que afloja dos reglas críticas, al catálogo (10 min).

### Tanda 2 — El arreglo estructural, y el de mejor relación valor/riesgo (medio día cada uno)

9. ✅ **Tema 2 / opción (a) — HECHO.** Estampado de repo y story en el registro de
   arranques, resumen durable antes de la poda (D2), comando lector `pipeline.js advisor-runs`,
   atribución del repo en `gates.log` sin marker, y el párrafo de (c) en `step-05-advisors-parallel.md`.
   Piezas: `lib/repo-attrib.js` + `lib/advisor-ledger.js` (nuevas) · `on-advisor-run.js` · `marker.js`
   (`pruneStale` + `appendLog`) · `pipeline.js`. Casos: `controls-bench/cases/hooks/16-advisor-ledger.json`
   (3) + `tests/advisor-ledger.test.js` (12, en cada arranque) + `tests/advisor-ledger-cli.test.js`
   (8, throttle diario). Los 4 arreglos verificados en ROJO revirtiendo cada uno.
10. ✅ **FIX-1 — HECHO.** Cubre **C1 + C3 + C9 + C8 (parte 2)** con una regla única en
    `lib/config-source.js`: **aflojar exige commit, apretar vale al toque**. Las llaves que AFLOJAN
    (`evidence.companion_repos`, `qa_guide`) se leen SÓLO de lo commiteado; las que DELIMITAN a qué se
    le aplica el freno (`stories.id_pattern`, `evidence.fe_paths`) van en UNIÓN de commiteado y carpeta,
    con aviso ruidoso cuando difieren. Piezas: `lib/config-source.js` (nueva) · `lib/story-discovery.js`
    (`storiesConfigForGate`) · `lib/evidence-config.js` (modo `{freno:true}`) · `lib/ui-signal.js` ·
    `on-pre-commit.js` (emisor único de avisos, antes de que cualquier freno pueda cortar) ·
    `on-frontmatter-write.js`. Casos: 5 en el banco (`17-config-de-frenos.json`) + 11 en
    `tests/guard-config.test.js`. *Efecto de borde documentado y avisado en el mensaje del freno.*
11. ✅ **FIX-3 — HECHO.** El lector del bloque `e2e:` acepta llaves sólo en el PRIMER nivel
    y avisa —nombrándolas— ante llaves desconocidas o anidadas. Verificado que los 4 repos del equipo
    con bloque `e2e:` no disparan ni un aviso: un lint que pone en rojo lo que ya funciona se apaga.
    4 casos en `tests/guard-config.test.js`.

### Tanda 3 — Superficie de config como disparador (medio día, 3 piezas independientes)

12. ✅ **FIX-4(c) — HECHO.** `pipeline.js lint-config` (nuevo `lib/config-lint.js`) +
    disparo automático al editar `.tycon/advisors.yaml` (`on-config-lint.js` en el despachador
    post-edit). Caza tres fallas silenciosas: llave que nadie lee, regla CRITICAL declarada que no
    puede disparar, y lista de exclusiones que crece. 13 casos en `tests/config-lint.test.js` + 5 en
    el banco (`18-config-lint.json`). 🔴 El catálogo de llaves cita **quién lee cada una**, y hay un
    caso que lo corre contra los 13 configs reales exigiendo cero hallazgos: el primer catálogo se
    escribió de memoria y 8 de sus 10 hallazgos eran falsos positivos.
13. ✅ **FIX-4(b) — HECHO.** `plugin.json*` → revisor .NET · `appsettings*.json` / `.env*`
    → revisor de seguridad, con `appsettings.Development.json` excluido. **Un** revisor por tipo.
14. ✅ **FIX-4(a) — HECHO.** Un cambio de **dependencia** (nombre o versión, en
    `dependencies`/`devDependencies`/`peerDependencies`) selecciona el revisor de convenciones del
    stack; un cambio de `scripts` no dispara nada. Se compara el mapa de dependencias commiteado
    contra el de la carpeta, no el diff: con `-U0` no hay contexto y una línea de `scripts` es
    indistinguible de una de dependencias. 11 casos en `tests/advisor-set-config.test.js`.
15. ✅ **FIX-8 — HECHO.** `on-planning-artifact.js` dispara también en `Edit` y deja
    `.advisors/navigation-drift.json`; el cierre de la próxima story de interfaz lo avisa. Se levanta
    solo cuando el revisor de wiring corrió **de verdad, en ese repo y después del cambio** (registro
    de arranques del Tema 2). 9 casos en `tests/navigation-drift.test.js` + 4 en el banco
    (`19-navigation-drift.json`). Cero revisores extra.

### Tanda 4 — Necesita decidir antes de codear

16. ✅ **FIX-2 — HECHO.** La escotilla se lee de lo COMMITEADO
    (`lib/config-source.js → archivoParaFreno`) y el control de evidencia tiene **llave propia**
    (`.tycon/story-evidence-gate` · env `TYCON_STORY_EVIDENCE_GATE`) — decisión D1. Impacto de
    separar: cero (ningún repo del equipo tiene `.tycon/atdd-gate`). 9 casos en
    `tests/escape-hatches.test.js` + 2 en el banco.
17. ✅ **FIX-7 — HECHO.** (a) La lista de disparo del pre-commit se amplió a
    `scripts/hooks/`, `.githooks/`, el instalador y el banco entero — **ahora incluye el archivo que
    la contiene**, que era el segundo agujero reproducido. (b) `build/check-hook-coverage.js` CENSA
    EL DISCO: 39 hooks encontrados, 30 con casos, **9 con deuda declarada** en
    `scripts/controls-bench/hook-debt.json` (decisión D3). Una deuda sin motivo de verdad bloquea
    igual, y el control avisa cuando una entrada quedó de más o el script ya no existe. De yapa:
    los `--selftest` de los cuatro controles del pre-commit **no los corría nadie** — ahora van en
    la tanda diaria (`scripts/tests/build-selftests.test.sh`).

### Las 3 decisiones que necesitan al dev

| # | Decisión | Recomendación de esta auditoría | Estado |
|---|---|---|---|
| **D1** | ¿Una llave o dos para la escotilla de emergencia? Hoy apagar "la prueba antes que el código" apaga de yapa "los criterios sin verificar" | **Dos llaves.** La herencia no está documentada en ningún lado; ése es el hallazgo reportable | ✅ **DECIDIDO: dos llaves** |
| **D2** | Retención del registro de corridas: ¿subir de 7 a ~90 días, o volcar un resumen durable antes de borrar? | **Resumen durable.** Menos de 1 MB al año y no toca la lógica que hoy depende de los 7 días | ✅ **DECIDIDO: resumen durable** — ya implementado |
| **D3** | Los 11 scripts sin casos de prueba: ¿bloquear desde el día uno o entrar con deuda declarada? | **Deuda declarada.** Bloquear a todo el equipo el primer día es la vía rápida a que alguien apague el control | ✅ **DECIDIDO: deuda declarada** |

---

## 5. Lo que NO se auditó — explícito

Para que nadie lea este documento como "el arnés quedó auditado".

1. ~~**El criterio de los revisores automáticos.**~~ ✅ **MEDIDO.** El instrumento ya
   existía (`advisor-runner.js`: 93 casos quirúrgicos, las dos herramientas, N=3 con unanimidad) y su
   reporte llevaba un día en rojo sin que nadie lo mirara, porque decía *"19 rojos"* mezclando tres
   problemas distintos. Desglosado: **2 de criterio** (el mismo caso en las dos herramientas), **14
   inestables** (el revisor contesta distinto entre corridas) y **3 errores de corrida**; y de los 15
   "paridad rota", 13 eran ruido. Se cableó el desglose en el runner y en el aviso de arranque.
   **Y después se arregló cada grupo** (mismo día): los 2 de "criterio" eran INFRAESTRUCTURA (el
   corral de engram que no se creaba, con `catch` vacío → el revisor caía a su modo de falla y el
   rojo era inatribuible; ahora se verifica y se anota la causa); de los 14 inestables, **13 eran
   variancia de muestreo del juicio** —pecados inequívocos, fallos disjuntos entre herramientas,
   repartidos en 11 de 28 revisores— y quedaron con `varianza_declarada` (ratio medido + piso +
   motivo; **por debajo del piso vuelve a ser rojo de criterio**); y **el 14º sí era un caso mal
   escrito**: un gemelo limpio cuyo fixture no incluía el módulo que el código importaba, así que el
   revisor no podía comprobar la limpieza.
2. ~~**El lado Codex.**~~ ✅ **MEDIDO**, con `TYCON_CODEX=1` en esta máquina: el banco
   corre **173 casos del lado Codex con 0 rojos y 0 paridad rota**, incluidas todas las piezas nuevas
   del día; el registro de hooks da 44 entradas cubiertas; y de los 15 desacuerdos del banco de
   revisores, sólo 2 eran reales. **Lo que sigue abierto es de otra naturaleza**: `trust` — 27 de 32
   hooks aprobados por hash en Codex; los no aprobados **no corren en sesiones interactivas y no dan
   error**. Cada cambio de script re-desaprueba, así que el trabajo de hoy dejó más por aprobar. Se
   cierra corriendo `/hooks` en una sesión de Codex: es acción del dev, no automatizable.
3. ~~**Los hooks fuera de la familia de config `.tycon/`**~~ ✅ **BARRIDO Y ATENDIDO** — `guides/decisions/interruptores-fuera-de-tycon-2026-08-25.md`. Censo de ~40 interruptores en
   4 familias; DOS caminos de apagado silencioso reproducidos y cerrados: persistir un kill TYCON_*
   en el rc del shell (regla **HARNESS-C1** del safety-guard — el mismo patrón C1, un piso más
   abajo) y sellar a mano la suite diaria (sello de hoy sin reporte del job → grito al arranque).
   Los opt-in por archivo y el registro auto-sanado de `settings.json` no son este patrón, con el
   motivo escrito. 8 casos en el banco.
4. ~~**Los controles de CI (Azure DevOps, GitHub Actions).**~~ ✅ **MEDIDO Y ATENDIDO**: **31 pipelines del equipo, ninguno corre un control del arnés** — toda la
   protección es condicional a la máquina. Se construyó el portón de servidor
   (`scripts/ci/tycon-ci-gate.js` + `guides/ci-gate.md`) con los tres controles que se pueden
   decidir con el repo y nada más. **DECIDIDO NO ADOPTAR**: los cuatro caminos que el
   portón atrapa no ocurren en este equipo —un solo dev, una sola máquina, el arnés puesto—, así que
   sería ceremonia. La pieza queda lista y `guides/ci-gate.md` deja escrito qué cambiaría la
   decisión.
5. **La prosa normativa** — los `SKILL.md`, los `steps/*.md`, las guías. Se auditó código, no reglas
   escritas en castellano que dependen de que alguien las recuerde.
6. ~~**El banco de controles como tal.**~~ ✅ **AUDITADO Y CABLEADO.**
   `scripts/controls-bench/vacuity-audit.js`: cada caso afirmativo se re-corre con su control
   reemplazado por un script que NO HACE NADA — si pasa igual, es vacuo (lo que asserta lo produce
   su propio setup). Primera corrida: **1 vacuo entre 103** — un caso de privacidad que asertaba
   sobre un archivo que el hook jamás escribe; reescrito con testigo positivo + aserción negativa,
   y verificado que ahora caza la regresión real (sacar el filtro de `/clients/` lo pone rojo).
   Corre a diario (tanda bash de fondo). Los must-not-flag no se auditan así a propósito: afirman
   una ausencia, y con un control mudo eso se cumple trivialmente — su valor es ser contracara de
   un caso afirmativo.
7. **Repos fuera del alcance** — se barrieron los 13 con config `.tycon/` conocidos, dentro de
   `~/SourceCode`. Repos de otras máquinas del equipo, no.
8. **Concurrencia y worktrees múltiples** — nada de lo reproducido corrió con dos pipelines en paralelo.
9. **El resto del registro de frenos** más allá de las 149 entradas de revisores (volumen, retención,
   integridad histórica).
10. **No se corrió ninguna suite de pruebas ni se modificó código de producción.** Todo fue en
    laboratorios aislados del scratchpad y clones locales. **El arnés quedó exactamente como estaba.**

---

## Anexo — dónde está la evidencia

| Superficie | Notas |
|---|---|
| Orquestador del pipeline | `scratchpad/audit-pipeline.md` |
| Revisores automáticos | `scratchpad/audit-advisors.md` |
| Hooks del arnés | `scratchpad/audit-hooks.md` |
| Los 13 repos del equipo | `scratchpad/audit-repos.md` |
| Tema 2 (rastro de corridas) | `scratchpad/audit-ledger.md` |
| Laboratorios de reproducción | `scratchpad/adv/lab1` (frenos de story) · `lab2` (selección de revisores) · `lab3` (detector de interfaz) · `lab4` (recordatorio de compilación) · `scratchpad/adv/tcg` (clon del repo de guías) |

*(Rutas relativas a `/private/tmp/claude-501/-Users-usuarioa-SourceCode-<repo>/00000000-0000-4000-8000-000000000001/scratchpad/`.)*
