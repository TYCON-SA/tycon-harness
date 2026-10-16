# Arnés TYCON para Claude Code y Codex

[English](README.md) · Castellano

**Un ciclo de desarrollo con IA (AI SDLC), de la spec a producción y después**, para Claude Code y Codex.

1. **Spec:** con el agente escribís la story del cambio: qué hay que hacer y cómo se prueba. Para un ajuste chico
   alcanza con pedirlo con tus palabras.
2. **Código:** el agente arma el plan, espera tu visto bueno y escribe el código y las pruebas.
3. **Revisión:** revisores especializados (seguridad, convenciones, cobertura) miran el cambio antes del commit.
4. **Entrega:** el commit y el merge pasan por controles. Para plugins de BIZUIT trae los guiones que despliegan a
   pruebas y a producción.
5. **Después:** cada merge a main deja su archivo de métricas. El tablero del ciclo y los procesos de cada noche
   (dependencias vulnerables, poda de reglas) hoy corren sólo en TYCON y se están publicando.

**Se vigila a sí mismo.** Un banco de pruebas comprueba, en cada cambio al arnés, que cada control siga frenando lo que
dice. Si lo prendés, además observa tus sesiones y propone reglas nuevas, que vos aprobás.

Con el perfil completo, los controles frenan, no sólo avisan: no depende de que el modelo se acuerde de las reglas. La
mayoría nació de un incidente real.

**Cada organización pone lo suyo.** Sus revisores, sus skills y su configuración viajan en el perfil de su equipo.
TYCON trae los suyos para plugins de BIZUIT.

## Antes de instalar: qué cambia en tu máquina

Si instalás con Claude, como dice más abajo, queda el perfil completo (`full`); el comando a mano te pregunta cuál
querés. El completo cambia cosas en todos tus proyectos, no sólo en uno:

- Claude te contesta en castellano, corto y con la conclusión primero.
- En un repo que trabaja con stories, Claude no edita código sin pasar por el proceso de stories del arnés.
- Git pasa a usar una carpeta global para sus controles al commitear (`core.hooksPath`). Desde ahí, git deja de correr
  los controles propios de cada repo, los de `.git/hooks/`. La instalación la configura sólo si git no tiene ninguna, y
  el plan te lo dice antes de tu «sí»; si ya tenés otra, no la toca.
- Una vez por día lee el historial de git de tus repos de proyectos (encuentra su carpeta por dónde usás Claude Code). Lo que anota queda en tu máquina.
- Claude Code guarda tus conversaciones un año.

Si no querés esto, pedí el perfil mínimo (`minimal`). Trae las guías, los revisores y el proceso de stories. No cambia
cómo te contesta Claude ni toca git. Deja un solo freno: el de comandos destructivos.
Para sacar el arnés, `harness.js uninstall --dry-run` muestra qué quitaría, y `harness.js uninstall --yes` lo quita.

## Qué necesitás

- Claude Code, instalado y con tu sesión iniciada.
- Windows 11 con PowerShell 7, o Mac. En Linux o en WSL, se instala a mano (está en la «Referencia»).
- Node 20 o posterior y `tar`. En Mac, además, Python 3 y Homebrew. Git **no** hace falta para usar el arnés: se baja
  como archivos, no se clona. Tampoco hace falta una cuenta de GitHub: este repo es público.
- Tu Node hace falta para instalar. Después el arnés baja su propio Node 24 (unos 50 MB, de nodejs.org) y sus hooks
  corren con él; tus proyectos siguen con tu Node, que no se toca. Se apaga con `TYCON_HARNESS_NODE=0`.
- Para programar extensiones de BIZUIT, el SDK de .NET de tu plugin. Sin él, la implementación frena al compilar.

Si te falta algo, Claude te dice qué instalar y cómo.

## Instalar con Claude Code

Es el camino recomendado y lleva unos 10 minutos. Claude corre casi todos los comandos; la bajada y la instalación
corren en tu propia terminal.

1. Abrí las instrucciones de tu sistema: [Windows](getting-started/windows.md), [Mac](getting-started/mac.md) o [Linux](getting-started/linux.md).
2. Copiá el bloque entero de la «Parte 1». Abrí Claude Code en cualquier carpeta y pegalo en una conversación nueva.
3. Claude te da las líneas que bajan el guion de instalación, lo muestran y lo corren: pegalas en tu propia terminal,
   así leés el guion antes de correrlo. Nada te pide iniciar sesión: el arnés nunca abre un navegador.
4. Claude te muestra el plan de instalación y espera tu «sí». El plan dice si va a configurar `core.hooksPath`.
5. Al final te arma un resumen que termina en «OK» o «NO OK». Cerrá Claude Code y abrilo de nuevo.

Si en el camino instalás una herramienta, Claude te pide cerrar y abrir la terminal y Claude Code. Si el resumen dice
«NO OK», guardalo: es lo que hay que mostrar al pedir ayuda.

Próximamente: una sola línea de terminal, igual en Windows y en Mac, con el mismo plan y el mismo «sí»: `npx @tycon-sa/harness@latest`. Todavía no está publicada: por ahora, los pasos de arriba.

El arnés queda en `~/.tycon/harness`, como archivos bajados (sin git). `~/.claude/tycon-harness` es un acceso directo a
esa misma carpeta, y es el que usan los comandos de esta página. No borres ni muevas esa carpeta: Claude Code lo
usa desde ahí, y se actualiza solo en ese lugar. Usar el arnés nunca necesita un clon de este repo.

