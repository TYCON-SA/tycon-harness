---
name: bizuit-sdk-integration
description: Bizuit BPM SDK integration patterns for TypeScript/React applications. Use when asked about "Bizuit SDK", "BizuitSDK usage", "how to call Bizuit processes", "Bizuit authentication", "multi-token authentication", "Bizuit catalog API", "Bizuit plugin API", or "integrating with Bizuit BPM".
metadata:
  author: tycon-team
  version: "1.0.0"
  last-updated: "2026-01-25"
  changelog: |
    v1.0.0 - Initial version extracted from a product's custom forms
---

# Bizuit BPM SDK Integration

Complete guide for integrating TypeScript/React applications with Bizuit BPM platform using `@tyconsa/bizuit-form-sdk`.

## Core Principles

1. **Multi-Token Authentication** - SDK uses `Basic` tokens, Plugin API uses `Bearer`
2. **Context-Based State** - Use React Context API for SDK instance and auth state
3. **Process-Driven Workflows** - All business logic via BPM processes
4. **Type Safety** - Full TypeScript support with defined interfaces
5. **Error Handling** - Standardized error responses from SDK

## When to Use This Skill

Use this skill when you need to:
- Initialize BizuitSDK in React applications
- Authenticate users with Bizuit BPM
- Call Bizuit BPM processes (startProcess)
- Fetch catalog data (parameters by type)
- Integrate with Plugin REST API endpoints
- Handle multi-token authentication (Basic vs Bearer)
- Manage SDK state with React Context

## Quick Reference

### SDK Initialization

```typescript
import { BizuitSDK } from '@tyconsa/bizuit-form-sdk';

// Configuration
const SDK_CONFIG = {
  defaultApiUrl: 'https://test.bizuit.example/acmeBizuitDashboardapi/api/',
  processName: 'DEMO_SiguienteRuta',
  pluginName: 'acmebackend'
};

// Initialize SDK
const sdk = useMemo(() => new BizuitSDK({
  apiUrl: SDK_CONFIG.defaultApiUrl
}), []);
```

### Authentication

```typescript
// Login
const loginResult = await sdk.forms.login({
  username: 'admin',
  password: 'admin123',
  apiUrl: SDK_CONFIG.defaultApiUrl
});

// Extract token (Basic format)
const authToken = loginResult.userInfo.authorization; // "Basic ..."

// Convert to Bearer for Plugin API
function getBearerAuthHeader(authToken: string): string {
  const tokenValue = authToken.replace(/^Basic\s+/i, '');
  return `Bearer ${tokenValue}`;
}
```

### Start Process (Common Pattern)

```typescript
const result = await sdk.forms.startProcess({
  processName: 'DEMO_SiguienteRuta',
  additionalParameters: sdk.forms.createParameters([
    { name: 'pIdSucursal', value: sucursalId },
    { name: 'pEstado', value: 'PENDIENTES' }
  ]),
  token: authToken
});

// Access result
const rutas = result.result?.instances?.[0]?.Rutas || [];
```

### Fetch Catalog Parameters

```typescript
const tiposEntrega = await sdk.forms.fetchParametersByType({
  typeName: 'TipoEntrega',
  token: authToken
});

// Result: Array of { id, nombre, ... }
```

### Plugin REST API Call

```typescript
const response = await fetch(`${pluginApiUrl}/rutas/siguiente`, {
  method: 'POST',
  headers: {
    'Authorization': getBearerAuthHeader(authToken),
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ idSucursal, estado: 'PENDIENTES' })
});

const data = await response.json();
```

## Architecture Patterns

### 1. React Context for SDK State

**Setup (AuthContext.tsx):**
```typescript
interface AuthContextType {
  sdk: BizuitSDK | null;
  authToken: string | null;
  userName: string | null;
  isAuthenticated: boolean;
  idSucursal: string | null;
  roles: string[];
  pluginApiUrl: string;
  // ... other auth state
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children, dashboardParams }: AuthProviderProps) {
  const { sdk, authToken, isAuthenticated, /* ... */ } = useAuth(dashboardParams);

  return (
    <AuthContext.Provider value={{ sdk, authToken, /* ... */ }}>
      {children}
    </AuthContext.Provider>
  );
}

// Hook for consuming context
export function useAuthContext() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuthContext must be used within AuthProvider');
  }
  return context;
}
```

