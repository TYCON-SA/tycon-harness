# Disciplina de ejecución de tests — no fundir la máquina del dev

> **Regla de oro:** durante el desarrollo, el agente corre **solo los tests del/los archivo(s) que tocó**.
> La suite completa corre **en el portón de `/tycon-merge-to-main`, cuando el dev la pide, o una vez
> al cierre del Step 4 del pipeline de stories** (`test-gate.sh`), **nunca dos veces seguidas** y
> **nunca en paralelo con un fan-out de subagentes**.

## El problema

`vitest run` (y `dotnet test`, y `npm test` a secas) **paralelizan por default** usando ~`cores-1`
workers/forks. Cada worker de vitest carga **jsdom + el grafo completo de módulos React**. En una
máquina típica del equipo (**8 cores / 16 GB RAM**), correr la **suite completa** (cientos de archivos,
1500+ tests) lanza ~7 forks que juntos **exhauntan la RAM → swap → thrash**. Síntoma diagnóstico:
el `collect` de vitest se dispara a cientos de segundos (ej: **822s**) y la máquina se **congela**.

Se agrava cuando, **al mismo tiempo**, el agente tiene **8–11 subagentes (advisors) corriendo en paralelo**
(cada uno con greps/reads). La combinación full-suite + fan-out es la que mata la máquina.

## Reglas de comportamiento (el agente) — NO-NEGOCIABLES

1. **Durante la iteración: solo el archivo tocado.**
   - Vitest/Jest: `npm test -- <patrón-del-archivo>` (ej: `npm test -- ZonasResumen`).
   - .NET xUnit: `dotnet test --filter "FullyQualifiedName~<Clase>"` o `--filter "Name~<Test>"`.
   - **NUNCA** `npm test` / `vitest run` / `dotnet test` **sin scope** mientras se itera.

2. **La suite completa: en el portón de `/tycon-merge-to-main`, con el OK del dev, o dentro del
   pipeline de stories.** Fuera del pipeline, un commit a `dev` va con los tests del área tocada: el
   portón del merge la re-corre como bloqueante, así que correrla antes es doble costo. Dentro del
   pipeline, la corrida de `test-gate.sh` al cierre del Step 4 es la corrida completa autorizada
   (el código rechaza un verde que no
   venga de `test-gate.sh`). Fuera de esos casos, si parece necesaria, preguntar — sobre todo si
   el dev está usando la máquina (mal ejemplo: dos suites completas, ~3500 tests, para un commit
   a `dev` con las scoped en verde). No "para confirmar" en medio del trabajo, no dos corridas
   seguidas; si ya corrió y pasó, no se vuelve a correr salvo que el diff haya cambiado
   sustancialmente desde entonces.

   *Precisión (desde 2026-08-28)*: "salvo que el diff haya cambiado" ahora lo
   decide un chequeo mecánico, no el ojo — `suite-freshness.js check` compara la huella del código
   que la corrida verde midió (guardada en `tests-result.json → code_state`) contra el working tree
   actual. Si el pipeline iteró fixes después del verde de «Correr las pruebas» y `suite-freshness` da STALE, la
   re-corrida del cierre (la última vuelta de Revisores, al converger) reemplaza a la de «Correr las pruebas» — una sola, nunca una por
   iteración: un verde que describe código que ya no existe no cuenta como "ya corrió y pasó". El
   portón de `/tycon-merge-to-main` corre build + tests sobre el código ya mergeado (en .NET, sin
   `Integration`/`EdgeCase`), o los corre la validación del PR en el servidor.

   *Después de un rojo, repetir primero la suite que falló*: `bash …/test-gate.sh <repo> <story> --suite <ruta>` (la
   `ruta` de su entrada en `suites.json`). Mientras quede alguna sin salir verde sola, la corrida completa sale 76 sin
   lanzar nada y da el comando de cada una.

   *Traer main no repite lo que ya se midió*: con el portón acotado porque una CI corre la completa, si lo que midió la
   última corrida, mezclado con main, da exactamente lo que hay en la carpeta, corren sólo las suites que fallaron y las
   que nombran archivos que trajo main. Se compara la carpeta, no los commits. Cualquier otro cambio corre lo de siempre
   (`lib/after-main.js`). No ve un archivo ignorado que lea una suite, ni el destino de un enlace fuera del repo: eso queda
   para la CI del pedido.

3. **Nunca full-suite + fan-out de subagentes simultáneo.** Si hay advisors/subagentes corriendo,
   **esperar** a que terminen antes de lanzar la suite completa (y viceversa). Secuenciar, no superponer.

