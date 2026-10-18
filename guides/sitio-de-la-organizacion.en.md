# The organization site: what it is, how to use it and how to install it

This guide is for whoever has never seen the site. It serves those who use it every day and whoever installs it for the
first time. First it tells what it is and how to use it; then, how to install it.

- **[Using the site](#what-it-is-and-what-it-is-for):** what it is, signing in for the first time, each tab, the
  configuration, what each person sees and the common problems.
- **[Installing it](#what-you-need-first):** what you need, how to try it on your machine and how to get it running.

Every step in this guide comes from the code or from a real run. What has not been tested for real yet says so on the
same line.

The screenshots come from a lab site with a made-up organization, **Acme**: its people, machines and products do not
exist. The site is in Spanish, so each screenshot is described in English in the text around it. Your site looks the
same, with your names.

## What it is and what it is for

It is a web page for the whole organization. Each person signs in with the organization's account and sees their own
things: their tasks, their change requests, their runs. Whoever maintains the harness sees everything, and also gets
the **Configuration** tab (*Configuración*), where the organization is customized (who is responsible for what, the
notice channel, the thresholds).

**The words the site uses**, for whoever does not program:

- **The harness:** the set of rules, controls and helpers the team uses to program with Claude. This site shows what the
  harness measures.
- **A story:** a programming task described in writing, with what it has to meet.
- **The pipeline and a run:** the pipeline is the step-by-step path the harness walks someone through to do a story
  (validate it, plan, program, test, review). A **run** is one time someone went through that path.
- **A repo:** the shared folder where the code or the configuration lives, with its history of changes. Its **main
  branch** is the version that counts.
- **A change request** (*pull request*; in Spanish, *pedido de cambio*): a proposal to change a repo. Another person
  looks at it and, if it is fine, **merges** it: adds it to the main branch.
- **The reviewers** (also "agents"): automatic helpers that review the work of each run.
- **Tokens:** the measure of how much text the model read and wrote; it is what a run costs.
- **The night snapshot:** what the night processes measured and saved. On the cards it shows as "source of"
  (*fuente del*) and a date.
- **The refresh:** how often the site reads everything again (15 minutes, unless the organization picks another
  interval).
- **The median:** the middle value; half of the runs are below it and half above.

Each team machine uploads its runs to a shared place, the **runs mailbox**. At night, some harness processes check the
dependencies (the third-party packages each product uses), the tests and the products, and leave what they measured in
the organization's **operations repo**. The site reads those two places and shows them.

**A day of whoever maintains it.** At 4 in the morning the night processes run and leave their snapshot in the
operations repo. A while later the morning notice arrives (Telegram, Slack or Teams), with counts and the link to the
site. The maintainer opens the link and lands on **Home** (*Inicio*), in "What to decide today" (*Qué decidir hoy*): a
yellow card is something waiting for a decision (a new dependency, a test that turned red last night) and it says where
it is decided. If someone's run got stuck, they look it up in **Runs** (*Corridas*) and open its detail: there they see
which step the time went to and what a control found. If a new machine started sending runs, Home counts it and
**Configuration** asks to confirm whose it is: they confirm it, the change is proposed as a request to the operations
repo, and when someone approves it, that person starts seeing their own things.

**A day of a developer.** They come in from the same link, or from the site address they saved. In **Home** they see
their own things: how many runs they did this week, their open pull requests and what is assigned to them. In **Runs**
they see only their runs, and in **Projects** (*Proyectos*), the products they work on. Nobody has to clone or run
anything on their machine to see it.

**Who uses it:**

- **Whoever maintains the harness:** installs it once, updates it deliberately, and edits the configuration from the
  Configuration tab.
- **Each person in the organization who programs with the harness:** signs in and sees their own things, if they are
  in the site's list. Whoever does not use the harness on a machine has no runs of their own, but still sees the rest of
  what is theirs.
- **Someone who is not in the list:** sees nothing. With "any Microsoft account" they can get past the sign-in, but the
  site shows them only a page with no data.

**What it does not do.** The site shows; it does not act. It writes to no repo, except the change requests that the
Configuration tab proposes, and those go in only when someone approves them. It does not run pipelines, merge, deploy or
touch any machine. What it shows is, at most, as old as the last night snapshot or the last download of the mailbox.

## Signing in for the first time

**The address.** Whoever installed the site gives it out: it comes in the morning notice, and maintainers have it in the
site's configuration (for maintainers: `site.url`, in the "Who gets into the site" section, *Quién entra al sitio*).
If you do not have it, ask whoever sent you the link or whoever installed the harness on your machine.

**Signing in.** The site asks for the account your organization chose when installing it: Microsoft, Google or GitHub.
If your organization installed it on Azure, the first screen is Microsoft's. With "any Microsoft account", the first
screen has two buttons: one for your Microsoft account and one for guests of the organization's directory. Getting past
the sign-in is not enough: you get in only if you are in the site's list. After you sign in, the site shows you Home. At the top right are your email and the **Sign out** button (*Salir*); at
the bottom left, the **Theme** (*Tema*: automatic, light or dark).

**What you see the first time** depends on who you are for the site:

- **A maintainer** sees the five tabs, and in Home what is waiting for a decision across the organization.
- **A confirmed person** sees three tabs (Home, Runs and Projects), with their own things.
- **Someone who is not in the list** sees only a page saying which account they signed in with, that the account is
  not in the list, whom to ask and how to sign in with another one. They see neither the menu on the left nor any data.

![The page for someone who is not in the list: "Your account is not in the list" (*Tu cuenta no está en la lista*)](sitio-de-la-organizacion/capturas/sin-rol.png)

**Your machine, not confirmed yet.** Each team machine uploads its runs with the git email of whoever uses it. A
maintainer has to confirm that the machine is yours. Until they do, only maintainers see your runs; you still get in,
if you are in the list, and see the rest. Ask whoever maintains the harness (if you do not know
who, whoever sent you the link or whoever installed the harness on your machine). They confirm it in Configuration, the
change goes in when someone approves it, and from the next refresh on (at most 15 minutes later) you see your own
things.

## The tabs

On the left is the menu, with the numbered tabs. Each tab answers a question.

**"Not measured"** (*no medido*). A gray, striped card says **not measured** and the reason, for example "there is no
snapshot of this source". "Not measured" is not zero and not green: it means that today that piece of data could not be
known. If a card stays like that for more than a day, tell a maintainer: the reason says what is missing. Some cannot
be measured from the site and always say so (for example, "Pending retrospectives": they live on the machine of whoever
merged); those do not need a notice.

### Home (Inicio)

**What it answers:** what is waiting for a decision of mine today?

For **a maintainer** it is "What to decide today": one card for each thing the night can bring. Each has a label
(**Decide**, *Decidir*, in yellow if there is something; **Nothing**, *Nada*, in green if there is not; **Not measured**
if it could not be known), a count and the date of the snapshot it came from ("source of"). Some carry the "where it is
decided" link (*dónde se decide*); the others are decided in the operations repo, where the night left its snapshot.
The cards are:

- **Dependencies:** the new ones with a vulnerability, the accepted ones not fixed yet, and the rejected ones without a
  declared debt (a date to pay it).
- **Watcher:** what the production watcher (a process that looks at the products in production) left pending, or
  accepted without a story.
- **Pull requests open more than two days** and **requests closed with the vulnerability alive**.
- **Red suites** and **red bench cases tonight:** the harness tests and the harness controls that turned red last
  night.
- **Declared data about to expire:** numbers someone wrote down by hand with a date to review them.
- **Unconfirmed machines with runs** and **pending retrospectives**.

![A maintainer's Home: "What to decide today", with cards in Decide, Nothing and Not measured](sitio-de-la-organizacion/capturas/inicio-quien-mantiene.png)

For **a person** it is "Your things" (*Lo tuyo*): their runs of the last 7 days (with a link to Runs), their open change
requests, what is assigned to them (up to a day behind, since it comes from the night snapshot) and their projects.

![A person's Home: your runs, your open pull requests, what is assigned to you and your projects](sitio-de-la-organizacion/capturas/inicio-persona.png)

**What to do:** a card in Decide is resolved where its link says, not on the site. Once it is resolved, the card turns to
Nothing with the next night's snapshot.

### Runs (Corridas)

**What it answers:** how are the pipeline runs going? Where did the time go, and what did the controls find?

At the top, the scope: how many runs were read and from which machines. Then "What to look at first" (*Lo que se mira
primero*) explains the two outcomes of a control: **found an error** (*encontró un error*: a test or the build did not
pass and was fixed right there) and **stopped** (*frenó*: the control did not let something through). Both are the
control doing its job, not a problem. Next to each median, **n=** says how many runs the number comes from.

Below there is a **filter** (dates, product, machine, only runs with measured usage, only runs that reached the last
step) and cards with the filter's numbers: how many reached the end, how long a run takes, in how many a control found an
error, how many agents were launched and how much was used.

![Runs: the scope, "What to look at first" and the filter cards](sitio-de-la-organizacion/capturas/corridas-tabla.png)

Further down is **"Run by run"** (*Corrida por corrida*): one row per run, newest first. Each row's bar splits the time
among the pipeline steps, with the legend's colors: 0 Start, 1 Validate the story, 2 Build the plan, 3 Approve the plan,
4 Implement and run the tests, 5 Reviewers, 6 Findings: the report, 7 Findings: the decision and 8 Prepare the commit.
"No mark" (*sin marca*) is a stretch the run did not record.

![The step legend and the "Run by run" table](sitio-de-la-organizacion/capturas/corridas-leyenda.png)

**Clicking a row** opens its detail: the timeline with each step and each control in its lane, what the controls found,
the reviewers that ran, the token usage per step and the files it touched. The timeline legend: a **green circle** means
the control looked and let it through; a **red triangle**, that it found an error; a **black square**, that it did not
let it through; a **dotted circle**, that how it came out was not recorded; an **orange line**, that another round of
reviewers starts; a **vertical bar**, a step marked together with the previous one; the **gray**, the time between
steps; and an **orange box**, the time waiting for a person (an unanswered question). If the detail shows a command to
run, it is for whoever maintains the harness. The files show only if the
organization chose to download the conversations ("Run conversations" section, *Conversaciones de las corridas*).

![A run's detail: the timeline, the controls, the reviewers and the usage](sitio-de-la-organizacion/capturas/corridas-detalle.png)

**What to do:** a run that "stayed at 4" (*quedó en el 4*) may be in progress or abandoned; its detail says how far it
got. A person sees only the runs of their confirmed machines; a maintainer sees them all.

### Projects (Proyectos)

**What it answers:** how is each product doing?

One row per product: the stories in progress (and how many in review), those stopped for more than 30 days, the blocked
ones, which version is in test and which in production, whether it is waiting for an approval, whether the watcher looks
at it, its live vulnerabilities and how it compares with the other products (parity). At the bottom, the total without
counting shared things twice. A person sees the products they work on. **Parity** compares each product with the
others: what one does and the rest do not.

![Projects: one row per product](sitio-de-la-organizacion/capturas/proyectos.png)

**What to do:** a stopped or blocked story gets unstuck in its repo, with its team; the site only shows it.

### Harness (Arnés)

**What it answers:** do the harness controls work? Only maintainers see it.

It shows whether each night snapshot arrived on time, how many cases of the **controls bench** (tests that confirm each
harness brake stops what it has to stop) and how many **test suites** (the harness's own tests) came out red, the
**reviewers' exam** (whether the automatic reviewers keep finding what they have to find), and the harness version the
site runs. The link at the bottom opens
the harness dashboard in six questions.

![Harness: the night snapshots, the controls bench, the suites and the site version](sitio-de-la-organizacion/capturas/arnes.png)

**What to do:** a snapshot that did not arrive or a new red is looked at in the night process that produced it.

### Configuration (Configuración)

**What it answers:** how is the organization configured, and how is it changed? Only maintainers see it. The next part
goes through it section by section.

At the top there are four cards: machines to confirm, sections with something to fix, sections up to date, and machines
with an old harness version or "no news" (*sin noticias*: they have not sent runs for a while, so their version is not
known). Below, five tabs: **People** (*Personas*), **Repos and products** (*Repos y productos*),
**Notices and the night** (*Avisos y la noche*), **How Claude works** (*Cómo trabaja Claude*) and **Installation and
updates** (*Instalación y actualización*). A number next to a tab says how many things are waiting there.

![Configuration: the four cards at the top and the People tab](sitio-de-la-organizacion/capturas/configuracion-personas.png)

## Configuration, section by section

Each section is a part of a configuration file that lives in an organization repo: the **operations repo** (the night's
and the site's things) or the **team profile repo** (what reaches each machine). Each one says at the top right how it
is: **up to date** (*al día*), **to confirm** (*por confirmar*), **not configured** (*sin configurar*), **view only**
(*sólo para mirar*), or **reviewed** (*revisada*) while you have a reviewed change not proposed yet.

**The cycle of a change.** Nothing is written directly. You change a section's fields and press **Review changes**
(*Revisar cambios*): the site validates the change with the same rules the harness uses and says "Reviewed: it is well
written" (*Revisado: está bien escrito*) or what is wrong. Then **Propose the change** (*Proponer el cambio*) shows
today's file next to the file after the change, to look at it before confirming. The file is written in a format with
braces and quotes; you do not need to understand all of it: check that the only difference between the two sides is
what you changed (each side scrolls to show the whole file). **Confirm and propose** (*Confirmar y
proponer*) opens a change request (a pull request) in that section's repo, and the section shows the link to the request.
Someone on the team reviews it and merges it. The site picks up the change on the **next refresh** (every 15 minutes, if
the organization did not choose another interval). **Download** (*Descargar*) downloads the changed file, for when the
site cannot propose: you hand it to whoever has access to that repo, who uploads it with a change request.

![A section changed and reviewed: "Reviewed: it is well written"](sitio-de-la-organizacion/capturas/configuracion-revisado.png)

![Before proposing: today's file and the file after the change, with "Confirm and propose"](sitio-de-la-organizacion/capturas/configuracion-diferencia.png)

![The open request: the section shows its link](sitio-de-la-organizacion/capturas/configuracion-propuesto.png)

**What shows as "view only".** Some sections are shown without being editable, and they say why. For example, "Azure
DevOps" when the profile repo lives on GitHub, a section that the harness version the profile asks for cannot read yet
(the section says which version to ask for), or the thresholds while the night does not read the organization's file
yet. To change them, first do what they say.

The sections, in the order of the screen:

### People (Personas)

- **The organization** (*La organización*): the name and logo shown in the top bar and the footer. It lives in
  `operations.json`, in the operations repo. A maintainer reviews it.
- **Who gets into the site** (*Quién entra al sitio*): the list of who gets in and what they see, one row per person,
  with their role ("Maintains the site", *Mantiene el sitio*, or "Dev") and one or more emails. Nobody gets in if they
  are not here, with any sign-in. Maintainers see the Configuration tab and propose changes; devs see their own things.
  A person gets in with any of their emails and sees the same. To add someone: Configuration, in People, "Who gets into
  the site" → **+ Add person** (*+ Agregar persona*), their email and their role; it is done here, without the Microsoft
  portal. The first time, the section brings the list built from what there was before (the maintainers and each person
  with a confirmed machine) and warns that it is not saved yet: it is saved when you propose it. If someone leaves the
  list, as soon as the request is approved and the site refreshes (at most 15 minutes), their next page is "Your
  account is not in the list", with no data. Above the list you see how people sign in to the site; that is changed at
  installation. The runs mailbox, the refresh and the site's address go here too. It lives in `operations.json`, in the
  operations repo. Another maintainer reviews it. **"How often the site updates"** (*Cada cuánto se actualiza el
  sitio*) takes 5 to 120 minutes; undeclared, 15. Shorter, a change shows sooner, but the site reads the operations
  repo, the profile repo and the mailbox again more often while it is awake: more reads to the cloud, which cost a bit
  more on an installation billed by use. It does not keep it awake: asleep it reads nothing, and on waking it reads
  everything.
- **"A maintainer's changes"** (*Los cambios de un mantenedor*): whether a change proposed by a site maintainer goes in
  by itself, or stays as a request for another person to approve. It is off by default: undeclared, the request stays.
  On ("yes", `site.auto_apply` in `operations.json`), "Propose" opens the request, approves it with the site's identity
  and completes it; right after, the site reads the repo again and the section says "Applied" (*Aplicado*). It only
  happens if the main branch's policies are met with that vote: if they ask for more (another reviewer, a named
  reviewer, a build), the site says what is missing and leaves the request to be approved. On GitHub the request always
  stays: whoever opens a request cannot approve it. Before proposing, next to the button, the section says what will
  happen. Who did it stays written: the request's description names who asked for it, and the site's log records
  `cambio aplicado: <file> por <email>, pedido <link>`. What counts is the option already in the repo: the change that
  turns it on is left to be approved like any other, and only after that do changes go in by themselves. It lives in
  `operations.json`, in the operations repo.
- **People and machines** (*Personas y máquinas*): whose each machine that sends runs is, and which projects each
  person works on. A new machine shows up in "To confirm" (*Por confirmar*) with the email it claims; **Confirm**
  (*Confirmar*) puts it in that person's name. It lives in `operations.json`, in the operations repo. A maintainer
  reviews it.
- **Who gets the notices and the requests** (*A quién le llegan los avisos y los pedidos*): who gets assigned what the
  night finds (an old dependency, a watcher finding). It lives in `operations.json`, in the operations repo. A
  maintainer reviews it.

![People and machines: one machine to confirm and the confirmed ones](sitio-de-la-organizacion/capturas/configuracion-confirmar-maquina.png)

### Repos and products (Repos y productos)

- **Where each repo lives** (*Dónde vive cada repo*): where the harness, the team profile and the operations repo are.
  It reaches every machine. It lives in `team-repos.json`, in the profile repo. Whoever maintains the harness reviews
  it.
- **Each product's deployments** (*Despliegues de cada producto*): which step of each pipeline is test and which is
  production, so that Projects says which version is out. It lives in `operations.json`, in the operations repo.
  Whoever knows the product's pipelines reviews it.
- **Accepted differences between products** (*Diferencias aceptadas entre productos*): what a product does differently
  on purpose, with a date to look at it again; the night does not count it as a difference. It lives in
  `scripts/ci/product-parity.json`, in the operations repo. Whoever maintains the harness reviews it.
- **Azure DevOps**: the team's Azure DevOps organization. It reaches each machine. It lives in `team-profile.json`, in
  the profile repo. Whoever maintains the harness reviews it.

Below are **Products** (*Productos*: the ones the night checks) and **What the organization brings** (*Lo que trae la
organización*: the skills, reviewers, onboarding guides and packs of the profile repo, each with its link). They are view
only: they are changed with a request in their repo.

![Repos and products](sitio-de-la-organizacion/capturas/configuracion-repos.png)

### Notices and the night (Avisos y la noche)

- **Where each morning's summary arrives** (*Dónde llega el resumen de cada mañana*): the notice channel (Telegram,
  Slack or Teams). It lives in `operations.json`, in the operations repo. A maintainer reviews it.
- **Waiting notice** (*Aviso de espera*): how many minutes a run waits for a person before giving notice. It reaches
  every machine. It lives in `team-repos.json`, in the profile repo. A maintainer reviews it.
- **Thresholds: when something is painted green or red** (*Umbrales: cuándo algo se pinta verde o rojo*): the limits
  the dashboard uses to color each number; in between, yellow. It lives in `scripts/nightly/dashboard/sources.json`, in
  the operations repo. A maintainer reviews it.

![Notices and the night](sitio-de-la-organizacion/capturas/configuracion-avisos.png)

### How Claude works (Cómo trabaja Claude)

- **How Claude answers** (*Cómo contesta Claude*): the language, style and length of the answers on every machine. It
  lives in `team-profile.json`, in the profile repo. A maintainer reviews it.
- **Which model each pipeline job uses** (*Qué modelo usa cada trabajo del pipeline*): the model of the reviewers, the
  adversarial pass, the helpers and the session; what is not declared uses today's. It lives in `team-repos.json`, in
  the profile repo. A maintainer reviews it, looking at the cost.
- **Where the full tests run on merge** (*Dónde corren las pruebas completas al mergear*): on the machine or on the
  server, repo by repo. It lives in `team-repos.json`, in the profile repo. A maintainer reviews it.
- **Test coverage** (*Cobertura de las pruebas*): the percentage of covered new lines below which the test control gives
  notice (it warns, it does not stop). It lives in `team-repos.json`, in the profile repo. A maintainer reviews it.
- **Integrations** (*Integraciones*): which services each machine uses (the time clock, the memory, the mailbox, the
  night); a machine can turn one off for itself. It lives in `team-profile.json`, in the profile repo. A maintainer
  reviews it.
- **Run conversations** (*Conversaciones de las corridas*): whether the site also downloads what was said in each run;
  with that, the Runs detail shows the files it touched. It lives in `operations.json`, in the operations repo. A
  maintainer reviews it.

![How Claude works](sitio-de-la-organizacion/capturas/configuracion-claude.png)

### Installation and updates (Instalación y actualización)

- **How the machines update** (*Cómo se actualizan las máquinas*): which version each machine takes and whether it
  updates itself on start. It lives in `team-profile.json`, in the profile repo. A maintainer reviews it.
- **Installation profile** (*Perfil de instalación*): how much the harness installs on each machine (minimal or full),
  with the list of what each one brings. It lives in `team-profile.json`, in the profile repo. A maintainer reviews it.
- **The organization's packs** (*Paquetes de la organización*): which harness packs (the reviewers and guides of a
  product or a client) are turned on on every machine. It lives in `team-profile.json`, in the profile repo. A
  maintainer reviews it.

Below is **Which harness version each machine has** (*Qué versión del arnés tiene cada máquina*), the one each machine
reported with its last run. It is view only: the machines update themselves on start.

![Installation and updates](sitio-de-la-organizacion/capturas/configuracion-instalacion.png)

## What each role sees

The site decides who you are by your email, and only with the "Who gets into the site" list:

| Role | Home | Runs | Projects | Harness | Configuration |
|---|---|---|---|---|---|
| **Maintainer** | "What to decide today", for the whole organization | all runs | all products | yes | yes, and proposes changes |
| **Confirmed person** (a dev in the list) | "Your things" | those of their confirmed machines | the products they work on | no | no |
| **Person with an unconfirmed machine** (a dev in the list) | "Your things" | those of their confirmed machines; the new machine's, not yet | the products they work on | no | no |
| **No role** (not in the list) | only the page "Your account is not in the list" | no | no | no | no |

**How you move from one role to another.** A maintainer decides it, in Configuration, and it goes in when someone
approves the request:

- To get in as a **dev**, your email has to be in "Who gets into the site" with the role "Dev". To see your runs, a
  machine of yours also has to be confirmed in your name ("People and machines"): it shows up by itself in "To confirm"
  when it uploads its first run.
- To **maintain**, your email has to be in "Who gets into the site" with the role "Maintains the site". Whoever installs
  puts the first person (`SITE_FIRST_MAINTAINER`), while the list has nobody who maintains.
- To stop seeing, the email is removed from the list.

## Common problems

### I cannot sign in

**What you see:** "Could not sign in" (*No se pudo entrar*), with the reason; or the Microsoft, Google or GitHub page
does not let you through.

**Why it happens:** the site asks for an email your provider vouches for. Common cases: your account has no email in its
directory; your organization did not verify your email's domain; or you signed in with a personal Microsoft account
through the main button (personal accounts signing in directly are not accepted yet). It also happens if the browser
signs in by itself with another account.

**What to do:** if you are a guest of the organization's directory, sign in through the guests' button. If not, sign in
with your organization's account: sign out of the other one or open a private window. If the message is about the email,
ask whoever runs your directory to add or verify your email. To be in the site's list, ask a maintainer.

### I sign in and see nothing

**What you see:** the page "Your account is not in the list", with the account you signed in with.

**Why it happens:** you got past the sign-in, but that account is not in the "Who gets into the site" list. Maybe you
are using another email than the one in the list.

**What to do:** if you have another account, use "sign in with that one". If not, ask a maintainer to add you, with the
email you sign in with. It goes in when someone approves the request and the site refreshes (at most 15 minutes).

### I do not see my runs

**What you see:** you get in, but some of your runs are missing in Runs.

**Why it happens:** the machine they came from is not confirmed in your name yet. Or the email you sign in with is not
that machine's git email: for example, the Microsoft account has a user name different from the email.

**What to do:** ask a maintainer to confirm the machine. If the email does not match, a maintainer can record the other
one as yours in the organization's configuration.

### The site is stopped

**What you see:** the "Site stopped" page (*Sitio frenado*), which says since when.

**Why it happens:** the organization's configuration (`operations.json`, in the operations repo) has not validated for
more than 24 hours. During those 24 hours the site keeps the last good configuration and maintainers see a notice; past
that, it stops for everyone.

**What to do:** a maintainer fixes the file with a request in the operations repo. The site unblocks itself on the next
refresh.

![The site stopped](sitio-de-la-organizacion/capturas/sitio-frenado.png)

### Loading the runs

**What you see:** "loading the sources" (*cargando las fuentes*) or "loading the runs" (*cargando las corridas*), and
the page reloads by itself.

**Why it happens:** the site has just started and is still reading the operations repo or downloading the runs mailbox.
The first mailbox download can take a few minutes.

**What to do:** wait. If it stays the same for more than ten minutes, tell a maintainer.

![Runs while the site downloads the mailbox](sitio-de-la-organizacion/capturas/cargando-corridas.png)

### Could not update

**What you see:** a red band at the top, "could not update since" (*no se pudo actualizar desde*) a time, with the
reason.

**Why it happens:** the last refresh could not read a source (the operations repo or the mailbox). The site keeps showing
the last thing it read well.

**What to do:** nothing, if it goes away on the next refresh. If it stays, a maintainer looks at the reason: it is
almost always an expired credential or a permission that changed.

![The "could not update" band](sitio-de-la-organizacion/capturas/no-se-pudo-actualizar.png)

### "Propose" is off

**What you see:** in a Configuration section, "Propose the change" is not there, or it is gray, and next to it it says
why.

**Why it happens:** the site only proposes if the repo requires another person to approve each change before adding it
to the main branch (a "review policy"); without that rule, the site could change the repo without anyone looking. Also
when the policy lets whoever creates the request approve it ("Allow requestors to approve their own changes", on Azure
DevOps): the site creates the request, and it would approve itself; unless the organization turns on "A maintainer's
changes", which is meant for exactly that. And when the site has no permission to write to that
repo, or when there is already an open request on the same file (the section shows its link).

**What to do:** review, press **Download**, and hand the file to whoever has access to the repo. A maintainer can ask for
the review policy or the write permission. With an open request, wait until it is merged or closed.

!["Propose" off, with its reason: the repo has no policy requiring review](sitio-de-la-organizacion/capturas/proponer-apagado.png)

### Configuration says the site rejected the request

**What you see:** when reviewing or proposing, a red box with the reason: "the session expired or was closed: reload
the page" (*la sesión venció o se cerró: recargá la página*), "your account … is not among those who maintain the
site", "the site is loading…", or "the request was rejected by what stands in front of the site, not the site" (*el
pedido lo rechazó lo que está delante del sitio*).

**Why it happens:** the session expired; or you signed in with another account (the message says which one); or the
site was restarting; or the cloud's sign-in, in front of the site, stopped the request.

**What to do:** reload the page. If it says your account does not maintain the site, sign out and sign in with the
organization's account. If it says it was rejected by what stands in front of the site and it persists after reloading,
tell a maintainer (the installation guide, in the Azure recipe, says how to fix it).

### The first page is slow to open

**What you see:** after a while without use, the first page is slow to open, sometimes more than half a minute.

**Why it happens:** in an installation that sleeps when nobody uses it (Azure Container Apps, Render), the first visit
wakes it up.

**What to do:** wait; the next pages open quickly.

## What you need first

- **The site image.** It is published automatically in the package registry of the harness public repo every time
  something it carries changes. You can also build it yourself (below).
- **A way to sign in to the organization:** Entra ID, Google Workspace, GitHub, or any OIDC provider (Okta, Keycloak).
  An application for the site is registered in that provider.
- **The organization's operations repo**, and an identity that can read it (that repo only).
- **Optional: the runs mailbox**, if the organization collects the runs of its machines.
- **A place to run a container** with HTTPS in front: a cloud, a free service or your own machine.

## Try it on your machine with Docker

About ten minutes, most of it building the image. You need Docker running and a clone of the harness public repo.

1. **Build the image** (from the root of the clone; run for real: about 2 minutes the first time):

   ```bash
   docker buildx build -f scripts/site/Dockerfile -t sitio:local .
   ```

2. **Start it**, with the port only on your machine and a volume for its disk:

   ```bash
   docker run --rm -p 127.0.0.1:8080:8080 -v sitio-datos:/data -e SITE_DATA_DIR=/data \
     -e SITE_PUBLIC_URL=http://127.0.0.1:8080 -e SITE_SESSION_KEY="$(openssl rand -hex 32)" \
     -e SITE_AUTH_PROVIDER=github -e SITE_AUTH_GITHUB_ORG=<your GitHub organization> \
     -e SITE_OIDC_CLIENT_ID=<the Client ID> -e SITE_OIDC_CLIENT_SECRET=<the secret> \
     -e SITE_OPERATIONS_REPO=<the https address of the operations repo> -e SITE_OPERATIONS_TOKEN=<a read token> \
     -e SITE_FIRST_MAINTAINER=<your email> sitio:local
   ```

   At startup the log says each variable is "presente" or "ausente", never its value. If a required one is missing, it
   does not start and says which one.

3. **Check that it is alive** (in another terminal):

   ```bash
   curl -s http://127.0.0.1:8080/livez
   node scripts/site/check-deploy.js --url http://127.0.0.1:8080
   ```

   `/livez` answers `{"ok":true}`. The check without a session makes sure that, without signing in, nothing is visible.
   With made-up values (a repo that does not exist) we measured it: the site starts, `/livez` gives 200, `/` redirects to
   the GitHub sign-in, `/api/inicio` gives 401, and the site is **stopped** because it cannot read the repo (`/healthz`
   gives 503 and the check says "el sitio está frenado"). With the real repo and its token, the site loads.

4. **Sign in.** Open http://127.0.0.1:8080 and sign in with your account. For that you first register the application
   on GitHub (*Settings → Developer settings → OAuth Apps → New OAuth App*, with the address `http://127.0.0.1:8080` and
   the callback `http://127.0.0.1:8080/auth/callback`). Signing in with a real account has not been tested for real yet.

To stop it: `Ctrl+C` in the terminal. The `sitio-datos` volume stays; remove it with `docker volume rm sitio-datos`.

## Common to every installation

This part applies wherever you install it.

### HTTPS in front

The site requires its public address (`SITE_PUBLIC_URL`) to be `https://` and uses a cookie that only travels over HTTPS.
Whoever installs it provides the TLS: the platform, a proxy or a tunnel. The container listens on port 8080.

### The disk

A persistent volume mounted as a folder at `SITE_DATA_DIR`. It holds the mirror of the mailbox (the runs' dumps and,
with `site.mailbox.threads: true`, a small summary of each conversation) and the last good configuration. Conversations
are not kept: each one is downloaded once, summarized and deleted, and a pass downloads at most 300 MB of conversations
at a time. The repos' clones and the change texts go to the container's disk, never to the volume (a network disk
mounted over SMB does not allow the `chmod` git does when cloning). Measured with a 6.9 GB mailbox: without
the conversations it takes 163 MB, plus the summaries (a few kilobytes per run) and, while a pass lasts, up to 300 MB of
conversations waiting to be summarized. **2 GB is enough**, with room to grow. **Without a volume the site still works**: it uses a temporary folder and says so. But what comes from the conversations in the Runs tab stays "not
measured", every restart downloads everything again, and a restart resets the 24-hour window a broken configuration has
before the site stops (and lifts the stop until it expires again).

### The memory

1 GB. Building the runs view with its conversations measures about 700 MB at peak.

### The organization's sign-in

The site does its own sign-in (`SITE_AUTH_PROVIDER`): generic `oidc` (Okta, Keycloak or another with discovery),
`microsoft`, `google` or `github`. It is chosen at installation, and Configuration shows it. In the provider you register
an application with the callback `<site address>/auth/callback` and a secret of 6 months at most. With any provider, who
gets in and what they see is decided by the site's list ("Who gets into the site"): getting past the sign-in is not
enough.

- **`google` and `github`** are limited to the organization: the domain (`SITE_AUTH_ALLOWED_DOMAINS`) or the GitHub
  organization (`SITE_AUTH_GITHUB_ORG`).
- **`microsoft`, one tenant** (`SITE_AUTH_MICROSOFT_ACCOUNTS=organization`, the default): the accounts of the
  organization's directory and its guests get in. `SITE_OIDC_ISSUER` is the tenant's.
- **`microsoft`, any account** (`SITE_AUTH_MICROSOFT_ACCOUNTS=any`): work or school accounts from any organization get
  in, without inviting them to the directory. `SITE_OIDC_ISSUER` is `https://login.microsoftonline.com/common/v2.0` and
  `SITE_AUTH_MICROSOFT_TENANT` is the organization's tenant: its guests get in through it, with their own button. You get
  in only with an email verified by your organization. Microsoft personal accounts signing in directly are not accepted
  yet: it could not be checked that their email is reliable (a guest with a personal account uses the guests' button).
- **The risk, plainly:** with "any account", the first door is open to any Microsoft account, and all the control is in
  the site's list. Whoever is not in the list sees a page with no data; no request answers them with data. That is why
  the list is guarded like a password: each change is a request with who proposed it and who approved it.
- The site gets no permission on anybody's directory: it does not assign, invite or read users.

### The probes

If your platform has probes, **both go against `/livez`**, with a response timeout of about 5 seconds.

- **Liveness, never against `/healthz`.** `/healthz` gives 503 when the site is stopped by a broken configuration. A
  liveness probe against it would restart the container in a loop, and restarting does not fix the configuration.
- **Readiness, not against `/readyz` either.** The platform sends no traffic until that probe passes, and `/readyz`
  waits for every source, the whole mailbox included. The site already serves each tab as soon as it can build it: one
  that is still waiting says «loading» and reloads itself, and a stopped one explains why. `/readyz` is for whoever wants
  to know whether everything finished loading.

### The secrets, with the least privilege

Each installation says where each one is stored and how its value gets in. **No value goes in a file of the repo, in
`operations.json`, in an installation's configuration file, on the command line or in a printed plan.**

| Secret | What for | Minimum scope |
|---|---|---|
| `SITE_SESSION_KEY` | signing the session | 32 random bytes, only for the site |
| `SITE_OIDC_CLIENT_SECRET` | the sign-in | a registration only for the site, with no API permissions beyond `openid email profile`; expires in 6 months at most |
| `SITE_OPERATIONS_TOKEN` (or the platform identity, `SITE_OPERATIONS_IDENTITY=managed`, no secret) | reading the operations repo | an identity of its own with read access to that repo only; if it is a token, for one organization, code read only, 90 days; on GitHub, fine-grained, one repo, `contents: read` |
| `SITE_MAILBOX_SAS` (or `SITE_MAILBOX_IDENTITY=managed`) | reading the runs in the mailbox | a read-and-list SAS (`rl`) tied to a stored access policy of the container, 6 months at most; or the platform identity with a read role on the container |
| the notice channel | sending the morning notice | it does not reach the site: the night process uses it. Telegram: the token is for the whole bot, use a dedicated one. Slack or Teams: the webhook address IS the credential |
| `SITE_OPERATIONS_WRITE_TOKEN` | proposing configuration changes from the site | on GitHub, fine-grained on the operations repo with `contents: write` and `pull_requests: write`; on Azure DevOps, a dedicated account with *Contribute*, *Create branch* and *Contribute to pull requests* on that repo only, *Force push* denied and no permission to bypass policies |
| `SITE_PROFILE_REPO` and `SITE_PROFILE_TOKEN` | reading the team profile (where each repo lives, the packs) | part of the normal installation: without them the Configuration tab says "falta el repo del perfil" (the profile repo is missing). The address of the profile repo and a read-only code token on that repo (it can be the same permission as the operations repo's, if both live in the same organization) |
| `SITE_PIPELINES_TOKEN` | read the pipelines, to choose them by name in the Configuration tab («Tests at merge» and «Deployments») and to see the name of each stage | part of the normal installation on Azure DevOps: only *Build: Read*, for the organization, 90 days; it can be the same token as the operations repo's with *Build: Read* added. Without it, the tab asks for the pipeline number by hand and says what is missing, and the saved stages show their identifier |
| `SITE_PROFILE_WRITE_TOKEN` | propose changes to the team profile | off by default: empty or commented out, never with a value; one dedicated identity and one repo per credential |

`SITE_FIRST_MAINTAINER` is not a secret: it is the email of whoever signs in first as maintainer, while the site's list
(`site.access` in `operations.json`) has nobody who maintains. Remove it afterwards.

### Where it reads operations from

The site reads its configuration and what the night leaves from the operations repo. There are three ways, depending on
where the site lives and where the repo lives. Pick only one: with `SITE_OPERATIONS_SOURCE=copy`,
`SITE_OPERATIONS_TOKEN` and `SITE_OPERATIONS_IDENTITY` are left over and the site does not start if they are set.

1. **Copy with the platform identity, in Azure** (`SITE_OPERATIONS_SOURCE=copy`,
   `SITE_OPERATIONS_COPY=<account>/<container>`). A job in the operations repo (`site-copy.yml`, in
   `pipelines/operations/` for Azure DevOps and in `pipelines/operations/github/` for GitHub) copies what the site reads
   to a container, on every change to `main` and once a day. The site reads it with its identity and a reader role on
   that container. The Azure setup creates the account with the key turned off: only identities with their role get in.
   What it costs: one more pipeline and its identity, with the write role on the container. No secret that expires, and
   no Azure DevOps license for the site. A change takes as long as the job plus one refresh to show.
2. **Copy with a SAS, outside Azure** (another cloud or your own machine): the same copy, and the site reads it with
   `SITE_OPERATIONS_COPY_SAS`, a read-only container SAS (`sp=r` or `rl`), tied to a stored access policy on the
   container so it can be revoked (the commands, in the recipe for your own machine).
   What it costs: the SAS is signed with the account key, so that account needs the account key turned on, and that key
   opens the whole account (read, write and delete everything). That is why the copy goes in its own account, never the
   mailbox's; and the SAS expires (6 months at most) and is renewed by hand.
3. **Reading the repo directly** (`SITE_OPERATIONS_SOURCE` empty or `repo`, as always): the site clones the repo with
   `SITE_OPERATIONS_TOKEN`. In GitHub, an app installed on that one repo with `contents: read`, or a fine-grained token
   for one repo; in Azure DevOps, the site's identity added to the organization (`SITE_OPERATIONS_IDENTITY=managed`) or a
   personal access token with read-only code access.
   What it costs: the personal token expires (90 days) and belongs to a person; the identity in Azure DevOps takes a
   license. In exchange, a change shows on the next refresh, with no copy job.

With the copy, if the job stops running the site says so: with a copy older than 24 hours, maintainers see the last-good
banner ("the operations copy is N hours old"); older than 48, the site stops, as when the repo cannot be read. "Propose",
in the Configuration tab, still uses `SITE_OPERATIONS_WRITE_TOKEN`: it fetches a fresh `main` into a separate clone and
builds the pull request on that tip.

### Whoever can edit the installation can read its secrets

Whoever has permission to change the installation (its variables, its image) can read all its secrets and make
themselves a maintainer: change the session key or point to another repo. That permission is only for those who
maintain the harness. Removing `SITE_FIRST_MAINTAINER` protects against an oversight, not against that administrator.

### The branch policy of the operations repo

Before publishing the site, `main` of the operations repo needs a branch policy that asks for a reviewer who is not the
author. Without it, anyone who can push to `main` can make themselves a site maintainer (by changing the list) or change
a night process and take its secrets. That policy is also what enables "Proponer" (propose) in the Configuration tab.
How to set it on Azure DevOps and on GitHub: the READMEs of the operations models (`pipelines/operations/README.md` and
`pipelines/operations/github/README.md`).

### The permission for "Propose"

"Propose the change" opens a change request in the section's repo. For that the site needs to write to that repo:
`SITE_OPERATIONS_WRITE_TOKEN` for the sections of the operations repo and `SITE_PROFILE_WRITE_TOKEN` for those of the
team profile. On Azure DevOps, a token with *Code: Read & write* on those repos, **without** *Bypass policies when
pushing* or *Bypass policies when completing pull requests*: the site creates a branch and a request, it never writes
`main`. With a personal token, the requests come out in that person's name, and the branch policy keeps asking for its
approvals: the policy must have "Allow requestors to approve their own changes" turned off, or the site does not propose
(the author would approve it), except with "A maintainer's changes" on (below). Without the permission, each section says
"To propose from here, the site needs permission to write to the repo. Meanwhile: review, download and upload it by
hand" (*Para proponer desde acá, el sitio necesita permiso para escribir en el repo…*).

### Changes that apply by themselves

With `site.auto_apply: true` in `operations.json` ("A maintainer's changes", in People), the site approves and completes
each request a maintainer proposes. For that its write identity needs, on Azure DevOps, *Code: Read & write* and
*Contribute to pull requests* on the repo, and never *Bypass policies*: the site skips no policy, and if one is not met
with its vote, the request stays. The review policy of `main` has to let the vote of whoever creates the request count
("Allow requestors to approve their own changes" on) and ask for one reviewer. With no policy at all on `main`,
"Propose" stays off even with the option on. To turn it on, first the new image, then the key: an older image does not
know `site.auto_apply` and would take `operations.json` as invalid (it keeps the last good one). Each applied change
leaves its line in the site's log with the email of whoever asked for it; it is the only log line that carries an email.

### The two ways to start it

The same image with Docker (`docker run … sitio:local`, above), or with Node alone from the clone, with the same
variables:

```bash
node scripts/site/server.js
```

### The check without a session

After any installation, and every morning from the night process:

```bash
node scripts/site/check-deploy.js --url https://<site address>
```

It asks, without a session, what a stranger would ask. It exits 0 if nothing is visible; 1 with the reason ("el sitio
responde sin iniciar sesión", "/api contesta con datos", "el sitio está frenado", "/healthz cuenta de más", "falta
no-store", "acepta http", "sin Referer: el candado de la plataforma frenaría las escrituras de Configuración" — the
site sends `Referrer-Policy: no-referrer`); 2 if it could not ask. It waits up to 90 seconds for the first answer: a sleeping site takes a
while to wake up. The morning notice carries the link only if it passed that morning.

## The recipes

Each recipe says what changes compared with the common part. **None of the three recipes has been tested for real
yet**: the first installation of each one tests it.

### Azure Container Apps

Free within the subscription quota, with scale to zero. The installation is a two-phase script that is first run as a
dry run:

```bash
node scripts/site/deploy/azure-container-apps.js --config <file outside any repo> --phase ambiente --dry-run
node scripts/site/deploy/azure-container-apps.js --config <file> --phase ambiente --apply
# add the two callbacks to the Entra ID registration
node scripts/site/deploy/azure-container-apps.js --config <file> --phase sitio --dry-run
node scripts/site/deploy/azure-container-apps.js --config <file> --phase sitio --apply
```

The `ambiente` (environment) phase creates the resource group, the log workspace (31 days, daily cap of 0.023 GB) and
the environment, and prints the address the site will have and the two callbacks to add to the registration. The `sitio`
(site) phase creates the disk, the application with internal ingress, the mailbox read role and the built-in sign-in, and
opens external ingress at the end. If a step fails, ingress stays internal, and running it again continues where it
stopped. It runs with your `az` session (it does not open a login). The configuration file holds subscription, group,
region, names, tenant, the image by its digest and the client identifier, and no secret; the script header lists each
key. The profile repo is part of the normal installation: its address goes in `profileRepo` in the file, and its token in
`SITE_PROFILE_TOKEN`, in the environment of whoever runs the setup, like the other secrets. Without both, the
Configuration tab says "falta el repo del perfil" (the profile repo is missing).

- **Sign-in:** two locks. In front, the platform's built-in sign-in with the same Entra ID registration. Behind it, the
  site's own, which decides with its list. `/healthz` and `/livez` stay outside the lock. `microsoftAccounts` in the
  configuration file picks the mode:
  - `organization` (the default): a single tenant. If the registration has "assignment required", people are assigned
    one by one in the portal (assigning a group needs an Entra ID P1/P2 license).
  - `any`: after setting up the application, the script reads that the registration asks for `email` and `xms_edov`,
    moves it to any Microsoft account with v2 access tokens (Azure does not accept the change without them), removes the
    required assignment and puts the platform's lock on the common issuer. Your `az` session does it, and it has to own
    the registration; the site gets no new permission. Before running it, the site's list has to have everyone who gets
    in today (the section builds it by itself from what there was before: propose it and have it approved).
- **The lock and the writes:** the built-in sign-in protects against forged requests by looking at the browser's
  `Referer`, not the `Origin`. A POST with a session and without a `Referer` from the site itself is rejected with 403,
  sub-status 60 (it shows in the environment's logs, as the middleware's `RequestCompleted`). For "Review changes" and
  "Propose" to go through, the site sends `Referrer-Policy: same-origin`: the `Referer` travels within the site and never
  outside it. An earlier image sent `no-referrer` and the Configuration tab could not write; the session-less check warns
  about it. There is no need to touch the lock's CORS or proxy convention.
- **Disk:** an Azure Files share in a storage account of the site's own (cents per month), never in the mailbox
  account.
- **Secrets:** application secrets. Their values come from environment variables of whoever runs the installation, with
  the names in the table. The mailbox is read with the managed identity, no secret. The operations repo, in one of two
  ways (`operationsIdentity` in the configuration file): `managed`, the site's identity, no secret; or `token`, a
  read-only token (*Code: Read*) in `SITE_OPERATIONS_TOKEN`, which expires and has to be rotated.
- **Sleeps:** scales to zero, no cost while asleep. With 1 GiB the free quota covers about 100 hours awake per month,
  and going over is charged. The first request after a while takes time to answer. If it gets no request in 90 days,
  Azure may delete the environment and the installation has to run again.
- **Cost:** zero within the quotas. With `operationsIdentity: managed`, reading the operations repo on Azure DevOps
  needs a Basic license for the site's identity (the first 5 in the organization are free; after that, about 6 dollars
  per month). **No license cost:** `operationsIdentity: token`, with a read-only token from an account that already has
  its own; in exchange, the token expires and has to be rotated.
- **Updating:** run the `sitio` phase again with the changed configuration file (the new image, another identity, a
  rotated secret). With the application already created, it updates it: it says what changed (the image, the secrets and
  the variables that are added or removed) and leaves the ingress as it was.
- **Who runs it:** needs Contributor on the resource group and Owner or User Access Administrator on the mailbox account
  (only to grant the role). The region is that of the mailbox account.

### Render

Render's free plan, with `scripts/site/deploy/render.yaml` as the *Blueprint*. Replace the image with the digest of the
version you install.

- **Sign-in:** only the site's own; Render puts no lock in front.
- **Disk:** the free plan has none. Without `SITE_DATA_DIR`, what comes from the conversations stays "not measured" and
  a restart resets the 24-hour window of a broken configuration. With a Render disk (paid) mounted at `/data` and
  `SITE_DATA_DIR=/data`, it is complete.
- **Memory:** 512 MB on the free plan, less than the 1 GB the site asks for to build the runs view with its
  conversations. Not yet measured whether building it without conversations fits: if not, a paid plan.
- **Secrets:** in the service panel. The blueprint asks for them only when the service is created (`sync: false`);
  rotating one is done in the panel. The mailbox, with the read-and-list SAS.
- **Sleeps:** after 15 minutes without traffic, and wakes in about a minute (the check without a session waits for it).
  750 hours per month per workspace: one service fits. Without a payment method, if it goes over, Render suspends the
  service until the next month: it does not charge.

### Your own machine

A Docker on an office server, with `scripts/site/deploy/local/compose.yaml` and the secrets in a `sitio.env` (copy
`sitio.env.example`) **outside any repo**. It starts with `start.js`, which refuses if the file is inside a git repo (one
extra commit would upload it with every secret) or if other users of the machine can read it:

```bash
cp scripts/site/deploy/local/sitio.env.example <folder outside the repo>/sitio.env && chmod 600 <folder outside the repo>/sitio.env
node scripts/site/deploy/local/start.js --secrets-file <folder outside the repo>/sitio.env
```

`compose.yaml` names no secrets file: it gets it from `start.js`. With `--dry-run`, `start.js` prints the command without
starting anything.

- **How to reach it**, the safest first: (1) **only the internal network** of the office, with an internal name and the
  certificate of the organization's internal authority; (2) through the organization's **VPN**; (3) only after that, a
  public **tunnel**, with the tunnel provider's lock in front (the organization's sign-in) in addition to the site's.
  The container publishes the port only on `127.0.0.1`, with a TLS proxy in front.
- **Sign-in:** the site's own, plus that of the proxy or the tunnel if the organization has one.
- **Disk:** the Docker volume `sitio-datos`.
- **Secrets:** `sitio.env`, outside any repo, readable only by whoever runs the container. The mailbox, with the SAS.
- **Sleeps:** no. The cost is the machine.
- **The night check:** it runs on a cloud agent and cannot reach an internal network. The notice says "sitio: no se pudo
  probar desde el nocturno" (could not be checked from the night run), without a link, unless the organization runs the
  night process on its own agent inside the network.

**The operations copy outside Azure** (also for Render): the read-only SAS, tied to a stored access policy on the
container so it can be revoked. The copy's account needs its key turned on to sign it:

```bash
az storage container policy create --account-name <account> -c <container> -n site-read --permissions rl --expiry <date>
az storage container generate-sas --account-name <account> -n <container> --policy-name site-read -o tsv
```

## Inside, for whoever maintains the harness

How the site is built, for whoever changes it. Each piece has its tests in `scripts/tests/` (`site-*.test.js`).

### The server

A Node server with no dependencies, in Docker (`scripts/site/Dockerfile`) or with Node alone, that does not depend on
Claude or Codex.

- **The site does its own sign-in** (`oidc.js` and one file per provider in `auth-providers/`: generic `oidc`, Entra ID,
  Google and GitHub), with authorization code, PKCE, `state` and `nonce`. The `id_token` signature is verified with
  `crypto` (only RS256 and ES256), and each check has its test with a badly built token. Each provider is limited to the
  organization in its own way. **The identity never comes from a header** of a proxy or of the platform.
- **The session lives in a signed cookie**, for a fixed 8 hours, like the sign-in attempt: the site can restart or have
  several replicas. **The role is recomputed on every request** (`access.js`) and comes only from the `site.access` list
  of `operations.json` (the rule lives in `scripts/lib/people.js`): a maintainer is whoever has a `maintainer` entry (or
  the installation's first maintainer while the list has none); a person, whoever has a `dev` entry. Without
  `site.access`, the list is built from what there was before (`site.maintainers` and the people of `people.machines`).
  A person can have several emails: their things are computed with all of them. Everyone else has no role and sees a
  page with no data.
- **A single path for the data**: the routes table in `server.js`. A route that does not declare who may see it keeps
  the site from starting, and each route gets the model already filtered for whoever asks.
- **It reads straight from the sources** (`sources.js`): the operations repo, cloned with the credential in a header
  (never on disk), and the runs mailbox with a read-only SAS or the managed identity. What is specific to each cloud lives
  only in `cloud/`. Snapshots are copied with an allow list: no title, diagnosis or message reaches the model. The screen
  shows a state from a closed list, and the raw reason goes only to the log.
- **The refresh** runs every 15 minutes and keeps the last good one. If `operations.json` stops validating, the last good
  one is used for 24 hours, with a banner for the maintainers; after that the site stops for everyone. The window is
  stored in `SITE_DATA_DIR`. The image makes `/data` owned by the site user and declares it a volume, so a new volume is
  born writable. The mailbox download fetches several files at a time within its 2-minute cap; if it is cut short, the
  next pass starts 10 seconds later and resumes where it stopped. Navigation does not wait for everything: once the
  operations repo is read the tabs show, and only Runs waits for the mailbox. Every loading page reloads itself every 5
  seconds.
- **The tabs** (`views.js`) are built by the server, with no outside JavaScript and no inline `<script>`. "Not measured"
  is never 0.
- **What it does not do:** it writes to no repo except the requests of the Configuration tab, triggers nothing, and does
  not download conversations except for the Runs tab, with `site.mailbox.threads` and a disk.

### The Configuration tab

Only for maintainers (`tabs/config.js`, with all its routes registered as `maintainer`: a developer gets a 403 with no
data). It is the configuration of the organization, not that of any machine.

- **A common core** (`scripts/lib/org-config.js`): the sections (which part of which file, in which repo, with which
  reader) and "Revisar" (review), which applies the draft over the file as it is and validates all of it with the same
  reader the harness uses (`team-repos.js`, `operations-config.js`, the reading exported by `check-product-parity.js`).
  The rest of the file stays byte for byte. There is no validator of its own: two validators drift apart by themselves,
  and the night process judges with its own. The local page `harness.js team-config` uses the same core.
- **Keys that came later have their version** (`TEAM_REPOS_SINCE`, `MERGE_SUITES_SINCE`, `MODELS_SINCE`,
  `WAIT_NOTICE_SINCE`, `RESPONSE_SINCE`): a change is proposed only if the team profile asks for a harness version that
  can read it. A section whose reader cannot read its key yet says so.
- **It saves with a branch and a pull request, never on the main branch** (`scripts/lib/repo-proposal.js`): from the
  temporary clone the site already has, without touching its working tree or its index. The request is opened through
  the REST API of Azure DevOps or GitHub and says who asked for it. One request per file. If the file changed since the
  section was opened, or there is already an open request on it, nothing is created.
- **Without a policy that requires review on `main`, "Proponer" stays off.** On Azure DevOps a "Minimum number of
  reviewers" policy on the whole branch counts, or a "Required reviewers" one with a path filter; with the filter,
  "Proponer" is enabled file by file: only in the sections whose file the filter covers. In both, the vote of whoever
  creates the request cannot count. On GitHub the branch protection counts, or a rule that requires a pull request; with
  the push rule by path the site does not propose.
- **Every write is defended twice:** the site's `Origin` (or `Sec-Fetch-Site: same-origin`) and a double-submit token
  (`X-Site-Token`); then JSON and a body of up to 256 KB.
- **A single write credential at birth**, `SITE_OPERATIONS_WRITE_TOKEN`; the others, optional and off. Without a write
  identity, the tab validates and the browser builds the download of the validated file.
- **Thresholds only when the night process really reads them:** the section edits them only once the night left the
  mark `.dashboard/applied-config.json` with that file inside.

### The Runs tab

The runs view on the site, each person their own (`tabs/runs.js` on top of `scripts/nightly/dashboard/runs.js`: a single
code for the local view and the site's).

- **The server filters, before every answer** (`filtrarCorridas` in `access.js`). Someone else's run, one without a
  machine and an id that does not exist all answer the same: 404 with no body.
- **What travels, in parts:** the list, the detail when a run is opened and the texts when a change is opened. Each run
  has a stable id (16 hexadecimal characters of the sha256 of machine and session).
- **Built in a separate thread**, with a memory ceiling: measured with 551 runs, 34 seconds and about 690 MB at peak.
  While it rebuilds, or if it fails, it serves the previous one whole with its time.
- **Conversations, only with a disk** (`site.mailbox.threads: true` and `SITE_DATA_DIR`). Without that, what comes from
  the thread says "not measured". With it, each conversation is downloaded once, in batches of up to 300 MB, and
  summarized: the run's description, the time split and the list of changes. Then it is deleted from the disk. The table
  and the detail come from the summary. The change texts (the patches) are downloaded when someone opens a run's
  changes, and kept in a 200 MB cache on the container's disk; when it fills up, the ones opened longest ago are deleted.
  The mirror deletes what is no longer in the mailbox.

### The morning notice and the check without a session

- **The channel** (`scripts/lib/notify.js`): the only way out for the night notices. `operations.json → notify` chooses
  it; without `notify` nothing is sent. Telegram through its script; Slack and Teams through their webhook, whose address
  is never printed.
- **The text carries only counts and the link** (`daily-summary.js`): no project, repo, package, product, person, host or
  id names. The detail stays in the night snapshot and on the site.
- **The check without a session** (`scripts/site/check-deploy.js`) runs every morning before the notice; the link goes
  only if it passed.
- **The image** is published by `.github/workflows/site-image.yml` in the repo's package registry, with the harness
  version and `sha-<commit>` as tags and a provenance attestation. Each installation pins it by its digest.