**Usage in Components:**
```typescript
function MyComponent() {
  const { sdk, authToken, pluginApiUrl } = useAuthContext();

  const handleAction = async () => {
    const result = await sdk.forms.startProcess({
      processName: 'MyProcess',
      token: authToken
      // ...
    });
  };
}
```

### 2. useAuth Hook Pattern

**Custom hook for authentication logic:**
```typescript
function useAuth(dashboardParams?: DashboardParameters): UseAuthResult {
  const [sdk] = useState(() => new BizuitSDK({ apiUrl }));
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    const authenticate = async () => {
      try {
        // Dev mode: use credentials
        if (dashboardParams?.devUsername) {
          const result = await sdk.forms.login({
            username: dashboardParams.devUsername,
            password: dashboardParams.devPassword!,
            apiUrl
          });
          setAuthToken(result.userInfo.authorization);
          setUserName(result.userInfo.userName);
          setIsAuthenticated(true);
        }
        // Prod mode: use token from Dashboard
        else if (dashboardParams?.token) {
          setAuthToken(dashboardParams.token);
          setUserName(dashboardParams.userName || 'Usuario');
          setIsAuthenticated(true);
        }
      } catch (error) {
        console.error('Authentication failed:', error);
        setIsAuthenticated(false);
      }
    };

    authenticate();
  }, [sdk, dashboardParams]);

  return { sdk, authToken, userName, isAuthenticated };
}
```

### 3. Catalog Context Pattern

**Centralized catalog loading:**
```typescript
interface ListasContextType {
  tiposEntrega: TipoEntrega[];
  estadosRuta: EstadoRuta[];
  tiposAviso: TipoAviso[];
  // ... other catalogs
}

export function ListasProvider({ children }: ListasProviderProps) {
  const { sdk, authToken } = useAuthContext();
  const [catalogs, setCatalogs] = useState<ListasContextType>({
    tiposEntrega: [],
    estadosRuta: [],
    // ...
  });

  useEffect(() => {
    if (!sdk || !authToken) return;

    const loadCatalogs = async () => {
      try {
        const [tiposEntrega, estadosRuta, tiposAviso] = await Promise.all([
          sdk.forms.fetchParametersByType({ typeName: 'TipoEntrega', token: authToken }),
          sdk.forms.fetchParametersByType({ typeName: 'EstadoRuta', token: authToken }),
          sdk.forms.fetchParametersByType({ typeName: 'TipoAviso', token: authToken })
        ]);

        setCatalogs({
          tiposEntrega,
          estadosRuta,
          tiposAviso
        });
      } catch (error) {
        console.error('Failed to load catalogs:', error);
      }
    };

    loadCatalogs();
  }, [sdk, authToken]);

  return (
    <ListasContext.Provider value={catalogs}>
      {children}
    </ListasContext.Provider>
  );
}
```

## Multi-Token Authentication

### Understanding the Two Token Types

**1. SDK Token (Basic):**
- Format: `Basic {base64EncodedCredentials}`
- Used for: BPM process calls (`sdk.forms.startProcess`, `sdk.forms.fetchParametersByType`)
- Source: `loginResult.userInfo.authorization`

**2. Plugin API Token (Bearer):**
- Format: `Bearer {tokenValue}`
- Used for: REST API endpoints (`/api/plugins/{pluginName}/*`)
- Conversion: Strip "Basic " prefix, prepend "Bearer "

### Token Conversion Utility

```typescript
/**
 * Convert Basic token to Bearer for Plugin API
 * @param authToken - Basic token from SDK login ("Basic ...")
 * @returns Bearer token for REST API ("Bearer ...")
 */
export function getBearerAuthHeader(authToken: string): string {
  const tokenValue = authToken.replace(/^Basic\s+/i, '');
  return `Bearer ${tokenValue}`;
}
```

### Example Usage

