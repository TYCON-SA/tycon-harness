---
name: safe-query-builder
description: SafeQueryBuilder pattern for SQL injection prevention with Dapper. Use when asked about "SQL injection prevention", "SafeQueryBuilder", "SafeRepository", "parameterized queries", "Dapper query building", "secure SQL queries", or "how to prevent SQL injection in .NET".
metadata:
  author: tycon-team
  version: "1.0.0"
  last-updated: "2026-01-25"
  changelog: |
    v1.0.0 - Initial version from TotoraBackend patterns
---

# SafeQueryBuilder - SQL Injection Prevention Pattern

Complete guide to using SafeQueryBuilder for 100% SQL injection-proof queries with Dapper.

## Core Principle

**SQL Injection is IMPOSSIBLE** when using SafeQueryBuilder - all values are automatically parameterized.

## When to Use This Skill

Use this skill when you need to:
- Write secure SQL queries in .NET with Dapper
- Prevent SQL injection vulnerabilities
- Build dynamic queries safely
- Implement repository pattern with type safety
- Understand how SafeQueryBuilder works internally

## Quick Start

### 1. Create Repository

```csharp
using Bizuit.Backend.Core.Database;

public class UsersRepository : SafeRepository<User>
{
    protected override string TableName => "Users";

    public UsersRepository(IConnectionFactory connectionFactory)
        : base(connectionFactory)
    {
    }

    // Methods using SafeQueryBuilder...
}
```

### 2. SELECT Queries

```csharp
// Get all users
public async Task<IEnumerable<User>> GetAllAsync()
{
    var query = Query()                    // SELECT * FROM Users
        .OrderByDescending("CreatedOnDate");

    return await ExecuteAsync(query);
}

// Get by ID
public async Task<User?> GetByIdAsync(int id)
{
    return await ExecuteSingleAsync(
        Query().WhereEquals("ID", id));    // WHERE ID = @p0
}

// Get by multiple conditions
public async Task<IEnumerable<User>> SearchAsync(string name, bool? isActive)
{
    var query = Query()
        .WhereLike("Name", $"%{name}%")    // WHERE Name LIKE @p0
        .WhereEquals("IsActive", isActive); // AND IsActive = @p1

    return await ExecuteAsync(query);
}
```

### 3. INSERT Queries

```csharp
public async Task<int> CreateAsync(string name, string email)
{
    var insert = Insert()
        .Set("Name", name)          // @p0
        .Set("Email", email)        // @p1
        .Set("CreatedOnDate", DateTime.UtcNow);  // @p2

    return await ExecuteWithIdentityAsync(insert);  // Returns inserted ID
}
```

### 4. UPDATE Queries

```csharp
public async Task<bool> UpdateAsync(int id, string name, string email)
{
    var update = Update()
        .Set("Name", name)                      // @p0
        .Set("Email", email)                    // @p1
        .Set("LastModifiedOnDate", DateTime.UtcNow)  // @p2
        .WhereEquals("ID", id);                 // WHERE ID = @p3

    var rows = await ExecuteAsync(update);
    return rows > 0;
}

// Conditional updates
public async Task<bool> UpdatePartialAsync(int id, UpdateUserRequest request)
{
    var update = Update()
        .Set("LastModifiedOnDate", DateTime.UtcNow)
        .WhereEquals("ID", id);

    if (!string.IsNullOrEmpty(request.Name))
    {
        update.Set("Name", request.Name);
    }

    if (!string.IsNullOrEmpty(request.Email))
    {
        update.Set("Email", request.Email);
    }

    var rows = await ExecuteAsync(update);
    return rows > 0;
}
```

### 5. DELETE Queries

```csharp
public async Task<bool> DeleteAsync(int id)
{
    var rows = await ExecuteAsync(
        Delete().WhereEquals("ID", id));
    return rows > 0;
}
```

---

## SafeQueryBuilder API Reference

### Query Operations

#### SELECT

```csharp
// Basic SELECT
Query()                                    // SELECT * FROM [TableName]

// With columns
Query("ID", "Name", "Email")               // SELECT ID, Name, Email FROM [TableName]

// With DISTINCT
Query().Distinct()                         // SELECT DISTINCT * FROM [TableName]
```

