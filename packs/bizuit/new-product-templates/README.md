# new-product-templates — el punto de partida de un producto BIZUIT nuevo

Del paquete `bizuit`. Un **producto** son tres repos en un proyecto de Azure DevOps: el plugin de
backend (.NET), los formularios y las historias. Estas plantillas traen lo que el alta tiene que
dejar en cada repo y que **no** se saca copiando otro repo a ojo: sus pipelines con el ciclo
completo (compilar, probar, escanear, desplegar a staging y pasar a producción con aprobación), sus
`CLAUDE.md` con las reglas para revisores, las configuraciones del arnés y los archivos de
declaración vacíos.

Las usa la skill `bizuit-new-product`; quien dé de alta un producto a mano debería usar lo mismo.

🔴 **No confundir con `pipelines/templates/`** del arnés: ésos son pedazos de YAML que un pipeline
incluye en tiempo de corrida (`- template:`). Los de acá son archivos **enteros**, con marcadores,
que se copian UNA vez en el alta. Incluir uno con `- template:` falla.

## Qué hay

| carpeta | qué |
|---|---|
| `backend/` | `CLAUDE.md` (con su sección «Reglas para revisores»), `README.md`, el `coverlet.runsettings`, el archivo de vulnerabilidades declaradas, el `README` de migraciones, el `advisors.yaml` y el catálogo de producción |
| `forms/` | `CLAUDE.md`, `README.md`, los tres archivos de declaración vacíos y el `advisors.yaml` |
| `stories/` | `CLAUDE.md`, `README.md`, la convención de `.specs/`, el `advisors.yaml`, el `ado-config.yaml` y el hook de pre-commit |
| `common/` | el puntero `AGENTS.md` |
| `pipelines/` | los cinco pipelines de Azure DevOps |

🔴 **El destino conserva su nombre aunque la plantilla tenga otro.** Los archivos de declaración se
llaman en el repo del producto `pruebas-pendientes.json`, `vulnerabilidades-pendientes.json` y
`vulnerabilidades-formularios-pendientes.json`, porque así los leen los pipelines y los controles
del arnés; la plantilla lleva su nombre en inglés. La tabla de abajo dice cuál es cuál.

## A dónde va cada archivo

| plantilla | termina siendo | repo |
|---|---|---|
| `backend/CLAUDE.md` · `backend/README.md` | los mismos, en la raíz | plugin |
| `backend/tycon-advisors.yaml` | `.tycon/advisors.yaml` | plugin |
| `backend/production-catalog.json.template` | `.tycon/production.json` — **con el editor, no copiándolo** | plugin |
| `backend/coverlet.runsettings` | el mismo, en la raíz | plugin |
| `backend/declared-vulnerabilities.json` | `vulnerabilidades-pendientes.json` | plugin |
| `backend/database-README.md` | `database/README.md` | plugin |
| `forms/CLAUDE.md` · `forms/README.md` | los mismos, en la raíz | formularios |
| `forms/declared-test-debt.json` | `pruebas-pendientes.json` | formularios |
| `forms/declared-vulnerabilities.json` | `vulnerabilidades-pendientes.json` | formularios |
| `forms/declared-form-vulnerabilities.json` | `vulnerabilidades-formularios-pendientes.json` | formularios |
| `forms/tycon-advisors.yaml` | `.tycon/advisors.yaml` | formularios |
| `stories/CLAUDE.md` · `stories/README.md` | los mismos, en la raíz | historias |
| `stories/specs-README.md` | `.specs/README.md` | historias |
| `stories/tycon-ado-config.yaml` | `.tycon/ado-config.yaml` | historias |
| `stories/tycon-advisors.yaml` | `.tycon/advisors.yaml` | historias |
| `stories/githooks-pre-commit` | `.githooks/pre-commit` (con permiso de ejecución) | historias |
| `common/AGENTS.md` | `AGENTS.md` | los tres |
| `pipelines/backend-ci.yml` | `azure-pipelines.yml` | plugin |
| `pipelines/backend-prod.yml` | `azure-pipelines-prod.yml` | plugin |
| `pipelines/forms-ci.yml` | `azure-pipelines.yml` | formularios |
| `pipelines/forms-prod.yml` | `azure-pipelines-prod.yml` | formularios |
| `pipelines/stories-gate.yml` | `azure-pipelines.yml` | historias |

### Lo que el alta NO saca de acá

| qué | de dónde sale |
|---|---|
| el esqueleto del plugin (código, pruebas, `plugin.json`, `.gitignore`) y su host de desarrollo (`src/DevHost/`) | el template público `TYCON-SA/bizuit-custom-plugin-sample` |
| la infraestructura de formularios (build, jest, tsconfig) y el primer formulario | el template público `TYCON-SA/bizuit-custom-form-sample` |
| `.engram/config.json` y `.engram-project` | se generan con el nombre del producto, en minúsculas (sólo si el equipo usa engram) |

Los dos templates públicos **se compilan y se prueban solos todas las noches**, contra los paquetes
de BIZUIT tal como están publicados ese día. Por eso se copia de ellos y no de un producto vivo: un
producto vivo sólo sabe que andaba el día que alguien lo tocó.

## Los marcadores

Se copian y se reemplazan — y **antes de commitear el alta se verifica que no quedó ninguno vivo**:

```bash
node <arnés>/scripts/ci/check-unreplaced-placeholders.js <repo-backend> <repo-formularios> <repo-historias>
```

