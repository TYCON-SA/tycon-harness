---
name: feature-based-crud-endpoints
description: Feature-based CRUD endpoint patterns with ownership enforcement, role-based access, validation, and batch operations. Use when asked about "feature endpoints", "CRUD patterns", "ownership enforcement", "role-based authorization", "batch operations", "endpoint organization", or "how to structure REST API endpoints in .NET".
metadata:
  author: tycon-team
  version: "1.0.0"
  last-updated: "2026-01-25"
  changelog: |
    v1.0.0 - Initial version from the backend patterns of a team product
---

# Feature-Based CRUD Endpoints

Complete guide to organizing REST API endpoints by feature with ownership enforcement, role-based access control, validation, and advanced patterns like batch operations and partial updates.

## Core Principles

1. **Feature-Based Organization** - Group endpoints by business feature (Users, Orders, Products)
2. **Ownership Enforcement** - Users can only access their own resources (unless admin)
3. **Role-Based Access Control** - Different permissions for different roles
4. **Validation First** - FluentValidation before business logic
5. **Static Endpoint Classes** - One static class per feature with `Map()` method
6. **Consistent Responses** - Standard error format, HTTP status codes

## When to Use This Skill

Use this skill when you need to:
- Structure REST API endpoints by feature
- Implement ownership enforcement (users see only their data)
- Configure role-based access control
- Add batch operations to reduce round-trips
- Implement partial updates (PATCH)
- Organize Minimal API endpoints cleanly
- Handle validation with FluentValidation

## Quick Start

### 1. Feature Endpoint Class

```csharp
namespace MyPlugin.Features.Users;

public static class UsersEndpoints
{
    // Role constants
    private const string readAndCreateRoles = "Administrators,Managers,Users";
    private const string modifyRoles = "Administrators,Managers";
    private static readonly string[] AdminRoles = { "Administrators" };

    public static void Map(IPluginEndpointBuilder endpoints)
    {
        // READ
        endpoints.MapGet("users", GetAll)
            .RequireAuthorization(readAndCreateRoles);

        endpoints.MapGet("users/{id:int}", GetById)
            .RequireAuthorization(readAndCreateRoles);

        endpoints.MapGet("users/search", Search)
            .RequireAuthorization(readAndCreateRoles);

        endpoints.MapPost("users/batch", GetBatch)
            .RequireAuthorization(readAndCreateRoles);

        // CREATE
        endpoints.MapPost("users", Create)
            .RequireAuthorization(readAndCreateRoles);

        // UPDATE
        endpoints.MapPut("users/{id:int}", Update)
            .RequireAuthorization(modifyRoles);

        endpoints.MapPatch("users/{id:int}/email", UpdateEmail)
            .RequireAuthorization(readAndCreateRoles);

        // DELETE
        endpoints.MapDelete("users/{id:int}", Delete)
            .RequireAuthorization(modifyRoles);
    }

    // Handlers below...
}
```

### 2. Ownership Enforcement Pattern

```csharp
private static bool IsAdmin(BizuitUserContext user)
{
    return user.HasAnyRole(AdminRoles);
}

private static (int UserId, IResult? Error) GetUserIdFromContext(BizuitUserContext user)
{
    var userIdValue = user.GetSettingValue("Users", "UserId");

    if (string.IsNullOrEmpty(userIdValue))
    {
        return (0, Results.BadRequest(new
        {
            error = "User does not have UserId configured in RoleSettings",
            username = user.Username
        }));
    }

    if (!int.TryParse(userIdValue, out var userId))
    {
        return (0, Results.BadRequest(new
        {
            error = "UserId value is not a valid integer",
            detail = $"The UserId setting value '{userIdValue}' cannot be converted to an integer"
        }));
    }

    return (userId, null);
}

private static async Task<IResult> GetAll(UsersService service, BizuitUserContext user)
{
    if (IsAdmin(user))
    {
        // Admins see everything
        var users = await service.GetAllAsync();
        return Results.Ok(users);
    }

    // Regular users see only their own data
    var userIdResult = GetUserIdFromContext(user);
    if (userIdResult.Error != null)
        return userIdResult.Error;

    var ownUsers = await service.GetByOwnerAsync(userIdResult.UserId);
    return Results.Ok(ownUsers);
}
```

