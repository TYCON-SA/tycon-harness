# Bizuit Plugin React/TypeScript — Guía Stack-Specific

Guía consolidada para el equipo TYCON sobre plugins frontend React en la plataforma Bizuit. Aplica a todos los plugins frontend del equipo (formularios como `acme-pedidos` o `acme-admin`, y similares). **No aplica** a BIZUITDashboard (Angular 14) ni a los sitios públicos hechos en Next.js.

> **📚 Fuente de verdad del framework**: el repo del framework de plugins (un repo del equipo).
>
> Ahí vive el código real del SDK `@tyconsa/bizuit-form-sdk`, plugins de ejemplo frontend, y el runtime del form host. **Cualquier duda sobre cómo funciona el SDK, el auth token, las APIs del host → consultar ese repo antes de asumir.** Esta guía es una síntesis de convenciones — el repo es la implementación real.
>
> **Sin acceso a ese repo** (un dev de otra organización): el punto de partida es el template público de formularios, <https://github.com/TYCON-SA/bizuit-custom-form-sample>, con los paquetes npm `@tyconsa/bizuit-form-sdk` y `@tyconsa/bizuit-ui-components`. El backend que lo acompaña sale del template público del plugin, <https://github.com/TYCON-SA/bizuit-custom-plugin-sample>.

> **🌐 Regla de routing por entorno (BZURL)**: en **código frontend** la base de la URL la da el host en `dashboardParams.pluginApiUrl` y el código le agrega `/<plugin>/<ruta>` — nunca un `fetch('/api/...')` desde la raíz del servidor, nunca la versión a mano (código y síntomas en §3). Pero al **testear/debuggear a mano contra staging/prod** (curl, browser devtools, E2E apuntando al host), la URL real SÍ lleva el prefijo del plugin, y tampoco ahí la versión: `https://<host>/api/plugins/{pluginName}/{ruta}`. DevHost local NO lo lleva (`http://localhost:5001/api/{ruta}`). Un 404 body-vacío en staging con un path que anda en DevHost = falta el prefijo; un 404 `{"error":"Endpoint not found"}` = sobra algo en la ruta, casi siempre la versión. Ninguno es un bug. Incidente recurrente multi-proyecto (regla reforzada 2026-07-15; la versión salió de la regla el 2026-10-14).

---

## 1. Stack baseline

- **React 18** + **TypeScript** estricto
- **Tailwind** vía CDN en dev, bundleado en prod (ojo con limitations de prod — ver sección 6)
- **esbuild** (no Vite, no webpack app) vía `build-form-dev.js` / `build-form.js`
- **SDK auth**: `@tyconsa/bizuit-form-sdk`
- **Testing**: `vitest` + `@testing-library/react`, opcionalmente Playwright para E2E
  - *Divergencia conocida*: Totora usa `jest` — mantener lo que el proyecto declare en `package.json`

---

## 2. Estructura de archivos

```
plugin-name/
├── src/
│   ├── components/          # PascalCase .tsx
│   ├── hooks/               # useXxx.ts (sin JSX)
│   ├── services/            # apiCall, helpers HTTP
│   ├── utils/               # *Catalogs.ts, formatters, validators
│   ├── types/               # interfaces + type aliases
│   └── index.tsx            # orquestador, inyecta apiCall a hooks
├── dist/                    # output del build
├── dev.html                 # dev harness (React + Tailwind via CDN)
├── dev-proxy.js             # CORS proxy a DevHost
├── build-form.js            # build producción
├── build-form-dev.js        # build dev
└── package.json
```

**Reglas:**
- `.tsx` solo para componentes con JSX
- `.ts` para hooks sin JSX, utils, services, types
- `index.tsx` como orquestador — inyecta `apiCall` a los hooks (dependency injection manual)
- No usar alias `@/` sin configurar `paths` en `tsconfig.json` — los proyectos actuales usan paths relativos

---

## 3. Auth + API

### Token del SDK

```ts
// El SDK entrega "Basic X" — convertir a Bearer antes de mandar
const bearerToken = `Bearer ${authToken.replace(/^Basic\s+/i, '')}`;
```

### Endpoints — de dónde sale la URL del backend (REACT-C6)

