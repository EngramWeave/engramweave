# EngramWeave Core and Desktop Context

Shared product semantics belong in [the system context](../engramweave-docs/CONTEXT.md). Compiler body generation is implemented; Draft Analyzer, Human Review actions and formal integration remain planned extensions.

## Current Core and Desktop boundary

Core runs independently and owns explicit scanning, Source registration, current file reads, basic search, Capture, database projection recovery, Compiler execution and append-only Draft publication. Desktop hosts or connects to Core. [File and API contracts](docs/p1-contracts.md) and [Compiler contracts](docs/compiler.md) define supported behavior.

P2 A extends P1 registration to all five Source processing stages and independent lifecycle properties on supported Sources and Knowledge. Registry fills absent/null/empty stages with `pending` and lifecycles with `active`, including historical and discarded Sources, without changing body, Annotation, other properties or independent Assets. Current-file GET remains read-only; Capture does not automatically scan or compile. Desktop displays processing, lifecycle and registration separately. Drafts have dedicated live file reads; Research registration and review/integration actions are not implemented.

The existing `/v1` fields `Source.state` and `Job.status` represent registration and execution respectively. Stages and lifecycle are projected from `metadata_json`; schema version 2 adds concrete Compiler Jobs through an atomic migration of validated version 1 databases. Missing/empty lifecycle reads as active without writing a property. Invalid/missing/unsupported Registry entries expose no readable lifecycle. An unregistered current Source with no stage returns null until registration persists pending.

Property normalization uses deterministic YAML-node byte edits and a locked Windows handle commit with same-directory original backup, temporary file and recovery manifest. Scans recover verified interrupted property writes before enumeration; conflicting current files and uncertain artifacts are preserved and reported. Arbitrary hard-link aliases are refused; recognizable Capture temporary links retain the original inode while only the Record name is replaced. Capture replay accepts exact request bytes, their exact pending-normalized form, or that form advanced to compiled when a readable linked Draft records the matching compilation-input revision. This uses file provenance rather than SQLite and returns the current revision without resetting the stage. A manual stage change without that proof, or any other content/property change, conflicts.

## Processing and runtime state ownership

Source Record Properties own `processing_status`: `pending / compiled / reviewed / planned / archived`. Core stores a rebuildable projection. Source, Draft, and formal knowledge Properties independently own `lifecycle_status: active | discarded`, preserving the content stage. Core separately owns registration (`ready / invalid / missing / unsupported`) and Job execution (`queued / running / succeeded / failed / interrupted`). Error details and retry/recompile counts remain Core runtime data.

Source Registry fills an absent or empty processing property with `pending`, preserving submitted body, Annotation, and other metadata. This includes historical material. Database rebuilding reads intact stage properties rather than resetting them; file damage is handled through file history or backup recovery.

Current Jobs include scans and single-Source compilation, each retaining bounded terminal history in Core. They serialize in the current implementation; a running Compiler does not hold user-file locks while waiting for the model. Retry and recompile counters belong to the components that actually produce them. Ordinary rebuild preserves existing Job history under retention; missing/corrupt database reconstruction does not promise recovery of completed runtime history or counters from user files.

## Current Compiler and Draft publication

Compiler reads current active, valid, registered pending or compiled Source text and Annotation, freezes its input and execution settings, and makes one API or Codex call. Non-inline Record descriptions and external assets are not treated as submitted text. API uses configurable OpenAI-compatible text inference; Codex reuses the installed CLI with ChatGPT authentication, read-only sandbox and disabled shell/Code Mode/apps/plugins/browser capabilities. Tool events and incomplete runs are rejected; an ordinary diagnostic item does not invalidate a completed structured result. Neither route dynamically calls Core tools or writes knowledge files.

Execution settings live separately from bootstrap configuration in the application data directory. Windows DPAPI protects API credentials for the current OS user and binds them to their endpoint; no credential getter is exposed. The native bridge permits only declared operations. Local loopback endpoints can omit a key. Compiler supports selectable output format, reasoning effort and bounded timeout; it never switches routes or performs hidden retries.

