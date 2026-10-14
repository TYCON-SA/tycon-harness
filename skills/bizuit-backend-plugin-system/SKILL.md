---
name: bizuit-backend-plugin-system
description: Bizuit Backend Plugin System with IBackendPlugin interface, automatic transaction management, and dependency injection. Use when asked about "backend plugins", "IBackendPlugin", "ConfigureServices", "ConfigureEndpoints", "plugin lifecycle", "transaction management by HTTP method", or "how to create a backend plugin for Bizuit".
metadata:
  author: tycon-team
  version: "1.0.1"
  last-updated: "2026-01-28"
  changelog: |
    v1.0.1 - Added PluginConfigCache documentation (security + metadata caching)
    v1.0.0 - Initial version from TotoraBackend patterns
---

# Bizuit Backend Plugin System

Complete guide to building backend plugins for Bizuit using the `IBackendPlugin` interface with automatic DI, transaction management, and endpoint routing.

## Core Principles

1. **Plugin-Based Architecture** - Each plugin is a self-contained module with its own services and endpoints
2. **Automatic Transaction Management** - Transactions based on HTTP method (POST/PUT/PATCH/DELETE = transactional)
3. **Dependency Injection** - Full ASP.NET Core DI support
4. **Lifecycle Management** - Plugins can be loaded/unloaded without restarting the host
5. **Multi-Tenant** - Each plugin instance is isolated per tenant

## When to Use This Skill

Use this skill when you need to:
- Create a new backend plugin for Bizuit
- Understand the plugin lifecycle (load → configure → unload)
- Configure services and endpoints
- Implement transaction management
- Use Bizuit Backend Core services (SafeQueryBuilder, etc.)
- Integrate with Bizuit BPM API
- Set up background workers (IHostedService)

## Quick Start

### 1. Create Plugin Class

```csharp
using Bizuit.Backend.Abstractions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace MyPlugin;

public class MyPluginBackend : IBackendPlugin
{
    public PluginInfo Info => new()
    {
        Name = "myplugin",
        Version = "1.0.0",
        Description = "My Custom Backend Plugin",
        Author = "Your Name"
    };

    public void ConfigureServices(IServiceCollection services, IConfiguration configuration)
    {
        // Register services here
    }

    public void ConfigureEndpoints(IPluginEndpointBuilder endpoints)
    {
        // Register endpoints here
    }

    public void OnUnloading()
    {
        // Cleanup resources
    }
}
```

### 2. Register Services

```csharp
public void ConfigureServices(IServiceCollection services, IConfiguration configuration)
{
    // Get connection string from plugin configuration
    var connectionString = configuration.GetConnectionString("Default");

    // Add Bizuit Backend Core (SafeQueryBuilder, IConnectionFactory, etc.)
    services.AddBizuitBackendCore(connectionString);

    // Register repositories
    services.AddScoped<UsersRepository>();

    // Register services
    services.AddScoped<UsersService>();

    // Register validators (FluentValidation)
    services.AddScoped<IValidator<CreateUserRequest>, CreateUserRequestValidator>();
}
```

### 3. Register Endpoints

```csharp
public void ConfigureEndpoints(IPluginEndpointBuilder endpoints)
{
    UsersEndpoints.Map(endpoints);
    // Other feature endpoints...
}
```

**Endpoints class:**

```csharp
public static class UsersEndpoints
{
    public static void Map(IPluginEndpointBuilder endpoints)
    {
        // GET /api/plugins/myplugin/users
        endpoints.MapGet("users", GetAll)
            .RequireAuthorization()
            .RequireRoles("Administrators", "Users");

        // GET /api/plugins/myplugin/users/{id}
        endpoints.MapGet("users/{id:int}", GetById)
            .RequireAuthorization();

        // POST /api/plugins/myplugin/users (transactional)
        endpoints.MapPost("users", Create)
            .RequireAuthorization()
            .RequireRoles("Administrators");

        // PUT /api/plugins/myplugin/users/{id} (transactional)
        endpoints.MapPut("users/{id:int}", Update)
            .RequireAuthorization()
            .RequireRoles("Administrators");

        // DELETE /api/plugins/myplugin/users/{id} (transactional)
        endpoints.MapDelete("users/{id:int}", Delete)
            .RequireAuthorization()
            .RequireRoles("Administrators");
    }

    // Handler methods...
    private static async Task<IResult> GetAll(UsersService service)
    {
        var users = await service.GetAllAsync();
        return Results.Ok(users);
    }

    // ... other handlers
}
```

