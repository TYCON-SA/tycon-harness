'use strict';

/**
 * gh-pr.test.js — el lector de un comando `gh`.
 *
 * El freno antes de publicar (scripts/hooks/public-push-guard.js) necesita saber, de un comando de terminal, qué `gh`
 * trae, a qué repo apunta, qué TEXTO publica y qué parte de ese texto no se puede leer. Lo que no puede pasar:
 *   · que un comando que publica cuente como de lectura (pasa sin que nadie lo mire);
 *   · que un texto armado por la terminal (`$(…)`, una variable, la entrada estándar) se dé por leído;
 *   · que el cuerpo de un pedido escrito en la forma que arma el agente —un bloque `cat <<'EOF'`— se frene siempre
 *     (un freno que corta el camino normal se apaga);
 *   · que la ruta de un archivo local se revise como si fuera texto publicado.
 *
 * Correr: node --test scripts/tests/gh-pr.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const gh = require(path.resolve(__dirname, '..', 'lib', 'gh-pr.js'));
const az = require(path.resolve(__dirname, '..', 'lib', 'az-pr.js'));

// armada acá: escrita de corrido, este archivo —que viaja en la copia— dispararía el detector de rutas de máquina
const LOCAL_FILE = ['', 'Users', 'alguien', 'notas', 'cuerpo.md'].join('/');

const one = (cmd) => {
  const all = gh.comandosGh(cmd);
  assert.strictEqual(all.length, 1, `esperaba un solo gh en: ${cmd}\n${JSON.stringify(all, null, 1)}`);
  return all[0];
};
const texts = (c) => c.textos.map((t) => t.texto);
const files = (c) => c.archivos.map((a) => a.ruta);

test('GhReader_NoGh_Empty_AndQuotedMentionIsNotACommand', () => {
  assert.deepStrictEqual(gh.comandosGh('git status && ls'), []);
  assert.deepStrictEqual(gh.comandosGh('echo "gh pr create --title x"'), []);
  assert.strictEqual(gh.pareceGh('git status'), false);
  assert.strictEqual(gh.pareceGh('gh pr list'), true);
  assert.strictEqual(gh.pareceGh('/opt/homebrew/bin/gh pr list'), true);
});

test('GhReader_ClosedReadList_ReadOnlyVerbsAndGroups', () => {
  for (const cmd of [
    'gh pr view 12', 'gh pr list --state open', 'gh pr status', 'gh pr checks 12 --watch', 'gh pr diff 12', 'gh pr checkout 12',
    'gh issue view 3', 'gh issue list', 'gh release view v1', 'gh release list', 'gh release download v1 -D out',
    'gh repo view', 'gh repo clone acme/widgets', 'gh auth status', 'gh --version', 'gh help pr', 'gh search prs foo',
    'gh run list', 'gh run view 5 --log', 'gh workflow list', 'gh api repos/acme/widgets/pulls', 'gh api -X GET repos/acme/widgets/pulls -f state=open',
    'gh api --method=get /repos/acme/widgets', 'gh pr create --help', 'gh browse',
  ]) assert.strictEqual(one(cmd).lectura, true, `tenía que ser de lectura: ${cmd}`);
});

test('GhReader_EverythingElsePublishes_IncludingUnknownVerbsAndAliases', () => {
  for (const cmd of [
    'gh pr create --title a --body b', 'gh pr edit 12 --title a', 'gh pr comment 12 --body a', 'gh pr review 12 --approve --body a',
    'gh pr merge 12 --merge --subject a', 'gh pr close 12 --comment a', 'gh issue create --title a --body b', 'gh issue comment 3 -b a',
    'gh release create v1 --notes a', 'gh release upload v1 a.txt', 'gh release edit v1 --notes a', 'gh gist create a.txt',
    'gh repo edit --description a', 'gh label create a', 'gh api repos/acme/widgets/issues -f title=a', 'gh api -X POST repos/acme/widgets/issues',
    'gh api repos/acme/widgets/issues --input body.json', "gh api graphql -f query='mutation { a }'", 'gh mialias --title a', 'gh pr frobnicate 1',
  ]) assert.strictEqual(one(cmd).lectura, false, `no es de lectura: ${cmd}`);
});

test('GhReader_VerbIsTheTokenNextToTheGroup_AValueCannotChooseIt', () => {
  // el verbo no se elige desde un valor: «el primer argumento que no es una opción» leía esto como `gh pr view`
  let c = one('gh pr --title view create --body x');
  assert.strictEqual(c.lectura, false);
  assert.strictEqual(c.verbo, null);
  c = one('gh pr create --title view --body x');
  assert.strictEqual(c.verbo, 'create');
  assert.strictEqual(c.lectura, false);
  // un alias con un verbo de lectura no es de lectura: puede ser cualquier comando
  assert.strictEqual(one('gh mialias view').lectura, false);
  // una opción en el lugar del grupo: no se sabe qué es, y no pide la versión ni la ayuda
  assert.strictEqual(one('gh --whatever pr view 1').lectura, false);
  // el grupo en una variable tampoco
  assert.strictEqual(one('gh "$GRUPO" view 1').lectura, false);
  assert.strictEqual(one('gh').lectura, true, '`gh` a secas imprime la ayuda');
});

test('GhReader_GroupVerbAndSummary_NeverTheText', () => {
  const c = one('gh pr create --title "un titulo" --body "un cuerpo"');
  assert.strictEqual(c.grupo, 'pr');
  assert.strictEqual(c.verbo, 'create');
  assert.strictEqual(c.resumen, 'gh pr create');
  assert.ok(!/titulo|cuerpo/.test(c.resumen));
  assert.strictEqual(one('gh api repos/acme/widgets/issues -f title=x').resumen, 'gh api');
  assert.strictEqual(one('env GH_TOKEN=x /usr/local/bin/gh.exe release create v1 --notes n').resumen, 'gh release create');
});

test('GhReader_PublishedTexts_EveryOptionValueAndPositional_NotFilePathsNorTheRepo', () => {
  let c = one('gh pr create --title "el titulo" --body="el cuerpo" --base main -R acme/widgets');
  assert.ok(texts(c).some((t) => t.includes('el titulo')));
  assert.ok(texts(c).some((t) => t.includes('el cuerpo')));
  assert.ok(!texts(c).some((t) => t.includes('acme/widgets')), 'el repo al que apunta no es texto publicado');
  c = one(`gh pr comment 12 --body-file ${LOCAL_FILE}`);
  assert.deepStrictEqual(files(c), [LOCAL_FILE]);
  assert.ok(!texts(c).some((t) => t.includes('alguien')), 'la ruta de un archivo local no se publica: se lee el archivo');
  c = one('gh release create v9 --title "la version" -F notas.md paquete.tgz "otro archivo.txt#la etiqueta"');
  assert.deepStrictEqual(files(c).sort(), ['notas.md', 'otro archivo.txt', 'paquete.tgz']);
  assert.ok(texts(c).some((t) => t.includes('la version')));
  assert.ok(texts(c).some((t) => t === 'v9'), 'la marca de la versión se publica');
  assert.ok(texts(c).some((t) => t.includes('la etiqueta')), 'la etiqueta de un adjunto se publica');
  c = one('gh release upload v9 a.bin b.bin --clobber');
  assert.deepStrictEqual(files(c).sort(), ['a.bin', 'b.bin']);
  c = one('gh gist create --public -d "la descripcion" uno.md dos.md');
  assert.deepStrictEqual(files(c).sort(), ['dos.md', 'uno.md']);
  assert.ok(texts(c).some((t) => t.includes('la descripcion')));
  c = one('gh api repos/acme/widgets/issues -f title="el titulo" -F body=@cuerpo.md --input extra.json');
  assert.deepStrictEqual(files(c).sort(), ['cuerpo.md', 'extra.json']);
  assert.ok(texts(c).some((t) => t.includes('el titulo')));
  c = one('gh api repos/acme/widgets/issues -f body=@no-es-archivo');
  assert.deepStrictEqual(files(c), [], '-f es crudo: la arroba no lee un archivo');
  assert.ok(texts(c).some((t) => t.includes('@no-es-archivo')));
  c = one('gh pr create -t "titulo corto" -b "cuerpo corto"');
  assert.ok(texts(c).some((t) => t.includes('titulo corto')) && texts(c).some((t) => t.includes('cuerpo corto')));
  c = one('gh issue create --title a --body b --template plantilla.md');
  assert.deepStrictEqual(files(c), ['plantilla.md']);
});

test('GhReader_TargetRepo_FromFlagEnvPrefixAndApiPath', () => {
  assert.strictEqual(one('gh pr create -R Acme/Widgets --title a --body b').repo, 'acme/widgets');
  assert.strictEqual(one('gh pr create --repo=acme/widgets --title a --body b').repo, 'acme/widgets');
  assert.strictEqual(one('gh pr create --repo github.com/acme/widgets --title a --body b').repo, 'acme/widgets');
  assert.strictEqual(one('gh pr create --repo https://github.com/acme/widgets.git --title a --body b').repo, 'acme/widgets');
  assert.strictEqual(one('GH_REPO=acme/widgets gh pr create --title a --body b').repo, 'acme/widgets');
  assert.strictEqual(one('env GH_REPO=acme/widgets gh issue create --title a --body b').repo, 'acme/widgets');
  assert.strictEqual(one('gh api /repos/acme/widgets/issues -f title=a').repo, 'acme/widgets');
  assert.strictEqual(one('gh api repos/acme/widgets/issues/3/comments -f body=a').repo, 'acme/widgets');
  assert.strictEqual(one('gh api repos/{owner}/{repo}/issues -f title=a').repo, null, 'con los marcadores decide la carpeta');
  assert.strictEqual(one('gh api graphql -f query=a').repo, null);
  assert.strictEqual(one('gh pr create --title a --body b').repo, null);
});

test('GhReader_Unreadable_ShellExpansionsStdinEditorAndInterpreters', () => {
  const unreadable = (cmd) => { const c = one(cmd); assert.ok(c.ilegible.length > 0, `tenía que ser ilegible: ${cmd}`); return c; };
  unreadable('gh pr create --title "x" --body "$(cat cuerpo.md)"');
  unreadable('gh pr create --title "x" --body $(cat cuerpo.md)');
  unreadable('gh pr create --title "$TITULO" --body b');
  unreadable('gh pr create --title "${TITULO}" --body b');
  unreadable('gh pr create --title x --body "`cat cuerpo.md`"');
  unreadable('gh pr create --title x --body-file -');
  unreadable('gh pr comment 12 -F -');
  unreadable('gh api repos/acme/widgets/issues --input -');
  unreadable('gh api repos/acme/widgets/issues -F body=@-');
  unreadable('gh gist create -');
  unreadable('gh pr create');
  unreadable('gh pr create --title x');
  unreadable('gh issue create --title x');
  unreadable('gh pr comment 12');
  unreadable('gh pr create --title x --body y --web');
  unreadable('gh pr comment 12 --editor');
  unreadable('gh release create "$TAG" --notes n');
  // adentro de una cadena que ejecuta otro intérprete: no se puede leer lo que va a correr
  let all = gh.comandosGh('bash -c "gh pr create --title x --body y"');
  assert.ok(all.length === 1 && all[0].ilegible.length > 0 && all[0].lectura === false);
  all = gh.comandosGh("python3 -c 'import os; os.system(\"gh issue create --title x --body y\")'");
  assert.ok(all.length === 1 && all[0].ilegible.length > 0);
  // el título y el cuerpo en una sola línea de comillas simples: nada que expandir
  const c = one("gh pr create --title 'cuesta $5' --body 'un `acento` literal'");
  assert.deepStrictEqual(c.ilegible, []);
  // lo que sí se lee no se marca
  assert.deepStrictEqual(one('gh pr create --title x --body y').ilegible, []);
  assert.deepStrictEqual(one('gh pr create --fill').ilegible, [], '--fill toma los mensajes de los commits, que ya miró el empuje');
  assert.deepStrictEqual(one('gh pr create --title x --fill-verbose').ilegible, []);
  assert.deepStrictEqual(one('gh release create v1 --generate-notes').ilegible, []);
  assert.deepStrictEqual(one('gh pr merge 12 --merge').ilegible, []);
  assert.deepStrictEqual(one('gh pr comment 12 --body-file cuerpo.md').ilegible, []);
});

test('GhReader_SelectorWithVariable_InPrAndIssue_IsNotPublishedText', () => {
  // el número de un pedido en una variable no es texto que se publica: no vuelve ilegible un comando que se puede leer
  assert.deepStrictEqual(one('gh pr merge "$PR" --merge').ilegible, []);
  assert.deepStrictEqual(one('gh pr comment $PR --body-file cuerpo.md').ilegible, []);
  assert.deepStrictEqual(one('gh pr create --title x --body y --base "$BASE" -R "$REPO"').ilegible, []);
  assert.strictEqual(one('gh pr create --title x --body y -R "$REPO"').repo, null, 'un repo que no se puede leer no es un repo explícito');
});

test('GhReader_HeredocBody_TheFormTheAgentWrites_IsRead_EvenWithQuotesInside', () => {
  const cmd = [
    'gh pr create --title "el titulo" --body "$(cat <<\'EOF\'',
    '## Resumen',
    'Un cuerpo con "comillas dobles", \'simples\', un $signo y una `tilde`.',
    '',
    'Co-Authored-By: alguien',
    'EOF',
    ')"',
  ].join('\n');
  const c = one(cmd);
  assert.deepStrictEqual(c.ilegible, [], JSON.stringify(c, null, 1));
  const body = texts(c).find((t) => t.includes('## Resumen'));
  assert.ok(body, 'el cuerpo del bloque es un texto publicado');
  assert.ok(body.includes('"comillas dobles"') && body.includes('un $signo') && body.includes('Co-Authored-By: alguien'));
  assert.ok(texts(c).some((t) => t.includes('el titulo')));
  // con el delimitador SIN comillas la terminal expande el cuerpo: sólo se lee si no hay nada que expandir
  const plain = one('gh pr comment 12 --body "$(cat <<EOF\nun cuerpo sin nada raro\nEOF\n)"');
  assert.deepStrictEqual(plain.ilegible, []);
  assert.ok(texts(plain).some((t) => t.includes('un cuerpo sin nada raro')));
  const expanded = one('gh pr comment 12 --body "$(cat <<EOF\nhola $USUARIO\nEOF\n)"');
  assert.ok(expanded.ilegible.length > 0);
  // el bloque por la entrada estándar no se lee
  const stdin = one("gh pr create --title x --body-file - <<'EOF'\ncuerpo\nEOF");
  assert.ok(stdin.ilegible.length > 0);
});

test('GhReader_EveryGhOfAChain_EachWithItsOwnFlags', () => {
  const all = gh.comandosGh('gh pr view 1 && gh pr comment 1 --body "uno" ; N=$(gh pr create --title t --body "dos") || gh issue list');
  assert.deepStrictEqual(all.map((c) => c.resumen), ['gh pr view', 'gh pr comment', 'gh pr create', 'gh issue list']);
  assert.deepStrictEqual(all.map((c) => c.lectura), [true, false, false, true]);
  assert.ok(texts(all[1]).includes('uno') && !texts(all[1]).includes('dos'));
  assert.ok(texts(all[2]).includes('dos') && !texts(all[2]).includes('uno'));
  // partido en varias líneas es UN comando
  const multi = one('gh pr create \\\n  --title "t" \\\n  --body "b"');
  assert.deepStrictEqual(multi.ilegible, []);
  assert.ok(texts(multi).includes('t') && texts(multi).includes('b'));
});

// ── formas de publicar sin que se mire (cada caso es una) ─────────────────────────────────────────────────────────────────

test('GhReader_AValueTakingOptionAlwaysTakesTheNextToken_HelpAsAValueIsNotHelp', () => {
  // `gh` toma lo que sigue a una opción con valor COMO su valor, aunque empiece con guion: esto crea un pedido cuyo
  // título es «--help». Leído como pedido de ayuda, pasaría sin que nadie mirara el cuerpo.
  let c = one('gh pr create --title --help --body "el cuerpo"');
  assert.strictEqual(c.lectura, false);
  assert.ok(texts(c).includes('--help') && texts(c).includes('el cuerpo'));
  c = one('gh pr create --title "el titulo" --body --help');
  assert.strictEqual(c.lectura, false);
  assert.ok(texts(c).includes('el titulo'));
  assert.strictEqual(one('gh pr create -t "el titulo" -b -h').lectura, false);
  // la ayuda de verdad sigue siendo de lectura: la opción suelta, no el valor de otra
  assert.strictEqual(one('gh pr create --help').lectura, true);
  assert.strictEqual(one('gh pr create --title x --body y --help').lectura, true);
  assert.strictEqual(one('gh pr create -h').lectura, true);
  // detrás de una opción que este lector no conoce no se sabe si es su valor: no cuenta como ayuda
  assert.strictEqual(one('gh pr create --odd-option --help --title x --body y').lectura, false);
});

test('GhReader_AuthorEmailIsPublishedText_SelectorsAreNot', () => {
  const c = one('gh pr merge 12 --merge --author-email alguien-de-verdad --match-head-commit abc123');
  assert.ok(texts(c).includes('alguien-de-verdad'), 'el correo del commit de merge se publica');
  assert.ok(!texts(c).includes('abc123'), 'un commit que ya existe no es texto');
  assert.ok(texts(one('gh pr merge 12 --merge -A alguien-de-verdad')).includes('alguien-de-verdad'));
});

test('GhReader_WhereItRuns_LiteralCdIsFollowed_UnknownCdAndRepoAreSaid', () => {
  // un `cd` literal antes del `gh` cambia desde dónde corre: se informa para que quien llama resuelva el repo
  let c = gh.comandosGh('cd clones/arnes && gh pr create --title a --body b').pop();
  assert.deepStrictEqual(c.cds, ['clones/arnes']);
  assert.strictEqual(c.cwdDesconocido, false);
  assert.strictEqual(c.cdIncierto, false, 'con `&&`, si el `cd` falla el `gh` no corre: se sabe dónde corre');
  // un `cd` que puede fallar sin cortar la línea (`;`, un salto, `||`): el `gh` corre en la carpeta nueva O en la de
  // antes. Se dice, para que quien llama mire las dos
  c = gh.comandosGh('cd uno; pushd dos && gh pr create --title a --body b').pop();
  assert.deepStrictEqual(c.cds, ['uno', 'dos']);
  assert.strictEqual(c.cdIncierto, true);
  assert.strictEqual(gh.comandosGh('cd uno\ngh pr create --title a --body b').pop().cdIncierto, true);
  assert.strictEqual(gh.comandosGh('cd uno || exit; gh pr create --title a --body b').pop().cdIncierto, true);
  // las formas de PowerShell son el mismo `cd`
  for (const cmd of ['Set-Location clon; gh pr create --title a --body b', 'sl clon; gh pr create --title a --body b',
    'Push-Location -Path clon; gh pr create --title a --body b', 'chdir clon; gh pr create --title a --body b']) {
    const last = gh.comandosGh(cmd).pop();
    assert.deepStrictEqual(last.cds, ['clon'], cmd);
    assert.strictEqual(last.cwdDesconocido, false, cmd);
  }
  // lo que no se puede seguir: una variable, `cd -`, `cd` a secas, `popd`
  for (const cmd of ['cd "$CLON" && gh pr create --title a --body b', 'cd - && gh pr create --title a --body b',
    'cd && gh pr create --title a --body b', 'pushd x && popd && gh pr create --title a --body b', 'cd $(pwd)/x && gh pr create --title a --body b',
    'Push-Location x; Pop-Location; gh pr create --title a --body b']) {
    assert.strictEqual(gh.comandosGh(cmd).pop().cwdDesconocido, true, cmd);
  }
  // 🔴 un `cd` que este lector ve y cuyo efecto NO llega al `gh` (un subshell, una tubería, en segundo plano) o que no
  // está donde se lo espera (adentro de un `if`, de unas llaves, entre comillas): leído como «el `gh` corre ahí»
  // manda a mirar la carpeta equivocada, y un pedido al repo público sale como si fuera de otro proyecto
  for (const cmd of ['(cd otra && true); gh pr create --title a --body b', '{ cd otra; }; gh pr create --title a --body b',
    'if cd otra; then gh pr create --title a --body b; fi', "'cd' otra; gh pr create --title a --body b",
    'cd otra | cat; gh pr create --title a --body b', 'cd otra & gh pr create --title a --body b',
    'env -C otra gh pr create --title a --body b', 'echo x | xargs gh pr create --title a --body']) {
    assert.strictEqual(gh.comandosGh(cmd).pop().cwdDesconocido, true, cmd);
  }
  c = one('gh pr create --title a --body b');
  assert.deepStrictEqual(c.cds, []);
  assert.strictEqual(c.cwdDesconocido, false);
  assert.strictEqual(c.cdIncierto, false);

  // el repo puesto antes, en otro comando de la misma línea: se informa, y se dice que no lo nombró el propio `gh`
  c = gh.comandosGh('export GH_REPO=acme/widgets; gh issue create --title a --body b').pop();
  assert.strictEqual(c.repo, 'acme/widgets');
  assert.strictEqual(c.repoAmbiente, true);
  // el que nombra el propio comando no es «de ambiente»
  for (const cmd of ['gh pr create --title a --body b -R acme/widgets', 'GH_REPO=acme/widgets gh pr create --title a --body b',
    'gh api repos/acme/widgets/issues -f title=a', 'export GH_REPO=otra/cosa; gh pr create --title a --body b --repo acme/widgets']) {
    const last = gh.comandosGh(cmd).pop();
    assert.strictEqual(last.repo, 'acme/widgets', cmd);
    assert.strictEqual(last.repoAmbiente, false, cmd);
    assert.strictEqual(last.repoDesconocido, false, cmd);
  }
  // un repo que está y no se puede leer no es «sin repo»: es desconocido. También el que se pone de una forma que este
  // lector no sigue: una asignación suelta (vale si la variable ya estaba exportada), y las formas de PowerShell
  for (const cmd of ['gh pr create --title a --body b --repo "$R"', 'GH_REPO="$R" gh pr create --title a --body b',
    'export GH_REPO=$(cat repo.txt); gh pr create --title a --body b', 'export GH_HOST=github.otra.test; gh pr create --title a --body b',
    'GH_REPO=otra-org/otro-repo\ngh issue create --title a --body b', '$env:GH_REPO = "acme/widgets"; gh issue create --title a --body b',
    '$env:GH_REPO="acme/widgets"; gh issue create --title a --body b', 'Set-Item env:GH_REPO acme/widgets; gh issue create --title a --body b',
    '(export GH_REPO=otra/cosa); gh issue create --title a --body b']) {
    const last = gh.comandosGh(cmd).pop();
    assert.strictEqual(last.repoDesconocido, true, cmd);
    assert.strictEqual(last.repo, null, cmd);
  }
});

test('GhReader_Graphql_QueryIsARead_MutationPublishes_AndItsTargetIsUnknown', () => {
  assert.strictEqual(one("gh api graphql -f query='query { viewer { login } }'").lectura, true);
  assert.strictEqual(one("gh api graphql -f query='{ viewer { login } }'").lectura, true);
  const m = one("gh api graphql -f query='mutation { addComment(input: {subjectId: \"x\", body: \"hola\"}) { clientMutationId } }'");
  assert.strictEqual(m.lectura, false);
  assert.strictEqual(m.repoDesconocido, true, 'una mutación nombra su destino por un identificador: no se sabe a qué repo va');
  // sin la consulta a la vista (un archivo, una variable) no se sabe: publica
  assert.strictEqual(one('gh api graphql -F query=@consulta.graphql').lectura, false);
  assert.strictEqual(one('gh api graphql -f query="$Q"').lectura, false);
});

test('GhReader_TheBinaryCannotHideBehindQuotesOrAnExpansion', () => {
  // con comillas en el medio es el mismo programa
  assert.strictEqual(gh.pareceGh('g""h pr create --title a --body b'), true);
  assert.strictEqual(one('g""h pr create --title a --body b').resumen, 'gh pr create');
  assert.strictEqual(one("'gh' pr create --title a --body b").lectura, false);
  // el programa en una variable o en una sustitución, con la forma de un `gh` que publica: no se sabe qué corre
  for (const cmd of ['$GH pr create --title a --body b', '"$GH" issue comment 3 --body a', '$(which gh) pr create --title a --body b',
    '`which gh` release create v1 --notes a']) {
    assert.strictEqual(gh.pareceGh(cmd), true, cmd);
    const all = gh.comandosGh(cmd);
    assert.ok(all.length >= 1 && all.some((c) => !c.lectura && c.ilegible.length > 0), `${cmd}\n${JSON.stringify(all)}`);
  }
  // con OTRO nombre, puesto en la misma línea: un alias o una función que envuelve a `gh`. La línea nombra a `gh` y
  // otro programa corre con la forma de un `gh` que publica: no se sabe qué corre
  for (const cmd of ['alias g=gh; g pr create --title a --body b', "alias pub='gh pr'; pub create --title a --body b",
    'Set-Alias g gh; g issue comment 3 --body a', 'function g { gh @args }; g pr create --title a --body b',
    'g() { command gh "$@"; }; g release create v1 --notes a']) {
    const all = gh.comandosGh(cmd);
    assert.ok(all.some((c) => !c.lectura && c.ilegible.length > 0), `${cmd}\n${JSON.stringify(all)}`);
  }
  // una variable delante de otra cosa no es un `gh`; ni otro programa con esa forma en una línea que no nombra a `gh`
  assert.deepStrictEqual(gh.comandosGh('$EDITOR notas.md'), []);
  assert.deepStrictEqual(gh.comandosGh('"$NODE" build/check.js'), []);
  assert.deepStrictEqual(gh.comandosGh('glab issue create --title a'), []);
  // y junto a un `gh` de lectura, un programa cualquiera sigue siendo un programa cualquiera
  assert.deepStrictEqual(gh.comandosGh('gh pr view 12 && npm run build').filter((c) => !c.lectura), []);
});

test('GhReader_AGhGivenAsTextToAShell_IsHidden_TextGivenToAnythingElse_IsData', () => {
  // QUÉ CUBRE Y QUÉ NO (decisión de diseño): el freno cubre el ACCIDENTE —un `gh` que publica,
  // corrido de cualquiera de las formas en que se corre un comando—, no la EVASIÓN. Un `gh` pasado como TEXTO A UNA
  // TERMINAL (`bash -c "gh …"`, `iex`, `cmd /c`, `eval`, por una tubería, un bloque o un texto de entrada hacia una
  // terminal, `xargs`, `ssh`) es una forma común de correrlo: no se puede leer, no sale. El mismo texto dado a
  // cualquier otro programa es un dato. Frenar todo texto con esa forma salvo en
  // una lista de programas «inofensivos» frenaría `sed`, `npm test -t "…"`, un `python3 - <<EOF` que edita una guía,
  // en CUALQUIER repo — y un freno que corta el trabajo de todos los días se apaga.
  const hidden = (cmd) => gh.comandosGh(cmd).some((c) => !c.lectura && c.ilegible.length > 0);
  for (const cmd of [
    'bash -c "gh pr create --title a --body b"', 'zsh -lc "gh pr create --title a --body b"', 'sudo -u otro sh -c "gh issue comment 3 --body a"',
    'iex "gh pr create --title a --body b"', "Invoke-Expression 'gh issue comment 3 --body a'", 'cmd /c "gh pr create --title a --body b"',
    'pwsh -Command "gh release create v1 --notes a"', 'eval "gh pr create --title a --body b"', 'ssh otra-maquina "gh pr create --title a --body b"',
    'timeout 30 bash -c "gh pr create --title a --body b"', "alias x='gh pr create --title a --body b'; x", 'CMD="gh pr create --title a --body b"; $CMD',
    'export CMD="gh pr create --title a --body b"; eval "$CMD"',
    // con comillas adentro del texto, es el mismo comando
    "sh -c 'gh \"pr\" create --title a --body b'", 'sh -c "g\'\'h pr create --title a --body b"',
    // los grupos que también publican
    "sh -c 'gh project item-create 1 --title a'", "bash -c 'gh secret set X --body a'", "bash -c 'gh variable set X --body a'",
    // por una tubería hacia una terminal (también `|&`, con un salto de línea después, o con paréntesis)
    "printf 'gh pr create --title a --body b' | bash", 'echo "gh pr create --title a --body b" | sh', 'echo "gh issue comment 3 --body a" | xargs -I{} sh -c {}',
    'cat guion.txt | grep "gh pr create" | zsh', "echo 'gh pr create --title a --body b' |& bash", "echo 'gh pr create --title a --body b' |\nbash",
    "echo 'gh pr create --title a --body b' | (bash)", "echo 'gh pr create --title a --body b' | tee copia.txt | sh",
    // por un bloque heredoc o un texto de entrada hacia una terminal (con espacio o con número de descriptor)
    "bash <<'EOF'\ngh pr create --title a --body b\nEOF", "bash << 'EOF'\ngh pr create --title a --body b\nEOF", 'sh <<EOF\n  gh api repos/acme/widgets/issues -f title=a\nEOF',
    'bash <<< "gh pr create --title a --body b"', "bash -c \"$(cat <<'EOF'\ngh pr create --title a --body b\nEOF\n)\"",
    "bash 3<<'EOF'\ngh pr create --title a --body b\nEOF", "bash<<'EOF'\ngh pr create --title a --body b\nEOF",
    'bash <<EOF\ngh pr create --title a --body b\n',   // sin su línea de cierre: la terminal corre igual lo que sigue
    // código de una línea que lo EJECUTA, en el lenguaje que sea (se reconoce por la llamada)
    "python3 -c 'import os; os.system(\"gh issue create --title a --body b\")'", "python3 - <<'PY'\nimport subprocess\nsubprocess.run(\"gh pr create --title a --body b\", shell=True)\nPY",
    "node -e 'require(\"child_process\").execSync(\"gh pr create --title a --body b\")'", "perl -e 'system(\"gh release create v1 --notes a\")'",
    // …con el programa y sus argumentos por separado, y con un texto con huecos
    "python3 -c \"import subprocess; subprocess.run(['gh','pr','create','--title','a','--body','b'])\"",
    "node -e \"require('child_process').execFileSync('gh',['pr','create','-t','a','-b','b'])\"", "python3 -c 'import os; os.system(f\"gh pr create --title {t} --body b\")'",
    // otras formas de darle el texto a una terminal
    'env -S "gh pr create --title a --body b"', '$SHELL -c "gh pr create --title a --body b"', 'parallel "gh pr comment {} -b hola" ::: 1 2',
    'su otro -c "gh pr create --title a --body b"',
    // los argumentos del `gh` llegan por la entrada: un `gh` a secas no es «la ayuda» si otro programa le agrega el resto
    'echo "pr create -t a -b b" | xargs gh',
    // detrás de un alias o de una variable, también `api` y `repo edit`
    'alias g=gh; g api repos/acme/widgets/issues -f title=a', 'G=gh; $G repo edit --description "a"',
  ]) assert.ok(hidden(cmd), `tenía que ser oculto: ${cmd}\n${JSON.stringify(gh.comandosGh(cmd))}`);
  // un `gh` de LECTURA pasado a una terminal se lee como tal: no se frena
  for (const cmd of ['bash -c "gh pr view 5"', "ssh otra-maquina 'gh pr list'", 'echo "gh pr checks 12" | sh',
    "grep -l \"gh pr create\" docs/*.md | xargs sed -i '' 's/a/b/'"]) {
    assert.deepStrictEqual(gh.comandosGh(cmd).filter((c) => !c.lectura), [], `no tenía que frenarse: ${cmd}`);
  }
  // 🔴 Las gemelas del código de una línea. El comando que la llamada corre se LEE: uno de lectura no se frena. Y el
  // mismo código dado a un programa que no es un intérprete es un DATO (buscar `execSync("gh pr` en el código
  // se frenaría en cualquier repo: se frenaría por la llamada sola, con cualquier programa y cualquier verbo).
  for (const cmd of ["python3 -c 'import os; os.system(\"gh pr view 5\")'", "node -e 'require(\"child_process\").execSync(\"gh pr list\")'",
    "python3 -c \"import subprocess; subprocess.run(['gh','pr','view','5'])\"", "perl -e 'system(\"gh\", \"release\", \"view\", \"v1\")'",
    "python3 - <<'PY'\nimport subprocess\nsubprocess.run(\"gh pr checks 5\", shell=True)\nPY", "echo 'import os; os.system(\"gh pr view 5\")' | python3",
    "grep -rn 'execSync(\"gh pr create' scripts/", "grep 'execSync(\"gh pr' .", "git commit -m 'el guion hace run(\"gh pr create\") y sigue'",
    "echo 'subprocess.run([\"gh\", \"pr\", \"create\"])' > notas.md",
    "cat > guion.py <<'PY'\nimport subprocess\nsubprocess.run(\"gh pr create --title a --body b\", shell=True)\nPY"]) {
    assert.deepStrictEqual(gh.comandosGh(cmd), [], `no tenía que frenarse: ${cmd}`);
  }
  // …y las que sí: por una tubería (también a través de otro programa), con el intérprete por su ruta o detrás de un
  // lanzador, con una lectura ANTES de la que publica, y con comillas escapadas adentro del texto
  for (const cmd of ["echo 'import os; os.system(\"gh pr create --fill\")' | python3", "echo 'os.system(\"gh pr create --fill\")' | tee x.py | python3 -",
    "uv run python -c 'import os; os.system(\"gh issue create --title a\")'", "/usr/bin/python3.12 -c 'import os; os.system(\"gh issue create --title a\")'",
    "node -e 'const {execSync}=require(\"child_process\"); execSync(\"gh pr view 5\"); execSync(\"gh pr merge 5 --squash\")'",
    "python3 -c 'import os; os.system(\"gh pr create --title \\\"a\\\" --body b\")'", "perl -e 'system(\"gh\", \"release\", \"create\", \"v1\")'",
    // 🔴 en la lista, una VARIABLE ocupa su lugar: cortar la lista ahí dejaría `gh --repo`, que se leería «de lectura»
    "python3 -c 'import subprocess; subprocess.run([\"gh\",\"--repo\",repo,\"pr\",\"create\"])'", "python3 -c 'import subprocess; subprocess.run([\"gh\",\"-R\",repo,\"pr\",\"create\"])'",
    "python3 -c 'import subprocess; subprocess.run([\"gh\",\"api\",url,\"-X\",\"POST\"])'", "python3 -c 'import subprocess; subprocess.run([\"gh\",\"api\",\"-X\",\"POST\",url])'",
    "python3 -c 'import subprocess; subprocess.run([\"gh\",\"--repo=\" + repo,\"pr\",\"create\"])'",
    // un texto al que se le pega algo, cuando lo escrito todavía no trae su grupo: se arma al correr
    "python3 -c 'import os; os.system(\"gh --repo \" + repo + \" pr create\")'",
    // sin paréntesis, y sin comillas, como se escribe en ruby y en perl; y detrás de un lanzador con una opción
    "ruby -e 'system \"gh pr create --title x --body y\"'", "ruby -e 'puts %x(gh pr create --title x)'", "perl -e 'print qx{gh release create v1}'",
    "sudo -E python3 -c 'import os; os.system(\"gh pr create --fill\")'",
    // 🔴 la lista se parte por las comas de AFUERA: una coma, un paréntesis o un corchete adentro de un texto o de una
    // llamada no cortan (si cortaran, se perdería la cuenta, no se vería el grupo y se descartaría la lista entera)
    "python3 -c 'subprocess.run([\"gh\",\"--repo\",f(\")\"),\"pr\",\"create\"])'", "python3 -c 'subprocess.run([\"gh\",\"--repo\",d[\"a]\"],\"pr\",\"create\"])'",
    "python3 -c 'subprocess.run([\"gh\",\"pr\",\"create\",\"--title\",\"a\" + \",b\"])'",
    // …y un texto con algo pegado no es el valor: no se puede leer
    "python3 -c 'subprocess.run([\"gh\",\"pr\",\"view\" if x else \"create\"])'", "python3 -c 'subprocess.run([\"gh\",\"api\",url,\"-X\"+m])'",
    "node -e \"require('child_process').execFileSync('gh', ['pr', 'create', '--title', t])\"",
    // tres comillas (leídas como un texto vacío, el comando quedaría afuera), y los otros delimitadores de `qx`
    "python3 -c 'import os; os.system(\"\"\"gh pr create --title t --body b\"\"\")'", "python3 -c 'import subprocess; subprocess.run(f\"\"\"gh pr create --title {t} --body b\"\"\", shell=True)'",
    "perl -e 'print qx/gh pr create --title a/'", "perl -e 'print qx[gh pr create --title a]'", "ruby -e 'puts %x<gh pr create --title a>'",
    "ruby -e 'puts %x|gh pr create --title a|'", "ruby -e 'puts %x!gh pr create --title a!'",
    // el intérprete con una opción justo delante: detrás de uno que lanza intérpretes, o con su opción de código después
    "npx -y tsx -e 'require(\"child_process\").execSync(\"gh pr create --title a --body b\")'", "uv run --no-project python -c 'import os; os.system(\"gh pr create --fill\")'",
    "echo 'import os; os.system(\"gh pr create --fill\")' | uv run --no-project python", "timeout 30 python3 -c 'import os; os.system(\"gh pr create --fill\")'",
    "sudo -E python3 - <<'PY'\nimport os\nos.system(\"gh pr create --fill\")\nPY", "node --input-type=module --eval 'import {execSync} from \"child_process\"; execSync(\"gh pr create --fill\")'",
    // las tres comillas: simples, sin cerrar, y con algo pegado cuando lo escrito todavía no trae su grupo
    "python3 -c \"import os; os.system('''gh pr create --title t''')\"", "python3 -c 'import os; os.system(\"\"\"gh pr create --title t'",
    "python3 -c 'import os; os.system(\"\"\"gh --repo \"\"\" + r + \" pr create\")'"]) {
    assert.ok(hidden(cmd), `tenía que ser oculto: ${cmd}\n${JSON.stringify(gh.comandosGh(cmd))}`);
  }
  // el nombre de un lenguaje como valor de la opción de TIPO de un buscador no es un intérprete, traiga lo que traiga después
  for (const cmd of ["rg -t ruby -e 'system(\"gh pr create\")' lib/", "time rg --type ruby 'system(\"gh pr create\")'", "rg -g node 'execSync(\"gh pr create\")'"]) {
    assert.deepStrictEqual(gh.comandosGh(cmd), [], `no tenía que frenarse: ${cmd}`);
  }
  // una lista larga se lee entera: el grupo puede venir después de muchas opciones
  const largo = Array.from({ length: 45 }, (_, k) => `"--label","l${k}"`).join(',');
  assert.ok(hidden(`python3 -c 'subprocess.run(["gh",${largo},"pr","create"])'`), 'una lista de más de 40 argumentos');
  for (const cmd of ["python3 -c 'import os; os.system(\"\"\"gh pr view 5\"\"\")'", "python3 -c 'subprocess.run([\"gh\",\"pr\",\"view\",d[k]])'",
    "for f in a; do rg -t ruby 'system(\"gh pr create\")' $f; done", "time rg -t ruby 'system(\"gh pr create --title x\")'"]) {
    assert.deepStrictEqual(gh.comandosGh(cmd), [], `no tenía que frenarse: ${cmd}`);
  }
  // …con sus gemelas: la variable en una lectura, una lista de nombres, y el nombre de un intérprete que es el valor
  // de una opción de un buscador (`rg -t ruby`) o que viene después del código (una carpeta que se llama `node`)
  for (const cmd of ["python3 -c 'import subprocess; subprocess.run([\"gh\",\"pr\",\"view\",str(n)])'", "python3 -c 'import subprocess; subprocess.run([\"gh\",\"api\",url])'",
    "python3 -c 'herramientas = [\"gh\", \"jq\", \"git\"]; print(herramientas)'", "python3 -c 'import os; os.system(\"gh pr view \" + str(n))'",
    "perl -e 'system \"gh pr view 5\"'", "ruby -e 'puts %x(gh pr list)'", "rg -t ruby 'system(\"gh pr create --title x\")'", "grep -rn 'system(\"gh pr create\")' node",
    "python3 - <<'PY'\ntexto = 'correr `gh pr create --fill` y listo'\nopen('guia.md','w').write(texto)\nPY"]) {
    assert.deepStrictEqual(gh.comandosGh(cmd), [], `no tenía que frenarse: ${cmd}`);
  }
  // 🔴 una opción CONOCIDA entre comillas es la misma opción (las comillas las saca la terminal): con `"-X" POST` tomado
  // por un argumento, un `gh api` que escribe quedaría «de lectura»
  for (const cmd of ['gh api "-X" POST repos/acme/widgets/issues', 'gh api "--method" POST repos/acme/widgets/issues', 'gh api repos/acme/widgets/issues "-f" title=a']) {
    assert.deepStrictEqual(gh.comandosGh(cmd).map((c) => c.lectura), [false], cmd);
  }
  assert.deepStrictEqual(gh.comandosGh('gh api "-XGET" repos/acme/widgets/issues').map((c) => c.lectura), [true]);
  // …y el valor de una opción sigue siendo un valor, parezca lo que parezca
  assert.deepStrictEqual(texts(gh.comandosGh('gh issue create --title "-X" --body "--title"')[0]).sort(), ['--title', '-X']);
  // 🔴 un `<<PALABRA` adentro de una cadena no abre un bloque: el lector se tragaría como «cuerpo» los renglones de
  // abajo, y el `gh` que venga ahí saldría sin mirar (lo resuelve az-pr.js, que es de donde salen las fichas)
  const below = gh.comandosGh('echo "ejemplo: cat <<EOF"\ngh pr create --title a --body b');
  assert.strictEqual(below.length, 1, JSON.stringify(below));
  assert.strictEqual(below[0].resumen, 'gh pr create');
  assert.strictEqual(below[0].lectura, false);
  // y un bloque de verdad sigue siendo texto: el `gh` de DESPUÉS del bloque se lee
  const after = gh.comandosGh("cat > notas.md <<'EOF'\nuna nota\nEOF\ngh pr create --title a --body b");
  assert.deepStrictEqual(after.map((c) => c.resumen), ['gh pr create']);
  // una barra al final del renglón une los renglones sin dejar espacio: `g\<salto>h` es `gh`
  assert.strictEqual(gh.pareceGh('g\\\nh pr create --title a --body b'), true);
  // los gemelos: el mismo texto, dado a algo que no es una terminal. Son comandos de todos los días.
  for (const cmd of [
    'git commit -m "docs: cómo usar gh pr create"', 'grep -rn "gh pr create" guides | head -5', 'rg "gh api repos" scripts | wc -l',
    'echo "ahora corré gh pr create --fill"', "cat > notas.md <<'EOF'\nusar gh pr create --fill\nEOF", 'printf "gh pr create\\n" >> notas.md',
    'git log --grep "gh release create" --oneline | cat', "sed -n '/gh pr create/p' docs/x.md", 'grep -rn "gh pr create" . | sed -e s/a/b/ | sort | uniq -c',
    'npm test -- -t "gh pr create"', 'node --test --test-name-pattern="gh pr create" scripts/tests/gh-pr.test.js',
    "python3 - <<'PY'\ntexto = 'usar gh pr create --fill'\nprint(texto)\nPY", 'MSG="usar gh pr create"; git commit -m "$MSG"',
    'bash -c "echo listo"', 'grep -c "gh pr create" guion.sh | cat',
  ]) assert.deepStrictEqual(gh.comandosGh(cmd).filter((c) => !c.lectura), [], `no tenía que ser oculto: ${cmd}`);
  // y adentro del texto de un `gh` leído, es texto de ESE comando (se revisa como tal): no esconde otro
  const own = gh.comandosGh('gh pr comment 12 --body "después corré gh pr create"');
  assert.strictEqual(own.length, 1);
  assert.deepStrictEqual(own[0].ilegible, []);
});

test('GhReader_OptionsBeforeTheGroup_AndGhAsAName_NotAsAProgram', () => {
  // `gh` acepta opciones ANTES del grupo (`gh -R a/b pr create`). Las puertas de «un texto con un `gh` que publica»
  // exigir el grupo pegado a `gh` haría que, con una opción en el medio, el texto ni se leyera y saliera sin mirar.
  const hidden = (cmd) => gh.comandosGh(cmd).some((c) => !c.lectura && c.ilegible.length > 0);
  for (const cmd of ['bash -c "gh -R a/b pr create --title a --body b"', "ssh otra 'gh --repo a/b issue comment 3 --body a'",
    'echo "gh -R a/b pr create --title a --body b" | sh', "sh <<EOF\ngh -R a/b pr create --title a --body b\nEOF",
    'C="gh -R a/b pr create --title a --body b"; eval $C', "alias pub='gh -R a/b pr'; pub create --title a --body b",
    'alias g=gh; g -R a/b pr create --title a --body b', '$GH --repo a/b issue create --title a --body b',
    // adentro del texto valen las mismas reglas que afuera: una variable, un alias, una función
    'bash -c "G=gh; \\$G pr create --title a --body b"', 'bash -c "alias g=gh; g pr create --title a --body b"',
    // y en el código de una línea, `gh` puede no ser lo primero del texto ni el grupo lo segundo de la lista
    "python3 -c 'import os; os.system(\"cd repo && gh pr create --title a --body b\")'",
    "python3 -c \"import subprocess; subprocess.run(['gh','-R','a/b','issue','create','--title','a'])\"",
    "node -e \"require('child_process').execFileSync('/usr/bin/gh',['pr','create','-t','a','-b','b'])\"",
  ]) assert.ok(hidden(cmd), `tenía que ser oculto: ${cmd}\n${JSON.stringify(gh.comandosGh(cmd))}`);
  // directo, con la opción antes del grupo, se LEE (y el repo es el que nombra)
  const direct = one('gh -R acme/widgets pr create --title a --body b');
  assert.strictEqual(direct.lectura, false);
  assert.strictEqual(direct.repo, 'acme/widgets');
  // 🔴 y `gh` como NOMBRE no es un comando: tomado siempre por el programa, `brew install gh jq` sería «un `gh`
  // desconocido que publica», y en una máquina del equipo sin la lista no correría
  for (const cmd of ['which gh', 'command -v gh >/dev/null 2>&1 || echo falta', 'brew install gh jq git', 'type gh', 'bash -c "echo gh"',
    'ssh otra "which gh"', 'alias g=gh', 'apt-get install -y gh']) {
    assert.deepStrictEqual(gh.comandosGh(cmd).filter((c) => !c.lectura), [], `no es un gh que publica: ${cmd}`);
  }
  // cuando otro programa SÍ lo corre, se lee como siempre
  assert.strictEqual(gh.comandosGh('timeout 30 gh pr view 5').pop().lectura, true);
  assert.deepStrictEqual(texts(gh.comandosGh('xargs gh pr comment 1 --body hola').pop()).sort(), ['1', 'hola']);
  assert.strictEqual(gh.comandosGh('mi-envoltorio gh pr create --title a --body b').pop().resumen, 'gh pr create');
  assert.strictEqual(gh.comandosGh('if true; then gh pr create --title a --body b; fi').pop().resumen, 'gh pr create');
  // las redirecciones no son texto del comando, y lo que corre DESPUÉS del `gh` no puede cambiarle el archivo
  const piped = gh.comandosGh('gh pr create --title a --body-file f.md 2>&1 | tail -3').shift();
  assert.deepStrictEqual(texts(piped), ['a']);
  assert.strictEqual(piped.otros, 0, 'un `| tail` después no cuenta: corre cuando el `gh` ya leyó su archivo');
  assert.deepStrictEqual(texts(one('gh pr create --title a --body b >/dev/null')).sort(), ['a', 'b']);
  // el comando partido con una barra al final del renglón es UN comando (`g\<salto>h` es `gh`)
  assert.strictEqual(one('g\\\nh pr create --title a --body b').resumen, 'gh pr create');
  assert.strictEqual(one('gh pr cre\\\nate --title a --body b').verbo, 'create');
  // un bloque con delimitador con barra o con guiones es un bloque (su cuerpo no se parte en comandos), y un `<<`
  // adentro de una cuenta no lo es
  assert.deepStrictEqual(gh.comandosGh("cat > f <<\\EOF\ndon't\nEOF\ngh pr create --title a --body b").map((c) => c.resumen), ['gh pr create']);
  assert.deepStrictEqual(gh.comandosGh("cat > f <<'FIN-1'\ndon't\nFIN-1\ngh pr create --title a --body b").map((c) => c.resumen), ['gh pr create']);
  assert.deepStrictEqual(gh.comandosGh('echo $((1<<b))\ngh pr create --title a --body b').map((c) => c.resumen), ['gh pr create']);
});

test('GhReader_ACdThatMayNotHaveRun_OrThatTheShellExpands_IsNotTakenForGranted', () => {
  // con un `||` antes en la misma lista, el `cd` puede no correr aunque lo siga un `&&`
  assert.strictEqual(gh.comandosGh('true || cd /tmp && gh pr create --title a --body b').pop().cdIncierto, true);
  assert.strictEqual(gh.comandosGh('test -d x || mkdir x; cd x && gh pr create --title a --body b').pop().cdIncierto, false, 'el `;` corta la lista: el `||` de antes no cuenta');
  assert.strictEqual(gh.comandosGh('git fetch && cd clon && gh pr create --title a --body b').pop().cdIncierto, false);
  // una ruta que la terminal arma al correr (un comodín, llaves, `~usuario`) no es la carpeta que se lee en el texto
  for (const cmd of ['cd ~/SourceCode/tycon-* && gh pr create --title a --body b', 'cd ~otro/clon && gh pr create --title a --body b',
    'cd clon{1,2} && gh pr create --title a --body b', 'cd clo? && gh pr create --title a --body b', 'cd [c]lon && gh pr create --title a --body b']) {
    assert.strictEqual(gh.comandosGh(cmd).pop().cwdDesconocido, true, cmd);
  }
  // `~` y `~/algo` sí se saben leer
  assert.deepStrictEqual(gh.comandosGh('cd ~/clon && gh pr create --title a --body b').pop().cds, ['~/clon']);
});

test('GhReader_OtherCommandsOnTheSameLine_AreCounted', () => {
  // quien llama necesita saber si el `gh` corre solo: otro comando de la misma línea puede escribir el archivo que
  // el `gh` va a leer, después de que se lo miró
  assert.strictEqual(one('gh pr create --title a --body-file cuerpo.md').otros, 0);
  assert.strictEqual(gh.comandosGh('echo hola > cuerpo.md && gh pr create --title a --body-file cuerpo.md').pop().otros, 1);
  assert.strictEqual(gh.comandosGh('git push -u origin rama && gh pr create --fill').pop().otros, 1);
  // un `cd` o poner el repo no cuentan: no escriben archivos
  assert.strictEqual(gh.comandosGh('cd x && gh pr comment 1 --body-file c.md').pop().otros, 0);
  assert.strictEqual(gh.comandosGh('export GH_REPO=acme/widgets; gh pr comment 1 --body-file c.md').pop().otros, 0);
  // 🔴 otro `gh` SÍ cuenta: uno de lectura también escribe archivos (con una redirección, `gh release download`)
  assert.strictEqual(gh.comandosGh('gh pr view 5 > c.md && gh pr comment 5 --body-file c.md').pop().otros, 1);
  assert.strictEqual(gh.comandosGh('cd x && gh release download v1 && gh pr comment 1 --body-file c.md').pop().otros, 1);
});

test('GhReader_WhatTheAdversarialPassFound_EachOneLeftTheGuardGreenWithoutLooking', () => {
  const hidden = (cmd, o) => gh.comandosGh(cmd, 0, o).some((c) => !c.lectura && c.ilegible.length > 0);
  const last = (cmd, o) => gh.comandosGh(cmd, 0, o).pop();
  // una sustitución ENTRE COMILLAS DOBLES es un comando que corre: lo de adentro se lee como una línea más
  for (const cmd of ['URL="$(gh pr create --title a --body b)"', 'echo "listo: $(gh pr create --title a --body b)"', 'echo "`gh issue comment 3 --body a`"']) {
    const all = gh.comandosGh(cmd);
    assert.ok(all.some((c) => !c.lectura && texts(c).includes('a')), `${cmd}\n${JSON.stringify(all)}`);
  }
  assert.deepStrictEqual(gh.comandosGh('echo "$(gh pr view 5 --json title)"').filter((c) => !c.lectura), [], 'una de lectura adentro sigue siendo de lectura');
  // …con SUS comillas adentro (otro contexto de comillas: partido tal cual, la primera de adentro cerraría la cadena)
  const nested = gh.comandosGh('URL="$(gh pr create --title "dos palabras" --body "un cuerpo")"; echo "$URL"').filter((c) => !c.lectura);
  assert.strictEqual(nested.length, 1, JSON.stringify(nested));
  assert.deepStrictEqual(texts(nested[0]).sort(), ['dos palabras', 'un cuerpo']);
  assert.deepStrictEqual(nested[0].ilegible, []);
  // y con el cuerpo en un bloque adentro de la sustitución
  const deep = gh.comandosGh("X=\"$(gh pr create --title a --body \"$(cat <<'EOF'\nun cuerpo\nEOF\n)\")\"").filter((c) => !c.lectura);
  assert.deepStrictEqual(texts(deep[0]).sort(), ['a', 'un cuerpo']);
  // el `gh` de afuera con su valor en una sustitución sigue siendo ilegible (el texto lo arma la terminal)
  assert.ok(hidden('gh pr comment 5 --body "$(cat notas.md)"'));
  // 🔴 Un comentario y el cuerpo de un bloque de OTRO comando no son código: un apóstrofo ahí («don't») no abre una
  // cadena. Recorridos como código esconderían la sustitución con el `gh` que viene después, y saldría sin mirar.
  for (const cmd of ["# don't forget the body\nURL=\"$(gh pr create --title a --body b)\"",
    "git commit -F - <<'EOF'\ndon't\nEOF\nURL=\"$(gh pr create --title a --body b)\"",
    "cat > notas.md <<\\FIN\nit's\nFIN\necho \"$(gh pr create --title a --body b)\"", "echo \"it's $(gh pr create --title a --body b)\""]) {
    const found = gh.comandosGh(cmd).filter((c) => !c.lectura && c.resumen === 'gh pr create');
    assert.strictEqual(found.length, 1, `${cmd}\n${JSON.stringify(gh.comandosGh(cmd))}`);
    assert.deepStrictEqual(texts(found[0]).sort(), ['a', 'b']);
  }
  // una sustitución adentro de otra
  const twice = gh.comandosGh('echo "$(basename "$(gh pr create --title a --body b)")"').filter((c) => !c.lectura);
  assert.deepStrictEqual(twice.map((c) => c.resumen), ['gh pr create']);
  // el cuerpo de un bloque que la terminal EXPANDE (delimitador sin comillas): una sustitución ahí adentro corre
  assert.deepStrictEqual(gh.comandosGh('cat <<EOF\nla dirección: $(gh pr create --title a --body b)\nEOF').filter((c) => !c.lectura).map((c) => c.resumen), ['gh pr create']);
  assert.deepStrictEqual(gh.comandosGh("cat <<'EOF'\nla dirección: $(gh pr create --title a --body b)\nEOF"), [], 'con el delimitador entre comillas es texto');
  // tres niveles se leen; con uno más ya no se sigue, y cae en la red: «no pude leer», nunca «no hay ningún `gh`»
  const thrice = gh.comandosGh('echo "$(echo "$(basename "$(gh pr create --title a --body b)")")"').filter((c) => !c.lectura);
  assert.deepStrictEqual(thrice.map((c) => c.resumen), ['gh pr create']);
  assert.deepStrictEqual(texts(thrice[0]).sort(), ['a', 'b']);
  // 🔴 la red: una sustitución que nombra a `gh` y no se pudo sacar (sin cerrar, o demasiado adentro) es «no pude leer»
  for (const cmd of ['echo "$(echo "$(echo "$(basename "$(gh pr create --title a --body b)")")")"', 'URL="$(gh pr create --title a --body b',
    'echo "$(gh pr create --title a --body b"']) {
    const net = gh.comandosGh(cmd).filter((c) => c.ilegible.length);
    assert.ok(net.length > 0, `tenía que ser oculto: ${cmd}\n${JSON.stringify(gh.comandosGh(cmd))}`);
    assert.match(net[0].ilegible.join(' '), /adentro de una sustitución/);
  }
  // una sustitución que no nombra a gh no molesta
  assert.deepStrictEqual(gh.comandosGh('echo "hay $(ls | wc -l) archivos" && gh pr view 5').filter((c) => !c.lectura), []);
  // un contenido en base64 que no es texto (una imagen por la API de contenidos): no se puede leer
  assert.ok(hidden('gh api -X PUT repos/acme/widgets/contents/a.png -f message=m -f content=/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U'));
  // el repo nombrado por un ARGUMENTO (con una dirección, `gh` ignora la carpeta)
  assert.strictEqual(last('gh pr comment https://github.com/acme/widgets/pull/5 --body hola').repo, 'acme/widgets');
  assert.strictEqual(last('gh issue close https://github.com/acme/widgets/issues/7 --comment hola').repo, 'acme/widgets');
  assert.strictEqual(last('gh repo edit acme/widgets --description hola').repo, 'acme/widgets');
  assert.strictEqual(last('gh api https://api.github.com/repos/acme/widgets/issues -f title=a').repo, 'acme/widgets');
  assert.strictEqual(last('gh pr comment 5 --body hola').repo, null);
  // `gh api` que escribe: la ruta también se publica (el nombre del archivo), y un campo en base64 se mira descifrado
  const put = last('gh api -X PUT repos/acme/widgets/contents/docs/secreto.md -f message=m -f content=aG9sYSBab3JibGF4IHF1ZSB0YWwgY29tbyBhbmRhcw==');
  assert.ok(texts(put).includes('repos/acme/widgets/contents/docs/secreto.md'), 'la ruta');
  assert.ok(texts(put).some((t) => /hola Zorblax/.test(t)), 'el contenido, descifrado');
  assert.ok(!texts(last('gh api repos/acme/widgets/issues')).length, 'una lectura no suma su ruta');
  // el bloque pegado a `clave=` en un campo: se revisa su cuerpo, no la marca al azar que lo reemplaza
  const field = last("gh api repos/acme/widgets/issues -f title=a -f body=\"$(cat <<'EOF'\nun cuerpo con nombre\nEOF\n)\"");
  assert.ok(texts(field).includes('body=un cuerpo con nombre'), JSON.stringify(texts(field)));
  assert.ok(!texts(field).some((t) => /ghprbloque/.test(t)), 'la marca no llega al texto revisado');
  // el bloque se corta donde lo corta la terminal: en el primer renglón que es el delimitador, sin sangría
  assert.ok(hidden("gh pr create --title a --body \"$(cat <<'EOF'\nuno\nEOF\ndos\nEOF\n)\""), 'un EOF adentro: lo leído no es lo publicado');
  assert.ok(hidden("gh pr create --title a --body \"$(cat <<'EOF'\nuno\n  EOF\n)\""), 'el cierre con sangría no cierra');
  assert.deepStrictEqual(texts(last("gh pr create --title a --body \"$(cat <<'EOF'\nuno\ndos\nEOF\n)\"")).sort(), ['a', 'uno\ndos']);
  // lo que la lista general da por lectura y escribe
  assert.ok(hidden('gh label clone otra-org/otro-repo'), 'copia etiquetas de otro repo: ese texto no está en el comando');
  assert.strictEqual(last('gh workflow run despliegue.yml -f nota=hola').lectura, false);
  assert.strictEqual(last('gh workflow list').lectura, true);
  assert.strictEqual(last("gh api graphql -f query='{ viewer { login } }' --input mutacion.json").lectura, false, 'con --input lo que se manda es el archivo');
  assert.strictEqual(last("gh api graphql -f query='{ viewer { login } }'").lectura, true);
  // `--help=false` no es un pedido de ayuda
  assert.strictEqual(last('gh pr create --help=false --title a --body b').lectura, false);
  assert.strictEqual(last('gh pr create --help').lectura, true);
  // en `gh pr review`, `--comment` es un interruptor: no se lleva el `-b` que sigue
  const review = last('gh pr review 5 --comment -b "un texto"');
  assert.deepStrictEqual(review.ilegible, []);
  assert.ok(texts(review).includes('un texto'));
  // `-f` es `--fill`: el título y el cuerpo salen de los commits
  assert.deepStrictEqual(last('gh pr create -f').ilegible, []);
  // `gh gist edit <id> <archivo>` reemplaza un archivo del gist con el contenido de ése
  assert.deepStrictEqual(last('gh gist edit abc123 --filename notas.md local.md').archivos.map((a) => a.ruta), ['local.md']);
  // un programa cualquiera con un verbo parecido NO es un alias de gh (`git merge` con un mensaje que nombra a gh)
  for (const cmd of ['git merge -m "ver gh pr 5" una-rama', 'docker create --name "gh pr" x', 'gh pr view 5 && git merge una-rama']) {
    assert.deepStrictEqual(gh.comandosGh(cmd).filter((c) => !c.lectura), [], cmd);
  }
  // expansiones de zsh (la terminal de una Mac) y `$[…]`: lo escrito no es lo que llega
  for (const cmd of ['gh pr create --title "$=TITULO" --body b', 'gh pr create --title "$[1+1]" --body b', 'gh pr create --title "$~T" --body b']) {
    assert.ok(hidden(cmd), cmd);
  }
});

test('GhReader_PowerShell_BackslashPathsTextBlocksAndParenthesizedValues', () => {
  // El freno corre también para la herramienta de PowerShell, y ahí las reglas son otras: la barra invertida no
  // escapa (es parte de una ruta), los bloques de texto son `@'…'@`, y un valor entre paréntesis lo calcula la terminal.
  const ps = { powershell: true };
  const win = 'C:\\tools\\gh.exe pr create --title a --body b';
  assert.strictEqual(gh.pareceGh(win), true, 'el filtro barato tiene que seguir siendo un superconjunto del lector');
  assert.strictEqual(gh.comandosGh(win, 0, ps).pop().resumen, 'gh pr create');
  // un bloque de texto literal se LEE entero, con sus apóstrofos
  const block = gh.comandosGh("gh pr create --title a --body @'\nno es 'tan' fácil\ny sigue\n'@", 0, ps).pop();
  assert.deepStrictEqual(texts(block).sort(), ['a', "no es 'tan' fácil\ny sigue"]);
  assert.deepStrictEqual(block.ilegible, []);
  // el que expande, sólo si no trae nada que expandir
  assert.deepStrictEqual(gh.comandosGh('gh pr create --title a --body @"\nun cuerpo fijo\n"@', 0, ps).pop().ilegible, []);
  assert.ok(gh.comandosGh('gh pr create --title a --body @"\nhola $nombre\n"@', 0, ps).pop().ilegible.length > 0);
  // un valor entre paréntesis: no se puede leer
  assert.ok(gh.comandosGh('gh pr create --title a --body (Get-Content cuerpo.md -Raw)', 0, ps).shift().ilegible.length > 0);
  // el renglón se continúa con una comilla invertida (en bash, con una barra): en las dos es UN comando
  const cont = gh.comandosGh('gh pr create --title a `\n--body b', 0, ps);
  assert.strictEqual(cont.length, 1);
  assert.deepStrictEqual(texts(cont[0]).sort(), ['a', 'b']);
  assert.deepStrictEqual(cont[0].ilegible, []);
  assert.deepStrictEqual(texts(gh.comandosGh('gh pr create --title a \\\n--body b').pop()).sort(), ['a', 'b'], 'el gemelo de bash');
  // …y con las reglas de bash esa misma comilla invertida es una sustitución: no se da por leído
  assert.ok(gh.comandosGh('gh pr create --title a `\n--body b').some((c) => c.ilegible.length > 0));
  // entre comillas dobles, en PowerShell la barra invertida no escapa NADA (una ruta de red empieza con dos); en bash
  // dos barras son una
  const share = '"\\\\servidor\\compartida\\cuerpo.md"';
  assert.deepStrictEqual(gh.comandosGh(`gh pr create --title a --body-file ${share}`, 0, ps).pop().archivos.map((a) => a.ruta), ['\\\\servidor\\compartida\\cuerpo.md']);
  assert.deepStrictEqual(gh.comandosGh(`gh pr create --title a --body-file ${share}`).pop().archivos.map((a) => a.ruta), ['\\servidor\\compartida\\cuerpo.md']);
  // y una ruta de Windows entre comillas dobles conserva sus barras (también en bash: sólo se comen delante de $ ` " \)
  assert.deepStrictEqual(gh.comandosGh('gh pr create --title a --body-file "C:\\Users\\alguien\\cuerpo.md"').pop().archivos.map((a) => a.ruta), ['C:\\Users\\alguien\\cuerpo.md']);
  assert.ok(texts(gh.comandosGh('gh pr create --title "precio: \\$5 y \\"cita\\"" --body b').pop()).includes('precio: $5 y "cita"'));
});

test('AzReader_AnsiCQuotingIsAnExpansion', () => {
  // `$'…'` deja que la terminal arme el texto (`\x62` es una letra): lo escrito no es lo que llega
  const [, value] = az.fichas("gh $'Zor\\x62lax'").filter((f) => f.op === undefined);
  assert.strictEqual(value.expande, true);
  assert.ok(one("gh pr create --title $'Zor\\x62lax' --body b").ilegible.length > 0);
  assert.ok(one('gh pr create --title $"hola" --body b').ilegible.length > 0);
});

test('AzReader_TokensSayWhenTheShellExpands_AndNothingElseChanges', () => {
  const by = (cmd) => az.fichas(cmd).filter((f) => f.op === undefined);
  assert.deepStrictEqual(by('a "$X" \'$X\' "$(c)" "${Y}" "`z`" \\$Q "cuesta \\$5" "5$" $Z').map((f) => f.expande),
    [false, true, false, true, true, true, false, false, false, true]);
  // lo de siempre sigue igual: texto y si empezó libre
  assert.deepStrictEqual(by('az repos pr create --title "usá --squash false" --squash false').map((f) => [f.texto, f.esBandera]),
    [['az', true], ['repos', true], ['pr', true], ['create', true], ['--title', true], ['usá --squash false', false], ['--squash', true], ['false', true]]);
});

test('AzReader_AHeredocOperatorInsideQuotes_DoesNotOpenABlock', () => {
  // Las fichas salen de acá para los frenos de `az` y para el de `gh`. Un `<<PALABRA` adentro de una cadena abría un
  // bloque que no existe y se tragaba como «cuerpo» los renglones de abajo: los comandos que venían ahí desaparecían.
  const words = (cmd) => az.fichas(cmd).filter((f) => f.op === undefined).map((f) => f.texto);
  assert.deepStrictEqual(words('echo "ejemplo: cat <<EOF"\naz repos pr create --title a'), ['echo', 'ejemplo: cat <<EOF', 'az', 'repos', 'pr', 'create', '--title', 'a']);
  assert.deepStrictEqual(words("echo 'se usa <<FIN'\nls"), ['echo', 'se usa <<FIN', 'ls']);
  // un bloque de verdad sigue siendo texto: su cuerpo no se parte en comandos, y lo de después del cierre sí
  assert.deepStrictEqual(words("cat > x <<'EOF'\naz repos pr create --title cuerpo\nEOF\nls -la"), ['cat', '>', 'x', '<<EOF', 'EOF', 'ls', '-la']);
  // y un texto de entrada (`<<<`) no es un bloque
  assert.deepStrictEqual(words('bash <<< hola\nls'), ['bash', '<<<', 'hola', 'ls']);
});

// ── T60: un `gh pr create` dice su rama base, su rama de origen y si es un simulacro ────────────────────────────────
// Lo necesita el aviso de retrospectiva pendiente: un pedido hacia la rama principal es una entrega; hacia otra, no.
test('T60 GhPr_CreateExposesBaseAndHead', () => {
  const create = (resto) => one(`gh pr create --title t --body b ${resto}`);
  const pair = (c) => [c.base, c.head];
  // literales, en la forma larga, la corta y pegados con `=`
  assert.deepStrictEqual(pair(create('--base main --head feat/x')), ['main', 'feat/x']);
  assert.deepStrictEqual(pair(create('-B master -H fix/y')), ['master', 'fix/y']);
  assert.deepStrictEqual(pair(create('--base=dev --head=story/1.2')), ['dev', 'story/1.2']);
  // `gh` se queda con la última de una opción repetida
  assert.strictEqual(create('--base dev --base main').base, 'main');
  // la rama de otro dueño llega tal cual: quien llama decide si es una rama local
  assert.strictEqual(create('--base main --head alguien:feat/x').head, 'alguien:feat/x');
  // sin la opción: nulo, y NO «no se sabe»
  const bare = create('');
  assert.deepStrictEqual([bare.base, bare.head, bare.baseDesconocida, bare.headDesconocida], [null, null, false, false]);
  // armada por la terminal: «no se sabe», que no es lo mismo que «no vino»
  const armed = create('--base "$TARGET" --head "$(git branch --show-current)"');
  assert.deepStrictEqual([armed.base, armed.head, armed.baseDesconocida, armed.headDesconocida], [null, null, true, true]);
  // una literal después de una armada vuelve a saberse (vale la última)
  const lastWins = create('--base "$TARGET" --base main');
  assert.deepStrictEqual([lastWins.base, lastWins.baseDesconocida], ['main', false]);
  // el alias `new` se lee igual que `create`
  const alias = one('gh pr new --title t --body b --base main --head feat/z');
  assert.deepStrictEqual([alias.verbo, alias.base, alias.head], ['new', 'main', 'feat/z']);
  // el simulacro se marca (no crea nada), y sin la opción no
  assert.strictEqual(create('--base main --dry-run').simulacro, true);
  assert.strictEqual(create('--base main').simulacro, false);
  // sólo vale para un pedido: en `gh api`, `-H` es una cabecera
  const api = one('gh api -H "Accept: x" repos/a/b/pulls');
  assert.deepStrictEqual([api.base, api.head, api.simulacro], [null, null, false]);
  // lo que el lector ya devolvía no cambia: las ramas siguen sin contarse como texto publicado
  const c = create('--base main --head feat/x');
  assert.deepStrictEqual(texts(c), ['t', 'b']);
  assert.deepStrictEqual([c.grupo, c.verbo, c.lectura, c.resumen], ['pr', 'create', false, 'gh pr create']);
});

test('T60 GhPr_CreateExposesBaseAndHead — lo que el lector NO pudo leer se dice: no pasa por «no vino»', () => {
  const create = (resto) => one(`gh pr create --title t --body b ${resto}`);
  // `--dry-run=false` SÍ crea el pedido: no es un simulacro (y `=true` o suelto, sí)
  assert.strictEqual(create('--base main --dry-run=false').simulacro, false);
  assert.strictEqual(create('--base main --dry-run=true').simulacro, true);
  // una sustitución SIN comillas corta el comando ahí: la rama cuyo valor es esa sustitución «no se sabe», y el
  // lector avisa que lo de después no lo leyó (`cortado`) — una base o un simulacro escritos más allá se perdieron
  const cut = create('--base $(git config x) --dry-run');
  assert.deepStrictEqual([cut.base, cut.baseDesconocida, cut.cortado], [null, true, true]);
  const cutHead = create('--head `git branch --show-current` --base dev');
  assert.deepStrictEqual([cutHead.head, cutHead.headDesconocida, cutHead.base, cutHead.cortado], [null, true, null, true]);
  const later = one('gh pr create --title $(cat titulo) --base dev --body b');
  assert.deepStrictEqual([later.base, later.baseDesconocida, later.cortado], [null, false, true]);
  assert.strictEqual(create('--base main').cortado, false);
  // la opción del repo entre el grupo y el verbo (`gh pr -R dueño/repo create`): el verbo sigue sin decidir qué es de
  // lectura (ahí vale el que viene pegado al grupo), pero quien anota entregas lo encuentra en `verboTrasOpciones`
  const split = one('gh pr -R acme/widgets create --base main --title t --body b');
  assert.deepStrictEqual([split.verbo, split.verboTrasOpciones, split.lectura, split.repo, split.base], [null, 'create', false, 'acme/widgets', 'main']);
  assert.strictEqual(one('gh pr --repo=acme/widgets new --title t --body b').verboTrasOpciones, 'new');
  assert.strictEqual(create('--base main').verboTrasOpciones, 'create', 'con el verbo pegado, es el mismo');
  assert.strictEqual(one('gh pr --title create').verboTrasOpciones, null, 'el valor de otra opción no es un verbo');
  // un `gh` que no es el programa de su comando: MENCIONADO como argumento de otro (`echo`, un buscador), o corrido
  // por uno que lanza a otro (`xargs`, `timeout`). El lector dice cuál de los dos
  const mentioned = one('echo gh pr create --base main');
  assert.deepStrictEqual([mentioned.porOtroPrograma, mentioned.loLanzaOtro], [true, false]);
  const launched = one('timeout 30 gh pr create --base main --title t --body b');
  assert.deepStrictEqual([launched.porOtroPrograma, launched.loLanzaOtro], [true, true]);
  assert.deepStrictEqual([create('--base main').porOtroPrograma, create('--base main').loLanzaOtro], [false, false]);
});
