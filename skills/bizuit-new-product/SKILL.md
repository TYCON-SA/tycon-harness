---
name: bizuit-new-product
description: Da de alta un producto BIZUIT nuevo de cero — crea sus tres repos (plugin de backend .NET, formularios, historias), los llena con los templates públicos de BIZUIT y las plantillas del paquete bizuit del arnés, escribe sus pipelines de Azure DevOps con el ciclo completo (compilar, probar, escanear, desplegar a staging y pasar a producción con aprobación), los da de alta en Azure DevOps (pipelines, entorno de producción con aprobación, políticas de rama), lo inscribe en el control de paridad de la organización y emite la lista de tareas que sólo puede hacer una persona. Usar cuando el dev pide "dar de alta el producto X", "crear los repos de X", "armar el producto X de cero", "necesitamos un backend y un front para los formularios de X" o equivalentes.
---

# bizuit-new-product

Del paquete `bizuit` del arnés. Da de alta un producto BIZUIT nuevo: los tres repos, sus
pipelines, su configuración en Azure DevOps y su inscripción en los controles del arnés.

Destilada de altas reales. Cada trampa de «Lo que sale mal» hizo fallar algo alguna vez.

## Cuándo activarse

- "dar de alta el producto X" · "crear los repos de X" · "armar X de cero"
- "necesitamos un backend y un front para los formularios de X"
- "hay un repo vacío en el proyecto X, hay que armar todo"

**No activarse** si el producto ya existe y se le agrega algo (una feature, un formulario, una
historia): eso es trabajo normal, no un alta.

## Lo que esta skill NO hace, y por qué

**No inventa mecanismo nuevo.** Existe la tentación de mudar el cuerpo de los pipelines a
plantillas compartidas "porque hay N copias que divergen". Las particularidades por producto son
legítimas, lo pesado ya vive una sola vez en `scripts/ci/` del arnés (cada pipeline lo baja en
cada corrida), y el control de paridad mide que todos hagan lo mismo permitiendo declarar las
diferencias con motivo y fecha.

El alta copia las plantillas e **inscribe al producto nuevo en el control de paridad**. Ese segundo
paso es el que vale: un producto no inscripto no se compara con nadie y su pipeline puede quedarse
atrás años sin que ningún control lo diga.

## Las plantillas

Viven en el paquete bizuit del arnés: `<arnés>/packs/bizuit/new-product-templates/` (en una
máquina con el arnés instalado, `<arnés>` es `~/.claude/tycon-harness`). Su `README.md` trae la
tabla de a dónde va cada archivo, la de los marcadores y las variables que carga una persona.
**Leelo antes de empezar.**

Se copian y se les reemplazan los marcadores (`{{PRODUCT}}`, `{{BACKEND_REPO}}`, `{{PLUGIN}}`,
`{{SERVER_URL}}`…). 🔴 **Leer cada plantilla antes de pegarla y ajustar lo que no aplique.** Traen
decisiones tomadas para productos concretos que en otro pueden ser falsas — y una regla heredada
sin pensar es peor que una regla ausente: se lee como decidida.

Los pipelines bajan el arnés de su repo público, por clon y sin credencial, en un paso llamado
`Fetch harness (public GitHub, no credentials)`. El origen está en las variables
`harnessRepoUrl` y `harnessRef` de cada pipeline: una organización con su propio fork del arnés
cambia esas dos líneas y nada más.