El host le pasa al formulario la base de la API de plugins en `dashboardParams.pluginApiUrl`
(en desarrollo, `devPluginApiUrl`). Esa base ya incluye la carpeta en la que el host publica la
aplicación de formularios (`<carpeta-del-host>/api/plugins`). El código le agrega el nombre del
plugin y la ruta:

```ts
// En el punto de entrada: falla explícita si el host no la pasó (sin fallback silencioso)
const pluginApiUrl = dashboardParams?.pluginApiUrl || dashboardParams?.devPluginApiUrl || '';

// En el servicio: base + nombre del plugin + ruta
const PLUGIN_NAME = 'mi-plugin';
const r = await fetch(`${pluginApiUrl}/${PLUGIN_NAME}/ordenes/${id}`, { headers });
```

- ❌ **NUNCA `fetch('/api/ruta')` ni `fetch('/ruta')` desde la raíz del servidor.** En
  desarrollo funciona, porque el proxy local atiende `/api`; en el host sale fuera de la carpeta
  de la aplicación y responde **503** (o 404). Una prueba que afirma esa misma dirección no lo
  frena: confirma el error. La prueba tiene que armar la URL desde un `pluginApiUrl` de mentira
  (`'http://localhost:5003/api'`) y afirmar que el pedido sale de ahí.
- ❌ Sin el nombre del plugin (`${pluginApiUrl}/ordenes`): la ruta pega a `/api/plugins/ordenes`
  → **404** en el host.
- ❌ NUNCA agregar la versión ni `/v1` a mano: la resuelve el host.
- Para curl/debug manual contra staging/prod la URL completa SÍ lleva
  `/api/plugins/{pluginName}/`, sin versión (ver callout BZURL al tope).
- Antes de escribir el primer servicio de un formulario nuevo, abrir el de un formulario hermano
  del equipo y copiar cómo arma la base: el patrón es uniforme entre todos.
- Multipart uploads: usar `toDirectBackendUrl()` para bypass del proxy
- Dual auth cuando aplica: `Bearer` para admin + `X-Api-Key` para operaciones (patrón de Ebano)

### Errores HTTP

- Capturar `fetch` errors y mapear a estados AsyncState (`loading | success | error`)
- NUNCA swallow errors silencioso — loggear a `console.error` (Sentry captura en prod solo `console.error`)

### Request body — el host Bizuit mangonea el body según el método ⚠️ (REACT-W16/W17)

El proxy Next.js del host (`custom-forms/runtime-app/app/api/plugins/[...path]/route.ts`, en el repo del framework) procesa el body distinto por método, y rompe el plugin de formas que **NO se ven en build, solo deployado**:

- **POST/PUT/PATCH sin body** + `Content-Type: application/json` → el proxy hace `await request.json()` → `JSON.parse('')` → **HTTP 500 `{"error":"Unexpected end of JSON input"}`**. Pasa con `deactivate`/`reactivate`/`reset` y cualquier escritura sin payload. Quitar el `Content-Type` **no sirve** (IIS → 411 Length Required). **El apiClient debe mandar `'{}'` cuando no hay body en escrituras**:
  ```ts
  const isWriteMethod = method === 'POST' || method === 'PUT' || method === 'PATCH';
  body: body !== undefined ? JSON.stringify(body) : isWriteMethod ? '{}' : undefined,
  ```
- **DELETE con body** → el host **dropea el body** → `[FromBody]` del endpoint .NET queda null → NRE. Mandar el payload del DELETE por **query string**, nunca en el body.

La escritura sin body es W16 y el DELETE con body es W17. El advisor `tycon-plugin-react-conventions` los chequea.

---

## 4. Componentes

### Naming y ubicación

- Componentes: **PascalCase**, en `src/components/`
- Archivos: `MiComponente.tsx`
- Hooks: **camelCase empezando con `use`**, en `src/hooks/`, archivo `useMiHook.ts`

### Patrón de orquestación (Calden-style)

```tsx
// src/index.tsx — orquestador
const apiCall = createApiCall(authToken);
const projects = useProjects(apiCall);
const users = useUsers(apiCall);
// Componentes reciben props derivados de hooks, no instancian hooks propios
return <App projects={projects} users={users} />;
```

### Composition > boolean prop proliferation

```tsx
// ❌ MAL — props booleanas que se multiplican
<Modal showHeader showFooter showCancelButton size="large" />

// ✅ OK — composition pattern
<Modal>
  <Modal.Header>Título</Modal.Header>
  <Modal.Body>...</Modal.Body>
  <Modal.Footer cancel primary="Guardar" />
</Modal>
```

