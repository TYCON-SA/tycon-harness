# Definition of Done — gates de transición de status

**Aplicable a TODAS las stories TYCON.** Define gates obligatorios para dos transiciones:
- `in-progress` → `review` (gate del **dev**: implementación cerrada SIN deferrals abiertos)
- `review` → `done` (gate del **QA/UAT**: smoke check runtime + verificación end-to-end)

Build verde + tests verdes **NO son suficientes**. Dos formas en que una story `review` está rota sin que nada lo marque:
1. Con build verde, tests verdes y advisors aprobados, un endpoint del backend devuelve HTTP 400 silenciosamente, porque los E2E skipean cuando el endpoint no responde 200 (patrón `skip-on-not-ok`).
2. Con `TODO(Story-X-deferral)` documentados en su propio código: el wiring queda deferred y nadie cierra el ciclo. Recién al hacer dry-run del demo se descubre que las piezas no existen.

El detalle de cada una está al final (§ Por qué el Gate 2, § Por qué el Gate 1).

---

## Gate 1 — `in-progress` → `review` (responsabilidad del dev)

**Regla absoluta: una story NO puede pasar a `review` si tiene deferrals abiertos del propio story.**

Patterns que el validator detecta como deferrals abiertos:
- `TODO(Story-{N}-deferral)` (recomendado, canónico)
- `// TODO: Story {N}` / `// FIXME: Story {N}` / `// HACK: Story {N}`
- `[DEF-{N}-...]` / `DEFERRED-{N}` en código o comentarios
- Referencias a la propia story con verbo de pendiente: `pendiente Story {N}`, `Story {N} deferred`, etc.

Si la implementación deja work pendiente, hay 3 caminos válidos (NO está permitido marcar `review`):

| Situación | Camino correcto |
|-----------|-----------------|
| El work pendiente es necesario para algún AT/AC declarado del story | Status sigue `in-progress` hasta cerrarlo. NO avanza a `review`. |
| El work es legítimamente fuera de scope (descubierto durante implementación) | Crear story separada (ej: `1.7.1`) con `depends_on: [1.7]` y status `backlog`. Documentar en Change Log del story original el corte. |
| El work depende de otro story de este sprint o el siguiente | Marcar el deferral con cross-ref explícito al story que lo cierra. **No** queda como TODO genérico. |

**Anti-pattern explícito**:
```typescript
// TODO(Story-{N}-deferral): wire useSignalR(...).on('scan.validated', ...)
// Diferido por D3 (Story {N}). Requiere también el código que dispara los scans.
```
→ Si esto está en código y la story {N} está `review` → CRITICAL violation. La story no pasó de `in-progress`.

**Validator automation**: el `tycon-story-validator` agent (rule `VAL-C5`) escanea archivos modificados/creados por la story buscando estos patterns. Si encuentra → bloquea el commit prep del pipeline (Step 5).

### Stories entregadas en tandas — bloque `pipelines:` en el frontmatter

Cuando una story es grande y se entrega en varias tandas (backend / frontend / sub-features), **NO** se puede marcar `review` con tandas pendientes "implícitas en la cabeza del dev". Hay dos opciones válidas:

1. **Status sigue `in-progress`** hasta que todas las tandas terminen.
2. **Status puede pasar a `review` por tanda completada** SI Y SOLO SI el frontmatter incluye un bloque `pipelines:` que documenta machine-readable qué tanda quedó cubierta y cuál quedó pendiente con su `blocked_by` concreto. Ver `story-format.md` §1.1 para el schema completo.

```yaml
pipelines:
  - name: A-backend
    status: done
    acs: [1, 2, 3, 4, 5, 6]
    tasks: [1, 2, 3, 4]
    tasks_partial:
      - id: 5
        done: [5.1, 5.2, 5.3, 5.4]
        pending: [5.5]
  - name: C-frontend-listado
    status: blocked
    blocked_by: "Story <N.M> Task 5.5 backend — endpoint GET /api/ceibo/pedidos/{id}/listado no mergeado"
    acs_pending: [7, 9, 10]
    tests_pending: ["T36", "T39", "T40"]
```

