# Un solo vocabulario

Las guías en castellano dicen cada cosa con una sola palabra. Esta es la lista, y un control la cuida: un commit que
agrega una palabra de la columna «No se escribe» en la prosa de una guía no se crea.

## Las palabras

| Concepto | Se escribe | No se escribe |
|---|---|---|
| El pedido escrito, con criterios y pruebas | historia | `story`, `stories` |
| El agente que revisa el cambio | revisor | `advisor`, `advisors` |
| Una pasada del recorrido de una historia | ejecución | `corrida`, `corridas` |
| El producto | arnés | `harness` |
| El control de la CI que frena un merge | portón | `gate`, `gates` |
| Lo que git guarda de un repo | historial | `historia de git`, `historia del repo`, `historia de la rama` |

«historia» es sólo el pedido escrito. Lo que git guarda se dice «historial». Por eso el control cuenta esa fila con sus
frases de varias palabras, nunca con «historia» suelta.

## Lo que no cambia

Lo que lee la máquina queda como está:

- los nombres de comandos y skills (`tycon-pipeline`, `tycon-create-story`);
- las rutas de archivo (`guides/advisor-rules-catalog.md`), los ids de reglas (`ADVISORS-GATE`) y las claves de
  configuración;
- el paquete (`@tyconsa/harness`) y el repo (`tycon-harness`);
- el código entre acentos graves, los bloques de código y la dirección de los enlaces.

Tampoco cambian dos frases, que van como excepción en las reglas, cada una con su motivo:

- la frase que arranca el recorrido, `implementemos la story`, que la skill reconoce tal cual;
- el par que la portada presenta a propósito, `una historia (story)`.

## Lo que el control no mira

- **pipeline.** Tiene dos sentidos: el recorrido de una historia y el pipeline de la CI. Un control por palabra no los
  distingue, así que queda como está.
- **freno y control.** No son sinónimos. Un control mira; un freno es un control que frena. Se usan las dos.
- **puerta.** A veces nombra el portón de la CI, y a veces el freno de producción o un giro como «abrir la puerta a».
  El control no la cuenta. En la prosa nueva, para el portón de la CI se escribe «portón».
- **El inglés.** Se mide sólo la prosa en castellano. Un `.en.md`, el `README.md` y un `X.md` que tiene al lado su
  `X.es.md` son el inglés del par. Las `SKILL.md` tampoco se miden: son instrucciones para el agente.

## Cómo funciona el control

El control es `scripts/ci/vocabulary.js`, con sus reglas en `scripts/ci/vocabulary.json`. Corre en cada commit y mira
la prosa de `guides/`, `getting-started/`, `README.es.md`, `INDEX.md` e `INSTALL.md`.

El control informa y no frena: ni el commit ni el pedido quedan afuera por una palabra. Un sinónimo en una guía no
rompe nada.

Cada archivo tiene un techo: cuántas palabras por cambiar puede tener todavía. Un archivo nuevo nace con techo 0. Si un
archivo pasa su techo, el control dice el archivo, la línea, la palabra y la que va en su lugar. Si queda por debajo,
avisa el número que va en las reglas, para bajarlo en el mismo pedido.

Para ver cuánto queda en cada archivo:

```bash
node scripts/ci/vocabulary.js --measure
```

Si cambia una palabra de la lista, cambian esta tabla y `scripts/ci/vocabulary.json`, juntas: una prueba compara las
dos.
