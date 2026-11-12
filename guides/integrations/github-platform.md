# GitHub como plataforma del equipo

Esta guía es el caso de GitHub para lo que los pasos del arnés dicen en neutro: «el pedido de trabajo», «el pedido de
cambio», «la CI» y «la plataforma del equipo». El de Azure DevOps está en `guides/integrations/ado-projects.md` y sus
vecinas `ado-*`; cómo se arma un conector, en `guides/integrations/platform-connectors.md`.

El conector vive en `integrations/github/`. Habla con GitHub por el `gh` de la máquina.

---

## Qué es cada cosa en GitHub

| En los pasos del arnés | En GitHub |
|---|---|
| el pedido de trabajo de la historia | un issue del repo de historias |
| su tipo (historia, error) | una etiqueta `tipo:<Tipo>` |
| su estado | cerrado es el issue cerrado; si no, la etiqueta `estado:<estado>`, o «abierto» |
| las horas trabajadas | un comentario de formato fijo, «Horas completadas: N h» (un issue no tiene ese campo) |
| la estimación | el campo numérico de un proyecto de GitHub, o un comentario «Estimación: 16 h (historia, versión 2)» |
| el pedido de cambio | un pull request |
| que entre solo | el auto-merge, o la cola de merge si la rama tiene una |
| la CI | los controles de la punta: los check-runs y los estados de commit, de cada uno el más nuevo |
| la cola | las ejecuciones de Actions esperando o en curso en los repos del equipo |

Lo que un issue no tiene (la prioridad, un campo propio, el Epic padre) no se carga en silencio: el paso lo recibe como
«no soportado» con su nombre.

## Cómo se elige

- **Los repos:** cada repo de GitHub se declara en `team-repos.json` con su plataforma. Los pedidos de cambio y la CI de
  ese repo van por GitHub sin más.
- **Lo demás** (los pedidos de trabajo, la cola, los despliegues) lo elige el perfil del equipo,
  `integrations.platform`: `"github"` para todo, o por área (`{ "default": "github", "workItems": "github" }`).
- Para ver qué quedó elegido: `node scripts/lib/platform/platform.js chosen`.

## Lo que necesita cada máquina

- `gh` instalado y con sesión (`gh auth login`), o la variable `GH_TOKEN`. Sin eso, cada operación contesta «falta la
  credencial» con el comando para cargarla; nunca sigue como si no hubiera nada.
- El permiso de lectura del repo del equipo es otro: `github.token`, que cada persona carga con
  `harness.js config set github.token`. Nunca va al perfil ni a un archivo versionado.
- `TYCON_GH_CMD` reemplaza al `gh` (un ejecutable, o un `.js` que corre con node): lo usan las pruebas.

## Dónde van los pedidos de trabajo

El repo de historias declara a dónde van sus issues en `.tycon/work-items.yaml`:

```yaml
repo: acme/historias          # dueño/nombre del repo de los issues
type: "Historia"              # la etiqueta tipo:<Tipo> del pedido
state_active: "en curso"      # la etiqueta estado:<estado> al arrancar
default_tags: "tycon"
github:
  project: { owner: acme, number: 3, field: "Estimación" }   # opcional: el campo numérico que recibe la estimación
```

Sin `github.project`, o si el proyecto no se puede usar (sin permiso, el proyecto o el campo no existen), la estimación
va como comentario y el resultado dice por qué.

## Cómo entra un pedido de cambio

1. El freno de publicación lee el pedido antes de que salga: si frena, no sale nada.
2. Si ya hay uno abierto para el mismo par de ramas, se le cambian el título y el cuerpo; si no, se crea.
3. Si el repo permite la entrada automática, se la pide y se vuelve a leer el pedido.
4. Si no quedó puesta, se esperan los controles de la punta y se mergea con un commit de merge atado a esa punta. Un
   control en rojo, un choque o un merge rechazado es un «no» con el número del pedido; controles que no terminan a
   tiempo son «no medido», nunca «entró».

La rama no se borra desde el arnés: lo decide la regla del repo («borrar la rama al mergear»).

## Las reglas que el agente ve

`integrations/github/rules.md` tiene lo que `gh` no dice solo: que la cola de merge esconde el auto-merge, que
`gh pr checks` va antes de concluir, y la identidad noreply en las copias de prueba. No van en el `CLAUDE.md` de todas
las sesiones: aparecen la primera vez que el agente usa `gh pr`, `gh run`, `gh api` o `gh issue` en una sesión, y sólo
si la organización eligió GitHub para algo (`integrations/github/notices.json`).

## Lo que todavía no atiende

Votar un pedido de cambio (`change-request.vote`) no está: el conector lo contesta «no soportado». Las operaciones que
sí atiende están en `integrations/github/integration.json`.
