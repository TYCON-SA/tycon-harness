---
epic: 1
story: "1.1"
title: "Items: un pedido de alta válido, y lo que el servicio rechaza"
status: ready-for-dev
sprint: 1
priority: "P2"
approach: "[ADAPT]"
depends_on: []
files_to_modify:
  - src/MyPlugin/Features/Items/ItemsService.cs
  - tests/MyPlugin.Tests/Features/ItemsServiceTests.cs
---

# Story 1.1: Items: un pedido de alta válido, y lo que el servicio rechaza

Status: ready-for-dev

## Story

Como quien prueba el paquete del stack sobre el plugin de ejemplo,
quiero las reglas de alta de un item escritas y probadas,
para recorrer el pipeline de una story sobre un plugin .NET de verdad.

## Acceptance Criteria

1. **Given** un pedido de alta con nombre y con precio y cantidad no negativos **When** llega a
   `ItemsService.CreateAsync` **Then** pasa la validación y se crea; el item nace activo, sin fecha de modificación y
   sin descripción si no se la dieron.
2. **Given** un pedido de alta con el nombre vacío o de sólo espacios, o con el precio negativo **When** llega a
   `ItemsService.CreateAsync` **Then** el servicio lo rechaza con `ArgumentException` y no llama al repositorio.

### Tests (4 verificaciones)

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | `CreateItemRequest_WithValidData_IsValid` | 1 | unit | Nombre, precio 10 y cantidad 5 | El pedido tiene lo que el servicio exige |
| T2 | `Item_DefaultValues_AreCorrect` | 1 | unit | Un item recién armado | Activo, sin `UpdatedAt`, sin descripción |
| T3 | `CreateItemRequest_WithEmptyName_FailsValidation` | 2 | unit | Nombre `""` y `"   "` | El nombre no pasa `IsNullOrWhiteSpace` |
| T4 | `CreateItemRequest_WithNegativePrice_FailsValidation` | 2 | unit | Precio -1 y -100 | El precio es negativo |

## Tasks / Subtasks

- [ ] [SEQ] Task 1: Salvaguarda — confirmar que `ItemsService.CreateAsync` y las cuatro pruebas existen
- [ ] [SEQ] Task 2: El alta válida (AC 1) — T1, T2
- [ ] [SEQ] Task 3: Lo que se rechaza (AC 2) — T3, T4

### Task Dependencies

Task 1 → Task 2 → Task 3

## Dev Notes

### Qué existe hoy

- **Archivo:** `src/MyPlugin/Features/Items/ItemsService.cs`
  - `CreateAsync(CreateItemRequest request)` — valida el nombre y el precio y delega en `ItemsRepository.CreateAsync`.
- **Archivo:** `tests/MyPlugin.Tests/Features/ItemsServiceTests.cs` — las cuatro pruebas de la tabla.
- **Archivo:** `src/MyPlugin/MyPlugin.cs` — `MyPluginPlugin : IBackendPlugin`, el punto de entrada del plugin.

### Patrón de referencia verificado

- `src/MyPlugin/Features/Products/ProductsService.cs`, `CreateAsync`: la misma forma (validar con `ArgumentException`
  antes de llamar al repositorio). Es el hermano dentro del mismo plugin.

### Qué hay que hacer (la delta)

El plugin es el ejemplo público: el servicio y sus pruebas ya están. Implementar esta story es confirmar, criterio por
criterio, que las reglas escritas arriba son las que el servicio aplica y las pruebas ejercen, y completar lo que falte.

### Archivos a crear/modificar

| Archivo | Cambio |
|---|---|
| `src/MyPlugin/Features/Items/ItemsService.cs` | `CreateAsync` cumple los AC 1 y 2 |
| `tests/MyPlugin.Tests/Features/ItemsServiceTests.cs` | T1 a T4 |

### Lo que NO hay que hacer

- No tocar la base de datos ni las migraciones de `database/`.
- No agregar paquetes NuGet.

### Cómo verificar que funciona

```bash
dotnet test
```

### Salvaguarda de BD

No aplica: las pruebas de la tabla no usan base de datos.

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
