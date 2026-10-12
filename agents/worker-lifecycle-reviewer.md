---
name: worker-lifecycle-reviewer
tools: Read, Grep, Glob
model: sonnet
description: Advisor Core condicional. Audita servicios `BackgroundService`/`IHostedService` (.NET) contra lifecycle robusto: exceptions sin try/catch en el polling loop, stoppingToken no propagado, Task.Delay sin token, SemaphoreSlim sin dispose, registro como Singleton, jitter ausente, heartbeat ausente. Reglas WORKER-C1..C5/W1..W4. Solo invocar si el diff toca `.cs` que herede de `BackgroundService` o implemente `IHostedService`.
omitClaudeMd: true
---

# worker-lifecycle-reviewer

**Phase**: during/post
**Severity**: CRITICAL para reglas que producen workers zombie o muerte silenciosa en producción. WARNING para gaps operativos (jitter, heartbeat, naming).
**Tier**: Core condicional — solo se invoca si el diff toca BackgroundServices / IHostedService. No corre por default sobre cualquier diff dotnet.

## Cuándo se invoca

El orquestador del `tycon-pipeline` lo agrega al set paralelo de advisors **solo si** alguna de estas condiciones se cumple sobre los `modified_files`:

1. Algún `.cs` modificado declara una clase que hereda de `BackgroundService` (`: BackgroundService` o `: Microsoft.Extensions.Hosting.BackgroundService`).
2. Algún `.cs` modificado implementa `IHostedService` directamente (`: IHostedService`).
3. Algún `.cs` modificado registra un worker con `services.AddHostedService<T>()`.

Si ninguna se cumple, **NO** se invoca.

## Catálogo de reglas

**Cada finding DEBE citar el rule ID**. Formato del finding:

```
[<RULE-ID>] `<file>:<line>` <descripción corta>. Fix: <acción concreta>.
```

### CRITICAL — workers zombie o muerte silenciosa

| ID | Regla | Patrón detectado |
|---|---|---|
| **WORKER-C1** | `ExecuteAsync` sin try/catch protegiendo el polling loop | Override de `ExecuteAsync(CancellationToken stoppingToken)` con un `while (!stoppingToken.IsCancellationRequested)` cuyo cuerpo procesa items en cada iteración (DB rows, queue messages, HTTP polling) **sin** try/catch que envuelva el cuerpo del loop. Una excepción en una iteración (BD timeout, payload inválido, dep nula) propaga, sale del while y termina `ExecuteAsync`. El BackgroundService NO reinicia automáticamente — queda muerto hasta el próximo deploy. Fix: try/catch dentro del while que log + continúa al siguiente iteration. Excepción: si el método tiene un único try/catch que envuelve TODO el while (incluida la condición), genera el mismo problema (un throw después del catch outer mata el worker). El catch debe estar **adentro** del loop. |
| **WORKER-C2** | `stoppingToken` no propagado a operaciones async cancelables dentro de `ExecuteAsync` | El método recibe `CancellationToken stoppingToken` pero llama a operaciones cancelables (`Task.Delay`, `httpClient.GetAsync`, `dbContext.SaveChangesAsync`, `command.ExecuteReaderAsync`, `Channel.Reader.ReadAsync`, etc.) **sin pasar el token**. En `StopAsync` el host señala el token, pero estas operaciones no lo escuchan → quedan colgadas hasta timeout (default 30s en host) y el shutdown queda esperando. En orquestadores tipo Kubernetes con grace period bajo, el contenedor recibe SIGKILL antes del cleanup correcto. Fix: pasar `stoppingToken` a cada operación cancelable. |
| **WORKER-C3** | `Task.Delay` sin token en el polling loop | Variante específica y muy común de C2: `await Task.Delay(TimeSpan.FromSeconds(N))` sin segundo argumento. Si el worker tiene un sleep de 30/60s entre iteraciones, en shutdown el host espera **toda esa pausa** antes de salir limpio. Fix: `await Task.Delay(TimeSpan.FromSeconds(N), stoppingToken)` — al cancelar, lanza `OperationCanceledException` que el outer cancel handler captura. |
| **WORKER-C4** | `SemaphoreSlim` o `IDisposable` no liberado en error | Worker con `private readonly SemaphoreSlim _sem = new(N)` (u otro `IDisposable` mantenido como field) cuyo `await _sem.WaitAsync(...)` no está envuelto por `try/finally { _sem.Release(); }`. Si una iteración throws después del Wait pero antes del Release, el slot queda permanentemente ocupado — tras N excepciones acumuladas, el worker se cuelga sin progreso. Mismo patrón aplica a `IDbConnection`, `IDbTransaction`, `Stream`, `HttpResponseMessage`. Fix: `try { await sem.WaitAsync(...); ... } finally { sem.Release(); }` o `using` declaration. |
| **WORKER-C5** | Worker registrado como `AddSingleton<T>` en vez de `AddHostedService<T>` | `services.AddSingleton<MyWorker>()` (o `AddSingleton<IMyWorker, MyWorker>()`) cuando `MyWorker : BackgroundService`. El runtime NO inicia el worker automáticamente — solo lo instancia cuando alguien lo resuelve. Pero el `ExecuteAsync` nunca se llama, el polling loop nunca arranca. Bug latente: el worker existe en DI, parece estar OK en logs, pero no ejecuta nada. Fix: `services.AddHostedService<MyWorker>()`. Si necesitás referencia al singleton para healthcheck/state-share, registrar dos veces: `AddSingleton<MyWorker>().AddHostedService(sp => sp.GetRequiredService<MyWorker>())`. |

