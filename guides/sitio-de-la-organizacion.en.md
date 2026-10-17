# The organization site: what it is, where it lives and how to install it

This guide is for whoever installs the site for the first time and has never seen it. It says what it is, what you need,
how to try it on your machine, and how to get it running on a cloud, on a free service or on your own machine. How each
tab is used is in the site's usage guide.

Every step in this guide comes from the code or from a real run. What has not been tested for real yet says so on the
same line.

## What it is and what it is for

It is a web page for the whole organization. Each person signs in with the organization's account and sees their own
things: their work items, their pull requests, their runs. Whoever maintains the harness sees everything, and also gets
the **Configuration** tab, where the organization is customized (who is responsible for what, the notice channel, the
thresholds).

**A real day.** At 4 in the morning the night processes run and leave their snapshot in the operations repo. A while
later the morning notice arrives (Telegram, Slack or Teams), with counts and the link to the site. The maintainer opens
the link and sees what has to be decided today. A developer signs in and sees only their own things. Nobody has to clone
or run anything on their machine to see it.

**Who uses it:**

- **Whoever maintains the harness:** installs it once, updates it deliberately, and edits the configuration from the
  Configuration tab.
- **Each person in the organization:** signs in and sees their own things.
- **Someone from another organization:** does not get in. The site only lets the organization in.

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
`microsoft`, `google` or `github`. Each one is limited to the organization: one tenant, the domain
(`SITE_AUTH_ALLOWED_DOMAINS`) or the GitHub organization. In the provider you register an application with the callback
`<site address>/auth/callback` and a secret of 6 months at most.

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

`SITE_FIRST_MAINTAINER` is not a secret: it is the email of whoever signs in first as maintainer, while the list of
maintainers (`site.maintainers` in `operations.json`) does not exist. Remove it afterwards.

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
no-store", "acepta http"); 2 if it could not ask. It waits up to 90 seconds for the first answer: a sleeping site takes a
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

- **Sign-in:** two locks. In front, the platform's built-in sign-in with the same Entra ID registration, single tenant
  and with "assignment required" (people are assigned one by one; assigning a group needs an Entra ID P1/P2 license).
  Behind it, the site's own. `/healthz` and `/livez` stay outside the lock.
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
  several replicas. **The role is recomputed on every request** (`access.js`). A maintainer is whoever is in
  `site.maintainers` of `operations.json` (or the installation's first maintainer while that list does not exist). A
  person is whoever has a machine in `people` of `operations.json`. Everyone else has no role and sees a page with no
  data.
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
