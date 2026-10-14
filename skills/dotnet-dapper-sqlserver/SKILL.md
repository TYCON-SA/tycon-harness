---
name: dotnet-dapper-sqlserver
description: Dapper + SQL Server patterns for .NET applications. Use when asked about "Dapper queries", "SQL Server with C#", "SafeQueryBuilder", "parameterized queries", "async Dapper", "SQL injection prevention", "Dapper transactions", or "JSON in SQL Server".
metadata:
  author: tycon-team
  version: "1.0.0"
  last-updated: "2026-01-25"
  changelog: |
    v1.0.0 - Initial version with SafeQueryBuilder, query patterns, transactions, JSON handling
---

# Dapper + SQL Server Patterns

Comprehensive guide for using Dapper ORM with SQL Server in .NET applications.

## Core Principles

1. **Always Parametrize** - Never concatenate strings, always use `@Parameters`
2. **SafeQueryBuilder** - Use fluent query builder for type-safe queries
3. **Async-first** - All database operations should be async
4. **Explicit Ownership** - Manage connections with `using` statements
5. **UTC Timestamps** - Always use `DateTime.UtcNow`, never `DateTime.Now`

## When to Use This Skill

Use this skill when you need to:
- Write queries with Dapper in .NET
- Prevent SQL injection attacks
- Use SafeQueryBuilder for fluent queries
- Handle transactions with TransactionScope
- Work with JSON columns in SQL Server
- Optimize query performance
- Map database results to C# objects

## Quick Reference

### Basic Query Pattern

```csharp
using var connection = _connectionFactory.CreateConnection();
connection.Open();

var sql = "SELECT * FROM Users WHERE Id = @UserId";
var user = await connection.QueryFirstOrDefaultAsync<User>(sql, new { UserId = userId });
```

### SafeQueryBuilder Pattern

```csharp
public class UsersRepository : SafeRepository<User>
{
    protected override string TableName => "Users";

    public async Task<IEnumerable<User>> GetActiveUsersAsync()
    {
        var query = Query()
            .WhereEquals("IsActive", true)
            .OrderByDescending("CreatedDate");

        return await ExecuteAsync(query);
    }
}
```

### Transaction Pattern

```csharp
using (var scope = new TransactionScope(TransactionScopeAsyncFlowOption.Enabled))
{
    await _usersService.CreateUserAsync(user);
    await _rolesService.AssignRoleAsync(user.Id, roleId);

    scope.Complete();  // COMMIT
}
// Auto-ROLLBACK if exception before Complete()
```

### Parameterized Query (SQL Injection Safe)

```csharp
var parameters = new DynamicParameters();
parameters.Add("Name", $"%{searchTerm}%");  // LIKE pattern
parameters.Add("MinDate", DateTime.UtcNow.AddDays(-30));

var sql = @"
    SELECT * FROM Users
    WHERE Name LIKE @Name
      AND CreatedDate >= @MinDate";

var results = await connection.QueryAsync<User>(sql, parameters);
```

## Architecture Patterns

### 1. IConnectionFactory Pattern

**Setup (Program.cs):**
```csharp
var connectionString = builder.Configuration.GetConnectionString("Default");

builder.Services.AddScoped<IConnectionFactory>(sp =>
{
    if (isDevelopment)
        return new LoggingConnectionFactory(connectionString, logger);
    return new SqlConnectionFactory(connectionString);
});
```

**Usage in Repository:**
```csharp
private readonly IConnectionFactory _connectionFactory;

public UsersRepository(IConnectionFactory connectionFactory)
    : base(connectionFactory)
{
    _connectionFactory = connectionFactory;
}
```

### 2. SafeRepository Base Class

All repositories inherit from `SafeRepository<T>`:

```csharp
public class TasksRepository : SafeRepository<TaskItem>
{
    protected override string TableName => "DEMO_Entregas";

    // Fluent query builder available:
    // - Query() → SELECT builder
    // - Insert() → INSERT builder
    // - Update() → UPDATE builder
    // - Delete() → DELETE builder
    // - ExecuteAsync(query) → Execute async
}
```

### 3. Query Patterns

**Pattern 1: Simple Query Builder**
```csharp
var query = Query()
    .WhereEquals("ID", id)
    .OrderByDescending("CreatedOnDate");

return await ExecuteAsync(query);
```

**Pattern 2: Dynamic Filters**
```csharp
var query = Query();

if (filters.IdOwner.HasValue)
    query.WhereEquals("IdOwner", filters.IdOwner.Value);

if (filters.FechaDesde.HasValue)
    query.WhereGreaterOrEqual("FechaHora", filters.FechaDesde.Value);

return await ExecuteAsync(query);
```

**Pattern 3: Complex JOINs (Raw SQL)**
```csharp
var sql = @"
    SELECT u.*, r.Name AS RoleName
    FROM Users u
    INNER JOIN Roles r WITH (NOLOCK) ON u.RoleId = r.Id
    WHERE u.IsActive = @IsActive";

using var connection = _connectionFactory.CreateConnection();
connection.Open();

var results = await connection.QueryAsync<UserWithRole>(sql,
    new { IsActive = true });
```