---

## IBackendPlugin Interface

### Properties

```csharp
public interface IBackendPlugin
{
    PluginInfo Info { get; }
    void ConfigureServices(IServiceCollection services, IConfiguration configuration);
    void ConfigureEndpoints(IPluginEndpointBuilder endpoints);
    void OnUnloading();
}
```

**PluginInfo:**

```csharp
public class PluginInfo
{
    public string Name { get; set; }        // Must be URL-safe (lowercase, no spaces)
    public string Version { get; set; }     // Semantic versioning (1.0.0)
    public string Description { get; set; } // Short description
    public string Author { get; set; }      // Author/team name
}
```

**URL pattern:** All endpoints are prefixed with `/api/plugins/{pluginName}/`

Example: Plugin `Name = "myplugin"` → Endpoints at `/api/plugins/myplugin/*`

---

## ConfigureServices Patterns

### 1. Database Connection (Bizuit Backend Core)

```csharp
public void ConfigureServices(IServiceCollection services, IConfiguration configuration)
{
    // Get connection string from plugin configuration
    var connectionString = configuration.GetConnectionString("Default");

    if (!string.IsNullOrEmpty(connectionString))
    {
        // Adds:
        // - IConnectionFactory (for Dapper)
        // - SafeQueryBuilder base repository
        // - Transaction management
        services.AddBizuitBackendCore(connectionString);
    }
}
```

### 2. System Configuration (Injected by Host)

```csharp
// Get system configuration injected by Backend Host
var bizuitApiBaseUrl = configuration["System:BizuitApiBaseUrl"];
var tenantId = configuration["System:TenantId"];

Console.WriteLine($"[MyPlugin] Loaded for tenant '{tenantId}' with Bizuit API: {bizuitApiBaseUrl}");
```

**Available system configuration:**
- `System:BizuitApiBaseUrl` - URL of Bizuit BPM API
- `System:TenantId` - Current tenant ID

### 3. Bizuit API Integration

```csharp
// Register HttpClient for Bizuit API calls
if (!string.IsNullOrEmpty(bizuitApiBaseUrl))
{
    services.AddHttpClient("BizuitApiClient", client =>
    {
        client.BaseAddress = new Uri(bizuitApiBaseUrl);
        client.Timeout = TimeSpan.FromSeconds(30);
    });
}
```

### 4. Feature-Based Registration

```csharp
// Feature: Users (CRUD operations)
services.AddScoped<UsersService>();
services.AddScoped<UsersRepository>();

// Feature: Orders (with validators)
services.AddScoped<OrdersService>();
services.AddScoped<OrdersRepository>();
services.AddScoped<IValidator<CreateOrderRequest>, CreateOrderRequestValidator>();

// Feature: Notifications (with background worker)
services.AddScoped<NotificationsService>();
services.AddHostedService<NotificationWorker>();
```

### 5. External API Configuration

```csharp
// Register external API credentials
var apiUsername = configuration["ExternalApi:Username"];
var apiPassword = configuration["ExternalApi:Password"];
var tokenCacheDuration = configuration.GetValue<int>("ExternalApi:TokenCacheDurationMinutes", 60);

if (!string.IsNullOrEmpty(apiUsername) && !string.IsNullOrEmpty(apiPassword))
{
    services.AddSingleton(new ExternalApiConfiguration
    {
        Username = apiUsername,
        Password = apiPassword,
        TokenCacheDurationMinutes = tokenCacheDuration
    });

    services.AddSingleton<ExternalApiAuthService>();
    services.AddHttpClient<ExternalApiService>();

    Console.WriteLine($"[MyPlugin] ExternalApi configured for user '{apiUsername}' with {tokenCacheDuration}min cache");
}
else
{
    Console.WriteLine($"[MyPlugin] WARNING: ExternalApi not configured - API calls will fail");
    // Register dummy configuration to avoid DI failures
    services.AddSingleton(new ExternalApiConfiguration());
    services.AddSingleton<ExternalApiAuthService>();
}
```