### 3. Validation with FluentValidation

```csharp
private static async Task<IResult> Create(
    CreateUserRequest request,
    UsersService service,
    IValidator<CreateUserRequest> validator,
    BizuitUserContext user)
{
    // Validate request
    var validationResult = await validator.ValidateAsync(request);
    if (!validationResult.IsValid)
    {
        return Results.BadRequest(new
        {
            error = "Validation failed",
            errors = validationResult.Errors.Select(e => new
            {
                field = e.PropertyName,
                message = e.ErrorMessage
            })
        });
    }

    // Check ownership (if not admin)
    if (!IsAdmin(user))
    {
        var userIdResult = GetUserIdFromContext(user);
        if (userIdResult.Error != null)
            return userIdResult.Error;

        request.OwnerId = userIdResult.UserId;
    }

    // Create user
    var userId = await service.CreateAsync(request);

    return Results.Created($"/api/plugins/myplugin/users/{userId}", new { id = userId });
}
```

---

## Feature-Based Organization

### Structure

```
Features/
├── Users/
│   ├── UsersEndpoints.cs       # Endpoint definitions
│   ├── UsersService.cs         # Business logic
│   ├── UsersRepository.cs      # Data access
│   ├── Models/
│   │   ├── User.cs             # Domain model
│   │   ├── CreateUserRequest.cs
│   │   ├── UpdateUserRequest.cs
│   │   └── UserSearchFilters.cs
│   └── Validators/
│       ├── CreateUserRequestValidator.cs
│       └── UpdateUserRequestValidator.cs
│
├── Orders/
│   ├── OrdersEndpoints.cs
│   ├── OrdersService.cs
│   └── ...
│
└── Products/
    ├── ProductsEndpoints.cs
    ├── ProductsService.cs
    └── ...
```

### Endpoint Class Pattern

```csharp
public static class UsersEndpoints
{
    // Constants
    private const string readAndCreateRoles = "Administrators,Managers,Users";
    private const string modifyRoles = "Administrators,Managers";
    private static readonly string[] AdminRoles = { "Administrators" };

    // Map method - called from plugin ConfigureEndpoints
    public static void Map(IPluginEndpointBuilder endpoints)
    {
        // All endpoints registered here
    }

    // Helper methods
    private static bool IsAdmin(BizuitUserContext user) { ... }
    private static (int UserId, IResult? Error) GetUserIdFromContext(BizuitUserContext user) { ... }

    // Handlers
    private static async Task<IResult> GetAll(...) { ... }
    private static async Task<IResult> GetById(...) { ... }
    // ... etc
}
```

---

## Ownership Enforcement

### Pattern 1: Filter by Owner ID

**Use case:** Users can only see their own records

```csharp
private static async Task<IResult> GetAll(UsersService service, BizuitUserContext user)
{
    if (IsAdmin(user))
    {
        // Admins see all
        return Results.Ok(await service.GetAllAsync());
    }

    // Regular users see only their own
    var userIdResult = GetUserIdFromContext(user);
    if (userIdResult.Error != null)
        return userIdResult.Error;

    return Results.Ok(await service.GetByOwnerAsync(userIdResult.UserId));
}
```

### Pattern 2: Validate Current Assignment

**Use case:** Users can only access resources currently assigned to them

