---
name: tycon-new-migration
description: Genera la siguiente migración SQL numerada con plantilla TYCON estándar (idempotente, transaccional cuando combina DDL+DML, con PRINTs de auditoría) junto con su script de vuelta atrás `.rollback.sql`, obligatorio en repos donde el host administra las migraciones. Usar cuando el dev pide "crear nueva migración", "agregar migración para X", "next migration", o equivalentes en proyectos TYCON con migraciones SQL numeradas (`database/NNN_*.sql`). Detecta automáticamente el siguiente número libre escaneando el directorio.
---

# tycon-new-migration

Skill team-wide para crear migraciones SQL siguiendo la convención TYCON. Calibrado contra los patrones de los plugins Bizuit del equipo.

## Cuándo activarse

El usuario pide crear una migración nueva. Disparadores:

- "crear migración para `<descripción>`"
- "nueva migración: `<descripción>`"
- "agregar migración que `<descripción>`"
- "next migration"
- "migración para agregar columna X a tabla Y"

**No activarse** si el usuario solo pide *editar* una migración existente — eso es trabajo manual sobre el archivo, no este skill.

## Inputs

1. **Descripción funcional** de la migración (qué hace, en una línea).
2. **Tipo de operación** (deduce o pregunta):
   - `add-column` — agregar columna a tabla existente
   - `add-table` — crear tabla nueva
   - `seed-data` — insertar data canónica (rows en AuthTypes, Providers, etc.)
   - `alter-column` — cambiar tipo / constraint de columna existente
   - `rename` — renombrar columna o tabla
   - `mixed` — combinación (DDL + DML, requiere transacción)
3. **Path del directorio de migraciones** (default: `database/`, preguntar si no existe en el repo).
4. **Modo de rollback** — NO preguntar, detectar leyendo el `plugin.json` de la raíz del repo:
   - `requiresDatabase: true` **y** `migrations.enabled: true` → **migraciones administradas por el host**:
     el companion `.rollback.sql` es **obligatorio** (Paso 4).
   - Cualquier otro caso (o sin `plugin.json`) → migraciones a mano: el companion se **ofrece**, no se impone.

## Workflow

### Paso 1 — Detectar siguiente número libre

```bash
ls <database_path>/[0-9][0-9][0-9]_*.sql 2>/dev/null | \
  awk -F/ '{print $NF}' | \
  awk -F_ '{print $1}' | \
  sort -n | tail -1
```

- Si el último es `030`, el próximo es `031`.
- **Validación crítica**: si hay duplicados (ej: dos archivos `027_*.sql`), avisar al usuario antes de continuar — es bug pre-existente que el `migration-impact-analyzer` debería pescar (regla MIGRATION-C1).
- Formatear con padding de 3 dígitos: `001`, `010`, `100`.

### Paso 2 — Generar PascalCase descriptivo

A partir de la descripción del usuario (`"agregar columna IsActive a Users"`), derivar nombre del archivo:

- `031_AddIsActiveColumnToUsers.sql` (no `031_add_is_active_to_users.sql`)
- Convención: verbo en infinitivo + objeto (`Add`, `Remove`, `Rename`, `Refactor`, `Fix`, `Migrate`, `Configure`).
- Sin espacios, sin guiones, solo PascalCase + prefijo numérico + `.sql`.

### Paso 3 — Aplicar plantilla según tipo

#### `add-column`

```sql
-- NNN: <descripción>

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('<TableName>')
      AND name = '<ColumnName>'
)
BEGIN
    ALTER TABLE <TableName>
    ADD <ColumnName> <Type> <NULL|NOT NULL> <DEFAULT ...>;

    PRINT 'Added column <TableName>.<ColumnName>';
END
ELSE
BEGIN
    PRINT 'SKIPPED: <TableName>.<ColumnName> already exists';
END
GO
```

#### `add-table`

```sql
-- NNN: <descripción>

IF OBJECT_ID('<TableName>', 'U') IS NULL
BEGIN
    CREATE TABLE <TableName> (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        -- columns here
        CreatedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        UpdatedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CreatedBy NVARCHAR(100) NULL,
        UpdatedBy NVARCHAR(100) NULL
    );

    PRINT 'Created table <TableName>';
END
ELSE
BEGIN
    PRINT 'SKIPPED: <TableName> already exists';
END
GO
```

