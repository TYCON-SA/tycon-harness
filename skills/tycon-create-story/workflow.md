# Create Story Workflow

**Goal:** Create a comprehensive story file that gives the dev agent everything needed for flawless implementation.

**Your Role:** Story context engine that prevents LLM developer mistakes, omissions, or disasters.
- Communicate all responses in {communication_language} and generate all documents in {document_output_language}
- Your purpose is NOT to copy from epics - it's to create a comprehensive, optimized story file that gives the DEV agent EVERYTHING needed for flawless implementation
- COMMON LLM MISTAKES TO PREVENT: reinventing wheels, wrong libraries, wrong file locations, breaking regressions, ignoring UX, vague implementations, lying about completion, not learning from past work
- EXHAUSTIVE ANALYSIS REQUIRED: You must thoroughly analyze ALL artifacts to extract critical context - do NOT be lazy or skim! This is the most important function in the entire development process!
- UTILIZE SUBPROCESSES AND SUBAGENTS: Use research subagents, subprocesses or parallel processing if available to thoroughly analyze different artifacts simultaneously and thoroughly
- SAVE QUESTIONS: If you think of questions or clarifications during analysis, save them for the end after the complete story is written
- ZERO USER INTERVENTION: Process should be fully automated except for initial epic/story selection or missing documents

---

## INITIALIZATION

### Step 0 — Is this a BMAD project?

Before anything else, run:

```bash
node <this skill's directory>/scripts/story-without-bmad.js mode --repo {project-root}
```

- `{"mode":"bmad"}` → continue with «Configuration Loading» below, unchanged.
- `{"mode":"first-time",...}` → the repo has no BMAD project. Read fully and follow `./first-time.md` instead of the
  rest of this workflow, and STOP here: do not load the config, do not ask for an epic or a sprint.
- `{"mode":"existing",...}` → this product already has stories: in this repo with its own numbering, in the stories
  repo it declares, or in a sibling repo. Tell the person the `message`, as is, and STOP. With `ask: true`, ask where
  the new story goes and wait: never choose a place yourself. Never offer to initialize BMAD here, and never write a
  first-time story in this repo. If the person says this repo starts on its own, run `mode` again with `--this-repo`.
  To create the story in another place, run this skill again with that repo as `{project-root}`.
- The script exits 2 when the product's stories repo is declared but not cloned: tell the person what it says (which
  repo to clone) and STOP.

The script decides the mode from the repo. Never decide it yourself.

### Configuration Loading

Load config from `{project-root}/_bmad/bmm/config.yaml` and resolve:

- `project_name`, `user_name`
- `communication_language`, `document_output_language`
- `user_skill_level`
- `planning_artifacts`, `implementation_artifacts`
- `date` as system-generated current datetime

### Paths

- `sprint_status` = `{implementation_artifacts}/sprint-status.yaml`
- `epics_file` = `{planning_artifacts}/epics.md`
- `prd_file` = `{planning_artifacts}/prd.md`
- `architecture_file` = `{planning_artifacts}/architecture.md`
- `ux_file` = `{planning_artifacts}/*ux*.md`
- `story_title` = "" (will be elicited if not derivable)
- `project_context` = `**/project-context.md` (load if exists)
- `default_output_file` = `{implementation_artifacts}/{{story_key}}.md`

### Input Files

| Input | Description | Path Pattern(s) | Load Strategy |
|-------|-------------|------------------|---------------|
| prd | PRD (fallback - epics file should have most content) | whole: `{planning_artifacts}/*prd*.md`, sharded: `{planning_artifacts}/*prd*/*.md` | SELECTIVE_LOAD |
| architecture | Architecture (fallback - epics file should have relevant sections) | whole: `{planning_artifacts}/*architecture*.md`, sharded: `{planning_artifacts}/*architecture*/*.md` | SELECTIVE_LOAD |
| ux | UX design (fallback - epics file should have relevant sections) | whole: `{planning_artifacts}/*ux*.md`, sharded: `{planning_artifacts}/*ux*/*.md` | SELECTIVE_LOAD |
| epics | Enhanced epics+stories file with BDD and source hints | whole: `{planning_artifacts}/*epic*.md`, sharded: `{planning_artifacts}/*epic*/*.md` | SELECTIVE_LOAD |

