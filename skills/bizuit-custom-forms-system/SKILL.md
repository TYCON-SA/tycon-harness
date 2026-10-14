---
name: bizuit-custom-forms-system
description: "BIZUIT Custom Forms - Dynamic form loading system with multi-tenant deployment, plugin architecture, hot reload, database-driven configuration, Next.js runtime, .NET backend API, and Azure DevOps CI/CD. Use when working with form deployment, plugin uploads, runtime configuration, or IIS multi-tenant hosting."
metadata:
  author: tycon-team
  version: "1.0.0"
  last-updated: "2026-01-25"
  technologies:
    - Next.js 14
    - .NET 9 Minimal APIs
    - Azure DevOps
    - IIS
    - SQL Server
  related-skills:
    - esbuild-bundling
    - feature-based-crud-endpoints
    - azure-sql-database
---

# BIZUIT Custom Forms System

Complete architecture and implementation guide for BIZUIT's dynamic custom forms platform.


## Overview

**BIZUIT Custom Forms** is a dynamic form loading system that enables multi-tenant deployment without rebuilding the runtime application.

### Key Capabilities

1. **Dynamic Form Loading** - Upload forms via admin panel, available immediately
2. **Plugin Architecture** - Backend plugins with hot reload (no server restart for most changes)
3. **Multi-Tenant Deployment** - Single codebase serves multiple tenants (IIS virtual directories)
4. **Database-Driven Configuration** - All settings in `BZExtSystemConfigurations` table
5. **CI/CD Automation** - Auto-versioning, building, and artifact generation
6. **Offline Deployment** - ZIPs committed to git for air-gapped environments

### Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│ BIZUIT Dashboard (iframe container)                         │
│  - Authenticates user, generates JWT token                  │
│  - Opens runtime app in iframe with encrypted token         │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Runtime App (Next.js 14) - Port 3001/IIS                    │
│  - Decrypts token, validates tenant                          │
│  - Loads form.js from /public/forms/{formName}/             │
│  - Provides React + Bizuit SDK globals                       │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Backend API (.NET 9) - Port 8000/IIS                        │
│  - Controllers for form/plugin upload, metadata, config      │
│  - Plugin system (IBackendPlugin interface)                  │
│  - Hot reload mechanism (FileSystemWatcher)                  │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Database (SQL Server)                                        │
│  - BZExtForms, BZExtFormVersions, BZExtBackendPlugins        │
│  - BZExtSystemConfigurations (single source of truth)        │
└─────────────────────────────────────────────────────────────┘
```

## When to Use This Skill

✅ **Use when:**
- Uploading new form versions or backend plugins
- Configuring runtime app settings (URLs, security, dev mode)
- Debugging form loading issues or plugin execution
- Setting up new tenant deployments (IIS virtual directories)
- Understanding the complete request flow (Dashboard → Runtime → Plugin)
- Implementing hot reload for backend changes
- Working with database-driven configuration system

❌ **Don't use when:**
- Only working on individual form code (use `esbuild-bundling` skill)
- Only working on plugin endpoints (use `feature-based-crud-endpoints` skill)
- Database schema design (use `azure-sql-database` skill)

## Core Concepts

### Dynamic Form Loading

Forms are **not bundled** with the runtime app. They are:
- Built as standalone ESM bundles with external dependencies
- Uploaded via admin panel as ZIP packages
- Stored in database + file system (`/wwwroot/forms/`)
- Loaded dynamically at runtime via `import()`

**Benefits:**
- Update forms without redeploying runtime app
- Multiple versions of same form can coexist
- Rollback to previous version instantly
- Zero downtime deployments

### Plugin Architecture

Backend logic is organized as **plugins** (DLLs implementing `IBackendPlugin`):
- Uploaded via admin panel
- Stored in `/wwwroot/plugins/`
- Loaded dynamically via `AssemblyLoadContext`
- Hot reloadable (for stateless endpoints)

**Benefits:**
- Add new features without rebuilding host
- Independent versioning per plugin
- Tenant-specific plugin configurations
- Automatic transaction management

### Database-Driven Configuration

**All runtime configuration** comes from `BZExtSystemConfigurations` table:
- URLs, API keys, feature flags
- Tenant-specific overrides
- Encrypted secrets
- Hot reloadable via webhooks

**Priority:** Database > Environment Variables > appsettings.json

### Multi-Tenant Architecture

Single codebase serves multiple tenants via:
- IIS virtual directories (different BASE_PATH per tenant)
- JWT token claims (TenantId)
- Database connection strings (per tenant)
- Configuration overrides (per tenant)

## Runtime App (Next.js)

### Form Loading Flow

```typescript
// app/formsa/[formName]/page.tsx

// 1. Extract encrypted token from URL
const searchParams = useSearchParams();
const encryptedToken = searchParams.get('s');