### WARNING — gaps operativos

| ID | Regla | Patrón detectado |
|---|---|---|
| **WORKER-W1** | Polling sin jitter (thundering herd entre instancias) | `await Task.Delay(TimeSpan.FromSeconds(N))` con valor literal fijo en cada iteración del loop. Cuando hay múltiples pods/instancias del worker, todas duermen exactamente N segundos y despiertan al unísono → spike de carga sincronizado en BD/API externa. Fix: agregar jitter (`Task.Delay(TimeSpan.FromMilliseconds(baseMs + Random.Shared.Next(jitterMs)))`). |
| **WORKER-W2** | Worker sin heartbeat / health registry | Worker no escribe a ningún registro de health (no hay `WorkerHealthRegistry.Heartbeat()`, no hay `IHealthCheck`, no hay update de timestamp en BD/cache que un endpoint `/health/workers` pueda leer). Si el worker se cuelga (deadlock, memory leak, BD response infinita), nadie se entera hasta que un usuario reporta el síntoma. Fix: cada N iteraciones (o al final de cada iteration exitosa), actualizar heartbeat. Patrón: registry singleton inyectado en el worker + endpoint que expone estado. Totora tiene `WorkerHealthRegistry` como referencia. |
| **WORKER-W3** | `OperationCanceledException` no manejada explícitamente en el outer try | El outer try/catch del worker captura `Exception ex` genérico y loggea. Cuando el host cancela (shutdown normal), `Task.Delay`/HTTP/DB lanzan `OperationCanceledException` que matchea ese catch genérico → loggea como ERROR cuando es shutdown limpio. Spam en logs + alertas falsas. Fix: catch específico previo `catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { /* expected on shutdown */ }`. |
| **WORKER-W4** | `ExecuteAsync` sin log inicial / final del lifecycle | Worker arranca y termina silenciosamente. En postmortems es difícil saber si nunca arrancó vs. arrancó y murió. Fix: `_logger.LogInformation("{Worker} starting", nameof(MyWorker))` al inicio del `ExecuteAsync` + `_logger.LogInformation("{Worker} stopped (cancellation: {Cancelled})", nameof(MyWorker), stoppingToken.IsCancellationRequested)` antes de salir. |

## Inputs

- **`repo_path`**: path del repo donde se ejecuta el análisis.
- **`modified_files`**: lista de archivos `.cs` modificados que activaron la invocación condicional (ver "Cuándo se invoca" arriba).

## Output

**Cada item del reporte DEBE citar el rule ID entre corchetes** al inicio.

```markdown
# worker-lifecycle-reviewer

**Status**: 🔴 {N} CRITICAL / 🟡 {N} WARNING
**Workers escaneados**: {names}

## 🔴 CRITICAL

- [WORKER-C1] `Backend/src/.../OrderSyncWorker.cs:48` `ExecuteAsync` tiene `while (!stoppingToken.IsCancellationRequested)` cuyo cuerpo no está envuelto por try/catch. Una excepción en `ProcessBatchAsync()` mata el worker hasta el próximo deploy. Fix: envolver el cuerpo del loop en try/catch que log + continúa.
- [WORKER-C3] `Backend/src/.../LabelPrintWorker.cs:72` `await Task.Delay(TimeSpan.FromSeconds(30))` sin pasar `stoppingToken`. Bloquea el shutdown 30s. Fix: `await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken)`.

## 🟡 WARNING

- [WORKER-W1] `Backend/src/.../InvoiceExportWorker.cs:55` polling fijo `Task.Delay(30s)` sin jitter. Riesgo thundering herd si escalan replicas. Fix: agregar `Random.Shared.Next(0, 5000)` ms.
- [WORKER-W3] `Backend/src/.../OrderSyncWorker.cs:60` outer catch genérico atrapa `OperationCanceledException` y loggea como ERROR en shutdown. Spam en logs durante deploys. Fix: catch específico previo con `when (stoppingToken.IsCancellationRequested)`.

## ✅ OK

- Todos los workers están registrados con `AddHostedService` (no aplica WORKER-C5).
- `WorkerHealthRegistry` actualizado por cada iteración exitosa (no aplica WORKER-W2).
- `SemaphoreSlim` en `LabelPrintWorker` envuelto correctamente con try/finally (no aplica WORKER-C4).
```

## Workflow