**Reglas del bloque**:

- Cada pipeline `blocked` requiere `blocked_by` concreto no vacío (`tycon-story-validator` rule **VAL-C6** falla CRITICAL si falta).
- Todo AC del `## Acceptance Criteria` debe estar asignado a algún pipeline (cubierto o pendiente) — orphan AC = `tycon-story-validator` rule **VAL-W7** WARNING.
- Cada `acs_pending` / `tasks_pending` / `tests_pending` debe tener trazabilidad en `tasks/todo.md` (línea `[DEF-{N.M}-...]`) **O** en una engram observation `type=decision` con keyword `Story {N.M}`. Si no está en ninguno → `tycon-deferral-tracker` rule **DEFTR-C1** CRITICAL bloquea commit prep.
- Tests skipped (`it.skip`, `[Fact(Skip=...)]`, etc.) en código del diff requieren comentario adyacente `TODO(Story-{N}-deferral: AC#X | Task y.z | blocker: ...)` — sin comentario → `tycon-deferral-tracker` rule **DEFTR-C2** CRITICAL.

### Por qué el bloque `pipelines:`

Una tanda de backend puede mergear cubriendo 5 de 6 endpoints declarados. Si el sexto no queda documentado como blocked en ningún lugar machine-readable —solo un párrafo "PENDING en sesiones futuras" en el Change Log de la story—, recién al implementar la tanda de frontend se descubre que el data source no existe.

**Root cause**: validar "TODO en código" (VAL-C5) no ve una "subtask declarada en spec y no entregada". Sin el bloque, el loop entre spec y diff no está cerrado.

**Fix**: bloque `pipelines:` + advisor `tycon-deferral-tracker` (CRITICAL inmediato) + reglas VAL-W7 / VAL-C6 / DEFTR-C1 / DEFTR-C2 (2026-05-12).

---

## Gate 2 — `review` → `done` (responsabilidad del QA/UAT)

Checklist obligatorio antes de marcar `done`:

### 1. Smoke check runtime de endpoints

Para cada endpoint que la story declara o toca:

```bash
# Levantar la stack real (NO mocks)
./scripts/devhost.sh start            # backend on :5001
./start-all.sh                        # dev-proxy on :8082 + frontend ports
```

**Verificar los 3 puertos están listening** antes de continuar (un
proxy:8082 caído da `Failed to fetch` en el dev panel
aunque backend:5001 y frontend:8090 estén OK):

```bash
for port in 5001 8082 8090; do
  curl -s -o /dev/null -w "$port: HTTP %{http_code}\n" --max-time 3 \
    "http://localhost:$port/$([ $port = 5001 ] && echo 'api/health' \
     || [ $port = 8082 ] && echo 'api/ceibo/health' \
     || echo 'dev.html')"
done
# Esperado: 3x HTTP 200. Si alguno responde 000/timeout → reiniciar ese servicio.
```

Luego:
- **Backend**: ejecutar `curl` explícito contra cada endpoint con auth realista. Verificar HTTP 200/201 esperado (NO 400/500). Si la story declara handling de 4xx, verificar que el `error.code` sea el esperado.
- **Frontend**: abrir el dev panel (`dev.html` o equivalente) y verificar que los botones de health-check de cada endpoint respondan OK.

**⚠️ URL por entorno** — ANTES de armar el curl, determinar el target: la misma ruta puede cambiar de forma entre el entorno local y staging/prod. Un 404 contra staging con una ruta que anda en local es casi siempre la URL mal armada, no el endpoint. La forma de cada stack la dice la guía de su paquete (para el stack de plugins de Bizuit, la guía `bizuit-plugin-dotnet.md` del paquete bizuit, §7).

Ejemplo:

