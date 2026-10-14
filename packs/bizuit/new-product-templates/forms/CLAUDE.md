# CLAUDE.md — {{FORMS_REPO}}

Guía para trabajar en este repo. Es el canónico multi-herramienta: `AGENTS.md` es sólo un puntero
a este archivo.

## 🚨 REGLA CRÍTICA: NO COMMIT/PUSH SIN CONSENTIMIENTO 🚨

**Nunca `git commit` ni `git push` sin que el dev lo pida explícitamente.** Mostrar los cambios
pendientes y esperar aprobación.

## Reglas para revisores

- **Las rutas al backend van relativas y sin prefijo.** El host agrega `/plugins/<nombre>/` solo.
  Hardcodear `/plugins/{{PLUGIN}}/...` en código de formulario rompe en cuanto cambia la
  versión, y da 404 con cuerpo vacío — que se confunde con un endpoint inexistente.
- **Todo lo que viene del backend pasa por `DOMPurify` antes de renderizarse.** Sin excepción,
  aunque el campo "lo escribe un usuario interno".
- **Los inputs llevan `text-gray-900`.** Sin eso el texto tipeado queda ilegible en el tema del
  host.
- **Un formulario nuevo con pruebas de punta a punta se declara en `.tycon/advisors.yaml`**
  (`e2e.frontend_dirs` y `evidence.fe_paths`). Si no se declara, su verde no significa nada y
  nadie se entera.
- **Un formulario sin pruebas tiene que estar declarado en `pruebas-pendientes.json`** con motivo
  y fecha. Ninguna de las dos cosas = frena el pipeline, y está bien que frene.
- **`dev-credentials.js` nunca se commitea** (está ignorado); sólo viaja el `.example`.
- **Los revisores de React y de cableado de features se invocan A MANO en este repo.** React es
  `peerDependency` de cada formulario y no figura en el `package.json` raíz, así que el cómputo
  mecánico del arnés concluye "este repo no usa React" y no los invoca.

## Qué es este repo

Los **formularios y plugins frontend de {{PRODUCT}}** — el {{PRODUCT_DESCRIPTION}}. Cada
formulario es una carpeta propia, con su `package.json`, su configuración de Jest y su `src/`; se
compila a un `form.js` que el motor de formularios de BIZUIT carga en el navegador.

Nació vacío el {{DATE}}, con la infraestructura del template público de formularios
(`bizuit-custom-form-sample`), que es la única que se prueba sola todas las noches.

### Entornos: staging y producción

Cada merge a `main` publica en staging (`{{SERVER_URL}}`) los formularios que cambiaron y les
corre el humo. Producción (`{{PRODUCTION_URL}}`) recibe los MISMOS paquetes, sin reconstruirlos,
y sólo con la aprobación humana del entorno `production` en Azure DevOps.

## Cómo se crea un formulario

**Se copia una carpeta que ya funciona y se renombra. Nunca se arma a mano, y nunca se copia de
otro producto.** De cuál se copia depende de si es el primero:

**El primero** — el repo está vacío, no hay hermano de dónde sacarlo. Sale del template público:

```bash
cp -R ~/SourceCode/bizuit-custom-form-sample/form-template {{PRODUCT}}-NombreDelFormulario
```

**Del segundo en adelante** — se copia un formulario **de este mismo repo**, el más parecido al que
vas a hacer:

```bash
cp -R {{PRODUCT}}-OtroFormulario {{PRODUCT}}-NombreDelFormulario
```

Un hermano ya trae las convenciones de {{PRODUCT}}: cómo se arma el cliente del SDK, cómo se
manejan los errores, qué se muestra mientras carga. El template público no las conoce, y volver a
tomar esas decisiones en cada formulario es cómo un repo termina con cinco maneras de hacer lo
mismo.

En los dos casos, después:

```bash
cd {{PRODUCT}}-NombreDelFormulario
rm -rf node_modules dist coverage
# renombrar en package.json: name, description, y el nombre del formulario en los scripts de build
# y vaciar src/ y src/__tests__/ de lo que era del otro formulario
```

**El template público es la referencia de qué no puede faltar.** Si copiaste de un hermano, el
formulario tiene que quedar igual con estos archivos — si a alguno le falta uno, se lo trae del
template:

