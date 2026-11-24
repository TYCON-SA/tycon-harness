# GitLab como plataforma del equipo

Esta guía es el caso de GitLab para lo que los pasos del arnés dicen en neutro: «el pedido de trabajo», «el pedido de
cambio», «la CI» y «la plataforma del equipo». Vale para el GitLab público y para una instalación propia. El caso de
GitHub está en `guides/integrations/github-platform.md` y el de Azure DevOps en `guides/integrations/ado-projects.md`;
cómo se arma un conector, en `guides/integrations/platform-connectors.md`.

El conector vive en `integrations/gitlab/`. Habla con GitLab por el `glab` de la máquina.

---

## Qué es cada cosa en GitLab

| En los pasos del arnés | En GitLab |
|---|---|
| el pedido de trabajo de la historia | un issue del proyecto de historias |
| su tipo (historia, error) | una etiqueta `tipo:<Tipo>` |
| su estado | cerrado es el issue cerrado; si no, la etiqueta `estado:<estado>`, o «abierto» |
| las horas trabajadas | el tiempo trabajado del issue (su campo nativo) |
| la estimación | el tiempo estimado del issue (su campo nativo), en horas o en días enteros |
| el pedido de cambio | un merge request |
| que entre solo | «mergear cuando el pipeline dé verde», o la espera de los estados de commit de la punta |
| la CI | los estados de commit de la punta, de cada contexto el más nuevo; un trabajo que GitLab deja fallar y uno manual sin disparar no cuentan en contra |
| lo asignado | los issues y los merge requests abiertos, una fila por persona asignada |

Lo que un issue no tiene en todos los planes (la prioridad, un campo propio, el épico padre) no se carga en silencio: el
paso lo recibe como «no soportado» con su nombre. Una estimación en puntos, igual.

## Cómo se declara un repo

Un repo de producto de GitLab se declara en `team-repos.json`, en `merge_suites` o en `story_index`, con su plataforma,
su namespace y su nombre:

```json
{ "platform": "gitlab", "host": "gitlab.example.com", "namespace": "producto/plataforma", "repo": "servicio" }
```

- `namespace` es el grupo con todos sus subgrupos, separados por `/`.
- `host` es el servidor de una instalación propia, sin `https://` ni ruta. Un repo del GitLab público no lo lleva: el
  servidor lo pone el conector.
- Un repo declarado sin `host` y el mismo con `host` son dos entradas distintas: declaralo siempre de la misma forma.
- Un repo que no está declarado (pedido por su nombre, o como el proyecto de los pedidos de trabajo) va al GitLab
  público sólo si `team-repos.json` no declara ningún repo de GitLab con `host`. Si declara alguno, ese repo puede vivir
  en la instalación propia, y la operación contesta «sin plataforma» y pide declararlo con su `host`, en vez de mandar
  issues o pedidos al servidor público. Un repo que trae su `host` en la identidad va a ese servidor.
- Los repos del propio arnés (`public`, `profile`, `operations`, `maintainers`, `harness_copies`) y los de las
  herramientas de prueba (`stack.test_runners`) todavía no admiten GitLab: el archivo lo rechaza y dice dónde sí va.

Los pedidos de cambio y la CI de ese repo van por GitLab sin más. Lo demás (los pedidos de trabajo, lo asignado) lo
elige el perfil del equipo, `integrations.platform`: `"gitlab"` para todo, o por área
(`{ "default": "github", "workItems": "gitlab" }`). Para ver qué quedó elegido:
`node scripts/lib/platform/platform.js chosen`.

Por la línea de comandos, un repo se nombra por su ruta entera o por su identidad:
`node scripts/lib/platform/platform.js ci.read --repo producto/plataforma/servicio --args '{"branch":"main"}'`.

## Lo que necesita cada máquina