```bash
# Bug: TenantId="default" en appsettings causa 400 INVALID_TENANT
SINCE=$(date -u -v-1H +"%Y-%m-%dT%H:%M:%SZ")
curl -s -o /tmp/r -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer laboratorio" \
  "http://localhost:5001/api/auditoria/events?since=$SINCE"
# Esperado: HTTP 200 {"events":[],...}
# Si HTTP 400: BUG → fix → re-verify → recién entonces pasar a `done`
```

### 1.bis. Smoke runtime de failure paths (obligatorio cuando la story tiene fallback/retry/circuit)

**Rule 2026-05-13**: cuando la story declara comportamiento de resiliencia (fallback PDF, retry con backoff, circuit breaker, timeout handler, partial success envelope, discriminated union response con N statuses), el smoke check NO se completa con happy path solo. DEBE incluir **al menos 1 reproducción runtime de cada failure scenario declarado en ACs `### Errores` / `### Edge cases`**.

Por qué: "el happy path verificado" deja dead-code el path de resiliencia. Una story puede declarar un AC de `fallback-pdf` y otro de `fallback-pdf-memory` + auto-download base64, y que el componente ignore el `response.status` del envelope. Ese bug se detecta solo al hacer manual smoke con el printer-mock down (escenario realista de producción con la impresora inaccesible). Sin esta verificación explícita, el PDF in-memory se pierde sin alertar al user.

**Cómo verificar:**

```bash
# Por cada failure scenario del AC, reproducir manualmente:

# 1. AC dice "si printer no responde, fallback PDF" → matar la printer/mock:
kill $(lsof -ti:9100)   # tira printer-mock
# → Trigger el flow desde UI o curl. Verificar que el response trae
#   el status declarado (e.g. 'fallback-pdf-memory') Y que el frontend
#   muestra el UX declarado (toast warning + auto-download).

# 2. AC dice "si filesystem unwritable, in-memory PDF" → mockar el path:
# mount -o remount,ro /var/ceibo/pdf-fallback/   # u otra técnica
# → Trigger + verificar response status + UX.

# 3. AC dice "timeout 5s" → simular delay > 5s en el mock:
# (editar mock para sleep 6s antes de ACK)
# → Trigger + verificar TimeoutException atrapada + fallback path activado.
```

**Anti-pattern**: "lo probé con todo levantado y funcionó" → estás verificando happy path únicamente. Si el AC enumera 4 statuses, smoke debe cubrir los 4 (o al menos los != 'ok').

### 1.ter. Verificar sin desplegar: el SQL volcado por el código compilado, contra una base real de sólo lectura (patrón aceptado, 2026-09-06)

Cuando el
smoke «oficial» exige staging desplegado (merge + deploy) y el defecto es de SQL o de consulta, se
puede cerrar la verificación en ejecución **antes** del merge así:

1. La cadena de conexión de desarrollo (`appsettings.Development.json`) apunta a una base **real de
   sólo lectura** o a una réplica; nunca a una con escritura.
2. Un test **temporal, que no se commitea**, llama a los métodos compilados que arman la consulta
   (`BuildQuerySql`, `BuildCountSql`, …) y vuelca el SQL real a un archivo.
3. El smoke corre **ese** SQL contra los datos reales — no una transcripción a mano, que puede
   divergir del código.
4. 🔴 Condición necesaria: el smoke tiene que demostrarse **rojo revirtiendo el fix**, reproduciendo
   el síntoma; si no, es decoración.
5. La evidencia (el SQL volcado, la salida antes y después, el rojo con el fix revertido) va a
   `.advisors/dod-runtime/<story>-smoke-evidencia-<ts>.md`, como cualquier otro smoke.

No reemplaza el smoke de staging cuando la story toca algo más que la consulta: lo adelanta.

### 1.quater. Una migración que BORRA se prueba en una base descartable, o avisándole antes al dueño (2026-09-14)

Una migración que borra datos (`DELETE`, `TRUNCATE`, `DROP`, una
limpieza de versiones o de registros) se valida **sólo** en una de estas dos formas:

