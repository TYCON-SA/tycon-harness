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
   actual. Si el pipeline iteró fixes después del verde del Step 4 y `suite-freshness` da STALE, la
   re-corrida del cierre (step-07b, al converger) reemplaza a la del Step 4 — una sola, nunca una por
   iteración: un verde que describe código que ya no existe no cuenta como "ya corrió y pasó". El
   portón de `/tycon-merge-to-main` corre build + tests sobre el código ya mergeado (en .NET, sin
   `Integration`/`EdgeCase`), o los corre la validación del PR en el servidor.

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

## Checklist rápido antes de correr tests

- ¿Estoy iterando? → **solo el archivo tocado**, con filtro.
- ¿Voy a correr la suite completa? → ¿es el portón de `/tycon-merge-to-main`, el `test-gate.sh`
  del pipeline o lo pide el dev? Si no → **no**. ¿Ya la corrí en este diff, o hay subagentes
  corriendo? Si sí a cualquiera → **no**.
- ¿El proyecto tiene cap de `maxWorkers` en la config? → si no, **agregarlo** (es el fix durable).