```csharp
private static async Task<IResult> GetById(
    int id,
    UsersService service,
    ValidationHelper validationHelper,
    BizuitUserContext user)
{
    var user = await service.GetByIdAsync(id);
    if (user == null)
        return Results.NotFound(new { error = "User not found" });

    // Ownership check for non-admins
    if (!IsAdmin(user))
    {
        var userIdResult = GetUserIdFromContext(user);
        if (userIdResult.Error != null)
            return userIdResult.Error;

        // Validate current assignment (not historical)
        var isAssigned = await validationHelper.IsUserAssignedAsync(
            userIdResult.UserId,
            id);

        if (!isAssigned)
            return Results.Forbid();
    }

    return Results.Ok(user);
}
```

### Pattern 3: Enforce Owner on Create

**Use case:** Non-admin users must create resources owned by themselves

```csharp
private static async Task<IResult> Create(
    CreateUserRequest request,
    UsersService service,
    BizuitUserContext user)
{
    if (!IsAdmin(user))
    {
        // Force owner to be current user
        var userIdResult = GetUserIdFromContext(user);
        if (userIdResult.Error != null)
            return userIdResult.Error;

        request.OwnerId = userIdResult.UserId;
    }

    var userId = await service.CreateAsync(request);
    return Results.Created($"/users/{userId}", new { id = userId });
}
```

---

## Role-Based Access Control

### Role Constants

```csharp
// Define role groups
private const string readRoles = "Administrators,Managers,Users";
private const string readAndCreateRoles = "Administrators,Managers,Users";
private const string modifyRoles = "Administrators,Managers";
private static readonly string[] AdminRoles = { "Administrators" };
```

### Endpoint Authorization

```csharp
// Everyone can read
endpoints.MapGet("users", GetAll)
    .RequireAuthorization(readRoles);

// Everyone can create
endpoints.MapPost("users", Create)
    .RequireAuthorization(readAndCreateRoles);

// Only admins/managers can update
endpoints.MapPut("users/{id:int}", Update)
    .RequireAuthorization(modifyRoles);

// Only admins/managers can delete
endpoints.MapDelete("users/{id:int}", Delete)
    .RequireAuthorization(modifyRoles);
```

### Role Checks in Handlers

```csharp
private static bool IsAdmin(BizuitUserContext user)
{
    return user.HasAnyRole(AdminRoles);
}

private static async Task<IResult> GetAll(UsersService service, BizuitUserContext user)
{
    if (IsAdmin(user))
    {
        // Admins get full access
        return Results.Ok(await service.GetAllAsync());
    }

    // Non-admins get filtered results
    var filtered = await service.GetFilteredAsync(user);
    return Results.Ok(filtered);
}
```

---

## CRUD Operations

### 1. READ Operations

**GetAll - List with ownership filter:**

```csharp
private static async Task<IResult> GetAll(UsersService service, BizuitUserContext user)
{
    if (IsAdmin(user))
    {
        var users = await service.GetAllAsync();
        return Results.Ok(users);
    }

    var userIdResult = GetUserIdFromContext(user);
    if (userIdResult.Error != null)
        return userIdResult.Error;

    var ownUsers = await service.GetByOwnerAsync(userIdResult.UserId);
    return Results.Ok(ownUsers);
}
```

**GetById - With ownership validation:**

```csharp
private static async Task<IResult> GetById(
    int id,
    UsersService service,
    ValidationHelper validationHelper,
    BizuitUserContext user)
{
    var user = await service.GetByIdAsync(id);
    if (user == null)
        return Results.NotFound(new { error = "User not found" });

    // Ownership check
    if (!IsAdmin(user))
    {
        var userIdResult = GetUserIdFromContext(user);
        if (userIdResult.Error != null)
            return userIdResult.Error;

        var isAssigned = await validationHelper.IsUserAssignedAsync(
            userIdResult.UserId, id);

        if (!isAssigned)
            return Results.Forbid();
    }

    return Results.Ok(user);
}
```

**Search - With filters:**