#### WHERE Clauses

```csharp
// Equals
.WhereEquals("Status", "Active")           // WHERE Status = @p0

// Not equals
.WhereNotEquals("Status", "Deleted")       // WHERE Status <> @p0

// LIKE
.WhereLike("Name", "%John%")               // WHERE Name LIKE @p0

// IN
.WhereIn("Status", new[] { "Active", "Pending" })  // WHERE Status IN (@p0, @p1)

// NULL checks
.WhereIsNull("DeletedOnDate")              // WHERE DeletedOnDate IS NULL
.WhereIsNotNull("Email")                   // WHERE Email IS NOT NULL

// Greater than / Less than
.WhereGreaterThan("Age", 18)               // WHERE Age > @p0
.WhereLessThan("Age", 65)                  // WHERE Age < @p0
.WhereGreaterOrEqual("CreatedOnDate", date) // WHERE CreatedOnDate >= @p0
.WhereLessOrEqual("UpdatedOnDate", date)    // WHERE UpdatedOnDate <= @p0
```

#### ORDER BY

```csharp
.OrderBy("Name")                           // ORDER BY Name ASC
.OrderByDescending("CreatedOnDate")        // ORDER BY CreatedOnDate DESC

// Multiple columns
.OrderBy("Status")
.OrderByDescending("CreatedOnDate")        // ORDER BY Status ASC, CreatedOnDate DESC
```

#### LIMIT / OFFSET

```csharp
.Top(10)                                   // SELECT TOP 10 * FROM ...
.Skip(20).Take(10)                         // OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY
```

---

### INSERT Operations

```csharp
// Basic INSERT
Insert()
    .Set("Name", "John")
    .Set("Email", "john@example.com")
    .Set("CreatedOnDate", DateTime.UtcNow);

// Execute and return row count
var rows = await ExecuteAsync(insert);

// Execute and return inserted ID (SCOPE_IDENTITY())
var id = await ExecuteWithIdentityAsync(insert);
```

---

### UPDATE Operations

```csharp
// Basic UPDATE
Update()
    .Set("Name", "Jane")
    .Set("Email", "jane@example.com")
    .WhereEquals("ID", 123);

// Multiple WHERE clauses
Update()
    .Set("Status", "Processed")
    .WhereEquals("Status", "Pending")
    .WhereLessThan("CreatedOnDate", DateTime.UtcNow.AddDays(-7));
```

---

### DELETE Operations

```csharp
// Basic DELETE
Delete()
    .WhereEquals("ID", 123);

// Conditional DELETE
Delete()
    .WhereEquals("Status", "Inactive")
    .WhereLessThan("LastLoginDate", DateTime.UtcNow.AddYears(-1));
```

---

## Execution Methods

### ExecuteAsync

Returns number of rows affected (for UPDATE/DELETE) or IEnumerable (for SELECT).

```csharp
// SELECT
var users = await ExecuteAsync(query);
// Returns: IEnumerable<User>

// UPDATE/DELETE
var rows = await ExecuteAsync(update);
// Returns: int (number of rows affected)
```

### ExecuteSingleAsync

Returns single record or null.

```csharp
var user = await ExecuteSingleAsync(query);
// Returns: User? (nullable)
```

### ExecuteWithIdentityAsync

Returns inserted ID (for INSERT).

```csharp
var id = await ExecuteWithIdentityAsync(insert);
// Returns: int (SCOPE_IDENTITY())
```

---

## Advanced Patterns

### 1. Custom SQL with Parameters

For complex queries that SafeQueryBuilder doesn't support:

```csharp
public async Task<IEnumerable<User>> ComplexQueryAsync(string searchTerm)
{
    using var connection = _connectionFactory.CreateConnection();

    var sql = @"
        SELECT u.*, COUNT(o.ID) as OrderCount
        FROM Users u
        LEFT JOIN Orders o ON u.ID = o.UserID
        WHERE u.Name LIKE @SearchTerm
        GROUP BY u.ID, u.Name, u.Email
        HAVING COUNT(o.ID) > 0";

    return await connection.QueryAsync<User>(sql, new { SearchTerm = $"%{searchTerm}%" });
}
```