4. **Cap de subagentes en paralelo.** No spawnear 8–11 agentes de una. Batchear en grupos de **≤4–5**
   o secuenciar. (El runtime ya capa la concurrencia, pero un fan-out grande igual suma carga de I/O.)

5. **Gatear sobre el exit code real, NO sobre output pipeado.** `npm test | tail` devuelve el exit del
   `tail` (0), enmascarando el rojo. Capturar `$?` del comando directo o leer el resumen real.

6. **Flakes que pasan en aislamiento = no re-confirmar** corriendo la suite de nuevo. Correr el archivo
   solo; si pasa aislado, es flake de carga, se documenta, no se re-corre el conjunto.

7. **Una suite que compara la HUELLA de un artefacto generado no corre mientras otro proceso lo
   regenera.** `dashboard.test.sh` (C-27) hashea la página del tablero antes y después
   para probar que la suite no lo toca; si en paralelo se corre `dashboard.js` (que lo reescribe), el
   caso sale rojo sin defecto alguno, y descartarlo cuesta una segunda
   corrida. Misma regla que «suite completa y subagentes no se superponen», extendida
   a los artefactos generados: primero se regenera, después se corre la suite, nunca a la vez.

8. **Una sola corrida de cada check por repo: `marker.js run-check` toma un candado, y la segunda sale 75.** Si ya
   hay una corrida del mismo check en marcha en el mismo repo, la segunda no lanza nada; el 75 no es un rojo: dice
   desde qué hora corre la otra, su pid y su sesión. `test-gate.sh` pasa ese 75 tal cual, sin `tests-result.json`. Se espera su
   resultado, no se relanza. El candado de un proceso muerto se suelta solo; por edad no se suelta. Si quedó colgado,
   la negativa nombra la carpeta del candado para sacarlo a mano.

## El freno de pruebas sin alcance: qué reconoce

El freno (`scripts/hooks/test-scope-guard-pre.sh`) lee el comando como lo lee el shell (con `scripts/lib/test-scope.js`)
y frena la suite completa sin acotar aunque no esté al principio:

- **detrás de un prefijo**: `time`, `nice`, `nohup`, `timeout 60`, `env A=b`, `A=b`, `command`, `exec`, `sudo`, `!`,
  `xargs`, `watch`;
- **adentro de una agrupación o del control de flujo**: `( … )`, `{ …; }`, `if`, `for`, `while`, `case`, una función,
  un alias, `$( … )`;
- **lanzada por otro programa**: `bash -c`, `sh -c`, `eval`, `bash <<<`, `echo … | bash`, `ssh`, `docker exec`/`run`,
  `su -c`, `script -c`, `tmux`, `screen`, `find -exec` y, en PowerShell, `&`, `iex`, `pwsh -Command`, `cmd /c` y
  `Start-Process`;
- **por otro gestor o con su ruta**: `pnpm`, `yarn`, `bun test`, `npx -y`, `npm t`, `npm run test:*`,
  `uv`/`poetry`/`pipenv run`, `python -m pytest`, `py.test`, `node_modules/.bin/vitest`, `dotnet.exe`.

Qué cuenta como alcance, por herramienta: un archivo o una carpeta de pruebas concreta (no `.` ni `./`), `--filter` de
`dotnet test` con valor, `-k` de `pytest` con valor, el patrón después de `--` en `npm test`. **No** cuentan el valor de
una opción (`-o bin/out`, `--reporter verbose`, `--project web`), un filtro vacío, algo que sólo se sabe al correr
(`pytest $X`) ni un filtro por nombre de vitest o jest (`-t`, `--grep`): esos igual cargan todos los archivos, en
paralelo. Lo que no puede leer (comillas sin cerrar, el texto de un shell armado con variables) frena y lo dice.

El escape `TYCON_FULL_SUITE=1` vale cuando acompaña al comando de pruebas: como prefijo, con `env`, exportado o con
`$env:` antes en el mismo comando. Nombrarlo en un texto (un `echo`, un mensaje de commit) no lo usa.

## El fix técnico durable (por proyecto)

La disciplina de comportamiento no alcanza (un dev humano, o un agente futuro, puede correr la suite
completa igual). **Acotá los workers en la config** para que la suite completa **nunca** sature, aun
cuando se corra entera:

### Vitest (`vitest.config.ts`)

