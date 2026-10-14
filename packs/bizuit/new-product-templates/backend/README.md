# {{BACKEND_REPO}}

Plugin de backend de **{{PRODUCT}} — el {{PRODUCT_DESCRIPTION}}**, para el Backend Host de
BIZUIT.

👉 **Antes de tocar este repo, leé [`CLAUDE.md`](CLAUDE.md) completo.** Ahí está la arquitectura,
las convenciones (SafeQueryBuilder, features, orquestadores), cómo se despliega a staging y a producción.

## Arranque rápido

```bash
# 1. Configurar la base local (el archivo NO viaja en git: lleva credenciales)
cp src/DevHost/appsettings.json.example src/DevHost/appsettings.json
#    editar ConnectionStrings:Default

# 2. Compilar y probar
dotnet build {{BACKEND_REPO}}.sln
dotnet test tests/{{BACKEND_REPO}}.Tests/{{BACKEND_REPO}}.Tests.csproj

# 3. Levantar el host de desarrollo (http://localhost:5001)
dotnet run --project src/DevHost

# 4. Crear una feature nueva (endpoints + service + repository + modelo + pruebas)
npm run new-feature <Nombre>
```

## Dónde está cada cosa

| carpeta | qué hay |
|---|---|
| `src/{{BACKEND_REPO}}/` | el plugin: una carpeta por feature |
| `src/DevHost/` | host de desarrollo local — no viaja en el paquete |
| `tests/` | pruebas xUnit |
| `database/` | migraciones numeradas que aplica el host (ver `database/README.md`) |
| `.tycon/` | config del arnés: cómo llega el trabajo a main, qué servidores son producción |

## Historias

Las historias de {{PRODUCT}} **no viven acá**: viven en el repo `{{STORIES_REPO}}`, en `.specs/`.