### Componente nuevo si `.map()` inline falla en build

Regla operativa de Totora + Pacara: si después de 2-3 intentos un `.map()` inline en un componente da problemas de build esbuild, **crear un componente en archivo separado**. Fuerza a esbuild a regenerar el módulo desde cero.

### Grillas: `<DataGrid>` dual-mode (patrón `PedidosTable`)

Las grillas (`<table>`) NO se codean a mano cada vez. Usar **un único componente `<DataGrid>`** compartido en el barrel de UI (`@<scope>/ui`). El componente tiene **dos modos** y el modo se detecta por la **presencia de callbacks** — NO por un flag explícito:

```tsx
const usaOrdenamientoExterno = onSortChange !== undefined;
const usaPaginacionExterna   = onPageChange !== undefined;
```

- **Modo client-side (default)** — sin callbacks `onSortChange`/`onPageChange`: el `<DataGrid>` ordena y pagina **internamente** sobre las `rows` que recibe. Para grillas **acotadas** (dataset chico que no crece sin límite — detalle de UN registro, catálogo admin, cola de una estación).
- **Modo server-side (controlado)** — el parent pasa `onSortChange`/`onPageChange` + valores controlados (`sortField`, `sortDir`, `page`, `total`): el `<DataGrid>` solo renderiza y emite eventos; el parent hace el fetch paginado/ordenado server-side. Para grillas **que crecen sin límite** (listas de pendientes, audit logs).

Cargar todo el dataset en el browser para una grilla que crece es paginación falsa — usar el modo server-side. Migrar una grilla del modo client-side al server-side NO requiere tocar el `<DataGrid>`: solo wirear los callbacks en el parent.

```tsx
// Client-side — cero wiring de sort/paginación:
<DataGrid title="Catálogo" columns={cols} rows={rows} onExport={handleExport} />

// Server-side — el parent controla:
<DataGrid
  title="Pendientes" columns={cols} rows={pageRows}
  total={total} page={page} sortField={sf} sortDir={sd}
  onPageChange={setPage} onSortChange={setSort}
/>
```

**Columnas:** `{ key, label, sortable?, align?, render? }[]`. `render` para celdas custom (badges, botones de acción, formato monospace). Las acciones por fila van como una columna con `sortable: false` y `render`.

**Export:** en modo client-side el `<DataGrid>` tiene todas las filas → la barra CSV/Excel/PDF postea `{ title, columns, rows }` completo al endpoint genérico de export (ver guía .NET §7). El `onExport` se wirea con `apiBase` + `authToken` (la descarga es `fetch` + `Blob`, no pasa por el `ApiClient` que parsea JSON). En modo server-side el export re-consulta server-side.

**Regla:** grilla nueva o `<table>` artesanal que se toca → migrar a `<DataGrid>`. No reimplementar sort/paginación/export por grilla.

---

## 5. Estado y data fetching

- **Zustand** para state global si el plugin lo necesita (Yatay)
- `useState` + `useReducer` para state local
- **NO usar `useEffect` para state derivable durante render** — calcular en el render directo
- **NO usar `useEffect` para fetching** cuando se puede usar `useX` hook que encapsule el fetch + loading state
- Catálogos estáticos: hardcoded en `src/utils/*Catalogs.ts` (patrón Calden)

### AsyncState pattern

```ts
type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error };
```

Discriminated union. Nunca objeto con `{ loading, data, error }` porque invita a estados imposibles.

---

## 6. Tailwind — limitations de producción ⚠️

**Críticas.** El build prod de esbuild para plugins Bizuit **NO soporta** varias features de Tailwind que sí andan en dev. Si usás esto, el UI rompe en prod silencioso.

### Clases que NO funcionan en prod

- `peer-*` (`peer-hover:...`, `peer-focus:...`)
- `after:*`, `before:*` (pseudo-elementos)
- `backdrop-blur-*`
- Opacidades con slash: `bg-white/70`, `text-black/50`
- `line-clamp-*`
- `sr-only`
- **Breakpoints**: `sm:*`, `md:*`, `lg:*`, `xl:*`
- Group variants: `group-hover:*`, `group-focus:*`

### Regla mecánica