| archivo | para qué |
|---|---|
| `jest.config.cjs` | 🔴 `.cjs`, no `.js`: el paquete es `"type": "module"` y Jest lee su config como CommonJS. Con `.js` muere con *«module is not defined in ES module scope»* |
| `jest.setup.ts` | dos parches que jsdom necesita: `window.DEV_MODE` **antes** de importar el formulario (si no, `sentry.ts` silencia `console.log` para toda la corrida) y `window.matchMedia`, que `BizuitThemeProvider` pide al montarse. Sin el segundo, **todo** render revienta |
| `test/style-mock.cjs` | Jest no parsea CSS; el build la inlinea |
| `src/__tests__/` | el ejemplo de cómo se prueba un formulario. **Se reemplaza por las pruebas del formulario propio**, pero se conserva la forma: renderizarlo como lo renderiza el host (por `dashboardParams`), esperar los datos, y afirmar sobre lo que el usuario termina viendo |

Los paquetes `@tyconsa/*` **no se mockean**: el formulario los importa, el build los marca externos
y el host los provee en runtime, así que mockearlos no prueba nada sobre si el formulario anda con
los paquetes tal como están publicados.

Dos cosas que hay que hacer al crear uno, y que si se olvidan no dan error — se pierden en
silencio:

1. **Declararlo en `.tycon/advisors.yaml`** (`e2e.frontend_dirs` y `evidence.fe_paths`) si tiene
   pruebas de punta a punta. Un formulario con pruebas y sin declarar tiene un verde que no
   significa nada, y nadie se entera.
2. **Invocar a mano los revisores de React y de cableado de features.** El cómputo mecánico del
   arnés da "este repo no usa React" —React es `peerDependency` de cada formulario, no del
   `package.json` raíz—, así que esos revisores no se invocan solos. Medido el 2026-08-25 en un
   producto del equipo que escribió esta plantilla.

## 🔴 Rutas contra el backend: cambian según el entorno

| desde dónde | forma de la URL |
|---|---|
| código del formulario (cliente del SDK) | ruta **relativa, sin prefijo** — el host agrega `/plugins/<nombre>/` solo. Nunca hardcodear el prefijo |
| DevHost local (`dotnet run` del backend) | `http://localhost:5001/api/{ruta}` — **sin** nombre de plugin |
| servidor de staging de {{PRODUCT}} (curl, humo, E2E) | `{{SERVER_URL}}/api/plugins/{{PLUGIN}}/{version}/{ruta}` |

**Señal del error**: 404 con cuerpo vacío en el servidor cuando la misma ruta funciona en el
DevHost = falta el prefijo `/plugins/{nombre}/{version}`. No es un bug del endpoint.

## Pruebas

- Un formulario sin pruebas **frena el pipeline**. Si la deuda es deliberada, se declara en
  `pruebas-pendientes.json` con motivo y fecha; declararla no apaga el control, la registra.
- Correr pruebas **con scope**, nunca la suite entera mientras se itera:
  `npm test -- <patrón>` dentro de la carpeta del formulario. La suite completa congela la
  máquina (medido dos veces) y va sólo en el portón del merge.
- Desde la raíz del repo, `npm test`, `npm run type-check` y `npm run build` recorren **todos** los
  formularios. Un formulario que **no declare** alguno de los tres scripts cuenta como **fallo**,
  nunca como salteado: un formulario sin pruebas es justamente lo que esto viene a detectar, y un
  salteo en silencio es cómo pasa desapercibido hasta que alguien lo despliega.
- **Chequear tipos no es opcional**: esbuild **borra** los tipos sin leerlos, así que un formulario
  con un error de tipos real compila, se despliega y falla en el navegador. `npm run type-check`
  (`tsc --noEmit`) es lo único que los mira.

## Convenciones

Las del paquete bizuit, en `guides/bizuit/bizuit-plugin-react.md` del arnés: Tailwind en producción,
inputs con `text-gray-900`, modales con el patrón fijo, TypeScript estricto, autenticación por
Bearer del SDK, `DOMPurify` sobre todo lo que viene del backend antes de renderizar.

## Historias

Las historias de {{PRODUCT}} **no viven acá**: viven en el repo `{{STORIES_REPO}}`, en `.specs/`.