---

## EXECUTION

<workflow>

<step n="1" goal="Determine target story">
  <check if="{{story_path}} is provided by user or user provided the epic and story number such as 2-4 or 1.6 or epic 1 story 5">
    <action>Parse user-provided story path: extract epic_num, story_num, story_title from format like "1-2-user-auth"</action>
    <action>Set {{epic_num}}, {{story_num}}, {{story_key}} from user input</action>
    <action>GOTO step 2a</action>
  </check>

  <action>Check if {{sprint_status}} file exists for auto discover</action>
  <check if="sprint status file does NOT exist">
    <output>🚫 No sprint status file found and no story specified</output>
    <output>
      **Required Options:**
      1. Run `sprint-planning` to initialize sprint tracking (recommended)
      2. Provide specific epic-story number to create (e.g., "1-2-user-auth")
      3. Provide path to story documents if sprint status doesn't exist yet
    </output>
    <ask>Choose option [1], provide epic-story number, path to story docs, or [q] to quit:</ask>

    <check if="user chooses 'q'">
      <action>HALT - No work needed</action>
    </check>

    <check if="user chooses '1'">
      <output>Run sprint-planning workflow first to create sprint-status.yaml</output>
      <action>HALT - User needs to run sprint-planning</action>
    </check>

    <check if="user provides epic-story number">
      <action>Parse user input: extract epic_num, story_num, story_title</action>
      <action>Set {{epic_num}}, {{story_num}}, {{story_key}} from user input</action>
      <action>GOTO step 2a</action>
    </check>

    <check if="user provides story docs path">
      <action>Use user-provided path for story documents</action>
      <action>GOTO step 2a</action>
    </check>
  </check>

  <!-- Auto-discover from sprint status only if no user input -->
  <check if="no user input provided">
    <critical>MUST read COMPLETE {sprint_status} file from start to end to preserve order</critical>
    <action>Load the FULL file: {{sprint_status}}</action>
    <action>Read ALL lines from beginning to end - do not skip any content</action>
    <action>Parse the development_status section completely</action>

    <action>Find the FIRST story (by reading in order from top to bottom) where:
      - Key matches pattern: number-number-name (e.g., "1-2-user-auth")
      - NOT an epic key (epic-X) or retrospective (epic-X-retrospective)
      - Status value equals "backlog"
    </action>

    <check if="no backlog story found">
      <output>📋 No backlog stories found in sprint-status.yaml

        All stories are either already created, in progress, or done.

        **Options:**
        1. Run sprint-planning to refresh story tracking
        2. Load PM agent and run correct-course to add more stories
        3. Check if current sprint is complete and run retrospective
      </output>
      <action>HALT</action>
    </check>

    <action>Extract from found story key (e.g., "1-2-user-authentication"):
      - epic_num: first number before dash (e.g., "1")
      - story_num: second number after first dash (e.g., "2")
      - story_title: remainder after second dash (e.g., "user-authentication")
    </action>
    <action>Set {{story_id}} = "{{epic_num}}.{{story_num}}"</action>
    <action>Store story_key for later use (e.g., "1-2-user-authentication")</action>

    <!-- Mark epic as in-progress if this is first story -->
    <action>Check if this is the first story in epic {{epic_num}} by looking for {{epic_num}}-1-* pattern</action>
    <check if="this is first story in epic {{epic_num}}">
      <action>Load {{sprint_status}} and check epic-{{epic_num}} status</action>
      <action>If epic status is "backlog" → update to "in-progress"</action>
      <action>If epic status is "contexted" (legacy status) → update to "in-progress" (backward compatibility)</action>
      <action>If epic status is "in-progress" → no change needed</action>
      <check if="epic status is 'done'">
        <output>🚫 ERROR: Cannot create story in completed epic</output>
        <output>Epic {{epic_num}} is marked as 'done'. All stories are complete.</output>
        <output>If you need to add more work, either:</output>
        <output>1. Manually change epic status back to 'in-progress' in sprint-status.yaml</output>
        <output>2. Create a new epic for additional work</output>
        <action>HALT - Cannot proceed</action>
      </check>
      <check if="epic status is not one of: backlog, contexted, in-progress, done">
        <output>🚫 ERROR: Invalid epic status '{{epic_status}}'</output>
        <output>Epic {{epic_num}} has invalid status. Expected: backlog, in-progress, or done</output>
        <output>Please fix sprint-status.yaml manually or run sprint-planning to regenerate</output>
        <action>HALT - Cannot proceed</action>
      </check>
      <output>📊 Epic {{epic_num}} status updated to in-progress</output>
    </check>

    <action>GOTO step 2a</action>
  </check>
  <action>Load the FULL file: {{sprint_status}}</action>
  <action>Read ALL lines from beginning to end - do not skip any content</action>
  <action>Parse the development_status section completely</action>

  <action>Find the FIRST story (by reading in order from top to bottom) where:
    - Key matches pattern: number-number-name (e.g., "1-2-user-auth")
    - NOT an epic key (epic-X) or retrospective (epic-X-retrospective)
    - Status value equals "backlog"
  </action>

  <check if="no backlog story found">
    <output>No backlog stories found in sprint-status.yaml

      All stories are either already created, in progress, or done.

      **Options:**
      1. Run sprint-planning to refresh story tracking
      2. Load PM agent and run correct-course to add more stories
      3. Check if current sprint is complete and run retrospective
    </output>
    <action>HALT</action>
  </check>

  <action>Extract from found story key (e.g., "1-2-user-authentication"):
    - epic_num: first number before dash (e.g., "1")
    - story_num: second number after first dash (e.g., "2")
    - story_title: remainder after second dash (e.g., "user-authentication")
  </action>
  <action>Set {{story_id}} = "{{epic_num}}.{{story_num}}"</action>
  <action>Store story_key for later use (e.g., "1-2-user-authentication")</action>

  <!-- Mark epic as in-progress if this is first story -->
  <action>Check if this is the first story in epic {{epic_num}} by looking for {{epic_num}}-1-* pattern</action>
  <check if="this is first story in epic {{epic_num}}">
    <action>Load {{sprint_status}} and check epic-{{epic_num}} status</action>
    <action>If epic status is "backlog" → update to "in-progress"</action>
    <action>If epic status is "contexted" (legacy status) → update to "in-progress" (backward compatibility)</action>
    <action>If epic status is "in-progress" → no change needed</action>
    <check if="epic status is 'done'">
      <output>ERROR: Cannot create story in completed epic</output>
      <output>Epic {{epic_num}} is marked as 'done'. All stories are complete.</output>
      <output>If you need to add more work, either:</output>
      <output>1. Manually change epic status back to 'in-progress' in sprint-status.yaml</output>
      <output>2. Create a new epic for additional work</output>
      <action>HALT - Cannot proceed</action>
    </check>
    <check if="epic status is not one of: backlog, contexted, in-progress, done">
      <output>ERROR: Invalid epic status '{{epic_status}}'</output>
      <output>Epic {{epic_num}} has invalid status. Expected: backlog, in-progress, or done</output>
      <output>Please fix sprint-status.yaml manually or run sprint-planning to regenerate</output>
      <action>HALT - Cannot proceed</action>
    </check>
    <output>Epic {{epic_num}} status updated to in-progress</output>
  </check>

  <action>GOTO step 2a</action>