### 6. Background Workers (IHostedService)

```csharp
// Register background worker options
services.Configure<MyWorkerOptions>(configuration.GetSection("MyWorker"));

// Register hosted service
services.AddHostedService<MyBackgroundWorker>();
```

**Worker implementation:**

```csharp
public class MyBackgroundWorker : BackgroundService
{
    private readonly ILogger<MyBackgroundWorker> _logger;
    private readonly IServiceProvider _serviceProvider;
    private readonly MyWorkerOptions _options;

    public MyBackgroundWorker(
        ILogger<MyBackgroundWorker> logger,
        IServiceProvider serviceProvider,
        IOptions<MyWorkerOptions> options)
    {
        _logger = logger;
        _serviceProvider = serviceProvider;
        _options = options.Value;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            using var scope = _serviceProvider.CreateScope();
            var service = scope.ServiceProvider.GetRequiredService<MyService>();

            await service.DoWorkAsync();

            await Task.Delay(TimeSpan.FromMinutes(_options.IntervalMinutes), stoppingToken);
        }
    }
}
```

---

## ConfigureEndpoints Patterns

### IPluginEndpointBuilder API

```csharp
public interface IPluginEndpointBuilder
{
    // GET endpoint
    IEndpointConventionBuilder MapGet(string pattern, Delegate handler);

    // POST endpoint (transactional by default)
    IEndpointConventionBuilder MapPost(string pattern, Delegate handler);

    // PUT endpoint (transactional by default)
    IEndpointConventionBuilder MapPut(string pattern, Delegate handler);

    // PATCH endpoint (transactional by default)
    IEndpointConventionBuilder MapPatch(string pattern, Delegate handler);

    // DELETE endpoint (transactional by default)
    IEndpointConventionBuilder MapDelete(string pattern, Delegate handler);
}
```

### Endpoint Registration Pattern

**Feature-based endpoint classes:**

```csharp
public static class UsersEndpoints
{
    public static void Map(IPluginEndpointBuilder endpoints)
    {
        // List all users
        endpoints.MapGet("users", GetAll)
            .RequireAuthorization()
            .RequireRoles("Administrators", "Operators", "Users");

        // Get user by ID
        endpoints.MapGet("users/{id:int}", GetById)
            .RequireAuthorization();

        // Search users
        endpoints.MapGet("users/search", Search)
            .RequireAuthorization();

        // Create user
        endpoints.MapPost("users", Create)
            .RequireAuthorization()
            .RequireRoles("Administrators");

        // Update user
        endpoints.MapPut("users/{id:int}", Update)
            .RequireAuthorization()
            .RequireRoles("Administrators");

        // Delete user
        endpoints.MapDelete("users/{id:int}", Delete)
            .RequireAuthorization()
            .RequireRoles("Administrators");
    }

    // Handlers...
}
```

### Handler Signatures

**Simple GET:**

```csharp
private static async Task<IResult> GetAll(UsersService service)
{
    var users = await service.GetAllAsync();
    return Results.Ok(users);
}
```

**GET with route parameter:**

```csharp
private static async Task<IResult> GetById(int id, UsersService service)
{
    var user = await service.GetByIdAsync(id);
    if (user == null)
        return Results.NotFound(new { message = $"User {id} not found" });

    return Results.Ok(user);
}
```

**GET with query parameters:**

```csharp
private static async Task<IResult> Search(
    [FromQuery] string? name,
    [FromQuery] bool? isActive,
    UsersService service)
{
    var users = await service.SearchAsync(name, isActive);
    return Results.Ok(users);
}
```

**POST with request body:**

```csharp
private static async Task<IResult> Create(
    CreateUserRequest request,
    UsersService service,
    IValidator<CreateUserRequest> validator)
{
    // Validate request
    var validationResult = await validator.ValidateAsync(request);
    if (!validationResult.IsValid)
    {
        return Results.BadRequest(new
        {
            message = "Validation failed",
            errors = validationResult.Errors.Select(e => new
            {
                field = e.PropertyName,
                message = e.ErrorMessage
            })
        });
    }

    // Create user (transactional)
    var userId = await service.CreateAsync(request);

    return Results.Created($"/api/plugins/myplugin/users/{userId}", new { id = userId });
}
```