Si tu clase contiene cualquiera de estos caracteres o prefijos:
- `:` (excepto el primer separador de variante)
- `/` (opacidades)
- `[` `]` (arbitrary values)
- Prefijos `after:`, `before:`, `peer:`, `group:`, `sm:`, `md:`, `lg:`, `xl:`

→ **usar inline style** en lugar de Tailwind class.

```tsx
// ❌ MAL — no va a aplicar en prod
<div className="bg-white/70 backdrop-blur-sm sm:p-4">

// ✅ OK — inline style
<div style={{
  backgroundColor: 'rgba(255, 255, 255, 0.7)',
  backdropFilter: 'blur(4px)',
  padding: window.innerWidth > 640 ? '1rem' : undefined
}}>
```

---

## 7. Inputs y forms

### Regla crítica: `text-gray-900`

**TODOS** los `<input>`, `<select>`, `<textarea>` deben tener `className` incluyendo `text-gray-900`. Sin eso, heredan color blanco del padre en prod y el texto queda invisible.

```tsx
// ❌ MAL
<input type="text" className="px-3 py-2 border rounded-lg" />

// ✅ OK
<input type="text" className="px-3 py-2 border rounded-lg text-gray-900" />
```

### Padding estándar de inputs

`px-3 py-2 text-sm`. **NUNCA** `px-4 py-3` (rompe consistencia visual).

### Border radius

- `rounded-lg` para inputs y containers
- `rounded-2xl` solo para modales (convención Ebano)

### Validación

- Forms complejos: `react-hook-form` + `zod` (si el proyecto ya lo usa)
- Forms simples: validación inline custom es aceptable

---

## 8. Modales (patrón fijo)

```tsx
<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
  <div className="bg-white rounded-2xl max-h-[90vh] flex flex-col overflow-hidden">
    {/* Header: flex-shrink-0 */}
    <div className="flex-shrink-0 px-6 py-4 border-b border-gray-200">
      <h2>Título</h2>
    </div>

    {/* Content: scrollable */}
    <div className="flex-1 overflow-auto p-6">
      {/* ... */}
    </div>

    {/* Footer: flex-shrink-0 */}
    <div className="flex-shrink-0 px-6 py-4 bg-[#f9fafb] border-t border-gray-200 flex justify-between items-center">
      <button className="text-gray-600">Cancelar</button>
      <button className="bg-blue-600 text-white px-4 py-2 rounded-lg">Guardar</button>
    </div>
  </div>
</div>
```

**Reglas:**
- Container: `flex flex-col overflow-hidden`
- Header + Footer: `flex-shrink-0`
- Content: `flex-1 overflow-auto`
- Footer bg: `#f9fafb` con `border-t`
- Acciones: cancelar izquierda, primario derecha

### Tamaño fijo — el modal NO cambia de tamaño según el contenido

Un modal **no debe crecer ni encogerse en función de cuántos ítems muestre**. El "salto" visual cuando una lista se filtra o termina de cargar es un anti-patrón molesto.

- **Contenido variable** (listas, tablas, resultados de búsqueda): el container usa **`height` fijo** (ej. `h-[82vh]` / `style={{ height: '82vh' }}`), **nunca `max-h-` solo**. `max-height` sin `height` deja que el modal se ajuste al contenido — exactamente lo que NO queremos. El scroll va SIEMPRE adentro (el `content` con `flex-1 overflow-auto` ya lo resuelve).
- **Contenido fijo** (confirmaciones, forms cortos): el contenido ya es estable → se dejan con su alto natural; no hace falta `height` fijo.
- El alto se decide por el **tipo** de modal, no por la cantidad de datos. Misma lógica para el ancho (`width` fijo, no dependiente del contenido).

```tsx
{/* Modal de contenido variable — alto FIJO */}
<div className="bg-white rounded-2xl h-[82vh] flex flex-col overflow-hidden">
```

> Anti-patrón: `max-h-[90vh]` como única restricción de alto en un modal con lista
> → el modal "salta" de tamaño al filtrar. Usar `height` fijo.

---

## 9. Iconos

**NUNCA emojis 3D / realistas** en botones, banners o texto. Los emojis aplanados del unicode van OK pero preferir SVG.

- SVG inline para iconos custom
- Lucide o Heroicons para genéricos
- Si es decorativo (bullet point visual), OK emoji plano (`•`, `→`, `✓`)

**Mal:** 🚀 🔥 ⭐ (3D/realista)
**Bien:** SVG inline, `<CheckIcon />`, `•`