</step>

<step n="2" goal="Load and analyze core artifacts">
  <critical>🔬 EXHAUSTIVE ARTIFACT ANALYSIS - This is where you prevent future developer mistakes!</critical>

  <!-- Load all available content through discovery protocol -->
  <action>Read fully and follow `./discover-inputs.md` to load all input files</action>
  <note>Available content: {epics_content}, {prd_content}, {architecture_content}, {ux_content},
  {project_context}</note>

  <!-- Analyze epics file for story foundation -->
  <action>From {epics_content}, extract Epic {{epic_num}} complete context:</action> **EPIC ANALYSIS:** - Epic
  objectives and business value - ALL stories in this epic for cross-story context - Our specific story's requirements, user story
  statement, acceptance criteria - Technical requirements and constraints - Dependencies on other stories/epics - Source hints pointing to
  original documents <!-- Extract specific story requirements -->
  <action>Extract our story ({{epic_num}}-{{story_num}}) details:</action> **STORY FOUNDATION:** - User story statement
  (As a, I want, so that) - Detailed acceptance criteria (already BDD formatted) - Technical requirements specific to this story -
  Business context and value - Success criteria <!-- Previous story analysis for context continuity -->
  <check if="story_num > 1">
    <action>Find {{previous_story_num}}: scan {implementation_artifacts} for the story file in epic {{epic_num}} with the highest story number less than {{story_num}}</action>
    <action>Load previous story file: {implementation_artifacts}/{{epic_num}}-{{previous_story_num}}-*.md</action> **PREVIOUS STORY INTELLIGENCE:** -
  Dev notes and learnings from previous story - Review feedback and corrections needed - Files that were created/modified and their
  patterns - Testing approaches that worked/didn't work - Problems encountered and solutions found - Code patterns established <action>Extract
  all learnings that could impact current story implementation</action>
  </check>

  <!-- Git intelligence for previous work patterns -->
  <check
    if="previous story exists AND git repository detected">
    <action>Get last 5 commit titles to understand recent work patterns</action>
    <action>Analyze 1-5 most recent commits for relevance to current story:
      - Files created/modified
      - Code patterns and conventions used
      - Library dependencies added/changed
      - Architecture decisions implemented
      - Testing approaches used
    </action>
    <action>Extract actionable insights for current story implementation</action>
  </check>