Successful compilation creates a new `30_Drafts/<request-id>.md` file with title, body, lifecycle and Source links, preserving all earlier Drafts and edits. The generated filename never comes from model content. An unfinished publication manifest holds the completed result and before/after Source hashes outside the Vault. Core publishes the new file without overwrite, commits pending→compiled through the existing native property writer, updates the complete Source projection and persists Job completion. Startup reconciles saved results without invoking a model; unexpected edits, missing completed Drafts and uncertain file artifacts are preserved and reported.

Draft associations and editable contents remain file-owned, independently of database identities. A disposable SQLite temporary backlink index coalesces requests and reconciles per-file contributions. Directory entries and inode/size/mtime/ctime determine which metadata needs reparsing; generation changes, mutation preparation and a short expiry request reconciliation. File metadata and inverse edges are separate, and target previews do not deserialize entire Draft bodies. Draft body cache size is bounded by the cumulative file byte limit. Destinations are re-resolved; physical deletion rereads formal provenance content. Mutation targets always use fresh file bytes and native revision checks. Database recovery preserves existing Drafts and reads Source stages rather than resetting them. Multiple Drafts are permitted before archival; selecting the sole final integration input and discarding all related Drafts after archival belong to later review/integration capabilities. Source rename repair and full diff/restore interactions are not implemented.

## Intended scheduling and Recompile

Configured time or interval schedules select active, valid, supported pending Sources for compilation and reviewed Sources for integration proposals, excluding ongoing work. Desktop can explicitly start a selected batch. Missed scheduled runs are not replayed on startup.

Recompile preserves old Draft edits and returns the Source to pending without invoking the model immediately. It waits for a scheduled or manually started batch. Desktop may derive a recompile filter from the Core-held count.

Each round re-reads file stage and lifecycle. Temporary failures permit finite configurable retries within that round. Explicit failures or exhausted retries end the round and record failed Jobs without replacing the Source stage; a later eligible round can try again. A failed analysis step does not regenerate an already completed Draft body or block Review Complete. Desktop supports batch reanalysis of failed Draft Analyzer work.

## Intended model task separation

Knowledge Compiler comprises Compiler and Draft Analyzer. Compiler consumes submitted material and Annotation and returns title and body. Draft Analyzer then orchestrates Review Analyzer followed by Relation Analyzer. Both are AI tasks before Human Review, bind the same Source/Draft versions, and save separate sidebar results without editing the body.

Desktop configures Analysis Profiles, templates, models, and routes before capture. Capture chooses Review/Relation presets; users may change selection before execution, which uses current configuration.

The normal workflow enters Human Review only after Knowledge Compiler has finished its analysis attempts, with allowed failures clearly displayed. Body presence or `compiled` alone does not imply that active Analyzer Jobs have finished.

The API path prepares context in Core and performs separate model calls without an initial dynamic tool loop. The Agent path reuses the runner loop with Core Tools/MCP. Relation may reuse Review input context, Review output as reference, or neither. Core-built tool loops and broader orchestration are deferred; human approval and deterministic Executor boundaries remain intact.

Compiler, Review Analyzer, Relation Analyzer, and Integration Planner each offer API or Codex execution in the first useful release. Basic semantic recall spans Knowledge, Ideas, and Research; advanced relation retrieval follows later. These are planned extensions of the P1 implementation, not already delivered capabilities.

## Intended lifecycle operations

Source Record discard stops processing without replacing its stage. Related Draft marks and formal references are displayed; formal files are marked only through explicit user selection. ChangeSet is a temporary plan, not a lifecycle-marked trash item. User file actions confirm a target list, while AI proposals use ChangeSet. Physical deletion is separate cleanup after marking.

Successful integration marks related Drafts discarded for user-managed cleanup. Source, Annotation, and formal content are not discarded by that Draft cleanup.

An unarchived Source Record may have multiple Drafts, with one selected for final integration and all related Drafts discarded after archival; Planner can integrate it into multiple formal files. Capture-owned Assets under `20_Sources` are dedicated to individual Records. Source Record deletion removes its associated derived data and dedicated Asset; external shared Assets are never modified or deleted. Default cleanup skips Sources referenced by active formal content; explicit reference confirmation permits user override without repairing broken links.

Restoration defaults to Source only and offers related-object selection. Old Drafts discarded after successful integration are not automatically reactivated. ChangeSets do not participate in generic restoration.

## Intended temporary plan retention