// 2. Decrypt token (TripleDES with shared key)
const token = decryptToken(encryptedToken);

// 3. Parse JWT payload
const payload = JSON.parse(
  Buffer.from(token.split('.')[1], 'base64').toString()
);

// 4. Dynamic import with cache buster
const FormModule = await import(
  `/forms/${formName}/form.js?v=${Date.now()}`
);

// 5. Render with context
<FormComponent dashboardParams={{
  token,
  userName: payload.UserName,
  instanceId: payload.InstanceId,
  apiUrl: process.env.BIZUIT_API_URL
}} />
```

**Cache busting:** `?v=${Date.now()}` forces reload after form upload.

### Global Dependencies

Forms expect these globals (set in `app/layout.tsx`):

```typescript
window.React = React;
window.ReactDOM = ReactDOM;
window.BizuitFormSDK = BizuitFormSDK;
window.BizuitUIComponents = BizuitUIComponents;
```

**Why globals?** Forms use externals to avoid "Invalid hook call" (multiple React instances).

### Runtime Configuration

All config from **environment variables** (set by IIS or .env.local):

```typescript
// middleware.ts
const config = {
  BASE_PATH: process.env.BASE_PATH,           // /tenant1BIZUITCustomForms
  FASTAPI_URL: process.env.FASTAPI_URL,       // Backend API URL
  ALLOW_DEV_MODE: process.env.ALLOW_DEV_MODE, // Enable dev.html
  ENCRYPTION_TOKEN_KEY: process.env.ENCRYPTION_TOKEN_KEY // 24 chars
};
```

**⚠️ NEVER use `NEXT_PUBLIC_*`** - These are baked into build, can't change per deployment.

## Backend API (.NET 9)

### Form Upload

```csharp
[HttpPost("upload")]
[Authorize(Roles = "Administrators,BizuitAdmins")]
public async Task<IResult> UploadForm(IFormFile file, string formName)
{
    // 1. Validate ZIP (manifest.json + forms/{formName}/form.js)
    var manifest = await _formService.ValidateAsync(file);

    // 2. Save to database
    var versionId = await _formService.SaveVersionAsync(formName, manifest);

    // 3. Extract to wwwroot/forms/{formName}/
    await _formService.ExtractAsync(file, formName);

    // 4. Update metadata
    await _formService.UpdateFormMetadataAsync(formName, versionId);

    // 5. Trigger webhook (runtime reloads)
    await _webhookService.TriggerAsync("FormUploaded", new { formName });

    return Results.Ok();
}
```

### Plugin System

**Interface:**

```csharp
public interface IBackendPlugin
{
    PluginInfo Info { get; }
    void ConfigureServices(IServiceCollection services, IConfiguration config);
    void ConfigureEndpoints(IPluginEndpointBuilder endpoints);
    void OnUnloading();
}
```

**Loading:**

```csharp
// Bizuit.Backend.Host.Services.PluginLoader
public async Task<IBackendPlugin> LoadAsync(string assemblyPath)
{
    // 1. Load assembly (collectible context for hot reload)
    var context = new AssemblyLoadContext(pluginName, isCollectible: true);
    var assembly = context.LoadFromAssemblyPath(assemblyPath);

    // 2. Find IBackendPlugin implementation
    var pluginType = assembly.GetTypes()
        .First(t => typeof(IBackendPlugin).IsAssignableFrom(t));

    // 3. Instantiate
    var plugin = (IBackendPlugin)Activator.CreateInstance(pluginType);

    // 4. Configure DI
    plugin.ConfigureServices(services, configuration);

    // 5. Map endpoints to /api/plugins/{pluginName}/*
    var builder = new PluginEndpointBuilder(app, pluginName);
    plugin.ConfigureEndpoints(builder);

    return plugin;
}
```

### Hot Reload

```csharp
// Bizuit.Backend.Host.Services.PluginHotReloadService
protected override Task ExecuteAsync(CancellationToken stoppingToken)
{
    var watcher = new FileSystemWatcher(_pluginDir, "*.dll");
    watcher.Changed += async (sender, e) =>
    {
        await Task.Delay(500); // Debounce

        // Unload old + load new
        await _loader.UnloadAsync(pluginName);
        await _loader.LoadAsync(e.FullPath);

        _logger.LogInformation($"Hot reloaded: {pluginName}");
    };

    watcher.EnableRaisingEvents = true;
    return Task.CompletedTask;
}
```

**⚠️ Limitation:** Works for stateless endpoints. Background workers + SignalR require restart.

## Database Schema

### Forms

```sql
CREATE TABLE BZExtForms (
    ID INT IDENTITY(1,1) PRIMARY KEY,
    Name NVARCHAR(100) UNIQUE,
    DisplayName NVARCHAR(200),
    IsActive BIT DEFAULT 1,
    CurrentVersionID INT,
    CreatedAt DATETIME2 DEFAULT GETDATE()
);