#### `seed-data`

```sql
-- NNN: <descripción>

IF NOT EXISTS (SELECT 1 FROM <TableName> WHERE <NaturalKeyCol> = '<value>')
BEGIN
    INSERT INTO <TableName> (<cols>, CreatedAt, CreatedBy)
    VALUES (<vals>, GETUTCDATE(), 'migration-NNN');

    PRINT 'Inserted <TableName>: <natural-key>';
END
ELSE
BEGIN
    PRINT 'SKIPPED: <TableName> <natural-key> already exists';
END
GO
```

#### `alter-column`

```sql
-- NNN: <descripción>

IF EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('<TableName>')
      AND name = '<ColumnName>'
)
BEGIN
    -- WARNING: cambio de tipo puede requerir migración de datos previa
    -- si hay rows existentes con datos incompatibles
    ALTER TABLE <TableName>
    ALTER COLUMN <ColumnName> <NewType> <NULL|NOT NULL>;

    PRINT 'Altered column <TableName>.<ColumnName> to <NewType>';
END
GO
```

#### `rename`

```sql
-- NNN: <descripción>

IF EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('<TableName>')
      AND name = '<OldName>'
)
AND NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('<TableName>')
      AND name = '<NewName>'
)
BEGIN
    EXEC sp_rename '<TableName>.<OldName>', '<NewName>', 'COLUMN';
    PRINT 'Renamed <TableName>.<OldName> -> <NewName>';
END
ELSE
BEGIN
    PRINT 'SKIPPED: rename condition not met (old col missing or new col exists)';
END
GO
```

#### `mixed` (DDL + DML)

```sql
-- NNN: <descripción>

BEGIN TRY
    BEGIN TRANSACTION;

    -- DDL primero
    IF NOT EXISTS (...)
    BEGIN
        ALTER TABLE <T> ADD <C> <Type> NULL;
        PRINT 'Added column';
    END

    -- DML después (sobre la nueva columna)
    UPDATE <T>
    SET <C> = <expression>
    WHERE <condition>;

    PRINT 'Backfilled <N> rows';

    -- Hacer NOT NULL si aplica
    ALTER TABLE <T> ALTER COLUMN <C> <Type> NOT NULL;

    COMMIT TRANSACTION;
    PRINT 'Migration NNN completed successfully';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    PRINT 'Migration NNN FAILED: ' + ERROR_MESSAGE();
    THROW;
END CATCH
GO
```

### Paso 4 — Generar el companion de vuelta atrás (`.rollback.sql`)