```csharp
private static async Task<IResult> Search(
    [FromQuery] string? name,
    [FromQuery] bool? isActive,
    [FromQuery] int page = 1,
    [FromQuery] int pageSize = 20,
    UsersService service,
    BizuitUserContext user)
{
    var filters = new UserSearchFilters
    {
        Name = name,
        IsActive = isActive,
        Page = page,
        PageSize = pageSize
    };

    // Add ownership filter for non-admins
    if (!IsAdmin(user))
    {
        var userIdResult = GetUserIdFromContext(user);
        if (userIdResult.Error != null)
            return userIdResult.Error;

        filters.OwnerId = userIdResult.UserId;
    }

    var results = await service.SearchAsync(filters);
    return Results.Ok(results);
}
```

### 2. CREATE Operations

**Create - With validation and ownership:**

```csharp
private static async Task<IResult> Create(
    CreateUserRequest request,
    UsersService service,
    IValidator<CreateUserRequest> validator,
    BizuitUserContext user)
{
    // Validate request
    var validationResult = await validator.ValidateAsync(request);
    if (!validationResult.IsValid)
    {
        return Results.BadRequest(new
        {
            error = "Validation failed",
            errors = validationResult.Errors.Select(e => new
            {
                field = e.PropertyName,
                message = e.ErrorMessage
            })
        });
    }

    // Enforce ownership for non-admins
    if (!IsAdmin(user))
    {
        var userIdResult = GetUserIdFromContext(user);
        if (userIdResult.Error != null)
            return userIdResult.Error;

        request.OwnerId = userIdResult.UserId;
    }

    var userId = await service.CreateAsync(request);
    return Results.Created($"/api/plugins/myplugin/users/{userId}", new { id = userId });
}
```

### 3. UPDATE Operations

**Full Update (PUT):**

```csharp
private static async Task<IResult> Update(
    int id,
    UpdateUserRequest request,
    UsersService service,
    IValidator<UpdateUserRequest> validator,
    ValidationHelper validationHelper,
    BizuitUserContext user)
{
    // Validate request
    var validationResult = await validator.ValidateAsync(request);
    if (!validationResult.IsValid)
    {
        return Results.BadRequest(new
        {
            error = "Validation failed",
            errors = validationResult.Errors.Select(e => e.ErrorMessage)
        });
    }

    // Ownership check
    if (!IsAdmin(user))
    {
        var userIdResult = GetUserIdFromContext(user);
        if (userIdResult.Error != null)
            return userIdResult.Error;

        var isAssigned = await validationHelper.IsUserAssignedAsync(
            userIdResult.UserId, id);

        if (!isAssigned)
            return Results.Forbid();
    }

    var success = await service.UpdateAsync(id, request);
    if (!success)
        return Results.NotFound(new { error = "User not found" });

    return Results.NoContent();
}
```

**Partial Update (PATCH):**

```csharp
private static async Task<IResult> UpdateEmail(
    int id,
    [FromBody] string email,
    UsersService service,
    ValidationHelper validationHelper,
    BizuitUserContext user)
{
    // Ownership check
    if (!IsAdmin(user))
    {
        var userIdResult = GetUserIdFromContext(user);
        if (userIdResult.Error != null)
            return userIdResult.Error;

        var isAssigned = await validationHelper.IsUserAssignedAsync(
            userIdResult.UserId, id);

        if (!isAssigned)
            return Results.Forbid();
    }

    var success = await service.UpdateEmailAsync(id, email);
    if (!success)
        return Results.NotFound(new { error = "User not found" });

    return Results.NoContent();
}
```

### 4. DELETE Operations

**Soft Delete:**

```csharp
private static async Task<IResult> Delete(
    int id,
    UsersService service,
    BizuitUserContext user)
{
    // Only admins can delete (enforced by RequireAuthorization)

    var success = await service.SoftDeleteAsync(id);
    if (!success)
        return Results.NotFound(new { error = "User not found" });

    return Results.NoContent();
}
```

**Hard Delete:**