CREATE TABLE BZExtFormVersions (
    ID INT IDENTITY(1,1) PRIMARY KEY,
    FormID INT FOREIGN KEY REFERENCES BZExtForms(ID),
    Version NVARCHAR(20),
    PackagePath NVARCHAR(500),  -- /wwwroot/forms/{formName}/
    Manifest NVARCHAR(MAX),      -- JSON metadata
    UploadedAt DATETIME2 DEFAULT GETDATE()
);
```

### Plugins

```sql
CREATE TABLE BZExtBackendPlugins (
    ID INT IDENTITY(1,1) PRIMARY KEY,
    Name NVARCHAR(100) UNIQUE,
    AssemblyPath NVARCHAR(500),  -- /wwwroot/plugins/{name}.dll
    Version NVARCHAR(20),
    IsActive BIT DEFAULT 1,
    CreatedAt DATETIME2 DEFAULT GETDATE()
);
```

### Configuration

```sql
CREATE TABLE BZExtSystemConfigurations (
    ID INT IDENTITY(1,1) PRIMARY KEY,
    KeyID NVARCHAR(200),
    Category NVARCHAR(100),      -- 'runtime', 'backend', 'security'
    Data NVARCHAR(MAX),           -- JSON value
    IsEncrypted BIT DEFAULT 0,
    TenantID NVARCHAR(50),        -- NULL = global
    CreatedAt DATETIME2 DEFAULT GETDATE()
);
```

**Priority:** Tenant-specific > Global

## CI/CD Pipeline

### Form Build

```yaml
# azure-pipelines.yml
trigger:
  branches: [main, release/*]
  paths: ['*/src/**', '*/package.json', 'build-form.js']

steps:
  # 1. Detect changed forms
  - script: |
      git diff --name-only HEAD~1 HEAD | \
        grep -E '^([^/]+)/' | cut -d'/' -f1 | \
        sort -u > changed-forms.txt

  # 2. Auto-increment versions
  - script: |
      for form in $(cat changed-forms.txt); do
        cd $form
        npm version patch --no-git-tag-version
      done

  # 3. Build forms
  - script: |
      for form in $(cat changed-forms.txt); do
        cd $form
        npm install
        npm run build  # build-form.js (slim bundle)
      done

  # 4. Create ZIPs
  - script: |
      for form in $(cat changed-forms.txt); do
        # Create manifest.json
        cat > manifest.json <<EOF
{
  "version": "$(jq -r .version $form/package.json)",
  "commitHash": "$(git rev-parse HEAD)"
}
EOF
        # Package
        mkdir -p forms/$form
        cp $form/dist/form.js forms/$form/
        zip -r $form/upload/$form-v$(jq -r .version $form/package.json).zip \
          manifest.json forms/

        # Force add (override .gitignore)
        git add -f $form/upload/*.zip
      done

  # 5. Commit back
  - script: |
      git commit -m "ci: auto-increment versions [skip ci]"
      git push
```

**⚠️ `[skip ci]`** prevents infinite loop.

## Deployment

### IIS Multi-Tenant

```
Default Web Site
├── tenant1BIZUITCustomForms (virtual dir)
│   ├── Path: C:\inetpub\wwwroot\tenant1\custom-forms\
│   └── web.config:
│       BASE_PATH=/tenant1BIZUITCustomForms
│       ENCRYPTION_TOKEN_KEY=shared-24-char-key
│
└── tenant1BIZUITCustomFormsBackEnd (virtual dir)
    ├── Path: C:\inetpub\wwwroot\tenant1\backend-api\
    └── web.config:
        ConnectionStrings__DashboardDb=Server=...;Database=tenant1_db;
```

**web.config (Runtime):**

```xml
<aspNetCore processPath="dotnet" arguments=".\RuntimeApp.dll">
  <environmentVariables>
    <environmentVariable name="BASE_PATH" value="/tenant1BIZUITCustomForms" />
    <environmentVariable name="FASTAPI_URL" value="https://example.com/tenant1BIZUITCustomFormsBackEnd" />
    <environmentVariable name="ENCRYPTION_TOKEN_KEY" value="shared-24-char-key" />
  </environmentVariables>
</aspNetCore>
```

### Azure App Service

```bash
az webapp config appsettings set \
  --name tenant1-forms \
  --settings \
    BASE_PATH="/tenant1" \
    FASTAPI_URL="https://tenant1-api.example.com" \
    ENCRYPTION_TOKEN_KEY="shared-24-char-key"
```

## Complete Request Flow

```
1. Dashboard generates JWT token
   { UserName, Roles, TenantId, InstanceId }

2. Dashboard encrypts token (TripleDES)

3. Dashboard opens iframe
   GET /tenant1BIZUITCustomForms/formsa/totora-encargos?s={encrypted}

4. Runtime app decrypts token

5. Runtime loads form.js
   import('/forms/totora-encargos/form.js?v=123456')

6. Form initializes with SDK
   BizuitSDK.login({ token, apiUrl })

7. Form calls plugin
   POST /tenant1BIZUITCustomFormsBackEnd/api/plugins/totorabackend/rutas

8. Plugin validates token
   Extract TenantId from JWT claims

9. Plugin queries database
   WHERE TenantId = @tenantId (isolation)

10. Return response
```

## Security

### Token Encryption

```typescript
// Runtime: lib/encryption.ts
export function decryptToken(encrypted: string): string {
  const key = Buffer.from(process.env.ENCRYPTION_TOKEN_KEY!, 'utf8');
  const decipher = crypto.createDecipheriv('des-ede3', key, '');
  return decipher.update(encrypted, 'base64', 'utf8') +
         decipher.final('utf8');
}
```

**⚠️ Key must be exactly 24 chars** (TripleDES requirement)

### Tenant Isolation

```csharp
// Backend: Middleware/TenantIsolationMiddleware
public async Task InvokeAsync(HttpContext context, RequestDelegate next)
{
    var token = context.Request.Headers["Authorization"]
        .FirstOrDefault()?.Replace("Bearer ", "");

    var jwtToken = new JwtSecurityTokenHandler().ReadJwtToken(token);
    var tenantId = jwtToken.Claims.First(c => c.Type == "TenantId").Value;

    context.Items["TenantId"] = tenantId;
    await next(context);
}

// Repository: ALWAYS filter by tenant
public async Task<List<T>> GetAllAsync()
{
    var tenantId = _httpContext.Items["TenantId"] as string;
    return await ExecuteAsync(
        Query().WhereEquals("TenantId", tenantId)
    );
}
```

## Configuration System

### Database-Driven

```csharp
public async Task<string?> GetConfigAsync(string keyId, string? tenantId)
{
    var query = Query().WhereEquals("KeyID", keyId);

    if (!string.IsNullOrEmpty(tenantId))
        query.WhereEquals("TenantID", tenantId);
    else
        query.WhereNull("TenantID"); // Global

    var config = await ExecuteSingleAsync(query);

    if (config?.IsEncrypted == true)
        return _encryptionService.Decrypt(config.Data);

    return config?.Data;
}
```

### Webhook Reload

```csharp
// Backend: After upload
await _webhookService.TriggerAsync("FormUploaded", new { formName });

// Runtime: Webhook endpoint
[HttpPost("api/webhooks/form-uploaded")]
public async Task<IResult> OnFormUploaded(FormUploadedEvent evt)
{
    await _cacheService.InvalidateAsync($"/forms/{evt.formName}/form.js");
    await _configService.ReloadAsync();
    return Results.Ok();
}
```

## Troubleshooting

### Form Not Loading

**Diagnosis:**
```bash
# 1. Check form.js exists
ls public/forms/totora-encargos/form.js

# 2. Check database
sqlcmd -Q "SELECT Name, CurrentVersionID FROM BZExtForms WHERE Name='totora-encargos'"

# 3. Browser console
# Look for: "Cannot find module" or "Unexpected token"
```

**Fixes:**
- Missing form.js → Re-upload via admin
- Wrong BASE_PATH → Check web.config
- Invalid token → Verify ENCRYPTION_TOKEN_KEY matches Dashboard

### Plugin Not Responding

**Diagnosis:**
```bash
# 1. Check swagger
curl http://localhost:8000/api/plugins/totorabackend/swagger.json

# 2. Check DLL
ls wwwroot/plugins/TotoraBackend.dll

# 3. Check logs
tail -f logs/bizuit-backend-*.log | grep TotoraBackend
```

**Fixes:**
- Upload plugin via admin panel
- Verify AssemblyPath in database
- Restart server (if SignalR/workers changed)

### Hot Reload Not Working

**Limitations:**
- ✅ Works: Controllers, repositories, services
- ❌ Requires restart: IHostedService, SignalR hubs

**Manual reload:**
```bash
# IIS
iisreset

# Systemd
sudo systemctl restart bizuit-backend
```

## Public templates

- Plugin (backend .NET and local DevHost): <https://github.com/TYCON-SA/bizuit-custom-plugin-sample>
- Forms (build, tests, tsconfig and a first form): <https://github.com/TYCON-SA/bizuit-custom-form-sample>

## Related Skills

- **esbuild-bundling** - Form build configuration
- **feature-based-crud-endpoints** - Plugin endpoint patterns
- **azure-sql-database** - Database deployment
- **signalr-realtime** - Real-time messaging