**PUT with route parameter and body:**

```csharp
private static async Task<IResult> Update(
    int id,
    UpdateUserRequest request,
    UsersService service,
    IValidator<UpdateUserRequest> validator)
{
    var validationResult = await validator.ValidateAsync(request);
    if (!validationResult.IsValid)
    {
        return Results.BadRequest(new
        {
            message = "Validation failed",
            errors = validationResult.Errors.Select(e => e.ErrorMessage)
        });
    }

    var success = await service.UpdateAsync(id, request);
    if (!success)
        return Results.NotFound(new { message = $"User {id} not found" });

    return Results.NoContent();
}
```

**DELETE:**

```csharp
private static async Task<IResult> Delete(int id, UsersService service)
{
    var success = await service.DeleteAsync(id);
    if (!success)
        return Results.NotFound(new { message = $"User {id} not found" });

    return Results.NoContent();
}
```

---

## Automatic Transaction Management

**Rule:** Endpoints with HTTP methods `POST`, `PUT`, `PATCH`, `DELETE` are **automatically wrapped in a transaction**.

**How it works:**

1. Backend Host detects HTTP method
2. If transactional method → begins transaction before handler
3. Executes handler
4. If no exception → commits transaction
5. If exception → rolls back transaction

**Code example:**

```csharp
// This endpoint is automatically transactional
endpoints.MapPost("users", async (CreateUserRequest request, UsersService service) =>
{
    // Begin transaction (automatic)
    var userId = await service.CreateAsync(request);

    // Insert related data (same transaction)
    await service.CreateUserProfile(userId);

    // Commit transaction (automatic if no exception)
    return Results.Created($"/users/{userId}", new { id = userId });
});
```

**Explicit transaction control (if needed):**

```csharp
public async Task<int> CreateAsync(CreateUserRequest request)
{
    using var connection = _connectionFactory.CreateConnection();
    connection.Open();

    using var transaction = connection.BeginTransaction();
    try
    {
        // Insert user
        var userId = await ExecuteWithIdentityAsync(
            Insert()
                .Set("Name", request.Name)
                .Set("Email", request.Email));

        // Insert user roles (same transaction)
        foreach (var role in request.Roles)
        {
            await connection.ExecuteAsync(
                "INSERT INTO UserRoles (UserId, RoleId) VALUES (@UserId, @RoleId)",
                new { UserId = userId, RoleId = role },
                transaction);
        }

        transaction.Commit();
        return userId;
    }
    catch
    {
        transaction.Rollback();
        throw;
    }
}
```

**When NOT to use transactions:**

```csharp
// GET endpoints are NOT transactional (read-only)
endpoints.MapGet("users", async (UsersService service) =>
{
    return Results.Ok(await service.GetAllAsync());
});
```

---

## Authorization and Roles

### RequireAuthorization

```csharp
// Require authenticated user (any role)
endpoints.MapGet("users", GetAll)
    .RequireAuthorization();
```

### RequireRoles

```csharp
// Require specific roles
endpoints.MapGet("users", GetAll)
    .RequireAuthorization()
    .RequireRoles("Administrators", "Operators");

// Only Administrators can delete
endpoints.MapDelete("users/{id:int}", Delete)
    .RequireAuthorization()
    .RequireRoles("Administrators");
```

### Custom Authorization Logic

```csharp
private static async Task<IResult> GetAll(
    HttpContext context,
    UsersService service)
{
    // Get user claims
    var userId = context.User.FindFirst("sub")?.Value;
    var roles = context.User.FindAll("role").Select(c => c.Value).ToList();

    // Custom authorization logic
    if (!roles.Contains("Administrators") && !roles.Contains("Operators"))
    {
        return Results.Forbid();
    }

    var users = await service.GetAllAsync();
    return Results.Ok(users);
}
```

---

## Plugin Configuration Cache

**PluginConfigCache** is a host-level in-memory cache that stores plugin configuration to avoid repeated database queries.

### What Gets Cached

1. **Security Settings** (per endpoint):
   - `AdminRequiresAuth` - Whether admin auth is required
   - `AdminAllowedRoles` - Comma-separated roles allowed to access endpoint
   - `RateLimitEnabled`, `RateLimitRequests`, `RateLimitWindowSeconds`, `RateLimitByUser`