```ts
export default defineConfig({
  // ...
  test: {
    // Cap de workers — evita exhaust de RAM/CPU al correr la suite completa.
    // '50%' = mitad de los cores (4 en una máquina de 8). Override en CI con VITEST_MAX_WORKERS
    // (los runners de CI suelen tener más RAM y se benefician de más paralelismo).
    maxWorkers: process.env.VITEST_MAX_WORKERS ?? '50%',
    minWorkers: 1,
    // ...resto de la config
  },
});
```

- En máquinas con poca RAM relativa al nº de cores (típico: 16 GB / 8 cores con jsdom), `'50%'` es el
  balance. Si igual thrashea, bajar a un fijo (`maxWorkers: 3`) o `'40%'`.
- **Alternativa nuclear** (suites muy pesadas o CI con poca RAM): `fileParallelism: false` (corre los
  archivos en serie dentro de un worker) — más lento pero RAM mínima.

### Vitest — además del cap: atacar el COSTO, no solo el paralelismo (medido: 2.7x)

El cap evita el freeze pero no acorta la suite. Medido: de ~330s de pared los tests eran solo
97s — el resto era `collect` (768s: cada archivo re-evalúa el grafo de módulos entero) y
`environment` (244s: un jsdom por archivo). Diagnóstico: mirar el desglose que vitest imprime en
`Duration (transform … collect … tests … environment …)`. Si `collect >> tests`, el problema son
los barrels pesados, no tus tests. Fix validado (una suite 330s→120s, otra 39s→15s, 1719/1719 verdes):

```ts
test: {
  // Workers thread (más livianos que forks → menos RAM → menos riesgo de swap thrash):
  pool: 'threads',
  // Pre-bundlear UNA vez los barrels gigantes que cada archivo re-evaluaba módulo a módulo
  // (lucide-react solo ya son ~1500 módulos):
  deps: { optimizer: { web: { enabled: true, include: ['lucide-react', '<otros barrels pesados>'] } } },
}
```

**Descartados CON evidencia — no reintentar a ciegas:**
- `isolate: false` (la palanca más agresiva, archivos en ms): si la suite usa `vi.mock` per-file
  (lo normal en React), compartir el module registry entre archivos rompe en masa (~800 rojos en
  la suite medida). Solo viable re-arquitecturando los mocks (DI en vez de `vi.mock`).
- `clearMocks`/`restoreMocks`/`unstub*` globales como "higiene": destruyen los `vi.spyOn` de
  `beforeAll` → componentes renderizan vacío (`<body/>`) → falsos rojos masivos con síntoma
  "Unable to find element".
- Palanca siguiente si hace falta más: `environmentMatchGlobs` para correr stores/services/utils
  en `node` (sin jsdom), y fake timers en los archivos lentos que esperan timers reales.

**Gotcha de observabilidad**: NUNCA validar una corrida larga
pipeada a `tail`/`head` — deja ciego hasta el final. Siempre `> /tmp/run.log 2>&1` y leer el log.

### .NET (`dotnet test`)

`dotnet test` paraleliza **por assembly** (no por test dentro del assembly, salvo `[Collection]`/
xUnit parallelization). El riesgo es menor, pero para suites grandes:

- Filtrar siempre durante iteración: `dotnet test --filter "FullyQualifiedName~<Clase>"`.
- Si hay varios proyectos de test, evitar `dotnet test` sobre la solución entera en iteración;
  apuntar al `.csproj` específico: `dotnet test tests/<Proj>.Tests/<Proj>.Tests.csproj --filter ...`.
- Para limitar paralelismo de xUnit: `xunit.runner.json` con `"maxParallelThreads": 2` o
  `"parallelizeAssembly": false`.

## Suites que simulan la máquina del dev: la carpeta personal de prueba

Una suite que instala, dispara controles o hace commits de juguete escribe constancias en
`~/.claude/.tycon-pipeline/` (y `frenos.jsonl` sube al buzón y alimenta el tablero). Corrida con la HOME real,
esas constancias son falsas y se mezclan con las del dev; y un `git commit` con la HOME real lee el
`core.hooksPath` global del dev y corre **sus** ganchos. Motivo: sin una pieza común, cada suite arma
su HOME falsa a mano y a su manera, y alguna termina ensuciando los registros reales.

- Toda suite bash nueva de ese tipo usa `scripts/tests/lib/fake-home.sh` (con `source`):
  `fake_home_create <dir> [--installer]` arma la HOME falsa (y fija el arnés y agent-skills con lo que
  resolvía la real); se puede llamar una vez por caso, o dentro de una subshell para que no salga de ahí.