```typescript
// 1. Authenticate with SDK
const loginResult = await sdk.forms.login({ username, password, apiUrl });
const authToken = loginResult.userInfo.authorization; // "Basic ABC123..."

// 2. Call BPM process (use Basic token directly)
const processResult = await sdk.forms.startProcess({
  processName: 'MyProcess',
  token: authToken, // "Basic ABC123..."
  additionalParameters: sdk.forms.createParameters([])
});

// 3. Call Plugin REST API (convert to Bearer)
const response = await fetch(`${pluginApiUrl}/rutas/siguiente`, {
  headers: {
    'Authorization': getBearerAuthHeader(authToken), // "Bearer ABC123..."
    'Content-Type': 'application/json'
  }
});
```

## Common Workflows

### Workflow 1: Load Initial Data

```typescript
async function loadRutas(idSucursal: string) {
  const result = await sdk.forms.startProcess({
    processName: 'DEMO_SiguienteRuta',
    additionalParameters: sdk.forms.createParameters([
      { name: 'pIdSucursal', value: idSucursal },
      { name: 'pEstado', value: 'PENDIENTES' }
    ]),
    token: authToken
  });

  const rutas = result.result?.instances?.[0]?.Rutas || [];
  return rutas;
}
```

### Workflow 2: Submit Action

```typescript
async function anotarEntrega(entrega: EntregaData) {
  const result = await sdk.forms.startProcess({
    processName: 'DEMO_AnotarEntrega',
    additionalParameters: sdk.forms.createParameters([
      { name: 'pIdPedido', value: entrega.idPedido },
      { name: 'pIdTipoEntrega', value: entrega.idTipoEntrega },
      { name: 'pObservaciones', value: entrega.observaciones },
      { name: 'pIdEstadoRuta', value: entrega.idEstadoRuta }
    ]),
    token: authToken
  });

  if (result.result?.instances?.[0]?.Success) {
    return result.result.instances[0];
  } else {
    throw new Error(result.result?.instances?.[0]?.Message || 'Error al anotar la entrega');
  }
}
```

### Workflow 3: Confirm/Cancel an Order

```typescript
async function confirmarPedido(idPedido: string, idSucursal: string) {
  const result = await sdk.forms.startProcess({
    processName: 'DEMO_ConfirmarPedido',
    additionalParameters: sdk.forms.createParameters([
      { name: 'pIdPedido', value: idPedido },
      { name: 'pIdSucursal', value: idSucursal }
    ]),
    token: authToken
  });

  return result.result?.instances?.[0];
}

async function anularPedido(idPedido: string, idMotivo: number, descripcion: string) {
  const result = await sdk.forms.startProcess({
    processName: 'DEMO_AnularPedido',
    additionalParameters: sdk.forms.createParameters([
      { name: 'pIdPedido', value: idPedido },
      { name: 'pIdMotivo', value: idMotivo },
      { name: 'pDescripcion', value: descripcion }
    ]),
    token: authToken
  });

  return result.result?.instances?.[0];
}
```

## Plugin REST API Patterns

### Common Endpoints

**1. POST /rutas/siguiente**
```typescript
const response = await fetch(`${pluginApiUrl}/rutas/siguiente`, {
  method: 'POST',
  headers: {
    'Authorization': getBearerAuthHeader(authToken),
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ idSucursal, estado: 'PENDIENTES' })
});
const rutas = await response.json();
```

**2. POST /entregas**
```typescript
const response = await fetch(`${pluginApiUrl}/entregas`, {
  method: 'POST',
  headers: {
    'Authorization': getBearerAuthHeader(authToken),
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    idPedido: '123',
    idTipoEntrega: 3,
    observaciones: 'Entregado en mostrador'
  })
});
const entrega = await response.json();
```

**3. GET /avisos/historial**
```typescript
const params = new URLSearchParams({
  idPedido: '123',
  desde: '2026-01-01'
});

const response = await fetch(`${pluginApiUrl}/avisos/historial?${params}`, {
  headers: {
    'Authorization': getBearerAuthHeader(authToken)
  }
});
const avisos = await response.json();
```

**4. GET /parameters (Catalog)**
```typescript
const params = new URLSearchParams({ typeName: 'TipoEntrega' });

const response = await fetch(`${pluginApiUrl}/parameters?${params}`, {
  headers: {
    'Authorization': getBearerAuthHeader(authToken)
  }
});
const tipos = await response.json();
```

## Error Handling

### SDK Error Pattern

