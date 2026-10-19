# Paquete de ejemplo: Svelte y FastAPI

Un paquete de revisores para copiar, no para usar tal cual. El arnés no lo instala ni lo activa: vive fuera de `packs/`,
que es donde se buscan los paquetes.

| Archivo | Qué es | ¿Va al perfil del equipo? |
|---|---|---|
| `pack.json` | el manifiesto: qué revisores trae y cuándo corre cada uno | sí |
| `agents/example-svelte-reviewer.md` | revisor de componentes Svelte: `{@html}` sin limpiar (SVELTE-C1), suscripción sin cancelar (SVELTE-W1) | sí |
| `agents/example-fastapi-reviewer.md` | revisor de endpoints FastAPI: cuerpo sin modelo que lo valide (FASTAPI-C1), llamada bloqueante en `async def` (FASTAPI-W1) | sí |
| `exam/<revisor>.json` | los casos del examen: por cada regla, uno que la tiene que marcar y otro que no | no: se quedan donde armás y examinás el paquete |

Cómo copiarlo, activarlo, ver cuándo corre y examinar sus revisores: [guides/reviewer-packs.md](../../../guides/reviewer-packs.md)
([English](../../../guides/reviewer-packs.en.md)).