Obligatorio cuando el repo tiene migraciones administradas por el host (ver Inputs #4). En repos
sin host: ofrecerlo, y si el dev dice que no, seguir sin él.

**Por qué no se puede dejar para después.** El host guarda el **texto** del script dentro de la
base en el momento en que aplica la migración (`BZExtPluginMigrations.RollbackScript`, con
`RollbackAvailable = 1`). Desde ahí no vuelve a mirar el ZIP nunca más: agregar el `.rollback.sql`
en un deploy posterior **no hace nada** sobre las filas ya aplicadas. Una migración que se aplicó
sin companion queda sin vuelta atrás por panel **para siempre**.

Peor todavía, el panel no se queda mudo: sin script, el admin puede marcar la migración como
deshecha igual (`acknowledgeNoScript`) y el host la da por revertida **sin ejecutar una sola
sentencia**. La base queda como estaba y el tablero dice que se revirtió.

#### Naming — exacto, o no existe

`<NNN>_<PascalCaseName>.rollback.sql`, mismo nombre que la migración de ida + el sufijo. El host
lo vincula quitando ese sufijo y comparando el resto **carácter por carácter**; si difiere en una
letra **lo ignora en silencio** y la migración queda sin vuelta atrás. Su patrón es
`^(\d{3})_[A-Za-z0-9_]+\.rollback\.sql$` — solo letras, números y guión bajo, que es exactamente
lo que ya produce la convención PascalCase del Paso 2.

Dos límites más del host, ambos silenciosos:

- Script de **más de 1MB** → lo saltea con un warning en el log y la migración queda sin rollback.
- El companion **no** se numera aparte ni cuenta como migración: no ocupa el número siguiente.

#### El companion es idempotente, igual que la de ida

Lo corre el panel sin supervisión y alguien puede reintentarlo. Mismo estilo `IF EXISTS` + `PRINT`
que las plantillas del Paso 3.

#### Plantillas por tipo

##### `add-table` → `DROP TABLE`

```sql
-- NNN ROLLBACK: <descripción>

IF OBJECT_ID('<TableName>', 'U') IS NOT NULL
BEGIN
    DROP TABLE <TableName>;
    PRINT 'Rolled back: dropped table <TableName>';
END
ELSE
BEGIN
    PRINT 'SKIPPED: <TableName> does not exist';
END
GO
```

##### `add-column` → `DROP COLUMN` (con su constraint DEFAULT primero)

⚠️ SQL Server **no** deja borrar una columna que tiene un DEFAULT: hay que soltar el constraint
antes, y su nombre es autogenerado (`DF__Users__IsActi__3B75D760`), así que se resuelve por catálogo.
Si la migración de ida no puso `DEFAULT`, el primer bloque simplemente no encuentra nada.

```sql
-- NNN ROLLBACK: <descripción>

IF COL_LENGTH('<TableName>', '<ColumnName>') IS NOT NULL
BEGIN
    DECLARE @df SYSNAME;
    SELECT @df = dc.name
    FROM sys.default_constraints dc
    JOIN sys.columns c
      ON c.object_id = dc.parent_object_id
     AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID('<TableName>')
      AND c.name = '<ColumnName>';

    IF @df IS NOT NULL
        EXEC('ALTER TABLE <TableName> DROP CONSTRAINT ' + @df);

    ALTER TABLE <TableName> DROP COLUMN <ColumnName>;
    PRINT 'Rolled back: dropped column <TableName>.<ColumnName>';
END
ELSE
BEGIN
    PRINT 'SKIPPED: <TableName>.<ColumnName> does not exist';
END
GO
```

##### `seed-data` → `DELETE` acotado

**Nunca un `DELETE` pelado.** La plantilla de ida estampa `CreatedBy = 'migration-NNN'`, así que ese
sello identifica exactamente las filas que insertó — usarlo junto con la clave natural:

```sql
-- NNN ROLLBACK: <descripción>

IF EXISTS (SELECT 1 FROM <TableName> WHERE <NaturalKeyCol> = '<value>' AND CreatedBy = 'migration-NNN')
BEGIN
    DELETE FROM <TableName>
    WHERE <NaturalKeyCol> = '<value>'
      AND CreatedBy = 'migration-NNN';

    PRINT 'Rolled back: deleted <TableName> <natural-key>';
END
ELSE
BEGIN
    PRINT 'SKIPPED: <TableName> <natural-key> not present (or not inserted by migration-NNN)';
END
GO
```

Si la fila puede tener hijos por FK, el rollback tiene que borrarlos primero (o declararse NO
REVERSIBLE) — el `DELETE` va a fallar y el panel lo va a reportar como rollback fallido.

##### `rename` → el rename inverso

```sql
-- NNN ROLLBACK: <descripción>

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('<TableName>') AND name = '<NewName>'
)
AND NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('<TableName>') AND name = '<OldName>'
)
BEGIN
    EXEC sp_rename '<TableName>.<NewName>', '<OldName>', 'COLUMN';
    PRINT 'Rolled back: renamed <TableName>.<NewName> -> <OldName>';
END
ELSE
BEGIN
    PRINT 'SKIPPED: rollback rename condition not met';
END
GO
```

##### `alter-column` → casi siempre NO REVERSIBLE

Ver la sección de abajo. Generar el companion igual, con el encabezado explícito y el tipo original
restaurado.

##### `mixed` → esqueleto + `TODO`

El skill **no puede inferir** cómo deshacer un backfill: los valores previos ya no están. Generar el
esqueleto, marcar el bloque y **avisarle al dev en el Paso 6** que lo tiene que completar:

```sql
-- NNN ROLLBACK: <descripción>
-- ⚠️ TODO(dev): completar el deshacer del DML. El backfill de la migración de ida
--    pisó valores que este script no puede reconstruir — decidir si se restauran
--    desde otra fuente o si esta migración se declara NO REVERSIBLE.

BEGIN TRY
    BEGIN TRANSACTION;

    -- Orden inverso al de la ida: primero deshacer el DML, después el DDL.

    -- TODO(dev): deshacer el UPDATE

    IF COL_LENGTH('<T>', '<C>') IS NOT NULL
    BEGIN
        ALTER TABLE <T> DROP COLUMN <C>;
        PRINT 'Rolled back: dropped column <T>.<C>';
    END

    COMMIT TRANSACTION;
    PRINT 'Rollback NNN completed successfully';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    PRINT 'Rollback NNN FAILED: ' + ERROR_MESSAGE();
    THROW;
END CATCH
GO
```

#### Honestidad sobre qué deshace y qué no

Un script devuelve la **estructura**; **nunca** los **datos** que la migración de ida borró o
transformó. Cuando el tipo es destructivo — `alter-column` con pérdida de precisión o de tipo, un
`DROP` de algo con datos, un backfill que pisó valores — el skill no debe fingir que hay red.

Dos cosas, siempre juntas:

1. **Encabezado explícito** en el companion, primera línea del archivo:

   ```sql
   -- NO REVERSIBLE: devuelve la estructura, no los datos.
   -- <qué se pierde concretamente: "los decimales truncados al pasar DECIMAL(18,4) -> INT">
   ```

2. **Empujar al patrón seguro** en el aviso al dev: que la migración de ida **no destruya**
   (renombrar en vez de eliminar, agregar la columna nueva en vez de mutar la vieja) y que el
   borrado real venga en una migración posterior, ya con la vuelta atrás descartada a conciencia.

### Paso 5 — Crear archivo y avisar

1. Escribir el archivo en `<database_path>/<NNN>_<PascalCaseName>.sql`.
2. Escribir el companion en `<database_path>/<NNN>_<PascalCaseName>.rollback.sql` (Paso 4), salvo
   que el repo no tenga migraciones administradas por el host y el dev lo haya rechazado.
3. **Verificar el pareo antes de reportar**: los dos nombres tienen que ser idénticos salvo el
   sufijo. Un typo acá no da error en ningún lado — el host descarta el companion en silencio.
   ```bash
   diff <(ls <database_path>/<NNN>_*.sql | grep -v '\.rollback\.sql$' | sed 's/\.sql$//') \
        <(ls <database_path>/<NNN>_*.rollback.sql | sed 's/\.rollback\.sql$//')
   ```
4. Reportar al usuario:
   - Path absoluto de los dos archivos creados.
   - Tipo de plantilla aplicada.
   - Si el companion quedó marcado `NO REVERSIBLE` o con `TODO(dev)`, decirlo explícito.
   - Recordar: ejecutar la migración contra DB de test antes de commitear (`sqlcmd -S ... -i database/NNN_*.sql`).
   - Si hubo seeders detectados en el repo, recordar al usuario actualizarlos (regla `MIGRATION-W2`).

### Paso 6 — Recordatorios post-creación

Mostrar al usuario:

```
✅ Migración creada: database/NNN_<Name>.sql
✅ Vuelta atrás:     database/NNN_<Name>.rollback.sql

Recordá:
1. Ejecutar contra una base de test antes del commit. Si la migración BORRA datos: sólo en una
   base descartable o propia; en una compartida, avisale antes al dueño y esperá su OK
   (definition-of-done.md §1.quater)
2. Si la migración referencia columnas/tablas que se eliminan, actualizar el código primero (MIGRATION-C2)
3. Para datos canónicos (Providers, AuthTypes, etc.), actualizar también el seeder si existe
4. El `tycon-pipeline` va a invocar `migration-impact-analyzer` automáticamente cuando commitees el cambio
5. El .rollback.sql se congela en la base cuando la migración se aplica.
   Si lo dejás para después, esa migración queda SIN vuelta atrás para siempre.
```

Si el companion quedó con `TODO(dev)` o `NO REVERSIBLE`, agregar el punto 6 correspondiente:

```
6. ⚠️ El rollback quedó incompleto (TODO) — completalo ANTES de que esto se aplique en staging.
   -- o --
6. ⚠️ Esta migración es NO REVERSIBLE: el rollback devuelve la estructura, no <lo que se pierde>.
   Si eso no es aceptable, reescribí la de ida para que no destruya (renombrar en vez de borrar)
   y dejá el borrado real para una migración posterior.
```

### Trampas de operación (contarlas cuando el dev pregunte cómo se revierte)

Salieron de un ensayo real contra staging y no son obvias:

1. **La vuelta atrás la dispara "marcar como actual" una versión anterior** (`set-default`): el host
   detecta el downgrade, lista lo que hay que deshacer y pide confirmación explícita. **Arrancar**
   (`activate`) no toca la base.
2. **Deshacer una migración NO la elimina: la devuelve a pendiente.** Eso bloquea el arranque de la
   versión que la trae (*"Execute migrations before activating"*) y el deploy siguiente la reaplica.
   Revertir un cambio de base de verdad son **dos pasos**: deshacerlo y sacar el `.sql` del paquete.

## Anti-patterns (lo que NO hace)

- NO ejecuta la migración — solo crea el archivo.
- NO modifica `database/seed.sql` automáticamente — pertenece al dev decidir si aplica.
- NO commitea — el flujo de commit es manual o vía `tycon-pipeline`.
- NO toca migraciones existentes — solo crea nuevas.
- NO retrofitea vuelta atrás a migraciones ya aplicadas — es imposible: el host congeló esa fila
  con `RollbackAvailable = 0` y no vuelve a leer el ZIP.

Sobre el rollback, lo que **sí** hace: genera el companion `.rollback.sql` cuando el repo tiene
migraciones administradas por el host (`plugin.json` con `requiresDatabase: true` y
`migrations.enabled: true`). En repos sin host, lo ofrece pero no lo impone. En los casos que no
puede inferir (`mixed`) deja el esqueleto con un `TODO(dev)` explícito en vez de inventar el deshacer.

## Convenciones de naming

- Prefijo numérico de 3 dígitos (`001` a `999`).
- Underscore separa prefijo del nombre (`031_`).
- PascalCase para el nombre (`AddIsActiveColumnToUsers`, no `add-is-active`).
- Verbos típicos: `Add`, `Remove`, `Rename`, `Refactor`, `Fix`, `Migrate`, `Configure`, `Update`.
- Extensión `.sql`.
- Companion de vuelta atrás: mismo nombre + `.rollback.sql`. Solo `[A-Za-z0-9_]` en el nombre — el
  host valida contra `^(\d{3})_[A-Za-z0-9_]+\.rollback\.sql$` y descarta en silencio lo que no matchea.

Ejemplos (inventados, con la forma que se espera):

```
018_RenameInvoiceTotalColumn.sql
022_AddWarehouseTable.sql
023_AddIsArchivedColumnToOrders.sql
026_ConfigureDefaultBranch.sql
028_AddLabelFormat.sql
```

Con companion, el par queda así:

```
031_AddIsActiveColumnToUsers.sql
031_AddIsActiveColumnToUsers.rollback.sql
```

## Referencias

- `~/.claude/agent-skills/agents/migration-impact-analyzer.md` — advisor que valida migraciones nuevas
- `~/.claude/tycon-harness/guides/advisor-rules-catalog.md` — sección "Migration Impact Analyzer" con reglas MIGRATION-C1..C5 + W1..W3
- Host que administra las migraciones (el repo del framework de plugins):
  `custom-forms/backend-api-dotnet/BizuitCustomForms.WebApi/Services/Plugins/PluginMigrationService.cs`
  — patrón de nombre y vínculo (`:87`, `:138`), congelado del texto al aplicar (`:744`), límite de 1MB
  (`:129`), rollback sin script vía `acknowledgeNoScript` (`:896`), análisis de downgrade
  `AnalyzeVersionSwitchAsync` (`:935`); y `Controllers/PluginAdminController.cs` — `SetDefaultPreview`
  (`:1038`, lista lo que se va a deshacer) y `SetDefault` (`:1079`, lo ejecuta)