Persist ChangeSets for review, approval, version/precondition-checked execution, and unresolved-operation recovery. Clean successfully consumed or explicitly canceled plans, retaining necessary Job results and errors. Do not clean unfinished work until its outcome is clear, especially archival-marker recovery. Formal content history belongs to Git rather than permanent copies of every ChangeSet.

## Intended user-controlled review and planning

Review Complete changes compiled to reviewed without binding to an exact Draft version. Draft edits do not automatically revoke review, trigger planning, or invalidate candidates. Each Planner round reads the current Draft and current local library at startup, fixing its input for that round. Users can cancel Review Complete before planning to return to compiled, or cancel an unapproved generated ChangeSet and return planned to compiled before confirming again.

Candidate review compares proposed files with current local files. Users choose or edit the final approved contents, or request replanning from current local content. Generating and editing unapproved candidates never changes formal files. Approval immediately starts deterministic application of the final approved contents, with target precondition checks and without dependence on later Draft edits. No review-version binding or real-time Draft watcher is required.

A canceled or missing candidate with a usable reviewed Draft returns planned to reviewed for a new round and new approval. Recovery of interrupted approved execution remains an implementation responsibility rather than an extra product confirmation flow.

Planner is one unified knowledge-reorganization capability. Creation, modification, splitting, merging, reorganization, and discard are possible proposal outcomes, not independent user modes or workflows. One candidate ChangeSet uses the common review/edit/reject/replan/approve mechanism; implementation-level execution primitives must not narrow those outcomes.

## Intended Vault Git behavior

Track Ideas, Knowledge, Research, Projects, selected user System configuration, and Source Record Markdown files. Exclude independent Source Assets, Derived Representations, Drafts, and Inbox. After successful approved application, Core commits only the tracked files involved in that integration, including their earlier uncommitted user edits. It does not commit unrelated changes or require pre-planning commits. Users may manually commit edits or configure periodic commits. P1 does not implement Vault Git management; scoped commit and failure recovery belong to the integration extension.

## Sources presentation and explicit batch actions

Sources Health displays available/missing/invalid/unsupported; the existing ready registration value maps to available. Six overlapping views and filter dimensions follow the system context. The Processing column directly displays the file-owned processing_status (pending/compiled/reviewed/planned/archived), and Lifecycle directly displays lifecycle_status (active/discarded). Unknown captured time is shown as a dash, not repeated row diagnostics. Last-readable stages and lifecycle remain available for missing or unreadable Source projections, without enabling content execution or searchable cached body.

Compiler templates are seeded without overwriting edits at 90_System/Prompts/Compiler.md and frozen for each accepted request. New Drafts preserve captured_at and annotation values, including null or empty values and omission. Explicit repeat execution on compiled Sources appends a Draft and retains the compiled stage on failure.

Core owns selected Source Compile/Discard/Restore/Discard Drafts/Delete batches, runs individual actions sequentially, and rechecks each selected revision. The latest batch request and per-item results are atomically retained outside the Vault in source-batch.json. Desktop closure does not stop an attached Core; Core restart marks unfinished work interrupted and never replays queued models. Discard previews and Inspector show active Drafts only. Discard Drafts marks only the chosen Drafts and preserves Source bytes/stage. Source Discard requires all active related Drafts for unarchived Sources and lets users select active formal provenance references. Source-only restoration does not reactivate old Drafts. Physical cleanup requires discarded Source files, explicit target confirmation and reference override when active formal content still links to the Source. Native handle deletion verifies revisions while locking ancestors and refuses hardlinks, reparse points, hidden files and readonly files. Current inline Source deletion removes its Record/body and projection; Drafts, formal files and unproven/shared Assets are retained. Lifecycle edits reuse native file identity checks and recoverable property journals; partial cross-file outcomes remain inspectable and are not disguised as a transaction.

## Native files and efficient projections

Ordinary reads use Node. Core builds and owns a Windows x64 C# helper using the installed .NET Framework compiler; runtime executes the compiled artifact directly and does not invoke PowerShell or compile file-operation code. It remains available to the standalone CLI independently of Desktop. Fresh attribute queries share a Core-owned worker; mutation commits reuse a sequential helper and return the exact committed bytes/hash/timestamp for projection publication. Ancestor/file handle locks, native attribute checks, revision guards and recovery journals remain mandatory. Completed batch status is published only after the final receipt is durable. Status aggregates counts inside SQLite, and browsing without text search omits entire-body projections.