```typescript
try {
  const result = await sdk.forms.startProcess({
    processName: 'MyProcess',
    token: authToken,
    additionalParameters: sdk.forms.createParameters([])
  });

  // Check if process returned error
  if (!result.result?.instances?.[0]?.Success) {
    const errorMsg = result.result?.instances?.[0]?.Message || 'Error desconocido';
    throw new Error(errorMsg);
  }

  // Process successful result
  const data = result.result.instances[0];
  return data;

} catch (error) {
  console.error('Process failed:', error);
  throw error;
}
```

### REST API Error Pattern

```typescript
try {
  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return data;

} catch (error) {
  console.error('API call failed:', error);
  throw error;
}
```

## Configuration Best Practices

### Centralized Config

```typescript
// config/sdk.config.ts
export const SDK_CONFIG = {
  defaultApiUrl: 'https://test.bizuit.example/acmeBizuitDashboardapi/api/',
  processNames: {
    siguienteRuta: 'DEMO_SiguienteRuta',
    anotarEntrega: 'DEMO_AnotarEntrega',
    confirmarPedido: 'DEMO_ConfirmarPedido',
    anularPedido: 'DEMO_AnularPedido'
  },
  pluginName: 'acmebackend',
  catalogTypes: {
    tipoEntrega: 'TipoEntrega',
    estadoRuta: 'EstadoRuta',
    tipoAviso: 'TipoAviso'
  }
};
```

### Environment-Based URLs

```typescript
const getApiUrl = () => {
  if (dashboardParams?.apiUrl) return dashboardParams.apiUrl;
  if (dashboardParams?.devApiUrl) return dashboardParams.devApiUrl;
  return SDK_CONFIG.defaultApiUrl;
};

const getPluginApiUrl = () => {
  if (dashboardParams?.pluginApiUrl) return dashboardParams.pluginApiUrl;
  return 'http://localhost:8000/api/plugins/acmebackend';
};
```

## Common Mistakes

### ❌ Mistake 1: Using Basic token for Plugin API

```typescript
// WRONG - Plugin API requires Bearer token
const response = await fetch(`${pluginApiUrl}/rutas`, {
  headers: {
    'Authorization': authToken // "Basic ABC123..." - WRONG!
  }
});
```

✅ **Correct:**
```typescript
const response = await fetch(`${pluginApiUrl}/rutas`, {
  headers: {
    'Authorization': getBearerAuthHeader(authToken) // "Bearer ABC123..."
  }
});
```

---

### ❌ Mistake 2: Not checking process success

```typescript
// WRONG - Assumes process always succeeds
const result = await sdk.forms.startProcess({ ... });
const data = result.result.instances[0].Rutas; // Can be undefined!
```

✅ **Correct:**
```typescript
const result = await sdk.forms.startProcess({ ... });
if (!result.result?.instances?.[0]?.Success) {
  throw new Error(result.result?.instances?.[0]?.Message || 'Process failed');
}
const data = result.result.instances[0].Rutas;
```

---

### ❌ Mistake 3: Creating SDK instance multiple times

```typescript
// WRONG - Creates new SDK on every render
function MyComponent() {
  const sdk = new BizuitSDK({ apiUrl }); // BAD!
}
```

✅ **Correct:**
```typescript
function MyComponent() {
  const sdk = useMemo(() => new BizuitSDK({ apiUrl }), []); // Good
  // Or use SDK from AuthContext
  const { sdk } = useAuthContext(); // Better
}
```

## TypeScript Types

### Core Interfaces

```typescript
interface DashboardParameters {
  token?: string;
  userName?: string;
  instanceId?: string;
  apiUrl?: string;
  devUsername?: string;
  devPassword?: string;
  devApiUrl?: string;
  pluginApiUrl?: string;
}

interface LoginResult {
  userInfo: {
    authorization: string; // "Basic ..."
    userName: string;
    roles: string[];
  };
}

interface ProcessResult {
  result?: {
    instances?: Array<{
      Success?: boolean;
      Message?: string;
      [key: string]: any;
    }>;
  };
}

interface CatalogParameter {
  id: number;
  nombre: string;
  descripcion?: string;
  valor?: string;
}
```

## Summary

**Key Takeaways:**
- Use React Context for SDK state management
- Understand multi-token authentication (Basic for SDK, Bearer for REST API)
- Always check process Success before accessing result data
- Centralize SDK configuration in config files
- Use TypeScript types for type safety