1. **Una base descartable o propia**: un contenedor local, una copia restaurada para la prueba, o
   una base que es sólo del proyecto y de nadie más.
2. **Una base compartida, con aviso previo al dueño**: se le dice qué va a borrar y contra qué base,
   y se corre **después** de su OK. Sin respuesta no se corre.

Una base de pruebas que usa otro proyecto **no es descartable** aunque se llame «test». Y «validar
el arreglo» no cambia la regla: lo que se borra en la validación se borra igual.

Por qué: validar el arreglo de una migración de limpieza contra la base de pruebas de otro
proyecto, sin avisar, le borra sus datos (medido: 7 versiones de plugin, 497 opciones de
configuración y 1,4 millones de registros).

### 2. E2E con fail-loud env vars

Si la story tiene tests E2E que dependen de un endpoint:

- Los specs **NO deben usar el patrón `skip-on-not-ok` sin un override de fail-loud**. Convención: env var `<DOMAIN>_REQUIRED=1` (e.g. `E2E_AUDIT_REQUIRED=1`) que hace que el helper de probe **lance error** en lugar de retornar mensaje de skip.
- Correr al menos una vez con esa env var seteada **antes de pasar a `done`**:

```bash
E2E_AUDIT_REQUIRED=1 npm run test:e2e
# Si los tests skipean: hay un bug oculto → investigar
# Si los tests fallan: hay un bug real → fix → re-run
# Si los tests pasan: gate cumplido
```

- El **CI dedicado** que levanta toda la stack DEBE setear esa env var. Skipear silenciosamente en CI (cuando la infra está disponible) es inaceptable — esconde bugs hasta producción.

### 2.bis. Un AC de pantalla se prueba con una imagen del navegador real

Lo que el cliente ve no se da por probado porque una prueba salió verde: un **AC de pantalla** pide una **captura o una
grabación** del navegador real, atada a ese AC. Sin ella la matriz de verificación runtime lo deja `SIN-EVIDENCIA`
(bloquea, no se waivea), aunque el E2E o el humo hayan salido en verde.

- **Qué es un AC de pantalla**: en una story que cablea interfaz, todo AC salvo el que lleva `@sin-pantalla` en su texto;
  en una story sin interfaz, sólo el que lleva `@pantalla`. En duda, es de pantalla. Backend sigue con humo y medición.
- **Con el E2E**: poné `@ac-N` en el título del test que abre la pantalla (`'la lista muestra el total @ac-2'`). El gate
  E2E con el filtro de los specs de la story guarda la captura, y el `captures.json` de su carpeta la ata al AC. Una
  grabación `.webm` de Playwright cuenta igual que una captura.
- **Con un humo**: `smoke-run.sh <evidence-dir> <ruta-de-la-story.md> --acs N --pass-if '…' --capture <archivo.png|.webm>
  -- <comando>`. La huella de la imagen queda en el registro y en el espejo; cambiarla después la saca de la cuenta.
- **Datos de laboratorio**: la imagen es de un sitio de laboratorio o de prueba, con datos inventados; nunca de datos
  reales de un cliente.
- **Compatibilidad**: la regla rige para las stories que arrancan después de publicarla; una que ya estaba en curso recibe
  un aviso en la matriz, sin rojo.

### 3. Verificación cruzada con stories dependientes

- Si Story X declara `depends_on: [Y]` y Y está en `review`/`done`, validar runtime que los artifacts de Y siguen funcionando (no asumir).
- Si Y exporta un endpoint, X debería ejercitarlo en sus tests **sin** patrón skip silencioso (ver §2).

### 4. Documentación de drift conocido

Si durante el smoke check se detecta drift entre lo que la story declara y la realidad runtime (ej: schema rename, endpoint URL desactualizado, testid drift):

- **NO** marcar la story `done`.
- Crear engram entry tipo `learning` o `bugfix` con cross-ref al commit de fix.
- Referenciar en el changelog de la story.