🔴 **El catálogo de producción NO se copia con el shell**: se escribe con el editor, que abre el
cuadro de aprobación. La plantilla se llama `production-catalog.json.template` justamente para que
su nombre no dispare el freno de producción (ver «Lo que sale mal» #9).

## Inputs

Se averiguan solos — no preguntar:

| dato | de dónde sale |
|---|---|
| organización de Azure DevOps | `ado.org` de la configuración del arnés (`node <arnés>/scripts/lib/tycon-config.js explain`) |
| tipo de work item de las historias | plantilla de proceso del proyecto (Agile → `User Story`; Scrum → `Product Backlog Item`) |
| área e iteraciones | nodos de clasificación del proyecto |
| repos que ya existen, y si alguno está vacío | listado de repos del proyecto |
| la versión de .NET del plugin | el `global.json` o el `TargetFramework` del template público de plugins |

Se preguntan, en este orden (la 1 y la 2 desbloquean todo lo demás):

1. **Nombres de los repos.** Convención: `<Prefijo>BZExtBackend`, `<Prefijo>BZExtForms`,
   `<Prefijo>Proyecto`. Si hay un repo vacío en el proyecto, ofrecer renombrarlo como el de
   historias en vez de dejarlo muerto.
2. **URL del servidor BIZUIT**, por entorno (staging y producción). Ojo: en BIZUIT **una misma
   URL sirve para los formularios y para la API de administración de plugins**. Verificarlo antes
   de seguir (ver «Lo que sale mal» #8).
3. **Cuántos entornos hay.** Si hay uno solo, cambia la forma de los pipelines (ver Paso 6).
4. **Nombre corto del plugin** — proponer `<prefijo>bzextbackend`. Define la ruta de la API.
5. **¿El backend usa base de datos?** Si sí, el host del SQL de producción, la base y el prefijo de
   tablas; y si el equipo va a consultar esa base desde sus máquinas.
6. **¿Hay código existente para importar, o nace vacío?**

**Credenciales: NUNCA pedirlas en el chat y NUNCA escribirlas en un archivo.** La skill emite los
nombres de las variables que hay que cargar; las carga el dev, o el agente con
`az pipelines variable create --secret true` si el dev se las da explícitamente.

## Workflow

### Paso 0 — Mirar antes de tocar

Listar el proyecto destino, su plantilla de proceso, sus repos y sus pipelines. Un listado vacío
de un comando que falló **no es** "no hay": mirar el código de salida antes de cualquier tubería.

Confirmar con el dev el plan en una línea antes de crear nada: qué repos se crean, cuál se
renombra, cuántos entornos.

### Paso 1 — Los tres repos

Renombrar el vacío si corresponde, crear los otros dos, y **verificar releyendo el listado**.
Clonarlos uno al lado del otro, en una carpeta del producto: los `repo_group` de `.tycon/advisors.yaml`
nombran a los hermanos por ruta relativa a la carpeta padre.

### Paso 2 — El backend

Base: el template público `TYCON-SA/bizuit-custom-plugin-sample`, **entero, host de desarrollo
incluido**.

1. Copiar el template sin `.git`, `bin/`, `obj/`, `TestResults/`.
2. **Borrar las features de ejemplo** (`Items`, `Products`, `AuditLogs`), sus pruebas y sus
   migraciones, y **borrar `database/setup-database.sql`**. Dejar sólo `Me`, que sirve para
   verificar la instalación. Sus migraciones crean tablas de ejemplo en la base del cliente.

   🔴 **Las pruebas NO están en carpetas por feature: son archivos sueltos.** El código sí
   (`src/<Plugin>/Features/Items/`), pero sus pruebas viven planas en
   `tests/<Plugin>.Tests/Features/` como `ItemsServiceTests.cs` y `ProductsServiceTests.cs`.
   Un `rm -rf tests/.../Features/Items` no borra nada y **la compilación se rompe** después,
   con errores que parecen del renombre. Borrar los archivos por nombre y listar la carpeta
   para confirmar que quedó vacía.

   `tests/<Plugin>.Tests/SkeletonTests.cs` **se queda**: es lo que hace que el producto nazca
   con pruebas en vez de en 0% de cobertura.
3. Renombrar `MyPlugin` → `<Repo>` en contenido y en nombres de archivo; limpiar los `using` y
   los registros de las features borradas en la clase principal del plugin — **en los DOS
   lugares**: las altas de dependencias (`services.AddScoped<...>`) y los mapeos de endpoints
   (`ItemsEndpoints.Map(...)`), que están en métodos distintos.

   🔴 **El renombre es sensible a mayúsculas y `plugin.json` trae `"name": "myplugin"` en
   minúscula.** Reemplazar `MyPlugin` no lo toca, y ese nombre **define la ruta de la API**:
   si se cuela, el plugin queda sirviendo en `/api/plugins/myplugin/` y el síntoma es un 404 con
   cuerpo vacío. El valor correcto es el nombre corto del Input #4, y se fija en el punto 6.
   Después del renombre, `grep -ri myplugin .` tiene que dar sólo documentación del template,
   que el Paso 5 reemplaza.
4. **El `src/DevHost/` del template se deja como está**: está dentro de la solución, así que el
   control nocturno del template lo compila. Si aun así hiciera falta traer el de otro producto,
   va **sin** su `appsettings.json` ni su `appsettings.Development.json`: llevan credenciales.
5. **Verificar que las dos referencias de paquete sigan fijas** (`Bizuit.Backend.Core` y
   `Bizuit.Backend.Abstractions`). Si alguna flotara, fijarla antes de seguir — es la causa
   exacta de «Lo que sale mal» #1.
6. `plugin.json`: nombre, versión `1.0.0`, `entryPoint`, `pluginClass`, `defaultSettings` vacío.
   Copiarlo a `plugin.json.example`.
7. `appsettings.json` con valores hacia `localhost` y **agregarlo al `.gitignore`** junto con
   `appsettings.Development.json` y `plugin.local.json`.
8. Copiar de `packs/bizuit/new-product-templates/backend/`: `coverlet.runsettings`, `declared-vulnerabilities.json`
   como `vulnerabilidades-pendientes.json` y `database-README.md` como `database/README.md` (explica que las migraciones las aplica el host
   y que una ya aplicada no se edita).
9. Compilar y **mirar el código de salida real**. `dotnet test` va SIEMPRE con la ruta del proyecto
   de pruebas, nunca con la solución (el freno de pruebas del arnés bloquea la suite sin alcance).

### Paso 3 — Los formularios

Base: el template público `TYCON-SA/bizuit-custom-form-sample`, sin `.git` ni `node_modules`:

- `build-form.js`, `build-form-dev.js`, `.gitignore`.
- `package.json` de la raíz y `scripts/run-in-forms.js`. Son los que hacen que `npm test`,
  `npm run type-check` y `npm run build` recorran **todos** los formularios — y que un formulario
  que no declare alguno de los tres **falle**, en vez de saltearse en silencio.
- `form-template/` **entero**, con su andamiaje de pruebas: `jest.config.cjs` (es `.cjs` porque el
  paquete es `"type": "module"`), `jest.setup.ts` (leer los comentarios antes de tocarlo),
  `tsconfig.json`, `test/style-mock.cjs` y `src/__tests__/form-template.test.tsx` como ejemplo de
  cómo se prueba un formulario. **De acá se copia el primer formulario, archivos de prueba incluidos.**
- `.github/workflows/build-and-test.yml` **como referencia de qué tiene que hacer el control**
  (chequear tipos, probar y compilar cada formulario). El pipeline real del producto sale del
  Paso 6; lo que se trae de acá son los pasos, no el YAML.

Además:

- Copiar los archivos de declaración vacíos desde `packs/bizuit/new-product-templates/forms/` con el nombre que
  leen los controles: `declared-test-debt.json` → `pruebas-pendientes.json`,
  `declared-vulnerabilities.json` → `vulnerabilidades-pendientes.json` y
  `declared-form-vulnerabilities.json` → `vulnerabilidades-formularios-pendientes.json`. Existen para
  que los controles tengan dónde leer.
- **Verificar que arranque probándose**, no sólo compilando: desde la raíz del repo nuevo,
  `npm install && npm run type-check && npm test && npm run build`, y mirar el código de salida
  real. Si `npm test` no da verde acá, el pipeline de formularios va a frenar en el primer merge.
- **Avisarle al dev**: el pipeline de formularios va a quedar **en rojo hasta el primer
  formulario** (ver «Lo que sale mal» #6).

### Paso 4 — Las historias

`.specs/README.md`, el `CLAUDE.md` y `.githooks/pre-commit` salen de
`packs/bizuit/new-product-templates/stories/` (el hook es `githooks-pre-commit`; **hay que darle permiso de
ejecución** al copiarlo). Además, `.tycon/ado-config.yaml` con los datos **consultados** del
proyecto, no adivinados: tipo de work item según la plantilla de proceso, área, iteraciones, los
estados de la plantilla, y `epic_links` vacío con la nota de que un épico nuevo se anota ahí en el
mismo cambio.

El pipeline de este repo es sólo el portón de controles, con `trigger: none` y `pr: none`: lo
encola la política de rama.

### Paso 5 — Config del arnés en cada repo

- `.tycon/advisors.yaml` (de `tycon-advisors.yaml`): `merge.mode: pr`, `repo_group` con los repos
  hermanos y, en el backend y en formularios, `packs: [bizuit]`, para que el pipeline del arnés sume
  los revisores del paquete.
- `.tycon/production.json` en el backend si el equipo consulta la base de producción — **con el
  editor, nunca copiándolo** («Lo que sale mal» #3 y #9). Plantilla:
  `packs/bizuit/new-product-templates/backend/production-catalog.json.template`.
- `CLAUDE.md` **con la sección `## Reglas para revisores`** (obligatoria — «Lo que sale mal» #2),
  `AGENTS.md` como puntero, `README.md`. **Los tres salen de las plantillas**, con sus marcadores
  reemplazados; no se escriben de memoria en cada alta.
- Si el equipo usa engram: `.engram/config.json` y `.engram-project` con el nombre **normalizado
  en minúsculas**, que es como lo guarda engram; si no, la memoria se parte sola y sin dar error.

### Paso 6 — Los pipelines

Salen de `packs/bizuit/new-product-templates/pipelines/` (la tabla de destinos está en su README). Se
reemplazan los marcadores y se cambian **sólo identificadores**. Dejar los comentarios que
cuentan de qué incidente salió cada regla: borrarlos convierte una decisión en una costumbre.

**Si el producto tiene un solo entorno**, la forma cambia (detalle en el README de las plantillas):

- Del pipeline de integración se quita la etapa `Deploy`. El commit que sube la versión **no se
  mueve**: sigue en la etapa de empaquetado, así cada merge numera su paquete.
- El pipeline de producción espera la etapa `Build` del de integración, no `Deploy`.
- Escribir en la cabecera de los dos, y en la sección «Entornos» de los `CLAUDE.md`, que el paquete
  llega a producción sin haberse instalado antes en ningún lado.

**Verificar que los archivos que el pipeline espera existan** (el de cobertura, los de declaración):
recorrer las rutas literales del YAML y comprobarlas una por una. Y que los YAML parseen.

### Paso 7 — Commit y push

**Antes de commitear, correr el control de marcadores** en los tres repos:

```bash
node <arnés>/scripts/ci/check-unreplaced-placeholders.js <repo-backend> <repo-formularios> <repo-historias>
```

🔴 **No es opcional y no se puede hacer a ojo.** Un alta copia del orden de **120 marcadores**
repartidos en más de 20 archivos, y uno que sobreviva NO da error en ningún lado: se lee como un
valor más. Sale 0 = limpio · 1 = quedaron vivos · 2 = no pudo mirar.

**Con autorización explícita del dev, nunca antes.** Armar staging selectivo y **dejar que corran
los hooks**: pasarles por encima esconde justamente lo que hay que arreglar.

### Paso 8 — Alta en Azure DevOps

Convención de nombres de pipeline: `<Repo>`, `<Repo> - PROD`, `<Repo> - Porton del arnes`. El de
producción referencia al de integración **por nombre exacto** (`source:` de su bloque
`resources.pipelines`), así que el de integración va primero. Crearlos con `--skip-first-run`.

- **Entorno de producción**: Azure DevOps lo crea solo al dar de alta el pipeline que lo nombra.
  Agregarle el control de aprobación con 1440 minutos de vencimiento, y escribir en las
  instrucciones qué tiene que mirar quien aprueba. **Aprobadores: las personas que la organización
  tiene designadas para aprobar producción —al menos dos—, con `minRequiredApprovers: 1`.** Con
  `0`, Azure DevOps exige que aprueben **todos** los de la lista; con un solo aprobador, el día que
  falta nadie puede pasar a producción. Si otro producto de la organización ya tiene ese control,
  copiar sus aprobadores de ahí. Al terminar, releer el control y confirmar los aprobadores y el
  mínimo. Corregir el control **no** arregla las aprobaciones que ya estaban esperando: Azure les
  congela los aprobadores al crearlas, así que ésas las aprueba quien figuraba o se relanza la etapa.
- **Políticas de rama** en `main` de los tres repos: validación por build (apuntando al pipeline de
  integración de ese repo) y estrategia de merge con **sólo** `allowNoFastForward`. El squash está
  prohibido a propósito: con squash los commits individuales desaparecen y las notas de versión
  colapsan a "Merged PR N".

### Paso 9 — Inscribir en el control de paridad

**Este es el paso que se olvida y el que más vale.** El control
(`<arnés>/scripts/ci/check-product-parity.js`) lee el `product-parity.json` de la organización:
la lista de productos y los rasgos que tienen que coincidir. Vive en `scripts/ci/product-parity.json`
del **repo de operaciones** de la organización, donde está el resto de su configuración, y el
cambio va por pull request a ese repo. El arnés trae uno vacío a propósito. Sin `--config`, el
control la busca en el clon de operaciones que la máquina declara (`paths.operations`); si no la
encuentra, sale «no medido» diciendo por qué. Sin clon declarado, pasarla con `--config`.

1. Agregar el producto a los grupos que le correspondan (backend, formularios, producción).
2. Correr el control. Si marca divergencias:
3. **Verificar cada una antes de declararla**: correr el patrón del rasgo contra el archivo donde
   ahora vive ese comportamiento. Si el comportamiento se mudó, se declara con esa evidencia; si
   desapareció, **no se declara: se arregla**.
4. Declarar con motivo, fecha y fecha de revisión, diciendo qué haría que la diferencia deje de ser
   legítima.
5. Correr el control de nuevo y confirmar que vuelve a verde.

Si la organización todavía no tiene `product-parity.json` en su repo de operaciones (éste es su
primer producto), dejarlo dicho en las tareas humanas: el control necesita dos productos para
comparar (el ejemplo está en `pipelines/operations/examples/product-parity.json` del arnés).

### Paso 9 bis — Inscribir en la revisión nocturna de dependencias

Si la organización corre la revisión nocturna de dependencias del arnés
(`scripts/nightly/dependencies/nightly-dependencies.js`, desde su repo de operaciones), inscribir
los repos de backend (`nuget`) y de formularios (`npm`) en su lista de repos, **ahora**. El de
historias no entra: no tiene dependencias. Un producto recién nacido mide 0 y 0, así que entra sin
abrir una sola ficha; cada mes que pasa sin inscribirlo, entrar cuesta una tanda de avisos.

Verificar que miden con el nocturno en seco (`run --dry-run --json` sobre una lista con sólo el
producto nuevo): los dos con `medido: true`. Si alguno sale NO MEDIDO, el motivo lo dice: no se da
por bueno "ya va a andar en la noche".

### Paso 10 — Las tareas humanas

Emitirlas como lista, al final, separadas de lo hecho:

- **Los permisos** de la identidad de compilación del proyecto nuevo (#5 de abajo): contribuir y
  saltear las políticas de rama, **sólo en los repos que publican versión** (backend y
  formularios). Por interfaz: Project Settings → Repositories → Security → la identidad
  `<proyecto> Build Service`. El arnés trae `scripts/ci/grant-new-product-permissions.js`
  (empezar con `--verify`, que sólo mira) para la organización que lo tenga configurado.
  Otorgar permisos es una acción que el agente no hace solo.
- **Las variables** de despliegue en cada pipeline (la tabla está en el README de las plantillas),
  las contraseñas como secretas.
- **El llavero** del servidor de producción, si el equipo va a consultar la base.

### Paso 11 — Verificar que anda

No dar el alta por terminada sin probar. Lo que se puede probar y lo que no:

| qué | cómo |
|---|---|
| que los pipelines bajan el arnés | correr el pipeline de integración y ver en verde el paso `Fetch harness (public GitHub, no credentials)`, que imprime `Arnés público en <commit>`. Si falla, el agente de Azure no llega al repo del arnés: no es un permiso del proyecto |
| que el repo de historias está sano | su portón saltea la etapa fuera de un pull request: una corrida manual **no prueba nada**. Abrir un pull request de prueba |
| los pipelines de producción | no se pueden probar sin publicar algo de verdad: quedan para la primera publicación real. Decirlo, no darlos por buenos |

## Lo que sale mal

**1. El template público de plugins no compilaba** cuando fijaba sólo `Bizuit.Backend.Core`:
`Bizuit.Backend.Abstractions` flotaba a una versión con miembros nuevos en la interfaz que su host
de desarrollo no implementaba. Ahora fija las dos y se compila y prueba todas las noches. Pero no
se da por bueno de memoria: **antes de copiar, mirar que la última corrida nocturna del template
esté en verde.** Si está en rojo, el alta arranca sobre algo roto.

**2. El commit se rechaza si el `CLAUDE.md` no tiene `## Reglas para revisores`.** Es la única vía
por la que un revisor del pipeline ve las reglas propias del repo. Reglas verificables mirando sólo
el diff, techo de 4.000 bytes, sin credenciales.

**3. El catálogo de producción tiene esquema estricto.** Un servidor de producción **necesita**
`keychain`, y `host` tiene que ser un nombre de host pelado: **el nombre de instancia con barra
invertida lo rechaza**. Una instancia en un puerto no estándar va en `port`.

**4. Los marcadores tipo `TU_SERVIDOR` disparan el freno de producción.** Parecen un host de base.
Usar `localhost` en los ejemplos.

**5. Los permisos de la identidad de compilación.** Sin ellos, cada uno falla distinto y ninguno
da un error que se entienda:

| qué | cómo falla si no está |
|---|---|
| contribuir en los repos PROPIOS | `TF401027: You need the Git 'GenericContribute' permission` — y falla al final, después de compilar y probar todo |
| saltear las políticas de rama en esos repos | el commit de versión va directo a `main`, que tiene validación por build: sin esto el push se rechaza igual |

**6. El pipeline de formularios queda en rojo hasta el primer formulario.** Su control no distingue
"repo recién nacido" de "la detección se rompió", y hace bien: cero formularios casi siempre es lo
segundo. Consecuencia: **el primer cambio que entre a ese repo tiene que traer un formulario**.
Avisarlo en el alta; no aflojar el control.

**7. Copiar el host de desarrollo de otro producto se trae sus credenciales.** Su
`appsettings.json` está ignorado en git pero existe en disco. Excluirlo de la copia.

**8. Verificar la URL antes de creerle.** La misma URL sirve para el motor de formularios y para la
API de administración de plugins. Se comprueba sin credenciales: la ruta de subida contesta 405 a
un GET (existe, quiere POST) y la de listado contesta 401 (existe, quiere credenciales). Un 503 dice
que ahí no está publicado.

**9. El freno de producción salta con sólo NOMBRAR el catálogo en un comando**, aunque sea para
mirar si existe: copiarlo con `cp`/`rsync`, o listarlo en un `for`, se corta igual. El catálogo se
escribe con el editor (que abre el cuadro de aprobación) y se verifica sin nombrarlo (por ejemplo
listando `.tycon/` y contando). Por eso la plantilla no se llama como el archivo final.

**10. El producto nace sin que nadie mire sus dependencias** si no se inscribe en la revisión
nocturna (Paso 9 bis). Pasó: un producto nuevo quedó un día entero sin vigilancia, y un censo de la
organización encontró varios proyectos con entorno de producción que no miraba nadie.

## Anti-patterns

- ❌ Copiar del producto que uno tiene a mano en vez de las plantillas y los templates públicos.
- ❌ Dar el alta por terminada sin inscribir el producto en el control de paridad.
- ❌ Dar el alta por terminada sin inscribirlo en la revisión nocturna de dependencias, si la
  organización la corre.
- ❌ Commitear sin correr el control de marcadores: un `{{PRODUCT}}` vivo no lo ve nadie.
- ❌ Declarar una diferencia de paridad sin verificar dónde quedó el comportamiento.
- ❌ Pasarle por encima a los hooks para que el commit entre.
- ❌ Escribir credenciales en un archivo del repo, aunque sean de prueba.
- ❌ Dar por verificada una corrida que salteó la etapa que importaba.
- ❌ Commitear o pushear sin autorización explícita del dev.
- ❌ Escribir los documentos de memoria en cada alta en vez de partir de las plantillas — y su
  inverso: pegar una plantilla sin leerla, heredando decisiones de otro producto como si fueran
  de éste.