</step>

<step n="3" goal="Architecture analysis for developer guardrails">
  <critical>🏗️ ARCHITECTURE INTELLIGENCE - Extract everything the developer MUST follow!</critical> **ARCHITECTURE DOCUMENT ANALYSIS:** <action>Systematically
  analyze architecture content for story-relevant requirements:</action>

  <!-- Load architecture - single file or sharded -->
  <check if="architecture file is single file">
    <action>Load complete {architecture_content}</action>
  </check>
  <check if="architecture is sharded to folder">
    <action>Load architecture index and scan all architecture files</action>
  </check> **CRITICAL ARCHITECTURE EXTRACTION:** <action>For
  each architecture section, determine if relevant to this story:</action> - **Technical Stack:** Languages, frameworks, libraries with
  versions - **Code Structure:** Folder organization, naming conventions, file patterns - **API Patterns:** Service structure, endpoint
  patterns, data contracts - **Database Schemas:** Tables, relationships, constraints relevant to story - **Security Requirements:**
  Authentication patterns, authorization rules - **Performance Requirements:** Caching strategies, optimization patterns - **Testing
  Standards:** Testing frameworks, coverage expectations, test patterns - **Deployment Patterns:** Environment configurations, build
  processes - **Integration Patterns:** External service integrations, data flows <action>Extract any story-specific requirements that the
  developer MUST follow</action>
  <action>Identify any architectural decisions that override previous patterns</action>
</step>

<step n="4" goal="Web research for latest technical specifics">
  <critical>🌐 ENSURE LATEST TECH KNOWLEDGE - Prevent outdated implementations!</critical> **WEB INTELLIGENCE:** <action>Identify specific
  technical areas that require latest version knowledge:</action>

  <!-- Check for libraries/frameworks mentioned in architecture -->
  <action>From architecture analysis, identify specific libraries, APIs, or
  frameworks</action>
  <action>For each critical technology, research latest stable version and key changes:
    - Latest API documentation and breaking changes
    - Security vulnerabilities or updates
    - Performance improvements or deprecations
    - Best practices for current version
  </action>
  **EXTERNAL CONTEXT INCLUSION:** <action>Include in story any critical latest information the developer needs:
    - Specific library versions and why chosen
    - API endpoints with parameters and authentication
    - Recent security patches or considerations
    - Performance optimization techniques
    - Migration considerations if upgrading
  </action>
</step>