### 5. Gate 1 cerrado (deferrals)

Re-confirmar que el Gate 1 sigue cumplido: el código de la story no tiene `TODO(Story-{N}-deferral)` abiertos. Si durante el ciclo de QA aparecieron nuevos TODOs que referencian la propia story, **no** pasa a `done` hasta cerrarlos o moverlos a story aparte.

---

## Anti-patterns explícitos

### ❌ "Build verde, mergeo a main"

Build solo verifica compile + tests unitarios. NO verifica:
- que el endpoint responde 200 con auth real
- que las queries SQL ejecutan contra el schema desplegado
- que los broadcasts SignalR llegan al cliente
- que el dev panel funciona end-to-end

### ❌ "El test pasó, está OK"

Si el test usa `if (!res.ok()) test.skip(...)`, **el test puede pasar por skip**, no por verificación real. Convención TYCON: **skip-on-not-ok solo en local sin infra; en CI dedicado debe ser fail-loud**.

### ❌ "Yo ya lo probé en mi máquina"

No alcanza. Probarlo en el environment del CI (que es donde corren los E2E) o documentar la diferencia (ej: variables de entorno, seed data).

### ❌ Marcar `review` → `done` en bulk al final del sprint

Cada story debe pasar su propio gate. Si tres stories están todas en `review` y se marcan `done` el último día, la probabilidad de que todas hayan pasado el smoke check es baja.

---

## Por qué el Gate 2 — tests "verdes" que en realidad skipean

**Síntoma**: el dev panel `dev.html` reporta errores HTTP 400 en endpoints de stories que están en `review` con tests verdes.

**Causa raíz** (ejemplo): `appsettings*.json` del DevHost setea `System:TenantId="default"` (string no parseable a `int`). Un endpoint que hace `int.TryParse(userContext.TenantId, out var tid)` → falla → 400.

**Cómo se oculta**:
- Un spec con `if (!res.ok()) test.skip(true, 'Audit endpoint unavailable')` → **skipea silencioso ante 400**.
- Un helper de probe (`probeAuditEndpoint()`) que también skipea ante !ok.
- CI corre con tests "verdes" cuando en realidad están skipeando por backend roto.

**Cómo se detecta**: abriendo manualmente `dev.html` post-implementación. Los toasts rojos lo exponen.

**Fix**: corregir la configuración, y que el pipeline E2E exporte `E2E_AUDIT_REQUIRED=1` para fail-loud.

**Lección**: aplicar este checklist DoD ANTES de marcar `review`→`done`, no después de que el bug pegue en producción.

---

## Por qué el Gate 1 — `review` con deferrals abiertos

**Síntoma**: el dry-run de un demo descubre que piezas UI clave del guion no existen en runtime: unas sin implementar, otras sin wirear.

**Causa raíz**: las stories están marcadas `review` con commits verdes, advisors aprobados, tests pasando — **PERO** el propio código tiene:

```typescript
TODO(Story-{N}-deferral): wire useSignalR(signalrService).on('scan.validated', ...)
Diferido por D3 (Story {N}). Requiere también el código que dispara los scans
(form/simulator/hardware), no presente todavía.
```

→ El TODO declara explícitamente que parte del scope de la story está pendiente. La story está `review` aún con deferrals abiertos.

**Cómo se oculta**:
- El sprint accounting ("9/9 review") mira solo el frontmatter `status:`, NO los TODOs en código.
- Los deferrals quedan en `tasks/todo.md` (`[DEF-{N}-...]`) — invisible al dashboard de sprint.
- Los tests cubren el feedback visual via Storybook, NO el flow real keyboard → API → store.
- Sin `VAL-C5`, el validator no chequea `TODO(Story-X-deferral)` en código.

**Cómo se detecta**: dry-run del demo bloque por bloque, antes de mostrárselo al cliente.