```csharp
private static async Task<IResult> HardDelete(
    int id,
    UsersService service,
    BizuitUserContext user)
{
    // Only admins can hard delete

    var success = await service.HardDeleteAsync(id);
    if (!success)
        return Results.NotFound(new { error = "User not found" });

    return Results.NoContent();
}
```

---

## Advanced Patterns

### 1. Batch Operations

**Get multiple resources in one request:**

```csharp
endpoints.MapPost("users/batch", GetBatch)
    .RequireAuthorization(readRoles);

private static async Task<IResult> GetBatch(
    [FromBody] int[] ids,
    UsersService service,
    ValidationHelper validationHelper,
    BizuitUserContext user)
{
    if (ids == null || ids.Length == 0)
    {
        return Results.BadRequest(new { error = "No IDs provided" });
    }

    // Ownership check for non-admins
    if (!IsAdmin(user))
    {
        var userIdResult = GetUserIdFromContext(user);
        if (userIdResult.Error != null)
            return userIdResult.Error;

        // Validate user can access ALL requested IDs
        var accessibleIds = await validationHelper.GetAccessibleIdsAsync(
            userIdResult.UserId, ids);

        if (accessibleIds.Count != ids.Length)
        {
            return Results.Forbid();
        }
    }

    var users = await service.GetBatchAsync(ids);
    return Results.Ok(users);
}
```

### 2. Conditional Includes

**Include related data optionally:**

```csharp
private static async Task<IResult> GetById(
    int id,
    UsersService service,
    [FromQuery] bool includeOrders = false,
    [FromQuery] bool includeAddresses = false,
    BizuitUserContext user)
{
    var user = await service.GetByIdAsync(id);
    if (user == null)
        return Results.NotFound(new { error = "User not found" });

    // Ownership check...

    // Conditionally include related data
    if (includeOrders)
    {
        user.Orders = await service.GetOrdersAsync(id);
    }

    if (includeAddresses)
    {
        user.Addresses = await service.GetAddressesAsync(id);
    }

    return Results.Ok(user);
}
```

### 3. Audit History

**Get audit trail for a resource:**

```csharp
endpoints.MapGet("users/{id:int}/historial", GetHistorial)
    .RequireAuthorization(readRoles);

private static async Task<IResult> GetHistorial(
    int id,
    UsersService service,
    BizuitUserContext user)
{
    // Ownership check...

    var history = await service.GetAuditHistoryAsync(id);
    return Results.Ok(history);
}
```

### 4. Search with Pagination

```csharp
private static async Task<IResult> Search(
    [FromQuery] UserSearchFilters filters,
    UsersService service,
    BizuitUserContext user)
{
    // Add ownership filter for non-admins
    if (!IsAdmin(user))
    {
        var userIdResult = GetUserIdFromContext(user);
        if (userIdResult.Error != null)
            return userIdResult.Error;

        filters.OwnerId = userIdResult.UserId;
    }

    var results = await service.SearchAsync(filters);

    return Results.Ok(new
    {
        data = results.Items,
        pagination = new
        {
            page = filters.Page,
            pageSize = filters.PageSize,
            totalCount = results.TotalCount,
            totalPages = (int)Math.Ceiling((double)results.TotalCount / filters.PageSize)
        }
    });
}
```

---

## Validation Patterns

### FluentValidation Setup

**Validator:**

```csharp
public class CreateUserRequestValidator : AbstractValidator<CreateUserRequest>
{
    public CreateUserRequestValidator()
    {
        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("Name is required")
            .MaximumLength(100).WithMessage("Name must be 100 characters or less");

        RuleFor(x => x.Email)
            .NotEmpty().WithMessage("Email is required")
            .EmailAddress().WithMessage("Invalid email format");

        RuleFor(x => x.Age)
            .InclusiveBetween(18, 120).WithMessage("Age must be between 18 and 120");
    }
}
```

**Usage in endpoint:**