**Perfil mínimo.** Al pegar el bloque, escribí arriba «quiero el perfil mínimo». Claude instala `minimal` y no toca
`core.hooksPath`.

## Empezar a trabajar

1. Cerrá Claude Code y abrilo de nuevo en la carpeta del repo de tu extensión: las reglas entran al abrirlo.
2. Pedí una story: «creá una story con `tycon-create-story` para agregar un filtro por fecha». Leela y ajustala.
3. Pedí «implementemos la story» con la ruta del archivo. Esa frase va en castellano.
4. La primera vez, Claude Code te pide permiso para leer la carpeta del arnés. Se acepta una vez.
5. Claude te muestra el plan, espera tu visto bueno, programa y corre las pruebas y los revisores.
6. Deja el commit preparado: nunca commitea ni sube cambios sin tu permiso.

Si algo no anda, escribí `/tycon-harness` en Claude Code (qué versión tenés, si está bien instalado y si hay una nueva), o corré `node ~/.claude/tycon-harness/scripts/setup/harness.js doctor`, que dice qué falta. Ninguno de los dos toca nada.

## Para una organización

**Primero probalo solo.** Instalalo en tu máquina como dice arriba: no hace falta nada de tu organización. Si te sirve,
se arma para el equipo con dos repos de la organización, que sólo ve tu equipo, además de éste, que es el mismo para
todos:

| Repo | Qué guarda | ¿Llega a cada máquina? |
|---|---|---|
| Éste (público) | el arnés | Sí |
| El **perfil del equipo** (por ejemplo `harness-team-profile`) | la configuración que comparte el equipo y la lista de dónde vive cada repo de la organización (`team-repos.json`) | Sí, a cada máquina que instala con `--team` |
| Las **operaciones del equipo** (por ejemplo `harness-team-operations`) | lo que corre de noche para la organización (dependencias, tablero, retrospectivas) y a quién se le asignan sus avisos (`operations.json`) | No: lo leen sólo esos procesos |

Un ejemplo: en ACME, Pedro administra y Juan programa.

1. Pedro crea los dos repos de ACME, en su Azure DevOps o en su GitHub, con acceso sólo para el equipo. Para el perfil
   puede partir de [un perfil de ejemplo](https://github.com/TYCON-SA/harness-team-profile-example), listo para copiar.
2. Pedro corre `node ~/.claude/tycon-harness/scripts/setup/harness.js team-config`. Se abre una página en su máquina,
   sin nada en internet, donde declara dónde vive cada repo y a quién se le asignan los avisos. La página revisa lo que
   escribe, lo guarda en el repo que corresponde y le ofrece el pull request. Cuando ACME tiene su sitio de la
   organización desplegado, lo mismo se hace desde su pestaña **Configuración** (sólo para los que mantienen): valida
   con los mismos lectores y propone cada cambio con un pull request, nunca escribe `main`. Mientras tanto, la página
   local sigue sirviendo.
3. Juan instala con `--team` y el perfil: `harness.js install --version latest --team acme/harness-team-profile` si está
   en GitHub, o con la dirección del repo si está en Azure DevOps. Desde ahí, cada actualización le trae también lo del
   equipo.

Cómo se extiende el arnés para tu organización —las capas, la página de configuración y un recorrido de ejemplo— en un
[mapa interactivo](https://www.bizuit.com/sdd-harness/more/mapa-del-arnes.html).

**Los procesos de la noche.** En Azure DevOps, la revisión de dependencias, las métricas del ciclo y el tablero corren en
tu organización con tres pipelines modelo y tu repo de operaciones: [cómo darlos de alta](pipelines/operations/README.md).
En GitHub, los mismos tres corren como workflows de GitHub Actions, y los hallazgos de dependencias son issues en el
repo de cada producto: [cómo darlos de alta](pipelines/operations/github/README.md). El vigilante de producción no se
publicó: todavía es propio de TYCON.

## Dónde seguir

| Si querés… | Leé |
|---|---|
| Instalar a mano, en Linux o sin nadie delante | [Instalar a mano](getting-started/reference.es.md#instalar-a-mano) |
| Saber qué escribe en tu máquina y cómo apagar cada cosa | [Qué escribe en tu máquina](getting-started/reference.es.md#qué-escribe-en-tu-máquina-y-qué-hace-solo) |
| Actualizar, volver atrás o desinstalar | [Cómo se actualiza](getting-started/reference.es.md#cómo-se-actualiza) |
| Usarlo con Codex | [Qué es opcional](getting-started/reference.es.md#qué-es-opcional) |
| Cambiar el arnés | [CONTRIBUTING.md](.github/CONTRIBUTING.md) |

## Licencia y marcas

Apache License 2.0: ver [LICENSE](LICENSE). [NOTICE](NOTICE) lista el titular, las marcas y las atribuciones de
los archivos derivados de trabajo de terceros.

TYCON y Bizuit son marcas de sus dueños, y la licencia no las otorga.
Este arnés usa BMad Method, MIT; no está afiliado ni respaldado por BMad Code, LLC.

Para contribuir, leé [CONTRIBUTING.md](.github/CONTRIBUTING.md). Para reportar una vulnerabilidad, leé
[SECURITY.md](.github/SECURITY.md). Participar sigue el [código de conducta](.github/CODE_OF_CONDUCT.md).