---

## 10. Loading states

- Usar skeletons: `<SkeletonList>`, `<SkeletonTable>`, `<SkeletonCards>` (convención Ebano)
- **NO** spinner + texto "Cargando..." (feel anticuado)

## 11. Collapse / expand

- Usar `calden-collapse` con `grid-template-rows: 0fr -> 1fr` (convención Ebano)
- **NO** conditional rendering con `&&` — rompe animaciones

---

## 12. TypeScript

- `strict: true` en `tsconfig.json`
- `unknown` > `any` para input desconocido, con type guards (`value is T`)
- `interface` para object shapes
- `type` para unions y aliases simples
- Discriminated unions para AsyncState, Result types, etc.
- Evitar `as` assertions sin type guard que lo respalde

---

## 13. Logging

- `console.log` / `console.warn` / `console.error` estándar
- Sentry intercepta **solo `console.error`** en prod — no depender de `console.log` para debug prod
- Validar que `BZExtFormConfigurations` llegue como string (puede venir parseado) antes de usar

---

## 14. Testing

### Framework

- **vitest** default (Ebano estándar)
- Playwright para E2E
- *Divergencia*: Totora usa jest — seguir lo que el `package.json` del proyecto declare

### Patterns

- React Testing Library, NO enzyme
- MSW (Mock Service Worker) para mocks HTTP, NO `jest.fn()` manual sobre fetch
- Tests en `__tests__/` o `.test.tsx` junto al archivo
- Nombres de tests descriptivos (no estrictos con `MethodName_Scenario_Expected` como en .NET)

---

## 15. Anti-patterns auditables

Lista de violations concretas que un advisor puede detectar:

1. **Emojis 3D en iconos** → usar SVG/Lucide
2. **Input sin `text-gray-900`** → agregar
3. **Clases Tailwind prohibidas en prod** (`sm:*`, `backdrop-blur-*`, `bg-*/N`, etc.) → inline style
4. **`useEffect` para state derivable** → calcular en render
5. **`useEffect` para fetching sin abstracción** → crear hook `useX`
6. **`any` explícito** → `unknown` + type guard
7. **Comentarios `// ...`, "resto del código", "se mantiene igual"** → código completo obligatorio
8. **Breakpoints Tailwind en plugin Bizuit** (`sm:`, `md:`, `lg:`) → inline style o media query manual
9. **Emoji reemplazando icono** → SVG
10. **Placeholder `// TODO`, `// FIX`** en código nuevo sin ticket asociado
11. **Naming engañoso en helpers de auth** → `getBearerToken()` que devuelve token pelado debe llamarse `stripAuthPrefix()` o `getRawToken()`. Si el nombre promete "Bearer", tiene que devolver `"Bearer X"` completo. El consumidor no puede adivinar por el nombre qué formato recibe.
12. **Props deprecadas sin `@deprecated` JSDoc per-prop** → no alcanza con un comentario de bloque arriba del interface. Cada prop legacy debe tener su `/** @deprecated Story 2.X cleanup */` encima para que TS/IDE muestre tachado en los call-sites.
13. **Jest `moduleNameMapper` sin entry para CSS/assets del SDK** → si se importan `*.css` / `*.scss` / `*.svg` desde `node_modules` y cada test tiene que repetir `jest.mock(..., { virtual: true })`, configurar central en `jest.config.js`: `"\\.(css|scss)$": "<rootDir>/src/__mocks__/styleMock.js"`.
14. **Peer React desalineado con deps `-react`** → si el plugin agrega múltiples deps react-aware (`@acme/widgets-react`, `@sentry/react`, `@tyconsa/bizuit-form-sdk`, etc.), todos los peer de `react` deben ser compatibles con el peer declarado por el plugin. Una sola desalineación y el host explota en runtime sin mensaje claro. Verificar manualmente hasta que haya check automático en `build-form.js`.

### CRITICAL (bloquean el merge)

15. **Rename de componente exportado sin preservar contrato de props** → cuando un commit renombra un componente con call-sites existentes, la nueva interfaz DEBE incluir las props legacy (como optional/no-op documentadas `@deprecated`) O el mismo commit DEBE actualizar todos los call-sites. No hay tercera opción — "lo arreglamos en story siguiente" no cuenta si TS no lo fuerza.

---