```csharp
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
            error = "Validation failed",
            errors = validationResult.Errors.Select(e => new
            {
                field = e.PropertyName,
                message = e.ErrorMessage
            })
        });
    }

    var userId = await service.CreateAsync(request);
    return Results.Created($"/users/{userId}", new { id = userId });
}
```

---

## Error Handling

### Standard Error Format

```csharp
// 400 Bad Request
return Results.BadRequest(new
{
    error = "Validation failed",
    errors = validationResult.Errors.Select(e => e.ErrorMessage)
});

// 404 Not Found
return Results.NotFound(new { error = "User not found" });

// 403 Forbidden
return Results.Forbid();

// 409 Conflict
return Results.Conflict(new { error = "Email already exists" });
```

### Service-Level Exceptions

```csharp
public async Task<int> CreateAsync(CreateUserRequest request)
{
    // Check for duplicates
    var exists = await _repository.EmailExistsAsync(request.Email);
    if (exists)
    {
        throw new DuplicateEmailException($"Email '{request.Email}' already exists");
    }

    return await _repository.CreateAsync(request);
}
```

**Handle in endpoint:**

```csharp
private static async Task<IResult> Create(
    CreateUserRequest request,
    UsersService service,
    IValidator<CreateUserRequest> validator)
{
    var validationResult = await validator.ValidateAsync(request);
    if (!validationResult.IsValid)
    {
        return Results.BadRequest(new { error = "Validation failed", errors = validationResult.Errors });
    }

    try
    {
        var userId = await service.CreateAsync(request);
        return Results.Created($"/users/{userId}", new { id = userId });
    }
    catch (DuplicateEmailException ex)
    {
        return Results.Conflict(new { error = ex.Message });
    }
}
```

---

## Testing Patterns

### Unit Testing Endpoints

```csharp
[Fact]
public async Task GetById_ShouldReturnUser_WhenUserExists()
{
    // Arrange
    var service = new Mock<UsersService>();
    var user = new User { ID = 1, Name = "John" };
    service.Setup(s => s.GetByIdAsync(1)).ReturnsAsync(user);

    var userContext = CreateAdminContext();

    // Act
    var result = await UsersEndpoints.GetById(1, service.Object, userContext);

    // Assert
    var okResult = Assert.IsType<OkObjectResult>(result);
    Assert.Equal(user, okResult.Value);
}

[Fact]
public async Task GetById_ShouldReturnForbid_WhenNonAdminAccessesOthersUser()
{
    // Arrange
    var service = new Mock<UsersService>();
    var validationHelper = new Mock<ValidationHelper>();

    validationHelper.Setup(v => v.IsUserAssignedAsync(1, 2)).ReturnsAsync(false);

    var userContext = CreateNonAdminContext(userId: 1);

    // Act
    var result = await UsersEndpoints.GetById(2, service.Object, validationHelper.Object, userContext);

    // Assert
    Assert.IsType<ForbidResult>(result);
}
```

---

## Summary

**Key Takeaways:**

1. **Feature-Based Organization** - Group endpoints by business feature, not HTTP method
2. **Ownership Enforcement** - Filter data by owner, validate assignment
3. **Role-Based Access** - Different permissions for different roles
4. **Validation First** - FluentValidation before business logic
5. **Batch Operations** - Reduce round-trips with batch endpoints
6. **Partial Updates** - PATCH for single-field updates
7. **Consistent Responses** - Standard error format, HTTP status codes

**Most Common Operations:**

- Read all (with ownership filter): `GetAll(service, user)`
- Read by ID (with validation): `GetById(id, service, validationHelper, user)`
- Search (with filters): `Search(filters, service, user)`
- Create (with validation): `Create(request, service, validator, user)`
- Update (with validation): `Update(id, request, service, validator, user)`
- Partial update: `UpdateEmail(id, email, service, user)`
- Delete: `Delete(id, service, user)`

**When NOT to Use:**

- Simple CRUD without ownership (standard REST is enough)
- Single-tenant applications (no ownership needed)
- Microservices with separate databases per service