- El control es **evidencia positiva**: `fake_home_count <registro> <texto>` cuenta lo que quedó en la HOME
  falsa. Nunca «el registro real no creció»: las sesiones del dev escriben ahí al mismo tiempo.
- En `node --test`, lo mismo a mano: HOME temporal ANTES de los `require` (hay rutas que se fijan al cargar
  el módulo) y devuelta en `test.after`, con una afirmación positiva sobre la temporal.
- La carpeta del laboratorio se protege con `scripts/tests/lib/lab-guard.js`: en bash,
  `node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" <suite> || exit 1`; en `node --test`,
  `labGuard(BASE, '<suite>')`. Frena si la carpeta cae en un clon del arnés, en agent-skills o en `.claude`, y toma
  el nombre del lugar de `place.js`. Motivo: copiada a mano de una suite vieja, la guarda traía escrito el nombre del
  repo interno, y el control de lo publicado la frenaba recién en el pedido. `harness-place.test.js` frena la copia.

## Una prueba no depende de un sha ni de una hora

Una prueba que sale roja de a ratos casi nunca tiene un error en lo que mide: tiene un dato que cambia en cada
corrida. Motivo: un rojo de azar traba pedidos que no lo causaron y enseña a reintentar en vez de leer.

- **Commits de laboratorio**: con fecha, autor y committer fijos (`GIT_AUTHOR_DATE`, `GIT_COMMITTER_DATE`), así el
  sha sale siempre igual. Un sha armado con la hora de la corrida tiene, por ejemplo, un prefijo de ocho caracteres
  sólo de dígitos más o menos 2 de cada 100 veces.
- **El mantenimiento automático de git, apagado** en todo laboratorio que hace `commit`, `fetch`, `push` o `merge`
  (`-c maintenance.auto=false -c gc.auto=0`, o `harness_lab_git` / `harness_lab_no_auto_maintenance` de
  `scripts/tests/lib/harness-lab.sh`). Desde git 2.55 queda corriendo de fondo después de que el comando volvió y
  toca el `.git` del laboratorio (`objects/maintenance.lock`, `info/refs`) mientras la prueba saca su huella.
- **El reloj**: la fecha se inyecta con la variable del programa que se prueba (`TYCON_TODAY`, `TYCON_…_NOW`). Si la
  prueba lee el reloj para otra cosa (medir cuánto tarda, nombrar un temporal), lo dice en un comentario
  `stable-data: <motivo>`.
- **Lo que se busca**, fuera del dato que cambia: un número corto buscado en una salida que trae una hora con
  milésimas o un sha lo encuentra ahí de a ratos. Se busca el número suelto, en su campo.
- **Una sola foto**: si la prueba compara una huella y después lista lo que cambió, las dos salen de la misma
  recorrida; si no, un rojo puede salir sin decir qué cambió.

`scripts/tests/stable-test-data.test.js` frena las pruebas NUEVAS que crean commits sin fechas fijas o sin apagar el
mantenimiento, o que leen el reloj sin inyectarlo ni declararlo. Las fechas y el mantenimiento se buscan en el código,
no en los comentarios. La declaración `stable-data: <motivo>` vale sólo escrita en un comentario y exime al archivo de
las dos reglas: es para el archivo que necesita fechas que cambian a propósito (una prueba del orden por fecha) o que
nombra las formas en sus textos, como el propio control. Las que ya existían están en
`scripts/tests/fixtures/stable-test-data-baseline.json`, una lista que sólo puede achicarse. El control mira el texto
y no ejecuta: no ve un sha o una hora que llegan por otro camino (un archivo que escribió otro guion, el `git log` de
un repo ajeno), ni el commit de una función que envuelve a git y se llama sin ninguna opción (`g "$R" commit`). Tampoco
distingue un comentario al final de un renglón o un texto entre comillas que nombran `GIT_AUTHOR_DATE` de la fecha
fijada de verdad, y toma por comentario un renglón de un texto de varias líneas que empieza con `//` o `*`. Ahí manda
esta regla.

## Checklist rápido antes de correr tests

- ¿Estoy iterando? → **solo el archivo tocado**, con filtro.
- ¿Voy a correr la suite completa? → ¿es el portón de `/tycon-merge-to-main`, el `test-gate.sh`
  del pipeline o lo pide el dev? Si no → **no**. ¿Ya la corrí en este diff, o hay subagentes
  corriendo? Si sí a cualquiera → **no**.
- ¿El proyecto tiene cap de `maxWorkers` en la config? → si no, **agregarlo** (es el fix durable).
