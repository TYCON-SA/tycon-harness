# Bizuit Plugin .NET — Guía Stack-Specific

Guía consolidada para el equipo TYCON sobre plugins backend .NET en la plataforma Bizuit. Aplica a todos los `IBackendPlugin`: Nimbo, Totora, FRESNO (varios), Ebano, Yatay, Custom Forms plugins.

> **📚 Fuente de verdad del framework**: el repo del framework de plugins (un repo del equipo).
>
> Ahí vive el código real de `Bizuit.Backend.Core`, `Bizuit.Backend.Abstractions`, `IBackendPlugin`, `SafeQueryBuilder`, `BizuitUserContext`, `IUserIdResolver`, plus plugins de ejemplo backend y frontend. **Cualquier duda sobre cómo funciona una API del framework, lifecycle, routing, auth o transacciones → consultar ese repo antes de asumir.** Esta guía es una síntesis de convenciones — el repo es la implementación real.
>
> **Sin acceso a ese repo** (un dev de otra organización): el punto de partida es el template público del plugin, <https://github.com/TYCON-SA/bizuit-custom-plugin-sample>, y los paquetes NuGet `Bizuit.Backend.Abstractions` y `Bizuit.Backend.Core`.

> **🗃️ Regla sobre schema de BD (DOTNET-W9)**: **nunca asumir estructura de tablas/columnas**. Antes de escribir queries nuevas, los devs (y los advisors) deben verificar schema real contra la BD de dev. Connection string típico en `src/DevHost/appsettings.Development.json` (o equivalente por proyecto). Si la BD no está accesible, el advisor emite WARNING explícito y el humano decide — no silencia el problema.

> **🌐 Regla de routing por entorno (BZURL / DODRT-W3)**: la URL de un endpoint **cambia de shape según el entorno**. DevHost local: `http://localhost:5001/api/{ruta}` (SIN nombre de plugin). Staging/prod vía host Bizuit: `https://<host>/api/plugins/{pluginName}/{version}/{ruta}` (CON nombre de plugin + versión — ej: `myplugin` v1.0.0 + `products` → `/api/plugins/myplugin/1.0.0/products`). **Antes de curl-ear staging/prod, armar la URL con el prefijo del plugin** — un 404 body-vacío contra staging con un path que anda en DevHost es URL mal armada, no un bug del endpoint. Detalle en §7. Incidente recurrente multi-proyecto (regla reforzada 2026-07-15).

---

## 1. Stack baseline