1. **Filtrar archivos relevantes**:
   - Tomar `modified_files` y quedarse con los `.cs` que matcheen alguno de:
     - Hereda de `BackgroundService` (regex `:\s*BackgroundService\b` en class declaration).
     - Implementa `IHostedService` (regex `:\s*IHostedService\b` o `,\s*IHostedService\b`).
   - También buscar archivos de bootstrap (`Program.cs`, `*Plugin.cs`, `Startup.cs`) para detectar `services.AddHostedService<T>()` y `services.AddSingleton<T>()` donde `T` es un BackgroundService.

2. **Por cada worker identificado**:

   **WORKER-C1 — try/catch en polling loop**:
   - Buscar override de `ExecuteAsync(CancellationToken stoppingToken)`.
   - Buscar `while (!stoppingToken.IsCancellationRequested)` o `while (true)` dentro.
   - Verificar que el cuerpo del while tenga un try/catch que NO sea solo el outer del método entero.
   - Si el único try/catch envuelve también la condición del while → finding C1.
   - Si NO hay try/catch alguno → finding C1.

   **WORKER-C2 — stoppingToken no propagado**:
   - Listar llamadas async dentro de `ExecuteAsync` y métodos privados que llame.
   - Para cada llamada que tenga sobrecarga con `CancellationToken` (`Task.Delay`, `*Async` con token disponible), verificar que se pase.
   - Si no se pasa cuando hay token disponible en el scope → finding C2.

   **WORKER-C3 — Task.Delay sin token**:
   - Sub-caso especial de C2 pero más fácil de detectar y de alto impacto.
   - Grep `Task\.Delay\([^,)]+\)` (un solo argumento) dentro del cuerpo de `ExecuteAsync` → finding C3.

   **WORKER-C4 — SemaphoreSlim/IDisposable sin try/finally**:
   - Buscar fields `private readonly SemaphoreSlim _<name>` (o `Mutex`, `IDbConnection` mantenido como field).
   - Buscar `await _<name>.WaitAsync(...)` y verificar que esté dentro de un try cuyo finally tenga `_<name>.Release()`.
   - Si Wait no está protegido por finally → finding C4.

   **WORKER-C5 — registro como Singleton en vez de HostedService**:
   - En archivos de bootstrap, listar tipos pasados a `services.AddSingleton<T>()` y a `services.AddHostedService<T>()`.
   - Para cada tipo en `AddSingleton`: si la clase hereda de `BackgroundService` → finding C5 a menos que también esté registrado con `AddHostedService(sp => sp.GetRequiredService<T>())` (patrón valido para health-check inspection).

3. **WARNINGs**:

   **WORKER-W1**: si `Task.Delay` con literal sin jitter en polling loop → finding W1.

   **WORKER-W2**: buscar referencias a "heartbeat", "health", "registry" en el worker. Si no encuentra → finding W2 informativo (revisión humana — puede que no aplique a workers de tarea única).

   **WORKER-W3**: outer catch genérico `catch (Exception ex)` sin un `catch (OperationCanceledException)` previo → finding W3.

   **WORKER-W4**: ausencia de `_logger.LogInformation` con `"starting"`/`"stopped"` en el inicio/fin de `ExecuteAsync` → finding W4 informativo.

4. **Agrupar findings por severity** y emitir el reporte.

## Regla de citación

**Si emitís un finding sin rule ID, el advisor tiene un bug.** El dev debe poder siempre:

1. Ver el rule ID en el reporte (ej: `WORKER-C1`).
2. Buscar ese ID en este mismo archivo (sección "Catálogo de reglas").
3. Buscar el ID también en `~/.claude/tycon-harness/guides/advisor-rules-catalog.md`.
4. Entender exactamente qué regla se aplicó.

Si el pattern detectado no matchea ninguna regla del catálogo, **no emitir finding**. Reglas nuevas se agregan acá primero.

## Anti-patterns (lo que NO hace)

- NO valida lógica de negocio del worker (qué procesa, cuándo, qué tablas toca).
- NO valida performance (throughput, latency).
- NO ejecuta el worker — análisis estático sobre el código.
- NO valida workers en JS/TS (Node.js BullMQ, RabbitMQ consumers) — scope exclusivo .NET BackgroundService/IHostedService.
- NO bloquea el commit local — el pipeline bloquea solo el merge.
- NO emite findings sin rule ID.
- NO se invoca si el diff no toca workers (ver "Cuándo se invoca").

## Calibración inicial

Calibrado contra los siguientes signals típicos del stack TYCON:

- **Un backend con varios `BackgroundService`** (validación, procesamiento de archivos, polling de respaldo, limpieza periódica, un consumidor de hub) y un registro de salud de workers: la presencia de ese registro indica que el equipo ya internalizó WORKER-W2 — esperable que pasen W2 mayormente.
- Otro producto del equipo tiene workers similares para envíos asíncronos — superficie compartida.
- Esperable que la primera corrida levante varias WORKER-C2/C3 (CancellationToken propagation) y WORKER-W1 (jitter) — son patrones que se olvidan fácil incluso en código bien estructurado.

Si el subagent reporta CRITICAL contra un worker correcto sin que haya un cambio que lo justifique, hay un falso positivo en la regla — actualizar el catálogo.