2. **Plugin Metadata** (per plugin):
   - `LoggingEnabled` - Whether logging is enabled for the plugin
   - Other plugin-level configuration

### Cache Configuration

**Setting:** `PluginSecurityCacheTtlMinutes` in `BZExtSystemConfigurations` table
- **Category:** `Backend-Cache`
- **Default:** 5 minutes
- **Description:** Controls TTL for both security settings and plugin metadata cache

**Performance Impact:**
- First request: Cache miss → DB query (~600ms with cold start)
- Subsequent requests: Cache hit → 0 DB queries (~0ms overhead)

### Cache Invalidation

**Automatic invalidation:**
1. When plugin security config is updated via admin UI
2. When system configuration is refreshed (calls `_pluginConfigCache.InvalidateAll()`)
3. After TTL expiration

**Manual invalidation:**
```http
POST /api/admin/plugins/config-cache/invalidate-all
Authorization: Bearer {admin_token}
```

**Cache stats:**
```http
GET /api/admin/plugins/config-cache/stats
Authorization: Bearer {admin_token}
```

Response:
```json
{
  "securityEntriesCount": 54,
  "securityEntriesActive": 48,
  "metadataEntriesCount": 2,
  "metadataEntriesActive": 2,
  "defaultTtlMinutes": 5
}
```

### Admin UI

View cache status at: `/admin/settings/plugins/cache`

**Features:**
- Real-time cache statistics
- Security settings cache entries
- Metadata cache entries
- One-click invalidation

### Code Example

**ConfigurationController integration:**
```csharp
[HttpPost("refresh")]
public async Task<IActionResult> RefreshCache()
{
    // Refresh system configuration cache
    await _configService.RefreshCacheAsync();

    // Also invalidate plugin config cache (depends on system config)
    _pluginConfigCache.InvalidateAll();

    return Ok(new {
        message = "Configuration and plugin caches invalidated successfully"
    });
}
```

**When to invalidate manually:**
- After changing endpoint roles in `BZExtPluginEndpointRoles` table directly (bypass admin UI)
- After updating `PluginSecurityCacheTtlMinutes` setting
- When troubleshooting authorization issues

---

## Configuration Patterns

### appsettings.json (Backend Host)

```json
{
  "Plugins": {
    "myplugin": {
      "ConnectionStrings": {
        "Default": "Server=...;Database=MyPluginDb;..."
      },
      "ExternalApi": {
        "Username": "apiuser",
        "Password": "secret",
        "TokenCacheDurationMinutes": 60
      },
      "MyWorker": {
        "Enabled": true,
        "IntervalMinutes": 5
      }
    }
  }
}
```

### Reading Configuration in Plugin

```csharp
public void ConfigureServices(IServiceCollection services, IConfiguration configuration)
{
    // Connection string
    var connectionString = configuration.GetConnectionString("Default");

    // Nested section
    var username = configuration["ExternalApi:Username"];
    var password = configuration["ExternalApi:Password"];

    // Bind to options class
    services.Configure<MyWorkerOptions>(configuration.GetSection("MyWorker"));

    // Read value with default
    var intervalMinutes = configuration.GetValue<int>("MyWorker:IntervalMinutes", 5);
}
```

---

## Lifecycle Management

### OnUnloading

**Called when:**
- Plugin is unloaded by admin
- Backend Host is shutting down
- Plugin is being replaced with new version

**Use case:** Cleanup resources that aren't handled by DI

```csharp
public void OnUnloading()
{
    // Example: Close persistent connections
    // Example: Flush caches to disk
    // Example: Cancel background tasks

    // Most cleanup is automatic via DI disposal
    // Only use this for non-DI managed resources
}
```

**What's cleaned up automatically:**
- All `IDisposable` services registered in DI
- Background workers (IHostedService)
- HttpClient instances
- Database connections

---

## Complete Example: CRUD Plugin

