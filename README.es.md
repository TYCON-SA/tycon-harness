# Arnés TYCON para Claude Code y Codex

[English](README.md) · Castellano

Le suma a Claude Code (y a Codex, si lo prendés) las reglas, guías y revisiones con que TYCON desarrolla extensiones
de BIZUIT (.NET y React).
Vos pedís un cambio: Claude arma un plan, espera tu visto bueno, programa, corre las pruebas y deja el commit listo.
Todo corre en tu máquina, dentro de Claude Code, y no manda tu código a ningún lado.

## Antes de instalar: qué cambia en tu máquina

Si instalás con Claude, como dice más abajo, queda el perfil completo (`full`); el comando a mano te pregunta cuál
querés. El completo cambia cosas en todos tus proyectos, no sólo en uno:

- Claude te contesta en castellano, corto y con la conclusión primero.
- En un repo que trabaja con stories, Claude no edita código sin pasar por el proceso de stories del arnés.
- Git pasa a usar una carpeta global para sus controles al commitear (`core.hooksPath`). Desde ahí, git deja de correr
  los controles propios de cada repo, los de `.git/hooks/`. Claude te pregunta antes de configurarla.
- Una vez por día lee el historial de git de tus repos de proyectos (encuentra su carpeta por dónde usás Claude Code). Lo que anota queda en tu máquina.
- Claude Code guarda tus conversaciones un año.

Si no querés esto, pedí el perfil mínimo (`minimal`). Trae las guías, los revisores y el proceso de stories. No cambia
cómo te contesta Claude ni toca git. Deja un solo freno: el de comandos destructivos.
Para sacar el arnés, `harness.js uninstall --dry-run` muestra qué quitaría, y `harness.js uninstall --yes` lo quita.

## Qué necesitás

- Claude Code, instalado y con tu sesión iniciada.
- Windows 11 con PowerShell 7, o Mac. En Linux o en WSL, se instala a mano (está en la «Referencia»).
- Node 22 o posterior y `tar`. En Mac, además, Python 3 y Homebrew. Git **no** hace falta para usar el arnés: se baja
  como archivos, no se clona. Tampoco hace falta una cuenta de GitHub: este repo es público.
- Para programar extensiones de BIZUIT, el SDK de .NET de tu plugin. Sin él, la implementación frena al compilar.

Si te falta algo, Claude te dice qué instalar y cómo.

## Instalar con Claude Code

Es el camino recomendado y lleva unos 10 minutos. Claude corre casi todos los comandos; la bajada y la instalación
corren en tu propia terminal.

1. Abrí las instrucciones de tu sistema: [Windows](getting-started/windows.md), [Mac](getting-started/mac.md) o [Linux](getting-started/linux.md).
2. Copiá el bloque entero de la «Parte 1». Abrí Claude Code en cualquier carpeta y pegalo en una conversación nueva.
3. Claude te da las líneas que bajan el guion de instalación, lo muestran y lo corren: pegalas en tu propia terminal,
   así leés el guion antes de correrlo. Nada te pide iniciar sesión: el arnés nunca abre un navegador.
4. Claude te muestra el plan de instalación y espera tu «sí». Antes de tocar `core.hooksPath`, te vuelve a preguntar.
5. Al final te arma un resumen que termina en «OK» o «NO OK». Cerrá Claude Code y abrilo de nuevo.

Si en el camino instalás una herramienta, Claude te pide cerrar y abrir la terminal y Claude Code. Si el resumen dice
«NO OK», guardalo: es lo que hay que mostrar al pedir ayuda.

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

1. Pedro crea los dos repos de ACME, en su Azure DevOps o en su GitHub, con acceso sólo para el equipo.
2. Pedro corre `node ~/.claude/tycon-harness/scripts/setup/harness.js team-config`. Se abre una página en su máquina,
   sin nada en internet, donde declara dónde vive cada repo y a quién se le asignan los avisos. La página revisa lo que
   escribe, lo guarda en el repo que corresponde y le ofrece el pull request.
3. Juan instala con `--team` y el perfil: `harness.js install --version latest --team acme/harness-team-profile` si está
   en GitHub, o con la dirección del repo si está en Azure DevOps. Desde ahí, cada actualización le trae también lo del
   equipo.

**Lo que todavía no está.** Los procesos de la noche (dependencias, tablero, retrospectivas) todavía no se publicaron:
hoy corren sólo en TYCON, en Azure DevOps. Tampoco el vigilante de producción, que todavía es propio de TYCON.

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
