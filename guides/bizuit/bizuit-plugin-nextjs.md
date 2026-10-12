# Next.js — convenciones TYCON

Guía consolidada para aplicaciones **Next.js 14+** dentro del ecosistema TYCON. Aplica a:

- el sitio público de un producto (landing — único Next hoy)
- Futuros SaaS web nuevos basados en Next.js App Router
- Integraciones Next como BFF frente al backend Bizuit

**No aplica** a:

- Plugins Bizuit forms (React SPA, esbuild) → ver [`bizuit-plugin-react.md`](bizuit-plugin-react.md)
- BIZUITDashboard (Angular 14)
- Apps React SPA standalone (Vite/CRA)

> **Nota meta**: esta guía es joven (creada 2026-04-21). Muchas reglas son heurísticas del equipo extrapoladas de la experiencia con plugins React + el feedback oficial de Vercel. Iterar según aparezcan casos reales.

---

## 1. Stack baseline

- **Next.js**: 14+ (App Router obligatorio, no Pages Router para código nuevo)
- **React**: 18.3+ (19 cuando Next lo soporte estable)
- **TypeScript**: strict
- **Build**: `next build` (NO `build-form.js` del ecosistema Bizuit — distinto universo)
- **Deploy**: Vercel o Azure App Service / Static Web Apps
- **Testing**: Jest + testing-library, o Vitest (preferencia por Vitest en nuevos proyectos)
- **Linting**: ESLint con `next/core-web-vitals` + `@typescript-eslint/recommended`

### Diferencias clave con plugins Bizuit form

| Dimensión | Plugin Bizuit form | Next.js app |
|---|---|---|
| Entry | `src/index.tsx` | `app/layout.tsx` + `app/page.tsx` |
| Build | esbuild custom (`build-form.js`) | `next build` |
| Routing | NO hay — el host Bizuit renderiza | File-system (`app/`) |
| SSR/SSG | Imposible (corre en host Bizuit) | Obligatorio en muchos casos |
| Tailwind prod limitations | Sí (esbuild no purga) | No aplica (Next/Tailwind full pipeline) |
| Env vars | Via host | `NEXT_PUBLIC_*` (cliente) + runtime (servidor) |

---

## 2. Server vs Client Components

### Default: Server Component

Todo archivo en `app/` es **Server Component** por default. Esto significa:

- Renderiza en el servidor (o build-time con SSG)
- NO puede usar `useState`, `useEffect`, `onClick`, `onChange`, etc.
- Puede `await` directamente en el body del componente
- Puede acceder a BD / fs / env runtime

### `"use client"` — cuándo y cómo

Agregar `"use client"` al **tope del archivo** solo cuando el componente necesita:

- Event handlers interactivos (`onClick`, `onChange`, `onSubmit` con lógica cliente)
- Hooks de React (`useState`, `useEffect`, `useReducer`, `useContext`, `useRef`)
- APIs del browser (`window`, `document`, `localStorage`, `navigator`)
- Libraries que usan hooks internamente (`react-hook-form`, `framer-motion`, `@tanstack/react-query` cliente)

**Regla de oro**: minimizar la superficie `"use client"`. Si un componente grande solo necesita un `onClick` en un botón, extraer el botón a un archivo separado `"use client"` y mantener el resto Server.

```tsx
// ❌ MAL: toda la página cliente
"use client";
export default function ProductsPage() {
    const [filter, setFilter] = useState("");
    const products = await fetchProducts(); // ERROR: no se puede await en cliente
    // ...
}

// ✅ BIEN: página Server, interactividad aislada
// app/products/page.tsx (Server)
export default async function ProductsPage() {
    const products = await fetchProducts();
    return <ProductsList products={products} />;
}

// app/products/ProductsList.tsx (Client solo para el filter)
"use client";
export function ProductsList({ products }: { products: Product[] }) {
    const [filter, setFilter] = useState("");
    return <>...</>;
}
```

---

## 3. Data fetching

### Regla 1: Server Components primero

Si los datos se pueden obtener en el servidor, hacelo en el servidor. Evita el flash de loading state del cliente.

```tsx
// app/users/[id]/page.tsx (Server)
export default async function UserPage({ params }: { params: { id: string } }) {
    const user = await fetch(`${API}/users/${params.id}`).then((r) => r.json());
    return <UserCard user={user} />;
}
```