- **Runtime:** .NET 9.0 (C#, nullable enabled, implicit usings)
- **Framework:** `Bizuit.Backend.Core` v1.0.10+ — SafeQueryBuilder, transacciones automáticas, auth pipeline
- **Abstracciones:** `Bizuit.Backend.Abstractions` v1.0.1 — `IBackendPlugin`, `BizuitUserContext`, etc.
- **Database:** SQL Server con Dapper (parameterized vía SafeQueryBuilder)
- **API:** Minimal APIs (ASP.NET Core)
- **Testing:** xUnit (+ Moq cuando aplica)
- **Packaging:** ZIP artifact generado por pipeline Azure DevOps (o Custom Forms CI)

El plugin se distribuye como **DLL dinámico** que el Backend Host carga en runtime desde un ZIP. No es un servicio standalone.

---

## 2. IBackendPlugin — lifecycle

Todo plugin implementa `IBackendPlugin` y pasa por 5 fases:

```csharp
public class MyPluginPlugin : IBackendPlugin
{
    public string Name => "myplugin";
    public string Version => "1.0.0";

    public void ConfigureServices(IServiceCollection services, IConfiguration configuration)
    {
        var connString = configuration.GetConnectionString("Default");
        services.AddScoped<FeatureRepository>();
        services.AddScoped<FeatureService>();
    }

    public void ConfigureEndpoints(IEndpointRouteBuilder endpoints) => FeatureEndpoints.Map(endpoints);
    public void OnUnloading() { /* dispose timers, workers, etc. */ }
}
```

**Fases:**

1. **Load** — Host descubre el plugin desde el ZIP, carga el DLL en un `AssemblyLoadContext` aislado.
2. **ConfigureServices** — DI registration. Recibe `IConfiguration` con connection string y settings del panel admin. Registrar repos, services, options, HTTP clients.
3. **ConfigureEndpoints** — Registrar rutas Minimal API. Host captura las `.RequireAuthorization(roles)` y auto-pobla `BackendPluginEndpointRoles`.
4. **Runtime** — Host maneja auth pipeline, transacciones automáticas, role enforcement desde DB.
5. **Unload** — `OnUnloading()` para cleanup (workers, timers, connections). Se llama al hot-reload o shutdown.

El DI del plugin vive en un scope separado del host (ver sección 8 sobre `PluginServiceProvider`).

---

## 3. Estructura por Feature (no por Layer)

Obligatorio: cada feature es una carpeta self-contained con **todas** sus capas.

```
src/MyPlugin/
├── MyPluginPlugin.cs            # IBackendPlugin entry point
├── Features/
│   ├── Products/
│   │   ├── Models/Product.cs            # Entity + DTOs
│   │   ├── ProductsRepository.cs        # SafeQueryBuilder
│   │   ├── ProductsService.cs           # Business logic + validaciones
│   │   └── ProductsEndpoints.cs         # Minimal APIs
│   └── AuditLogs/                       # Feature sin transacción
├── Infrastructure/Json/                 # UTC converters, etc.
└── Shared/RoleConstants.cs
```

**Por qué feature-based (no layer-based):**

- **Cohesión:** todo lo que toca "Products" vive junto. Cambiar una regla toca 2-3 archivos de la misma carpeta, no 4 capas.
- **Descubribilidad:** un dev nuevo abre `Features/Products/` y ve el feature completo sin saltar entre `Repositories/`, `Services/`, `Controllers/`.
- **Desacople:** features no comparten estado. Cross-feature = Orchestrator Service (sección 6).
- **Delete-friendly:** borrar feature = borrar carpeta. No hay archivos huérfanos.

**Regla:** Features con transacción automática tienen Service layer. Features `[NoTransaction]` o de lectura simple pueden llamar Repository directo desde el Endpoint. Registro manual en `MyPluginPlugin.cs` — el scaffolder (`npm run new-feature`) crea los archivos pero vos los registrás en `ConfigureServices`/`ConfigureEndpoints`.

---

## 4. SafeQueryBuilder — OBLIGATORIO

**TODA operación de base de datos DEBE usar SafeQueryBuilder.** Nunca concatenar SQL crudo. Parametriza automáticamente — imposible tener SQL injection si se usa correctamente.

```csharp
public class ProductsRepository : SafeRepository<Product>
{
    protected override string TableName => "Products";

    public async Task<IEnumerable<Product>> SearchAsync(string? name, decimal? minPrice)
    {
        var query = Query();
        if (!string.IsNullOrEmpty(name)) query.WhereLike("Name", name);
        if (minPrice.HasValue) query.WhereGreaterThan("Price", minPrice.Value);
        return await ExecuteAsync(query);
    }

    public async Task<int> CreateAsync(CreateProductRequest req, int userId)
    {
        var insert = Insert()
            .Set("Name", req.Name).Set("Price", req.Price)
            .Set("CreatedBy", userId).Set("CreatedAt", DateTime.UtcNow);
        return await ExecuteWithIdentityAsync(insert);
    }
}
```

**Builders:** `Query()`, `Insert()`, `Update()`, `Delete()`. Exponen `.WhereEquals()`, `.WhereLike()`, `.WhereGreaterThan()`, `.WhereIn()`, `.Set()`.

**Atención:** cuando la conexión viene de `IConnectionFactory`, usar sólo tipos de `System.Data.Common` (`DbConnection`, `DbCommand`) — nunca `SqlConnection` de `Microsoft.Data.SqlClient`. El `AssemblyLoadContext` aislado del plugin causa `InvalidCastException` en producción si casteás a tipos concretos del host.

---

## 5. Transacciones automáticas

El Backend Host abre/cierra transacciones según el método HTTP. No hay que commitear/rollbackear manualmente.

| Método | Transacción | Uso |
|---|---|---|
| GET / HEAD / OPTIONS | No | Lecturas |
| POST / PUT / PATCH / DELETE | Sí | Mutaciones |

**Opt-out con `.NoTransaction()`** cuando el endpoint debe persistir aún si el contexto padre falla:

```csharp
endpoints.MapPost("audit-logs", Create).NoTransaction();    // audit trail
endpoints.MapPost("metrics", RecordMetric).NoTransaction(); // fire-and-forget
```

**Cuándo usar `[NoTransaction]`:** logs/audit trails (no deben rollbackar con la op padre), writes de alta frecuencia, integraciones con APIs externas donde el rollback no tiene sentido.

---

## 6. Orquestador pattern — Services llaman Services

**REGLA CRÍTICA:** Orchestration Services (los que coordinan múltiples features) **DEBEN llamar a otros Services, NUNCA a Repositories directamente**.

```csharp
public class OrderOrchestrationService
{
    private readonly ProductsService _products;        // Service, no Repository
    private readonly InventoryService _inventory;

    public async Task<int> PlaceOrderAsync(PlaceOrderRequest req, int userId)
    {
        // Orchestrator prepara/mapea — NO valida, NO inserta directo
        var productReq = new ReserveProductRequest { ProductId = req.ProductId, Qty = req.Qty };
        // Llama Service — el Service valida, chequea duplicados, aplica reglas
        await _products.ReserveAsync(productReq, userId);
        await _inventory.DeductAsync(req.ProductId, req.Qty, userId);
        return orderId;
    }
}
```

**Qué hace el Orchestrator:** mapear DTOs, parsear fechas/tipos, resolver IDs faltantes, llamar Services en orden, coordinar integraciones externas (BPM, APIs).

**Qué NO hace:** llamar Repositories directo (skipea validaciones del Service), implementar reglas de negocio, chequear duplicados.

**Por qué importa:**
- **Single source of truth:** las reglas viven en un solo lugar (el Service).
- **Testabilidad:** tests unitarios del Service cubren validaciones sin mockear medio sistema.
- **Invariantes:** si cambia una regla, cambia en UN lugar. Un Orchestrator con repos directos se olvida validaciones cuando la regla evoluciona.

---

## 7. Endpoints y routing

Endpoints se definen como Minimal APIs en `{Feature}Endpoints.cs` y se registran en `ConfigureEndpoints`.

```csharp
public static class ProductsEndpoints
{
    public static void Map(IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("products", GetAll).RequireAuthorization(RoleConstants.AllRoles);
        endpoints.MapPost("products", Create).RequireAuthorization(RoleConstants.AdminRoles);
        endpoints.MapDelete("products/{id:int}", Delete).RequireAuthorization(RoleConstants.AdminRoles);
    }

    private static async Task<IResult> GetAll(ProductsService service) => Results.Ok(await service.GetAllAsync());
}
```

**Prefijo automático en producción:** `/api/plugins/{pluginName}/{version}/{ruta}`. Ejemplo: `myplugin` v1.0.0 + `products` → `/api/plugins/myplugin/1.0.0/products`. En DevHost las rutas son simplificadas (sin el prefijo `/plugins/{name}`): `GET /api/products`. **Implicancia operativa**: todo curl/script/E2E contra staging o prod DEBE incluir el prefijo `/plugins/{pluginName}/{version}` — el mismo path que funciona en DevHost devuelve 404 body-vacío en el host. Ver callout BZURL al tope de esta guía.

**Naming:** rutas lowercase con guiones (`products`, `audit-logs`, `orders/items/pending`); DTOs con sufijo `Request` / `Response` (`CreateProductRequest`).

**⚠️ Un `Guid` como parámetro de ruta da 500 en el host (2026-10-02, sin reproducir todavía):**
un manejador que recibe un `Guid` desde la dirección (`"ordenes/{id}"` con `Guid id`, o
`{id:guid}`) respondió **500 en todas sus rutas y sin dejar registro**, en el host, mientras en
DevHost andaba. Con `string` o `int` la misma ruta funciona. Ningún plugin del equipo recibe hoy
un `Guid` por la ruta: todos usan `string`, también para identificadores que son Guid. Hasta
reproducirlo, recibí el identificador como `string` y convertilo adentro del manejador
(`Guid.TryParse` → `400` si no es válido). Un 500 sin registro en una ruta con Guid es esto, no
un error del servicio.

### Export genérico — recibe `columns` + `rows`, formatea, NO re-consulta

Para exportar grillas a CSV / Excel / PDF, **un único endpoint genérico** en `Features/Export/` — NO un endpoint de export por feature.

```csharp
// POST export → 200 con el archivo + Content-Disposition: attachment; filename="<slug>-<yyyymmdd-hhmm>.<ext>"
endpoints.MapPost("export", Export).RequireAuthorization(RoleConstants.AllRoles);
```

El endpoint **recibe el dataset ya resuelto** y solo lo formatea:

```csharp
public sealed class ExportRequest
{
    public string Title { get; init; } = "";
    public List<ExportColumn> Columns { get; init; } = [];   // { Key, Label }
    public List<Dictionary<string, object?>> Rows { get; init; } = [];
    public string Format { get; init; } = "";                // csv | xlsx | pdf
}
```

Reglas:

- **NO re-consulta la base.** El caller (la grilla en modo client-side) ya tiene las filas y las manda en el body. El endpoint es stateless: formatea lo que recibe. Las grillas server-side que necesiten re-query exportan con su propio path (mismo `ExportService`, distinto entry-point).
- **Un `ExportService` con 3 formatters:** CSV nativo (RFC 4180 — comillas dobles para `,`/`"`/saltos, `"` interna duplicada), Excel vía `ClosedXML`, PDF vía `QuestPDF`. La fila 1 siempre son los `Label`s de las columnas.
- **Validación con FluentValidation:** `format` dentro del enum, `columns` no vacío, `rows` bajo un cap (ej. 5000) → si no, `400` sin archivo.
- **Content-Type correcto por formato** + `Content-Disposition: attachment` con filename derivado del `title` slug + timestamp.

Esto evita N endpoints de export duplicados y mantiene el formateo (quoting CSV, workbook XLSX, paginado PDF) en un solo lugar testeable.

---

## 8. Auth — BizuitUserContext + UserIdResolver

**IMPORTANTE:** El Backend Host **NO popula `ClaimsPrincipal`** para los plugins. `context.User.Claims` está vacío. Toda la info de auth viene en `HttpContext.Items`:

| Item Key | Tipo | Contenido |
|---|---|---|
| `UserName` | `string` | Username autenticado |
| `Roles` | `string` | Roles comma-separated |
| `BizuitUserContext` | `BizuitUserContext` | Contexto completo (Username, Roles, RoleSettings) |
| `PluginServiceProvider` | `IServiceProvider` | DI container **del plugin** (no del host) |

```csharp
private static async Task<IResult> Create(HttpContext context, CreateProductRequest req)
{
    // userId numérico (para columnas INT como CreatedBy)
    var (userId, err) = await context.GetRequiredUserIdAsync();
    if (err != null) return err;

    var user = context.Items["BizuitUserContext"] as BizuitUserContext;
    if (user?.HasRole("Administrators") == true) { /* ... */ }

    var service = context.RequestServices.GetRequiredService<ProductsService>();
    var id = await service.CreateAsync(req, userId);
    return Results.Created($"/products/{id}", new { id });
}
```

**UserIdResolver:** singleton con cache. Lee username de `Items["UserName"]` (host) o `Identity.Name` (DevHost), ejecuta `SELECT UserId FROM Users WHERE UserName = @u` una sola vez por username, devuelve `int` usable en `CreatedBy`/`UpdatedBy`.

**Resolución DI en código estático:** usar `PluginServiceProvider` (no `RequestServices`, que apunta al host y devuelve null):

```csharp
var sp = context.Items["PluginServiceProvider"] as IServiceProvider ?? context.RequestServices;
var myService = sp.GetRequiredService<MyService>();
```

**RoleConstants** — nunca hardcodear roles sueltos:

```csharp
public static class RoleConstants
{
    public const string AllRoles = "Administrators,BizuitAdmins,{PluginName}Admins,Operadores,Supervisores";
    public const string AdminRoles = "Administrators,BizuitAdmins,{PluginName}Admins";
}
```

Los roles default se auto-populan en `BackendPluginEndpointRoles` al primer load. Admins los modifican desde el panel sin redeployment.

---

## 9. Tests (xUnit)

Tests en `tests/{Plugin}.Tests/`. Usar xUnit + Moq cuando aplica.

**Naming obligatorio:** `MethodName_Scenario_ExpectedResult`

```csharp
[Fact]
public async Task CreateAsync_WithDuplicateName_Throws()
{
    var repo = new Mock<ProductsRepository>();
    repo.Setup(r => r.ExistsByNameAsync("Foo")).ReturnsAsync(true);
    var sut = new ProductsService(repo.Object);

    await Assert.ThrowsAsync<InvalidOperationException>(
        () => sut.CreateAsync(new() { Name = "Foo" }, userId: 1));
}
```

**Ejemplos reales:** `PostPedidos_NoApiKey_Returns401`, `CreateUser_WithDuplicateEmail_Returns409`, `Despachar_PedidoNotFound_Returns404`, `ArmadoListo_WithValidPayload_StoresMetadata`.

**Filtrado:**
```bash
dotnet test                                                     # todos
dotnet test --filter "FullyQualifiedName~ProductsServiceTests"  # una clase
dotnet test --filter "Category!=Integration&Category!=EdgeCase" # solo unit (CI)
```

**Estrategia:** focus en reglas de negocio del Service. Cada Acceptance Criteria → al menos un test. Para exponer constantes internas a tests, usar `internal` + `InternalsVisibleTo` en csproj.

---

## 10. plugin.json ↔ plugin.json.example en sync

El pipeline CI usa `plugin.json.example` como base del ZIP deployment (evita incluir credenciales reales). Cuando modificás `plugin.json`, **DEBÉS** actualizar también `plugin.json.example`.

- `plugin.json` → desarrollo local, puede tener valores reales
- `plugin.json.example` → template CI/CD, valores vacíos / defaults

**Qué pasa si te olvidás:** pipeline buildea con `.example` desactualizado → settings nuevas no aparecen en el panel admin → plugin falla al cargar o usa defaults incorrectos.

**No modificar `version` manualmente** — el pipeline en `main` hace bump automático. Cambios manuales causan conflictos de merge.

**CI trigger scope:** el pipeline de `main` se dispara con cambios en `src/**`, `database/**`, `scripts/**`, `tests/**`, `plugin.json`, `plugin.json.example`, `package.json`, `azure-pipelines.yml` y `.tycon/**` (la lista de Totora, FRESNO, Ebano y Pacara desde el 2026-09-02; no todos los backends la tienen, y la fuente de verdad es el `trigger.paths.include` del `azure-pipelines.yml` de cada repo). Cambios sólo en `docs/`, `tasks/` o `CLAUDE.md` no disparan CI.

---

## 11. Anti-patrones

### SQL crudo
```csharp
// MAL
var sql = $"SELECT * FROM Products WHERE Name = '{name}'";  // SQL injection
// BIEN
var query = Query().WhereEquals("Name", name);
return await ExecuteAsync(query);
```

### Endpoint llamando Repository directo (cuando hay transacción)
```csharp
// MAL — saltea validaciones del Service
endpoints.MapPost("products", async (CreateProductRequest req, ProductsRepository repo)
    => Results.Ok(await repo.CreateAsync(req, userId)));

// BIEN — Endpoint → Service → Repository
endpoints.MapPost("products", async (CreateProductRequest req, ProductsService svc, HttpContext ctx) => {
    var (userId, err) = await ctx.GetRequiredUserIdAsync();
    return err ?? Results.Ok(await svc.CreateAsync(req, userId));
});
```

### ClaimsPrincipal en lugar de BizuitUserContext
```csharp
// MAL — Claims está vacío en producción (el host no las popula)
var username = context.User.Identity?.Name;               // null
var isAdmin = context.User.IsInRole("Administrators");    // false siempre

// BIEN — HttpContext.Items
var user = context.Items["BizuitUserContext"] as BizuitUserContext;
var (userId, err) = await context.GetRequiredUserIdAsync();
```

### Orchestrator con repos directos
```csharp
// MAL
public class BadOrchestrator {
    private readonly ProductsRepository _repo;            // Repo directo
    public async Task ProcessAsync(...) {
        var exists = await _repo.ExistsAsync(id);         // Validación acá
        if (exists) throw new Exception();
        await _repo.InsertAsync(...);                     // Skipea Service
    }
}

// BIEN — Orchestrator thin coordinando Services
public class GoodOrchestrator {
    private readonly ProductsService _products;
    public async Task ProcessAsync(...) => await _products.CreateAsync(req, userId);
}
```

### Tests de performance: se asserta lo que el cambio toca, el agregado se reporta (2026-09-06)

Regla `TEST-W10` del catálogo. Por qué: un test que asserta que baje el **total** de lecturas de
todas las tablas da rojo en CI con el merge hecho, aunque el arreglo ande. Medido con un mismo
arreglo: en el agente de CI el total **subió** (1.329 → 1.928) mientras las lecturas de la tabla
tocada bajaron igual que en la máquina
del dev (659 → 321): el total depende del **plan** que el motor SQL elige en cada entorno (versión,
estadísticas, volumen sembrado), no del cambio de código. Ningún revisor lo ve antes del merge.

- **Se asserta** la métrica que el cambio causa directamente: las lecturas de la tabla o de la
  operación tocada, medidas con `SET STATISTICS IO` (o equivalente) antes y después.
- **Se reporta, no se asserta**, el agregado entre tablas: se mide igual y va en el mensaje de
  falla, para poder diagnosticar un rojo futuro sin volver a instrumentar.
- Si una misma story afloja una afirmación tras un rojo por **segunda vez**, la nota en la story
  tiene que responder la pregunta de fondo —¿el AC estaba mal escrito, o el entorno de verificación
  nunca fue representativo?— y no sólo describir la instancia.

### No tests
No commitear features sin tests. Cada AC → al menos un test. Si no podés escribir un test, el AC es vago — reescribirlo.

### Mezclar folder por feature y por layer
```
// MAL — inconsistente
src/MyPlugin/
├── Features/Products/...           # feature-based
├── Repositories/AuditLogs.cs       # layer-based
├── Services/NotificationService.cs # layer-based

// BIEN — todo feature-based
src/MyPlugin/Features/{Products,AuditLogs,Notifications}/...
```

### `IConfiguration` vía DI constructor (DOTNET-C4 / VAL-C2)

El Backend Host (el sitio `*BIZUITExtensionsAPI` de cada producto) **NO registra `IConfiguration`** en el container de plugins. Inyectarla en ctor falla al runtime con `InvalidOperationException: Unable to resolve service for type 'Microsoft.Extensions.Configuration.IConfiguration' while attempting to activate '{Service}'` → HTTP 500 con body vacío al primer request que resuelve el servicio.

**Local funciona** (el DevHost usa DI nativo ASP.NET), **IIS prod no**. Por eso el dev agent puede pasar todos los tests unitarios, commitear, deployar, y **romper prod** sin darse cuenta. Ejemplo: el ctor de `PedidosService` agrega `IConfiguration` para leer `Pedidos:RetiroWebhookWaitMs` — pipeline verde local, 500 en staging post-deploy.

**Fix preferido — `IOptions<T>` con POCO:**

```csharp
// POCO en Features/Pedidos/Models/
public class PedidosOptions
{
    public int RetiroWebhookWaitMs { get; set; } = 8000;
}

// En ConfigureServices (IBackendPlugin)
services.Configure<PedidosOptions>(configuration.GetSection("Pedidos"));
services.AddScoped<PedidosService>();

// Service ctor
public PedidosService(..., IOptions<PedidosOptions> pedidosOptions)
{
    _pedidosOptions = pedidosOptions.Value;
}
```

`IOptions<T>` **SÍ está** registrado en el scope de plugins por el loader. Strong typing + testable (tests pasan `Options.Create(new PedidosOptions { ... })`).

**Fix legacy — factory con closure sobre `configuration`** (aceptable pero menos preferible, rompe lifetime y dificulta override en tests):

```csharp
services.AddSingleton<MyService>(sp => new MyService(configuration));
```

**MAL — pseudocódigo que va a explotar en IIS:**

```csharp
// MAL — DI no resuelve IConfiguration → InvalidOperationException en runtime
services.AddScoped<PedidosService>();

public class PedidosService
{
    public PedidosService(..., IConfiguration configuration) { ... }
    // ...
    var ms = _configuration.GetValue<int>("Pedidos:RetiroWebhookWaitMs", 8000);
}
```

### `sp.GetRequiredService<IConfiguration>()` dentro de factory delegate — ANTIPATRON (DOTNET-C4)

Variante del mismo bug, camuflada en factory delegates. El plugin loader **NO registra `IConfiguration`** en el SP — pedirla via `sp.GetRequiredService/GetService` explota al runtime igual que ctor injection. Es **lazy y latente**: un `AddSingleton<T>()` solo corre su factory al primer resolve, así que el bug puede dormir meses hasta que alguien ejerce el path.

**MAL — factory que pide IConfiguration al SP:**

```csharp
services.AddSingleton<RetiroWebhookSecurityService>(sp =>
{
    var config = sp.GetRequiredService<IConfiguration>();  // ← explota al primer webhook
    var service = new RetiroWebhookSecurityService(config);
    if (config.GetValue<bool>("Pedidos:DisableWebhookIpWhitelist"))
    {
        var logger = sp.GetRequiredService<PluginLogger>();
        _ = logger.LogWarningAsync("...");
    }
    return service;
});
```

Error en runtime:
```
System.InvalidOperationException: No service for type
  'Microsoft.Extensions.Configuration.IConfiguration' has been registered.
  at NimboBackendPlugin.<>c.<ConfigureServices>b__3_6(IServiceProvider sp)
```

**BIEN — closure sobre el param `configuration`** (patrón ya usado por `PluginLogger`):

```csharp
services.AddSingleton<RetiroWebhookSecurityService>(sp =>
{
    var service = new RetiroWebhookSecurityService(configuration);  // closure sobre el param
    if (configuration.GetValue<bool>("Pedidos:DisableWebhookIpWhitelist"))
    {
        var logger = sp.GetRequiredService<PluginLogger>();  // PluginLogger SI está en el SP, OK
        _ = logger.LogWarningAsync("...");
    }
    return service;
});
```

Regla dura: **nunca** hacer `sp.GetRequiredService<IConfiguration>()` ni `sp.GetService<IConfiguration>()` en código del plugin. Usar `configuration` capturado del param de `ConfigureServices(IServiceCollection services, IConfiguration configuration)` via closure. Otros deps registrados por el plugin (como `PluginLogger`) sí se pueden pedir al `sp`.

**Por qué es dura**: una factory así puede existir semanas sin explotar, hasta que el primer request real (por ejemplo, un webhook de un proveedor) resuelve el servicio en el host.

### Otras dependencies NO whitelisted (DOTNET-C5)

El plugin loader **solo expone** un subset del DI container del host:

**Whitelist (safe):**
- `IOptions<T>`, `IOptionsSnapshot<T>`, `IOptionsMonitor<T>`
- Repos/services registrados por el propio plugin
- `HttpClient` via named factory (`IHttpClientFactory`)
- `PluginLogger` (NO usar `ILogger<T>` nativo)
- Entidades `Microsoft.Extensions.Caching.*`
- `TimeProvider`

**Blacklist (explota en runtime):**
- `IConfiguration` (usar `IOptions<T>`)
- `ILogger<T>` de `Microsoft.Extensions.Logging` (usar `PluginLogger`)
- `IHostApplicationLifetime`, `IWebHostEnvironment`, `IServer`, `IApplicationBuilder`
- `IHttpContextAccessor` (verificar con el equipo del loader antes de asumir)

### Tipos de `Microsoft.Data.SqlClient` con `IConnectionFactory`
Usar sólo `System.Data.Common`. Castear a `SqlConnection` causa `InvalidCastException` en producción por el `AssemblyLoadContext` separado del plugin.

### Parsers estrictos con el esquema — sin campos propios en el JSON

Si el plugin parsea mensajes de un estándar de intercambio con un SDK que es **estricto con los campos que no están en el esquema**: agregar campos propios en línea al JSON (ej. `_purpose` como comentario, `_internal_note`, etc.) rompe el parser con una `FormatException` que no dice qué campo sobra.

**Regla:**
- NUNCA agregar campos fuera del esquema a los mensajes que vayan a parsearse.
- Para "comentarios inline" sobre fixtures de tests, usar archivos sidecar `.md` (ej. `pedido-estandar.json` + `pedido-estandar.notes.md`).
- Si necesitás metadata extra en producción: usar el mecanismo de extensión que el propio estándar define, con un identificador propio (`urn:bizuit:plugin:<name>:<key>`), conforme a la especificación.

Aplica a cualquier plugin Bizuit que parsee un estándar con un SDK estricto.

---

## 12. Fechas y horas

Las fechas se **persisten y serializan en UTC**. El cliente las convierte a la zona horaria del usuario (ver guía React §19 "Fechas y horas").

- En código: `DateTime.UtcNow` — **nunca `DateTime.Now`**. `DateTime.Now` mezcla la TZ del servidor en los datos y rompe la trazabilidad inequívoca (en entornos regulados — 21 CFR Part 11 — el audit trail exige timestamps sin ambigüedad de zona).
- Columnas SQL `datetime2` (sin offset) — válido **porque el código escribe UTC de forma consistente**. Usar `datetimeoffset` solo si se necesita preservar el offset original de captura.
- **Serialización JSON:** un `JsonConverter<DateTime>` que emite el sufijo `Z` (UTC explícito) — sin el `Z`, el navegador interpreta la cadena como hora local y la fecha se muestra corrida.
- **Lectura Dapper:** un `SqlMapper.TypeHandler<DateTime>` registrado global (`SqlMapper.AddTypeHandler`) que marca todo `DateTime` leído como `DateTimeKind.Utc`. SQL Server NO preserva el `Kind` → sin el handler, el `DateTime` sale `Unspecified` y el converter no agrega el `Z` (o lo doble-shiftea).

> Anti-patrón: `DateTime.Now`, o serializar `DateTime` sin converter UTC (el cliente
> recibe una cadena sin `Z` y la parsea como hora local).

---

## 13. Grillas server-side — sort con whitelist, filtros, export re-query

Cuando un endpoint de lista alimenta una grilla server-side (paginación + sort + export):

- **`sortBy` NUNCA se interpola crudo en SQL.** Resolverlo contra una whitelist
  `Dictionary<string,string>` key-pública→columna-SQL (case-insensitive). `sortBy` fuera
  de la whitelist → cae al `ORDER BY` default del endpoint (NO `400`, NO error). `sortDir`
  fuera de `{asc,desc}` → `asc`. Patrón: helper `GridSort.ResolveOrderBy(...)`.
- **Envelope `{ items, total }`** (`PagedResult<T>`): `total` es el `COUNT(*)` del dataset
  completo tenant-scoped **post-filtro**, no de la página.
- **Filtros parametrizados.** Todo filtro (texto libre, `etapa`, etc.) va como parámetro
  Dapper (`@Filter`, `@Etapa`), nunca interpolado. Para matching tolerante a acentos/case
  usar `COLLATE Latin1_General_CI_AI` en la comparación (`WHERE Col = @Param COLLATE
  Latin1_General_CI_AI`) — defensa ante data histórica inconsistente.
- **Export server-side = re-query.** El endpoint de export (`GET .../export?format=...`)
  re-consulta el dataset COMPLETO sin paginar con el `sortBy`/`sortDir`/filtros actuales y
  lo pasa a `IExportService.Generate`. NUNCA exportar "lo que el front mandó" — el front
  solo tiene una página. Método repo dedicado `ListAllForExportAsync(...)`.

---

## Referencias

- **Skill core:** `~/.claude/skills/bizuit-backend-plugin-system/`
- **Skill SafeQueryBuilder:** `~/.claude/skills/safe-query-builder/`
- **Skill Dapper+SqlServer:** `~/.claude/skills/dotnet-dapper-sqlserver/`
- **Skill feature CRUD:** `~/.claude/skills/feature-based-crud-endpoints/`
- **Template oficial (público):** <https://github.com/TYCON-SA/bizuit-custom-plugin-sample> — el esqueleto del plugin, sus pruebas y el host de desarrollo local (`src/DevHost/`). Para un plugin nuevo, se parte de ahí.
- **Template de formularios (público):** <https://github.com/TYCON-SA/bizuit-custom-form-sample> — la infraestructura del formulario (build, pruebas, tsconfig) y un primer formulario.
- **Ejemplos productivos:** Pacara BackEnd, Totora Backend, FRESNOBZExtBackend, EbanoPluginBackEnd
