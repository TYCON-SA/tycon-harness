# La constitución del arnés

Esta regla no se negocia. Toda historia que agregue o toque una integración la cumple. Una propuesta que no la cumple se
corrige antes de implementarla.

> **El núcleo sabe qué hacer, el perfil del equipo dice con qué herramientas, y la máquina de cada dev guarda sus
> credenciales. El núcleo no nombra ninguna herramienta en particular.**

## Las tres capas

| Capa | Qué guarda | Quién la cambia | Avisos | Registro de horas | Índice de código | Revisores propios |
|---|---|---|---|---|---|---|
| **Núcleo** (el arnés publicado) | Qué hacer y cuándo: «avisar a la persona», «registrar el tiempo de la corrida», «preguntarle al índice antes de buscar», «correr los revisores que el equipo activó». Los controles, los pasos y el contrato que cumple cada herramienta. | Quien mantiene el arnés, por un pedido al repo público | Que hay que avisar, cuándo y con qué texto | Que una corrida tiene horas, cuándo arrancan y cuándo cierran | Que antes de buscar a mano se consulta el índice, si hay uno | Cómo se carga un paquete de revisores y cuándo corre cada uno |
| **Perfil del equipo** (editable desde el sitio de la organización) | Con qué herramientas trabaja el equipo: cuál, prendida o apagada, para qué repos | Quien mantiene el perfil, desde la pestaña Configuración del sitio | Por qué canal salen los avisos, o ninguno | En qué herramienta se registran las horas, o en ninguna | Si el equipo usa un índice de código, y cuál | Qué paquetes de revisores activa la organización |
| **Máquina del dev** | Las credenciales y lo que es de cada persona: llaves, sesiones, identificadores propios | Cada dev, en su máquina, nunca en un repo | La llave del canal y a quién se le escribe | La llave de la herramienta de horas | Lo que necesite el índice para correr localmente | Nada: los revisores no llevan credenciales |

Cómo se lee:

- El núcleo no dice «mandá esto por Telegram» ni «abrí una entrada en la herramienta X». Dice «avisá» o «registrá el tiempo», y
  el perfil dice con qué. Si el perfil no nombra ninguna herramienta, el núcleo sigue andando y la integración queda
  apagada.
- El perfil no guarda una llave. Una llave en el perfil viaja a todas las máquinas del equipo y queda en la historia del
  repo.
- La máquina no decide qué herramienta usa el equipo. Si un dev tiene la llave de una herramienta que el perfil no
  activó, esa integración no corre.

## Lo que hoy no la cumple

- **El registro de horas (ya cumplido).** El núcleo no nombra ninguna herramienta de horas: el perfil elige cuál
  (ninguna u otra integración) y el núcleo sólo pide «registrá el tiempo». La skill y los hooks de cada herramienta
  viven en su integración.
- **Los avisos.** El núcleo nombra a Telegram: el aviso cuando una corrida espera a una persona, el aviso de la noche
  sobre la evidencia y la instalación. El mismo cambio en curso los saca: la organización elige desde el sitio uno o
  más canales, todo aviso pasa por un solo camino, y las credenciales quedan en la máquina de cada dev (o, para los
  avisos de la noche, en los secretos del servidor).

## Cómo se aplica en una historia

1. **Al escribirla:** si la historia agrega o toca una integración, dice en qué capa queda cada parte. Lo que el núcleo
   hace va con un verbo genérico («avisar», «registrar horas», «indexar»), nunca con el nombre de una herramienta.
2. **Al revisarla:** un nombre de herramienta nuevo en el código del núcleo es un hallazgo.
3. **Al configurar:** la herramienta se elige desde el sitio de la organización (Configuración), y la credencial la carga
   cada dev en su máquina.