<step n="5" goal="Create comprehensive story file">
  <critical>📝 CREATE ULTIMATE STORY FILE - The developer's master implementation guide!</critical>

  <critical>TYCON Mary+GOLD: before writing, READ `story-format.md` from the harness
  (`$TYCON_GUIDES_DIR/story-format.md`, default `~/.claude/tycon-harness/story-format.md`).
  The template carries the structure; the rules of every section live in that guide. If the file
  cannot be read, SAY SO to the user and continue with the template — never skip it silently.</critical>
  <action>Fill the YAML frontmatter completely: epic, story, title, status, sprint, priority, approach,
  depends_on, files_to_create, files_to_modify. Add followup_of + followup_reason if the story corrects,
  recalibrates or extends another one (§1.2), and a pipelines block if it ships in batches (§1.1).
  Do NOT write work_item (tycon-ado-story-wi adds it; the old name ado_work_item is never written). No double quotes inside YAML comments or
  inside the title value (§1.0).</action>
  <action>Keep every Mary+GOLD section of the template. Backend stories MUST fill "Patron de referencia
  verificado" with real anchors opened in the sibling plugins, or the explicit "No aplica" (§9.2).
  Remove the template's guidance HTML comments when done.</action>
  <action>Initialize from template.md:
  {default_output_file}</action>
  <template-output file="{default_output_file}">story_header</template-output>

  <!-- Story foundation from epics analysis -->
  <template-output
    file="{default_output_file}">story_requirements</template-output>

  <!-- Developer context section - MOST IMPORTANT PART -->
  <template-output file="{default_output_file}">
  developer_context_section</template-output> **DEV AGENT GUARDRAILS:** <template-output file="{default_output_file}">
  technical_requirements</template-output>
  <template-output file="{default_output_file}">architecture_compliance</template-output>
  <template-output
    file="{default_output_file}">library_framework_requirements</template-output>
  <template-output file="{default_output_file}">
  file_structure_requirements</template-output>
  <template-output file="{default_output_file}">testing_requirements</template-output>

  <!-- Previous story intelligence -->
  <check
    if="previous story learnings available">
    <template-output file="{default_output_file}">previous_story_intelligence</template-output>
  </check>

  <!-- Git intelligence -->
  <check
    if="git analysis completed">
    <template-output file="{default_output_file}">git_intelligence_summary</template-output>
  </check>

  <!-- Latest technical specifics -->
  <check if="web research completed">
    <template-output file="{default_output_file}">latest_tech_information</template-output>
  </check>

  <!-- Project context reference -->
  <template-output
    file="{default_output_file}">project_context_reference</template-output>

  <!-- Final status update -->
  <template-output file="{default_output_file}">
  story_completion_status</template-output>

  <!-- CRITICAL: ready-for-dev is set in step 6, after the validator and the adversarial review of the story -->
  <action>Write the story with Status as "draft" (frontmatter `status: draft` and the `Status:` line under the title):
  the harness only lets a new story without the validator's record be written as a draft, and only lets a draft move
  to "ready-for-dev" after `tycon-story-validator` ran on that file. Step 6 sets "ready-for-dev". The entry in
  {{sprint_status}} stays "backlog" while the file is a draft</action>
  <action>Add completion note: "Ultimate
  context engine analysis completed - comprehensive developer guide created"</action>
</step>