## 16. Git / build workflow

- SIEMPRE rebuild antes de commit (`npm run build` OK)
- `type-check` (`tsc --noEmit`) antes de push a main
- Si vitest/jest falla → no commitear
- Ver `git-commit-conventions.md` para formato de mensaje

---

## 17. Engram project names frontend (heads-up)

Los canonical project names frontend NO siempre coinciden con el nombre del repo. Ejemplos:

| Directorio | Canonical project name |
|---|---|
| `Acme/FrontEnd/` | `AcmeForms` |
| `Globex/GlobexFrontend/admin/` | `GlobexFrontend` |

Ver `engram-workflow.md` para la lista completa.

---

## 18. Lo que NO está estandarizado (yet)

- Puerto dev: cada proyecto usa el suyo (8080-8083 Totora, 3000 Pacara, 8090 Calden)
- Alias de imports (`@/components` vs rutas relativas)
- Design system formal: solo Ebano tiene uno ("Impeccable")

Si el equipo quiere estandarizar algo de esto, agregarlo a esta guía.

---

## 19. Fechas y horas

El backend persiste y serializa las fechas en **UTC** (sufijo `Z` — ver guía .NET §"Fechas y horas"). El frontend **nunca renderiza el ISO crudo ni hardcodea un locale**.

- **Un único util central** de formateo (`formatDateTime` / `formatDate` / `formatTime` / `formatRelative`) — ningún componente reinventa el formateo de fecha.
- Formatear con `toLocale*()` / `Intl.*` **sin argumento de locale** → la config regional (formato dd/mm, separadores, nombres de mes) la decide el navegador.
- La **zona horaria sale siempre del navegador**: `new Date(utcIso)` parsea el `Z` como UTC y `toLocale*` lo convierte a la hora local del usuario.
- Una cadena datetime sin `Z` ni offset se asume **UTC** (el server guarda UTC) — el util la normaliza antes de parsear.
- Fecha ausente o inválida → placeholder (`'—'`), nunca `Invalid Date` ni throw.

```tsx
// ✅ util central, TZ + locale del navegador
import { formatDateTime } from '@ceibo/ui';
<td>{formatDateTime(order.fechaCreacion)}</td>
```

> Anti-patrón: `toLocaleString('es-AR')` hardcodeado en cada componente, o renderizar
> `{order.fecha}` crudo. El locale fijo ignora la config del browser; el ISO crudo
> muestra hora del servidor, no del usuario.

## 20. `<DataGrid>` compartido — modos server-side (cursor + fila expandible)

El `<DataGrid>` de `@ceibo/ui` (patrón `PedidosTable`) decide su modo por
**presencia de callbacks** — no por un prop `mode`. Cuatro variantes ortogonales:

| Modo | Activador | Uso |
|---|---|---|
| **client-side** | sin `onPageChange`/`onLoadMore` | grillas acotadas (ordena/pagina/exporta en el browser) |
| **server-side offset** | `onPageChange` + `total`/`page`/`sortField`/`sortDir` | grillas que crecen — el parent fetchea la página |
| **server-side cursor** | `onLoadMore` (+ `hasMore`) | listas vivas resilientes a inserciones — botón "Cargar más", el parent acumula `rows` |
| **fila expandible** | `renderExpanded` | ortogonal a los 3 anteriores — columna toggle `[+]/[−]` + fila `colSpan` |

Reglas:

- `onPageChange` y `onLoadMore` son **mutuamente excluyentes**. Si se proveen ambos →
  gana offset + `console.warn`. NO depender de `import.meta.env` en código de `shared/`
  (no está tipado en todos los `tsconfig` del monorepo) — un warn de API-misuse se emite
  siempre.
- En modo server-side las column `key` del `<DataGrid>` que se quieran ordenar **deben
  matchear la whitelist de sort del backend** (`onSortChange(field)` manda `col.key` como
  `sortBy`). Columnas fuera de la whitelist → `sortable: false`.
- Export server-side: el parent wirea `onExport` a `downloadServerExport(apiBase, authToken,
  path)` (GET que re-consulta el set completo) — NUNCA `exportGrid` con las filas del
  cliente (el cliente solo tiene una página).
- La sub-tabla de una fila expandible NO es un `<table>` artesanal — usar un `<DataGrid>`
  client-side anidado (patrón `PedidoDetalle`/`IngresosPendientes`).