**Pattern 4: Batch Operations (IN clause)**
```csharp
var idList = userIds.ToList();
var sql = "SELECT * FROM Users WHERE Id IN @Ids";

var results = await connection.QueryAsync<User>(sql, new { Ids = idList });
// Dapper automatically expands array into IN clause
```

## Common Tasks

### Insert with SCOPE_IDENTITY

```csharp
var insert = Insert()
    .Set("Name", user.Name)
    .Set("Email", user.Email)
    .Set("CreatedDate", DateTime.UtcNow);

var userId = await ExecuteWithIdentityAsync(insert);
return userId;
```

### Update with Conditions

```csharp
var update = Update()
    .Set("Name", newName)
    .Set("UpdatedDate", DateTime.UtcNow)
    .WhereEquals("Id", userId);

await ExecuteAsync(update);
```

### Delete

```csharp
var delete = Delete()
    .WhereEquals("Id", userId);

await ExecuteAsync(delete);
```

### Pagination

```csharp
var sql = @"
    SELECT * FROM Users
    WHERE IsActive = @IsActive
    ORDER BY CreatedDate DESC
    OFFSET @Skip ROWS
    FETCH NEXT @Take ROWS ONLY";

var results = await connection.QueryAsync<User>(sql, new
{
    IsActive = true,
    Skip = (page - 1) * pageSize,
    Take = pageSize
});
```

### Count + Data

```csharp
// Count query
var countSql = "SELECT COUNT(*) FROM Users WHERE IsActive = @IsActive";
var total = await connection.ExecuteScalarAsync<int>(countSql, new { IsActive = true });

// Data query
var dataSql = "SELECT * FROM Users WHERE IsActive = @IsActive OFFSET @Skip ROWS FETCH NEXT @Take ROWS ONLY";
var users = await connection.QueryAsync<User>(dataSql, new { IsActive = true, Skip = 0, Take = 20 });
```

## JSON in SQL Server

### JSON_VALUE (Extract Scalar)

```csharp
var sql = @"
    SELECT TOP 1 ID FROM DEMO_Entregas
    WHERE JSON_VALUE(DataPayload, '$.callId') = @CallId";

var itemId = await connection.QueryFirstOrDefaultAsync<int?>(sql,
    new { CallId = callId });
```

### JSON Serialization

```csharp
var dataJson = JsonSerializer.Serialize(actionData, new JsonSerializerOptions
{
    WriteIndented = false,
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase  // PascalCase → camelCase
});

insert.Set("DataPayload", dataJson);
```

### JSON Deserialization + Update

```csharp
var data = JsonSerializer.Deserialize<Dictionary<string, object>>(existingJson)
    ?? new Dictionary<string, object>();

data["newField"] = newValue;

var updatedJson = JsonSerializer.Serialize(data);
```

## Performance Tips

1. **Use `WITH (NOLOCK)` for reads** to avoid locking issues
2. **Buffer results only when needed** - Dapper buffers by default, use `buffered: false` for large datasets
3. **Async all the way** - Don't mix sync/async
4. **Connection pooling** - Let .NET handle it, don't create connection factories yourself
5. **Parameterize once** - Don't rebuild DynamicParameters in loops

## Security

### SQL Injection Prevention

✅ **ALWAYS parametrize:**
```csharp
// ✅ SAFE
var sql = "SELECT * FROM Users WHERE Name = @Name";
await connection.QueryAsync<User>(sql, new { Name = userName });
```

❌ **NEVER concatenate:**
```csharp
// ❌ VULNERABLE TO SQL INJECTION
var sql = $"SELECT * FROM Users WHERE Name = '{userName}'";
await connection.QueryAsync<User>(sql);
```

### Ownership Validation

```csharp
// ✅ Validate ownership in memory BEFORE query
var item = await GetByIdAsync(itemId);
if (item.IdOwner != currentOwnerId)
    throw new UnauthorizedAccessException();

// THEN proceed with update
await UpdateAsync(item);
```

## References

For detailed information, see:

- [SafeQueryBuilder](../safe-query-builder/SKILL.md) - Fluent query builder API reference, query patterns and transactions
- The sections above cover JSON columns in SQL Server (`JSON_VALUE`) and ownership validation

## Common Mistakes

❌ **Mixing sync/async:**
```csharp
var result = connection.QueryAsync<User>(sql).Result;  // DON'T
```

✅ **Async all the way:**
```csharp
var result = await connection.QueryAsync<User>(sql);  // DO
```

---

❌ **Not using `using` for connections:**
```csharp
var connection = _connectionFactory.CreateConnection();
connection.Open();
var results = await connection.QueryAsync<User>(sql);
// Connection never closed!
```

✅ **Always use `using`:**
```csharp
using var connection = _connectionFactory.CreateConnection();
connection.Open();
var results = await connection.QueryAsync<User>(sql);
// Connection auto-closed
```

---

❌ **DateTime.Now:**
```csharp
insert.Set("CreatedDate", DateTime.Now);  // Local time - BAD
```

✅ **DateTime.UtcNow:**
```csharp
insert.Set("CreatedDate", DateTime.UtcNow);  // UTC - GOOD
```