**Key:** Still use parameters (`@SearchTerm`) - NEVER string concatenation.

### 2. Transactions

```csharp
public async Task CreateUserWithOrdersAsync(User user, IEnumerable<Order> orders)
{
    using var connection = _connectionFactory.CreateConnection();
    connection.Open();

    using var transaction = connection.BeginTransaction();
    try
    {
        // Insert user
        var userId = await ExecuteWithIdentityAsync(
            Insert()
                .Set("Name", user.Name)
                .Set("Email", user.Email));

        // Insert orders
        foreach (var order in orders)
        {
            await connection.ExecuteAsync(
                "INSERT INTO Orders (UserID, Amount) VALUES (@UserID, @Amount)",
                new { UserID = userId, Amount = order.Amount },
                transaction);
        }

        transaction.Commit();
    }
    catch
    {
        transaction.Rollback();
        throw;
    }
}
```

### 3. Dynamic WHERE Clauses

```csharp
public async Task<IEnumerable<User>> SearchAsync(UserSearchRequest request)
{
    var query = Query();

    // Add WHERE clauses conditionally
    if (!string.IsNullOrEmpty(request.Name))
    {
        query.WhereLike("Name", $"%{request.Name}%");
    }

    if (request.IsActive.HasValue)
    {
        query.WhereEquals("IsActive", request.IsActive.Value);
    }

    if (request.MinAge.HasValue)
    {
        query.WhereGreaterOrEqual("Age", request.MinAge.Value);
    }

    query.OrderByDescending("CreatedOnDate");

    return await ExecuteAsync(query);
}
```

---

## Why SafeQueryBuilder Prevents SQL Injection

### ❌ VULNERABLE (String Concatenation)

```csharp
// NEVER DO THIS - SQL INJECTION VULNERABILITY!
var sql = $"SELECT * FROM Users WHERE Name = '{name}'";
var users = await connection.QueryAsync<User>(sql);

// Attack: name = "'; DROP TABLE Users; --"
// Results in: SELECT * FROM Users WHERE Name = ''; DROP TABLE Users; --'
```

### ✅ SAFE (SafeQueryBuilder)

```csharp
// ALWAYS DO THIS - 100% SAFE
var query = Query().WhereEquals("Name", name);
var users = await ExecuteAsync(query);

// Generated SQL: SELECT * FROM Users WHERE Name = @p0
// Parameters: { @p0 = "'; DROP TABLE Users; --" }
// Attack attempt is treated as literal string value
```

**How it works:**
1. SafeQueryBuilder builds parameterized SQL: `WHERE Name = @p0`
2. Values are passed separately as parameters: `{ @p0 = userInput }`
3. Database treats parameters as **data**, not **code**
4. No way to inject malicious SQL

---

## Common Patterns by Operation

### Get All (with Ordering)

```csharp
public async Task<IEnumerable<T>> GetAllAsync()
{
    return await ExecuteAsync(
        Query().OrderByDescending("CreatedOnDate"));
}
```

### Get by ID

```csharp
public async Task<T?> GetByIdAsync(int id)
{
    return await ExecuteSingleAsync(
        Query().WhereEquals("ID", id));
}
```

### Get by Foreign Key

```csharp
public async Task<IEnumerable<Order>> GetByUserAsync(int userId)
{
    return await ExecuteAsync(
        Query()
            .WhereEquals("UserID", userId)
            .OrderByDescending("OrderDate"));
}
```

### Soft Delete

```csharp
public async Task<bool> SoftDeleteAsync(int id)
{
    var rows = await ExecuteAsync(
        Update()
            .Set("DeletedOnDate", DateTime.UtcNow)
            .WhereEquals("ID", id));

    return rows > 0;
}
```

### Check Existence

```csharp
public async Task<bool> ExistsAsync(int id)
{
    using var connection = _connectionFactory.CreateConnection();
    var sql = "SELECT CASE WHEN EXISTS(SELECT 1 FROM Users WHERE ID = @ID) THEN 1 ELSE 0 END";
    return await connection.QuerySingleAsync<bool>(sql, new { ID = id });
}
```

### Duplicate Detection