### Regla 2: Cache por default (Next 14) / opt-in en Next 15+

- **Next 14 App Router**: `fetch()` está cacheado por default. Revalidar con `{ next: { revalidate: 60 } }` o desactivar con `{ cache: 'no-store' }`.
- **Next 15+**: el cache es **opt-in** — hay que usar `fetch(url, { cache: 'force-cache' })` o la directiva `"use cache"`.

Ver guía oficial al migrar entre versiones — el behavior cambió deliberadamente.

### Regla 3: Client-side fetching solo si hace falta

Si los datos dependen de interacción del usuario (filtros dinámicos, forms, etc.), usar React Query o SWR:

```tsx
"use client";
import { useQuery } from "@tanstack/react-query";

export function UserSearch() {
    const [query, setQuery] = useState("");
    const { data } = useQuery({
        queryKey: ["users", query],
        queryFn: () => fetch(`/api/users?q=${query}`).then((r) => r.json()),
        enabled: query.length > 2,
    });
    // ...
}
```

**NO** usar `useEffect + fetch + useState` para data fetching en componentes cliente — usar React Query / SWR.

---

## 4. Routing y layouts

- **App Router** obligatorio para código nuevo. Pages Router solo si el proyecto legacy ya lo usa.
- Jerarquía: `app/layout.tsx` (root) → `app/(group)/layout.tsx` (grupos) → `app/segment/page.tsx` (hoja).
- `loading.tsx` para estados de carga por segmento.
- `error.tsx` para error boundaries por segmento.
- `not-found.tsx` para 404s.

### Route groups con paréntesis

`app/(marketing)/layout.tsx` y `app/(app)/layout.tsx` permiten layouts distintos sin afectar la URL. Útil para separar landing vs dashboard dentro del mismo proyecto.

---

## 5. Metadata

Usar la Metadata API — NO `<Head>` del pages router.

```tsx
// app/page.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
    title: "Acme — Panel de pedidos",
    description: "...",
    openGraph: { ... },
    twitter: { ... },
};
```

Para metadata dinámica: `export async function generateMetadata({ params }) { ... }`.

---

## 6. Server Actions

- Usar Server Actions para mutaciones (forms, botones de "guardar") en vez de API routes cuando sea posible.
- Marcar con `"use server"` al tope del archivo o de la función.
- Validar input server-side con Zod o similar — el cliente puede hacer bypass trivialmente.

```tsx
// app/actions.ts
"use server";
import { z } from "zod";

const CreateUserSchema = z.object({
    email: z.string().email(),
    name: z.string().min(1),
});

export async function createUser(formData: FormData) {
    const parsed = CreateUserSchema.parse({
        email: formData.get("email"),
        name: formData.get("name"),
    });
    // ...
}
```

---

## 7. Env vars

- **Cliente** (bundled en JS): prefijo `NEXT_PUBLIC_*`. Ej: `NEXT_PUBLIC_API_URL`.
- **Servidor**: sin prefijo, solo accesible en Server Components / API routes / Server Actions. Ej: `DATABASE_URL`, `API_KEY`.

**Regla crítica**: si una var tiene secreto, NUNCA usar prefijo `NEXT_PUBLIC_` — terminaría en el bundle cliente visible en devtools.

---

## 8. Imágenes

Usar `<Image>` de `next/image`, NO `<img>` raw. Ganancias automáticas:

- Lazy loading
- Responsive via `sizes`
- Optimización (AVIF/WebP automático)

```tsx
import Image from "next/image";
<Image src="/hero.png" alt="..." width={800} height={600} priority />;
```

`priority` solo para imágenes above-the-fold (LCP).

---

## 9. Scripts de terceros

Usar `<Script>` de `next/script`, NO `<script>` en `<Head>`.

Estrategias:

- `beforeInteractive` — antes de hidratar (tracking init crítico, polyfills)
- `afterInteractive` — default, después de hidratar (analytics, etc.)
- `lazyOnload` — cuando el browser está idle (chat widgets, etc.)

---

## 10. Route Handlers (API routes)

Si se necesitan endpoints HTTP del mismo proyecto, usar Route Handlers en vez de Pages `api/`:

```tsx
// app/api/users/route.ts
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
    const users = await fetchUsers();
    return Response.json(users);
}

export async function POST(request: NextRequest) {
    const body = await request.json();
    // ...
}
```