<step n="6" goal="Update sprint status and finalize">
  <action>Validate the newly created story file {default_output_file} against `./checklist.md` and apply any required fixes before finalizing</action>
  <action>Run the `tycon-story-validator` subagent on the new story (pre-implementation: no `phase`). If its report has
  `[VAL-W17]` (a criterion asks for something the code already does), show it to the user in plain words BEFORE
  reporting completion: each criterion with the `file:line` and what the code already does there, exactly as the report
  gives it, and three choices: (a) keep the story as is, (b) adjust it (drop or rewrite those criteria, then validate
  again), (c) discard it. Without `[VAL-W17]`, say nothing about it.</action>
  <check if="the user chose (c) discard">
    <action>Delete {default_output_file}. Do NOT save it and do NOT touch {{sprint_status}}</action>
    <output>Story {{story_id}} discarded: the code already does it ({file:line} from the report). Nothing was saved.</output>
    <action>HALT — skip the rest of this step</action>
  </check>
  <action>Save story document unconditionally</action>

  <!-- The adversarial review of the story, before coding: once, after the validator and VAL-W17, before ready-for-dev -->
  <action>Run `node <this skill's directory>/../tycon-pipeline/scripts/pipeline.js story-review-gate --story {default_output_file}`.
  With `run: false`, record the skip and say it in one line: `pipeline.js story-review-record --story
  {default_output_file} --result saltado --reason <the gate's motivo> --risk <riesgo>` (with `record: current` there
  is nothing to record: say the gate's `linea`).</action>
  <check if="the gate says run: true">
    <action>Launch the `tycon-story-adversarial-reviewer` subagent ONCE, in the background, with `model:` = the gate's
    `model`. Prompt: «Revisá la historia {default_output_file} contra el repo {project-root}, antes de programarla. Una
    sola pasada, de sólo lectura. El validador ya corrió y emitió: <its VAL-* rule IDs, or "nada">. No repitas eso.
    Cada hallazgo con su regla SADV, el criterio o la sección, y su evidencia; sin evidencia no es hallazgo. Cerrá con
    el renglón «Veredicto:».» Never relaunch it: not for its findings, not after fixing them.</action>
    <action>Fix in the story every finding that what the story or the repo already says can settle, without asking:
    one `## Change Log` line per finding (`Revisión adversarial previa (SADV-xx): <what changed>`). When the fix
    touches a criterion or a test, update the tests table and the counts together. A finding that duplicates exactly
    what the validator already reported is dropped.</action>
    <check if="a CRITICAL finding cannot be fixed without a decision (two opposite criteria and nothing in the repo says which wins; a data item that does not exist and someone has to decide whether to create it)">
      <action>Ask the user ONE question only: the one that unblocks, in plain words, what it clashes with, what
      happens with each option, and the recommended one. Settle the rest after the answer, with no other question.
      In autonomous mode under a coordinator, the question goes to whoever approves, never to a blocking dialog.
      Until the answer arrives, record `--result pendiente` and do NOT set ready-for-dev.</action>
    </check>
    <action>Record it: `pipeline.js story-review-record --story {default_output_file} --result <limpio | corregido |
    preguntado> --findings '<JSON list of {regla, criterio, severidad, destino: corregido|preguntado|descartado}>'
    --model <model> --model-reason "<model_reason>" --risk <riesgo> --tokens <subagent tokens> --duration-ms
    <subagent duration>` (tokens and duration from the subagent tool result; leave them out if it does not give them:
    the record says `medido: false`). A reviewer that died or did not answer what was asked is `--result no-medido`:
    say it in one line and go on (step 1 of the pipeline launches it again).</action>
  </check>
  <check if="the story file changed after the validator's last run (fixes from the adversarial review, or any other edit)">
    <action>Run the `tycon-story-validator` subagent again on {default_output_file}, naming that path in the prompt, right
    before setting "ready-for-dev": every edit makes the validator's record stale, and the harness does not let a draft
    move to "ready-for-dev" without a current one. If it reports a CRITICAL, fix it and run it again.</action>
  </check>
  <action>Only after the record is written (and nothing is `pendiente`), set the story Status (frontmatter and the
  `Status:` line, from "draft") and the sprint status to "ready-for-dev"</action>

  <!-- Update sprint status -->
  <check if="sprint status file exists">
    <action>Update {{sprint_status}}</action>
    <action>Load the FULL file and read all development_status entries</action>
    <action>Find development_status key matching {{story_key}}</action>
    <action>Verify current status is "backlog" (expected previous state)</action>
    <action>Update development_status[{{story_key}}] = "ready-for-dev"</action>
    <action>Update last_updated field to current date</action>
    <action>Save file, preserving ALL comments and structure including STATUS DEFINITIONS</action>
  </check>

  <action>Report completion</action>
  <output>**🎯 ULTIMATE BMad Method STORY CONTEXT CREATED, {user_name}!**

    **Story Details:**
    - Story ID: {{story_id}}
    - Story Key: {{story_key}}
    - File: {{story_file}}
    - Status: ready-for-dev

    **Next Steps:**
    1. Review the comprehensive story in {{story_file}}
    2. Run dev agents `dev-story` for optimized implementation
    3. Run `code-review` when complete (auto-marks done)
    4. Optional: If Test Architect module installed, run `/bmad:tea:automate` after `dev-story` to generate guardrail tests

    **The developer now has everything needed for flawless implementation!**
  </output>
</step>

</workflow>