🔴 Un alta copia del orden de **120 marcadores de más de 15 tipos en más de 20 archivos**, y uno
que sobreviva **no da error en ningún lado**: se lee como un valor más. `repo_group:
[{{BACKEND_REPO}}]` en `.tycon/advisors.yaml` deja a los revisores diciendo «no encontré
hermanos» —que se lee como «este producto no tiene»—, y un `{{SERVER_URL}}` en un `CLAUDE.md`
es una instrucción que manda a un servidor que no existe. (El control saltea las carpetas que se
llaman `new-product-templates`: acá los marcadores son el contenido.)

| marcador | qué es | ejemplo |
|---|---|---|
| `{{PRODUCT}}` · `{{PRODUCT_LOWER}}` | el nombre corto del producto | `ACME` · `acme` |
| `{{PRODUCT_DESCRIPTION}}` | qué es, en una frase | `sistema de gestión de reclamos` |
| `{{BACKEND_REPO}}` · `{{FORMS_REPO}}` · `{{STORIES_REPO}}` | los tres repos | `AcmeBZExtBackend` · `AcmeBZExtForms` · `AcmeProyecto` |
| `{{PLUGIN}}` | el nombre corto del plugin: define la ruta de la API | `acmebzextbackend` |
| `{{ADO_ORG_URL}}` · `{{ADO_PROJECT}}` | la organización y el proyecto de Azure DevOps | `https://dev.azure.com/acme` · `ACME Reclamos` |
| `{{ADO_WORK_ITEM_TYPE}}` | el tipo de work item de las historias, según la plantilla de proceso | `User Story` (Agile) · `Product Backlog Item` (Scrum) |
| `{{SERVER_URL}}` · `{{PRODUCTION_URL}}` | el servidor BIZUIT de staging y el de producción | `https://staging.acme.example` · `https://bizuit.acme.example` |
| `{{SQL_HOST}}` · `{{DATABASE}}` | el SQL de producción y la base | `acme-sql.database.windows.net` · `AcmeDb` |
| `{{TABLE_PREFIX}}` | el prefijo de las tablas del plugin | `AC_` |
| `{{DOTNET_SDK}}` | la versión del SDK de .NET del plugin, como la pide `UseDotNet@2` | `9.0.x` |
| `{{DATE}}` | la fecha del alta | `2026-10-14` |

## Los pipelines

Son la forma de **dos entornos** (staging y producción), que es la normal:

- **`backend-ci.yml` y `forms-ci.yml`** corren en cada pull request (portón del arnés, escaneo de
  dependencias, secretos y código, pruebas con piso de cobertura) y en cada merge a `main`
  (empaquetan, numeran la versión, despliegan a staging y le corren el humo).
- **`backend-prod.yml` y `forms-prod.yml`** se disparan solos cuando el anterior termina en verde
  sobre `main`, esperan la aprobación del entorno `production` y promueven **el mismo paquete**,
  sin reconstruirlo.
- **`stories-gate.yml`** es sólo el portón de controles: lo encola la política de rama en cada pull
  request del repo de historias.

Todos bajan el arnés de su repo público, por clon y sin credencial. El origen está en dos
variables de cada pipeline, `harnessRepoUrl` y `harnessRef`: una organización con su propio fork
del arnés cambia esas dos líneas y nada más. Los pasos del despliegue (subir, migrar, activar,
humo, notas de versión, freno de retroceso) no viven acá: son guiones de `scripts/ci/` del arnés,
que el pipeline baja en cada corrida. Lo que se arregla allá llega solo a todos los productos.

### Las variables que carga una persona

Ninguna credencial va en un archivo. Se cargan como variables del pipeline en Azure DevOps (las
contraseñas, secretas):

| pipeline | variables |
|---|---|
| `backend-ci.yml` · `forms-ci.yml` | `BIZEXT_STAGING_URL` (`{{SERVER_URL}}`), `BIZEXT_STAGING_USER` y `BIZEXT_STAGING_PASS` (secreta) |
| `backend-prod.yml` · `forms-prod.yml` | `BIZEXT_PROD_USER` y `BIZEXT_PROD_PASS` (secreta). La URL de producción ya viene en el YAML (`{{PRODUCTION_URL}}`) |

### Si el producto tiene un solo entorno

- Del pipeline de integración se quita la etapa de despliegue (`Deploy`). El commit que sube la
  versión **se queda** donde está (en el empaquetado), para que cada merge numere su paquete.
- El pipeline de producción espera la etapa de **empaquetado** (`Build`) en vez de `Deploy`.
- Se dice en voz alta en la cabecera de los dos, y en la sección «Entornos» de los dos
  `CLAUDE.md`, que el paquete llega a producción sin haberse instalado antes en ningún lado, y que
  una migración que borra datos corre por primera vez sobre la base real.
- Si la organización usa el control de paridad (abajo), la diferencia se **declara** ahí,
  verificando rasgo por rasgo dónde quedó cada comportamiento.

🔴 **Los comentarios largos no son relleno**: cada uno cuenta de qué incidente salió su regla, con
fecha. Borrarlos convierte una decisión en una costumbre, y el que venga después la va a "limpiar"
sin saber qué está apagando. Los incidentes son de los productos del equipo que escribió estas
plantillas; se cuentan sin sus nombres.

## El control de paridad

`scripts/ci/check-product-parity.js` del arnés compara los pipelines de todos los productos de una
organización y avisa cuando uno hace algo que los demás no hacen (o deja de hacer algo que los
demás sí). La lista de productos y los rasgos que se comparan son datos de cada organización: van
en `scripts/ci/product-parity.json` de su repo de operaciones; el arnés trae uno vacío a propósito
(la forma está en la cabecera del control). Un producto dado de alta con estas plantillas coincide con los demás que salieron de
ellas; inscribirlo es el paso del alta que más se olvida y el que más vale.

## Antes de pegarlas, leerlas

Traen decisiones tomadas para productos concretos. Una regla heredada sin pensar es peor que una
regla ausente: se lee como decidida.