**Regla**: siempre validar body con Zod antes de procesar. NUNCA confiar en el cliente.

---

## 11. Testing

- **Server Components**: probar como funciones (`await Component({ params })` y assertear JSX/data).
- **Client Components**: testing-library + Jest/Vitest — igual que plugins Bizuit.
- **Route Handlers**: `fetch` directo al handler en test, o mock del `NextRequest`.
- **Server Actions**: invocar la función directamente con `FormData` mockeado.

```tsx
// Ejemplo Server Component test
import UserPage from "./app/users/[id]/page";
test("renders user name", async () => {
    const jsx = await UserPage({ params: { id: "123" } });
    expect(jsx).toContain("Juan");
});
```

---

## 12. TypeScript

- `strict: true` obligatorio en `tsconfig.json`.
- `params` y `searchParams` son **promesas en Next 15+** — `await params` en Server Components.
- Tipos de `metadata`, `Route`, `Metadata` desde `next`.
- Evitar `any` en API pública de componentes/actions — `unknown` + type guard.

---

## 13. Performance / Core Web Vitals

- `<Image priority>` solo en LCP.
- `<Script strategy="beforeInteractive">` solo si es bloqueante crítico.
- Evitar hydration mismatch (server render distinto a cliente) — typical causa: `Date.now()`, `Math.random()` en render sin `"use client"` + `useEffect`.
- `ppr` (Partial Prerendering) opt-in en Next 15+ para mejores FCP/TTFB.

---

## 14. Anti-patterns auditables

Lista de violations que un advisor puede detectar:

1. **`"use client"` en page/layout de nivel alto sin justificación** → extraer la interactividad a un child
2. **`useEffect + fetch + useState` para data fetching** → React Query / SWR o Server Component
3. **`<Head>` del pages router en app/** → usar Metadata API
4. **`<img>` raw en vez de `<Image>` de next** → `next/image` siempre
5. **`<script>` raw en vez de `<Script>` de next** → `next/script`
6. **`NEXT_PUBLIC_*` usado para secretos** → NUNCA — usar var server-side
7. **Server Action sin validación Zod** → input del cliente no se puede confiar
8. **Route Handler sin validación** → idem
9. **`any` explícito en API pública de Server Action / Route Handler / component** → `unknown` + type guard
10. **Mixing App Router y Pages Router en el mismo feature** → consistencia, preferir App
11. **Fetch con `no-store` siempre sin justificación** → rompe cache optimizations, solo usar cuando realmente necesario
12. **Hydration mismatch risks** (`Date.now()`, `Math.random()` en Server Component que luego se hidrata como Client) → mover a `useEffect` o aceptar SSR value
13. **Hardcoded API URLs en cliente sin `NEXT_PUBLIC_*`** → usar env var
14. **`params`/`searchParams` tipados como sync en Next 15+** → son Promise, hay que `await`
15. **Metadata dinámica con `revalidate: 0`** → fuerza dynamic rendering, romper SSG

---

## 15. Git / build workflow

- `npm run build` antes de commit (catch de errors TS en build time que `tsc --noEmit` a veces no captura)
- `next build` falla en producción si hay errors de linting / types — no ignorar
- `next dev` es tolerante; confiar solo en `next build` como gate real

---

## 16. Deployment

### Vercel
- Deploy automático por branch
- Preview deployments en cada PR
- Env vars diferenciadas por scope (Production / Preview / Development)

### Azure (alternativa si cliente requiere hosting propio)
- App Service con Node runtime
- Static Web Apps para apps estáticas (SSG puro)
- Attention: algunas features Next (ISR, Server Actions) requieren runtime Node, no estático

---

## 17. Engram project names (heads-up)

Si se usa Engram en un proyecto Next.js, el `project` es el nombre del proyecto en kebab-case — mismo criterio que los plugins React. Ver `engram-workflow.md`.

---

## 18. Lo que NO está estandarizado (yet)

- State management global (Zustand, Jotai, Redux Toolkit — el equipo no convergió a uno)
- Form libraries (react-hook-form vs formik vs nativo Server Actions — depende del caso)
- UI component libraries (shadcn/ui vs Radix vs MUI — depende del proyecto)
- i18n (next-intl vs next-i18next vs nativo — poca experiencia del equipo)

Estas decisiones se toman por proyecto y se documentan en el README del repo específico.