```csharp
public async Task<bool> EmailExistsAsync(string email, int? excludeUserId = null)
{
    using var connection = _connectionFactory.CreateConnection();

    var sql = @"
        SELECT CASE WHEN EXISTS(
            SELECT 1 FROM Users
            WHERE Email = @Email
            AND (@ExcludeUserId IS NULL OR ID <> @ExcludeUserId)
        ) THEN 1 ELSE 0 END";

    return await connection.QuerySingleAsync<bool>(sql, new
    {
        Email = email,
        ExcludeUserId = excludeUserId
    });
}
```

---

## Testing SafeQueryBuilder Queries

### Unit Testing Pattern

```csharp
[Fact]
public async Task GetByIdAsync_ShouldReturnUser()
{
    // Arrange
    var userId = 123;

    // Act
    var user = await _repository.GetByIdAsync(userId);

    // Assert
    Assert.NotNull(user);
    Assert.Equal(userId, user.ID);
}

[Fact]
public async Task CreateAsync_ShouldReturnNewId()
{
    // Arrange
    var name = "Test User";
    var email = "test@example.com";

    // Act
    var id = await _repository.CreateAsync(name, email);

    // Assert
    Assert.True(id > 0);
}
```

### Integration Testing

```csharp
public class UsersRepositoryTests : IntegrationTestBase
{
    private readonly UsersRepository _repository;

    public UsersRepositoryTests()
    {
        _repository = new UsersRepository(ConnectionFactory);
    }

    [Fact]
    public async Task CRUD_ShouldWork()
    {
        // Create
        var id = await _repository.CreateAsync("John", "john@test.com");

        // Read
        var user = await _repository.GetByIdAsync(id);
        Assert.Equal("John", user.Name);

        // Update
        var updated = await _repository.UpdateAsync(id, "Jane", "jane@test.com");
        Assert.True(updated);

        // Delete
        var deleted = await _repository.DeleteAsync(id);
        Assert.True(deleted);
    }
}
```

---

## Common Mistakes to Avoid

### ❌ Mistake 1: String Concatenation in WHERE

```csharp
// WRONG - SQL Injection vulnerability
var query = Query().Where($"Name = '{name}'");
```

**Fix:** Use WhereEquals
```csharp
// CORRECT
var query = Query().WhereEquals("Name", name);
```

---

### ❌ Mistake 2: Forgetting to Parameterize Custom SQL

```csharp
// WRONG
var sql = $"SELECT * FROM Users WHERE Name = '{name}'";
var users = await connection.QueryAsync<User>(sql);
```

**Fix:** Use parameters
```csharp
// CORRECT
var sql = "SELECT * FROM Users WHERE Name = @Name";
var users = await connection.QueryAsync<User>(sql, new { Name = name });
```

---

### ❌ Mistake 3: Not Handling Null Return Values

```csharp
// WRONG - NullReferenceException if not found
var user = await ExecuteSingleAsync(query);
var name = user.Name;  // Crash if user is null
```

**Fix:** Check for null
```csharp
// CORRECT
var user = await ExecuteSingleAsync(query);
if (user != null)
{
    var name = user.Name;
}
```

---

## Summary

**Key Takeaways:**

1. **SafeQueryBuilder = 100% SQL injection proof** - all values parameterized
2. **Fluent API** for building queries: WhereEquals, WhereLike, OrderBy, etc.
3. **Three execution modes:**
   - ExecuteAsync: SELECT (returns IEnumerable) or UPDATE/DELETE (returns row count)
   - ExecuteSingleAsync: Single record or null
   - ExecuteWithIdentityAsync: INSERT with ID return
4. **For complex queries:** Use custom SQL with parameters, NOT SafeQueryBuilder
5. **Always parameterize:** Even in custom SQL, use `@paramName` syntax

**Most Common Operations:**
- Get all: `Query().OrderByDescending("CreatedOnDate")`
- Get by ID: `Query().WhereEquals("ID", id)`
- Insert: `Insert().Set("Column", value)`
- Update: `Update().Set("Column", value).WhereEquals("ID", id)`
- Delete: `Delete().WhereEquals("ID", id)`

**When NOT to Use:**
- Complex JOINs (use custom SQL)
- Subqueries (use custom SQL)
- CTEs (use custom SQL)
- But still use parameters!