```csharp
// Plugin.cs
public class MyPluginBackend : IBackendPlugin
{
    public PluginInfo Info => new()
    {
        Name = "myplugin",
        Version = "1.0.0",
        Description = "Example CRUD Plugin",
        Author = "My Team"
    };

    public void ConfigureServices(IServiceCollection services, IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("Default");
        services.AddBizuitBackendCore(connectionString);

        services.AddScoped<UsersRepository>();
        services.AddScoped<UsersService>();
        services.AddScoped<IValidator<CreateUserRequest>, CreateUserRequestValidator>();
    }

    public void ConfigureEndpoints(IPluginEndpointBuilder endpoints)
    {
        UsersEndpoints.Map(endpoints);
    }

    public void OnUnloading()
    {
        // No custom cleanup needed
    }
}

// UsersEndpoints.cs
public static class UsersEndpoints
{
    public static void Map(IPluginEndpointBuilder endpoints)
    {
        endpoints.MapGet("users", GetAll)
            .RequireAuthorization();

        endpoints.MapGet("users/{id:int}", GetById)
            .RequireAuthorization();

        endpoints.MapPost("users", Create)
            .RequireAuthorization()
            .RequireRoles("Administrators");

        endpoints.MapPut("users/{id:int}", Update)
            .RequireAuthorization()
            .RequireRoles("Administrators");

        endpoints.MapDelete("users/{id:int}", Delete)
            .RequireAuthorization()
            .RequireRoles("Administrators");
    }

    private static async Task<IResult> GetAll(UsersService service)
    {
        var users = await service.GetAllAsync();
        return Results.Ok(users);
    }

    private static async Task<IResult> GetById(int id, UsersService service)
    {
        var user = await service.GetByIdAsync(id);
        if (user == null)
            return Results.NotFound(new { message = $"User {id} not found" });

        return Results.Ok(user);
    }

    private static async Task<IResult> Create(
        CreateUserRequest request,
        UsersService service,
        IValidator<CreateUserRequest> validator)
    {
        var validationResult = await validator.ValidateAsync(request);
        if (!validationResult.IsValid)
        {
            return Results.BadRequest(new
            {
                message = "Validation failed",
                errors = validationResult.Errors.Select(e => e.ErrorMessage)
            });
        }

        var userId = await service.CreateAsync(request);
        return Results.Created($"/api/plugins/myplugin/users/{userId}", new { id = userId });
    }

    private static async Task<IResult> Update(
        int id,
        UpdateUserRequest request,
        UsersService service,
        IValidator<UpdateUserRequest> validator)
    {
        var validationResult = await validator.ValidateAsync(request);
        if (!validationResult.IsValid)
        {
            return Results.BadRequest(new
            {
                message = "Validation failed",
                errors = validationResult.Errors.Select(e => e.ErrorMessage)
            });
        }

        var success = await service.UpdateAsync(id, request);
        if (!success)
            return Results.NotFound(new { message = $"User {id} not found" });

        return Results.NoContent();
    }

    private static async Task<IResult> Delete(int id, UsersService service)
    {
        var success = await service.DeleteAsync(id);
        if (!success)
            return Results.NotFound(new { message = $"User {id} not found" });

        return Results.NoContent();
    }
}

// UsersService.cs
public class UsersService
{
    private readonly UsersRepository _repository;

    public UsersService(UsersRepository repository)
    {
        _repository = repository;
    }

    public async Task<IEnumerable<User>> GetAllAsync()
    {
        return await _repository.GetAllAsync();
    }

    public async Task<User?> GetByIdAsync(int id)
    {
        return await _repository.GetByIdAsync(id);
    }

    public async Task<int> CreateAsync(CreateUserRequest request)
    {
        return await _repository.CreateAsync(request.Name, request.Email);
    }

    public async Task<bool> UpdateAsync(int id, UpdateUserRequest request)
    {
        return await _repository.UpdateAsync(id, request.Name, request.Email);
    }

    public async Task<bool> DeleteAsync(int id)
    {
        return await _repository.DeleteAsync(id);
    }
}

// UsersRepository.cs (using SafeQueryBuilder)
public class UsersRepository : SafeRepository<User>
{
    protected override string TableName => "Users";

    public UsersRepository(IConnectionFactory connectionFactory)
        : base(connectionFactory)
    {
    }

    public async Task<IEnumerable<User>> GetAllAsync()
    {
        return await ExecuteAsync(
            Query().OrderByDescending("CreatedOnDate"));
    }

    public async Task<User?> GetByIdAsync(int id)
    {
        return await ExecuteSingleAsync(
            Query().WhereEquals("ID", id));
    }

    public async Task<int> CreateAsync(string name, string email)
    {
        return await ExecuteWithIdentityAsync(
            Insert()
                .Set("Name", name)
                .Set("Email", email)
                .Set("CreatedOnDate", DateTime.UtcNow));
    }

    public async Task<bool> UpdateAsync(int id, string name, string email)
    {
        var rows = await ExecuteAsync(
            Update()
                .Set("Name", name)
                .Set("Email", email)
                .Set("LastModifiedOnDate", DateTime.UtcNow)
                .WhereEquals("ID", id));

        return rows > 0;
    }

    public async Task<bool> DeleteAsync(int id)
    {
        var rows = await ExecuteAsync(
            Delete().WhereEquals("ID", id));

        return rows > 0;
    }
}
```