- `glab` instalado y con sesión en ese servidor (`glab auth login --hostname <servidor>`). Sin sesión, cada operación
  contesta «falta la credencial» con ese comando; sin `glab`, «no medido»; sin red, «red». Ninguna sigue como si no
  hubiera nada.
- `TYCON_GLAB_CMD` reemplaza al `glab` (un ejecutable, o un `.js` que corre con node): lo usan las pruebas.

## Dónde van los pedidos de trabajo

El repo de historias declara a dónde van sus issues en `.tycon/work-items.yaml`:

```yaml
repo: producto/plataforma/historias   # la ruta entera del proyecto de los issues
type: "Historia"                      # la etiqueta tipo:<Tipo> del pedido
state_active: "en curso"              # la etiqueta estado:<estado> al arrancar
default_tags: "tycon"
```

El servidor es el del repo de GitLab con esa ruta que declara `team-repos.json`. Si el archivo está y no se puede leer,
la operación contesta «no medido»: no manda nada al servidor público por las dudas.

## El remoto de un clon

GitLab no tiene un servidor único, así que un remoto se reconoce por lo que la organización declaró: el `origin` de un
clon es de GitLab si su servidor es el de algún repo de GitLab de `team-repos.json`, por SSH o por HTTPS. Un remoto de un
servidor que nadie declaró sigue siendo «de otro servidor»: ahí el arnés no abre pedidos de cambio. Un alias de ssh no
se resuelve: el remoto tiene que nombrar el servidor declarado. Si `team-repos.json` no se puede leer, no se sabe de
qué servidor es el remoto: con el merge por pedido (`merge.mode: pr`), el plan se detiene en vez de empujar directo.

## Cómo entra un pedido de cambio

1. El freno de publicación lee el título y el texto antes de que salgan: si frena, no sale nada.
2. Si ya hay un merge request abierto para el mismo par de ramas, se le cambian el título y el texto; si no, se crea. En
   los dos casos con el borrado de la rama que pidió quien lo abre.
3. Si choca con su destino, el resultado lo dice (`conflict`) y la entrada no se pide.
4. Con un pipeline corriendo en la punta, se pide «mergear cuando el pipeline dé verde».
5. Sin pipeline, se esperan los estados de commit de la punta y se mergea atado a esa punta. Un estado en rojo o un merge
   rechazado es un «no» con el número del pedido; estados que no terminan a tiempo son «no medido», nunca «entró».

Siempre con commit de merge, nunca aplastado.

Al mergear a la rama principal con el skill de merge, el plan de `merge-pr.js` trae para un repo de GitLab declarado
`host: "platform"` y `repo` con su identidad: ese `repo`, en JSON, es lo que va en el `--repo` del paso del pedido de
cambio. El arnés no lee qué controles exige la rama en GitLab: con la regla `automatico` de `merge_suites`, las suites
completas corren en la máquina antes de abrir el pedido.

## Las reglas que el agente ve

`integrations/gitlab/rules.md` tiene lo que `glab` no dice solo: que el servidor va siempre en la línea, que un pedido
sin pipeline se mergea en el acto, y que los estados de commit se leen antes de concluir. No van en el `CLAUDE.md` de
todas las sesiones: aparecen la primera vez que el agente usa `glab mr`, `glab ci`, `glab api` o `glab issue` en una
sesión, y sólo si la organización eligió GitLab para algo (`integrations/gitlab/notices.json`).

## Lo que todavía no atiende

- La cola (`queue.read`), los despliegues (`deployments.read`) y la regla de aprobación de una rama
  (`branch-rules.read`): el conector no las declara y la capa las contesta «no soportado».
- Los épicos y los merge trains, que son de los planes de pago.
- Votar un pedido de cambio registra sólo la aprobación; otro voto es «no soportado».
- Los procesos de la noche, el alta de una organización con su perfil en GitLab y el sitio de la organización no usan
  todavía repos de GitLab.

Las operaciones que sí atiende están en `integrations/gitlab/integration.json`.