**Fix**:
- Process: Gate 1 explícito en este guide.
- Automation: `VAL-C5` rule en `tycon-story-validator` que escanea TODOs y bloquea commit prep.

**Lección**: `review` significa "implementación cerrada **sin** work pendiente del propio dev del story". Si tenés deferrals → `in-progress` o creá story aparte. **No hay un estado intermedio "review-pero-con-cosas-pendientes"**.

---

## Cómo integrar al pipeline TYCON

El skill `tycon-pipeline` termina en `step-11-prepare-commit` con el commit hecho pero la story todavía en `review`. Sin embargo, dos checks SÍ están automatizados en el pipeline:

1. **Gate 1 (deferrals abiertos)** — `tycon-story-validator` rule `VAL-C5`. Step 5 del pipeline re-corre el validator post-implementación con flag de deferral check; si encuentra TODOs `Story-{N}-deferral` en archivos modificados, retorna CRITICAL y bloquea el commit prep. **Esto evita marcar review con deferrals abiertos**.

2. **Gate 2 (smoke check runtime)** — manual del QA/UAT, post-pipeline. La transición `review` → `done` queda fuera del scope automático del pipeline.

### El cierre recortado (2026-09-16)

En el paso «Probar en vivo» del pipeline, lo que **frena** es mecánico y se quedó: la matriz por AC (cada criterio
con una ejecución real, o declarado imposible y firmado por el dev), el gate E2E del proyecto, los
hooks de evidencia (`on-frontmatter-write`, `on-pre-commit`, `on-dod-evidence-guard`, `on-stop-dod-gate`)
y el portón de CI. Lo que **salió** es lo que releía esa misma evidencia con un modelo:

- **`tycon-dod-runtime-checker` es opt-in por superficie.** Lo decide
  `pipeline.js dod-checker-needed --story <spec> --repo <repo>` (exit 0 invoca, 3 no), con tres preguntas
  sobre lo **único que sólo él cubre**: un worker (`BackgroundService`/`IHostedService`) en el diff, una
  transacción compleja declarada en los ACs (rollback o compensación verificados en runtime), o una tanda
  del bloque `pipelines:` todavía en vuelo. Si el helper no puede mirar (diff roto, sin base, story
  ilegible), se invoca. La decisión queda en `gates.log` (`dod-checker-decision`).
- **El meta-audit ACCOV-C9 se retiró** y **el self-audit ACCOV-C8 es opcional** (si existe incompleto,
  avisa; si existe, la convergencia C10 sigue).
- **El step 9** (cierre en Azure DevOps) ya no relanza revisores: `pipeline.js deferrals-open` contesta
  si quedan tags `[story-N-*]` vivos o tandas abiertas.
- **El merge** no lanza la suite E2E completa en segundo plano: vuelve cuando el gate del proyecto tenga
  aislamiento por worker.

Cómo se mide si alcanza: la ficha «Los hooks del cierre» del tablero (pregunta 4) cuenta, en todas las
máquinas, cuántas decisiones de esos hooks rechazaron una evidencia. Si baja a cero mientras suben los
`NOT-RUN` de la matriz, el recorte se revisa.

Recomendación operacional:
- Al ejecutar `tycon-pipeline`, el validator del Step 5 falla si hay deferrals abiertos → forzando al dev a cerrarlos o mover a story aparte.
- Al pasar status `review` → `done` (manual o vía script), correr el checklist de §1, §2, §3, §5 (re-confirmar Gate 1 cerrado).
- Documentar el resultado del checklist en el `Dev Agent Record > Completion Notes List` de la story.

---

## Resumen one-liner

> **`review` requiere CERO deferrals abiertos del propio story.** Si tenés `TODO(Story-X-deferral)` en código que la propia story X creó, status sigue `in-progress` o se mueve a story aparte (`X.1`).
>
> **`done` requiere smoke check runtime real**: `curl` (o equivalente) contra cada endpoint que la story toca, contra DevHost real, con auth, y verificado el HTTP esperado. Build verde no alcanza.