---

## Common Patterns

### Pattern 1: Bizuit BPM Integration

```csharp
// ConfigureServices
services.Configure<BpmIntegrationOptions>(options =>
{
    options.BizuitApiBaseUrl = configuration["System:BizuitApiBaseUrl"] ?? string.Empty;
});

services.AddHttpClient<BpmIntegrationService>();

// BpmIntegrationService
public class BpmIntegrationService
{
    private readonly HttpClient _httpClient;

    public BpmIntegrationService(HttpClient httpClient, IOptions<BpmIntegrationOptions> options)
    {
        _httpClient = httpClient;
        _httpClient.BaseAddress = new Uri(options.Value.BizuitApiBaseUrl);
    }

    public async Task<ProcessInstance> StartProcessAsync(string processName, object variables)
    {
        var response = await _httpClient.PostAsJsonAsync($"/api/processes/{processName}/start", variables);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<ProcessInstance>();
    }
}
```

### Pattern 2: External API with Token Cache

```csharp
// Configuration class
public class ExternalApiConfiguration
{
    public string Username { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
    public int TokenCacheDurationMinutes { get; set; } = 60;
}

// Auth service (singleton - token cache shared)
public class ExternalApiAuthService
{
    private readonly ExternalApiConfiguration _config;
    private readonly HttpClient _httpClient;
    private string? _cachedToken;
    private DateTime _tokenExpiry = DateTime.MinValue;

    public ExternalApiAuthService(ExternalApiConfiguration config, IHttpClientFactory httpClientFactory)
    {
        _config = config;
        _httpClient = httpClientFactory.CreateClient("ExternalApi");
    }

    public async Task<string> GetTokenAsync()
    {
        if (_cachedToken != null && DateTime.UtcNow < _tokenExpiry)
        {
            return _cachedToken;
        }

        var response = await _httpClient.PostAsJsonAsync("/auth/login", new
        {
            username = _config.Username,
            password = _config.Password
        });

        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<TokenResponse>();

        _cachedToken = result.Token;
        _tokenExpiry = DateTime.UtcNow.AddMinutes(_config.TokenCacheDurationMinutes);

        return _cachedToken;
    }
}

// ConfigureServices
var apiUsername = configuration["ExternalApi:Username"];
var apiPassword = configuration["ExternalApi:Password"];

if (!string.IsNullOrEmpty(apiUsername) && !string.IsNullOrEmpty(apiPassword))
{
    services.AddSingleton(new ExternalApiConfiguration
    {
        Username = apiUsername,
        Password = apiPassword,
        TokenCacheDurationMinutes = configuration.GetValue<int>("ExternalApi:TokenCacheDurationMinutes", 60)
    });

    services.AddSingleton<ExternalApiAuthService>();
    services.AddHttpClient("ExternalApi");
}
```

### Pattern 3: Background Worker with Scoped Services

