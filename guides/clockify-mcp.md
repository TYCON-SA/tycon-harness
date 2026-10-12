# Clockify MCP Server

MCP server opcional para integrar Clockify (tracking de horas) con Claude Code. Permite que el agente liste workspaces/projects/tasks, consulte time entries, genere summary reports y administre tracking conversacional desde cualquier proyecto.

Implementación elegida: **[aslamanver/mcp_clockify](https://github.com/aslamanver/mcp_clockify)** — Node-based, distribución via npm, cobertura amplia de la API (time entries + projects + tasks + workspaces).

---

## Por qué es opcional (y por qué user-scope)

- **Opcional**: no todos los devs trackean en Clockify. La guía existe para los que sí.
- **User-scope** (no project-scope): se instala una vez por máquina y queda disponible en **todos** los proyectos. Tracking no es un detalle del proyecto sino del workflow personal del dev.
- **API key personal**: cada dev usa su propia key. No se commitea a ningún repo. Vive solo en `~/.claude.json` (mac/linux) o `%USERPROFILE%\.claude.json` (Windows) — gestionado por `claude mcp add`.

---

## Instalación (una vez por máquina)

### Opción A — Script automático (recomendado)

**macOS / Linux:**

```bash
bash ~/.claude/tycon-harness/scripts/setup/install-clockify-mcp.sh
```

**Windows (PowerShell):**

```powershell
pwsh ~\.claude\tycon-harness\scripts\setup\install-clockify-mcp.ps1
```

> Si tu execution policy lo bloquea, correlo así:
> ```powershell
> powershell -ExecutionPolicy Bypass -File ~\.claude\tycon-harness\scripts\setup\install-clockify-mcp.ps1
> ```

Los scripts:

1. Verifican que tengas `claude` y `npx` en PATH.
2. Te piden la API key con input enmascarado (no queda en history ni en pantalla).
3. Si ya existe el server (reinstalación), lo remueven primero.
4. Corren `claude mcp add` con scope `user`.
5. Verifican que el server quede como `✓ Connected`.

### Opción B — Comando manual

Si preferís ver lo que pasa o el script falla por alguna razón:

```bash
claude mcp add \
  --scope user \
  --env="CLOCKIFY_API_KEY=<TU_API_KEY>" \
  clockify \
  -- npx -y mcp_clockify@latest
```

**Gotcha importante:** `--env=KEY=VALUE` debe usar `=` y NO espacio. La flag `-e` / `--env` es variadic en `claude mcp add`, así que con espacio se traga el nombre del server (`clockify`) y falla con:

```
Invalid environment variable format: clockify
```

### Sacar tu API key

1. Loguearte a Clockify (https://clockify.me).
2. Esquina superior derecha → **Profile Settings**.
3. Tab **API**.
4. Click **Generate** (o copiar la existente si ya la habías generado).

La key es un string base64-ish de ~52 chars. Es **personal** — no la compartas, no la commiteas.

---

## Verificación

```bash
claude mcp list | grep clockify
```

Debería mostrar:

```
clockify: npx -y mcp_clockify@latest - ✓ Connected
```

Reiniciá tu sesión de Claude Code (cerrá y abrí el editor o el `claude` CLI). Los tools nuevos aparecen al arranque.

---

## Qué provee

Tools típicos (la lista exacta depende de la versión del package; correr `claude mcp list` con el server activo para ver los descriptos por el server):

- **Workspaces** — listar workspaces a los que pertenece tu usuario
- **Projects** — listar projects de un workspace, obtener detalles
- **Tasks** — listar tasks de un project
- **Time entries** — listar entries (con filtros de fecha/usuario/project), crear, editar, borrar
- **Summary reports** — totales agrupados por user/project/task para un rango de fechas

### Casos de uso típicos

- *"¿cuánto trackié esta semana en TotoraBackend?"*
- *"creá una entry de 2hs para `Story 13-1` hoy"*
- *"summary report del último sprint para todo el workspace"*
- *"qué projects tengo abiertos en Clockify"*

---

## Distribución team-wide

El comando es trivial, pero **la API key es personal**. Así está armado el flujo:

1. **Guía + scripts en este repo** (el arnés) — llegan automáticamente via el hook `SessionStart` que hace `git pull` en cada sesión nueva (ver `README.md` paso 4).
2. **Cada dev corre el script una sola vez** con su propia key.
3. **No hay storage centralizado de keys** — Vault/1Password sería overkill para un MCP opcional.

Por eso esta guía está bajo "Setup opcional" del README, no en el flujo de instalación obligatoria.

---

## Troubleshooting

**`claude mcp add` falla con `Invalid environment variable format: clockify`**

Usaste `-e CLOCKIFY_API_KEY=... clockify` con espacio. Corregir a `--env=CLOCKIFY_API_KEY=...` con `=`.

**El server aparece pero no como `✓ Connected`**

- Verificar que la key sea válida: pegar el comando de health check de Clockify (`curl -H "X-Api-Key: $KEY" https://api.clockify.me/api/v1/user`) — si devuelve 401, la key está mal.
- Mirar logs del server: `claude mcp get clockify` muestra la config; correr el command manual (`CLOCKIFY_API_KEY=... npx -y mcp_clockify@latest`) y ver el output stderr.

**Quiero rotar la key**

Solo reinstalar — el script es idempotente, remueve la config vieja antes de agregar la nueva.

```bash
bash ~/.claude/tycon-harness/scripts/setup/install-clockify-mcp.sh
```

**Quiero desinstalarlo**

```bash
claude mcp remove --scope user clockify
```

**Quiero usarlo solo en un proyecto puntual (no user-wide)**

Cambiar `--scope user` por `--scope project` en el comando manual. Eso lo escribe en `<repo>/.mcp.json` y queda commiteable — pero **no commitees la key en plano** (usar variable de entorno o secret manager del proyecto). Para casi todos los usos, `user` es lo correcto.

---

## Anti-patrones

- ❌ Commitear la API key en cualquier archivo del repo (incluso en un `.env.example` con la key real).
- ❌ Usar `--scope project` con la key inline. Si trackeo es del proyecto, usar variable de entorno y referenciarla con `$CLOCKIFY_API_KEY` (Claude Code resolverá la env var al arrancar el server).
- ❌ Compartir tu key con otro dev. Cada uno genera la suya — Clockify trackea quién creó cada entry.
- ❌ Asumir que el server está disponible en todas las máquinas del equipo. Es **opcional**; tu workflow no debe romper si el dev de al lado no lo instaló.

---

## Changelog

- 2026-05-12 — Versión inicial. Implementación: `aslamanver/mcp_clockify` (npm). User-scope. Scripts `.sh` + `.ps1` para mac/linux y Windows.

> **Multi-modelo**: este setup es el CANÓNICO para las dos herramientas — registrás el MCP del lado Claude y el deployer del lado Codex lo traduce solo (`[mcp_servers]` de `~/.codex/config.toml`; la API key viaja por el AMBIENTE, jamás al archivo). No lo registres dos veces. Ojo bajo Codex: los nombres de las tools llevan guion BAJO (saneo medido — ver la tabla de nombres del lado Codex).