```csharp
// Worker
public class MyBackgroundWorker : BackgroundService
{
    private readonly ILogger<MyBackgroundWorker> _logger;
    private readonly IServiceProvider _serviceProvider;
    private readonly MyWorkerOptions _options;

    public MyBackgroundWorker(
        ILogger<MyBackgroundWorker> logger,
        IServiceProvider serviceProvider,
        IOptions<MyWorkerOptions> options)
    {
        _logger = logger;
        _serviceProvider = serviceProvider;
        _options = options.Value;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation($"[MyWorker] Started with interval: {_options.IntervalMinutes} minutes");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // Create scope for scoped services (repository, service)
                using var scope = _serviceProvider.CreateScope();
                var service = scope.ServiceProvider.GetRequiredService<MyService>();

                await service.DoWorkAsync();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[MyWorker] Error during execution");
            }

            await Task.Delay(TimeSpan.FromMinutes(_options.IntervalMinutes), stoppingToken);
        }

        _logger.LogInformation("[MyWorker] Stopped");
    }
}

// ConfigureServices
services.Configure<MyWorkerOptions>(configuration.GetSection("MyWorker"));
services.AddHostedService<MyBackgroundWorker>();
```

---

## Common Mistakes

### ❌ Mistake 1: Forgetting to Register Services

```csharp
// WRONG - Service not registered in ConfigureServices
public void ConfigureEndpoints(IPluginEndpointBuilder endpoints)
{
    endpoints.MapGet("users", async (UsersService service) =>
    {
        // Runtime error: UsersService not found in DI
    });
}

// CORRECT
public void ConfigureServices(IServiceCollection services, IConfiguration configuration)
{
    services.AddScoped<UsersService>();  // ✅ Register service
}
```

---

### ❌ Mistake 2: Using Singleton for Scoped Dependencies

```csharp
// WRONG - Repository needs IConnectionFactory (scoped)
services.AddSingleton<UsersRepository>();

// CORRECT
services.AddScoped<UsersRepository>();  // ✅ Match scope of dependencies
```

---

### ❌ Mistake 3: Not Using Bizuit Backend Core

```csharp
// WRONG - Manual connection management
services.AddScoped<IConnectionFactory>(sp =>
    new SqlConnectionFactory(connectionString));

// CORRECT - Use Bizuit Backend Core
services.AddBizuitBackendCore(connectionString);  // ✅ Includes IConnectionFactory + SafeQueryBuilder
```

---

### ❌ Mistake 4: Forgetting Transaction Handling

```csharp
// POST endpoint is transactional by default
// But if you need explicit control:

// WRONG - No transaction for multi-step operation
public async Task CreateWithRelated(CreateRequest request)
{
    var id = await _repository.CreateAsync(request);
    await _relatedRepository.CreateAsync(id, request.Related);
    // If second call fails, first insert is NOT rolled back
}

// CORRECT - Explicit transaction
public async Task CreateWithRelated(CreateRequest request)
{
    using var connection = _connectionFactory.CreateConnection();
    connection.Open();
    using var transaction = connection.BeginTransaction();

    try
    {
        var id = await ExecuteWithIdentityAsync(Insert()...);
        await connection.ExecuteAsync("INSERT INTO Related...", new { ... }, transaction);

        transaction.Commit();
    }
    catch
    {
        transaction.Rollback();
        throw;
    }
}
```

---

## Summary

**Key Takeaways:**

1. **IBackendPlugin interface** - Lifecycle: `Info` → `ConfigureServices` → `ConfigureEndpoints` → `OnUnloading`
2. **Automatic DI** - Full ASP.NET Core dependency injection support
3. **Automatic transactions** - POST/PUT/PATCH/DELETE wrapped in transactions
4. **Feature-based organization** - One static class per feature for endpoints
5. **Bizuit Backend Core** - Use `services.AddBizuitBackendCore(connectionString)` for SafeQueryBuilder + IConnectionFactory
6. **System configuration** - `System:BizuitApiBaseUrl`, `System:TenantId` injected by host
7. **Background workers** - Use `IServiceProvider` to create scopes for scoped services

**Most Common Operations:**

- Register services: `services.AddScoped<MyService>()`
- Register endpoints: `endpoints.MapGet("users", GetAll)`
- Add authorization: `.RequireAuthorization().RequireRoles("Administrators")`
- Background worker: `services.AddHostedService<MyWorker>()`
- External API: Token cache pattern with singleton auth service

**When NOT to Use:**

- Simple scripts (not web API)
- Single-tenant applications (plugin system is for multi-tenant)
- Non-.NET applications

