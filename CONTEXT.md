# EngramWeave Core and Desktop Context

Shared product semantics belong in [the system context](../doc/CONTEXT.md). This document distinguishes implemented contracts from planned extensions; it does not claim that compilation, review, or integration is implemented.

## Current Core and Desktop boundary

Core runs independently and owns explicit scanning, Source registration, current file reads, basic search, Capture, and database projection recovery. Desktop hosts or connects to Core. [File and API contracts](docs/p1-contracts.md) define supported behavior, including the P2 A extension.

P2 A extends P1 registration to all five Source processing stages and independent lifecycle properties on supported Sources and Knowledge. Registry fills absent/null/empty stages with `pending`, including historical and discarded Sources, without changing body, Annotation, other properties or independent Assets. Current-file GET remains read-only; Capture does not automatically scan or compile. Desktop displays processing, lifecycle and registration separately. Draft and Research registration, processing actions and model execution are not implemented yet.

The existing `/v1` fields `Source.state` and `Job.status` represent registration and execution respectively. Stages and lifecycle are projected from `metadata_json`; schema version 1 is unchanged. Missing/empty lifecycle reads as active without writing a property. Invalid/missing/unsupported Registry entries expose no readable lifecycle. An unregistered current Source with no stage returns null until registration persists pending.

Property normalization uses deterministic YAML-node byte edits and a locked Windows handle commit with same-directory original backup, temporary file and recovery manifest. Scans recover verified interrupted property writes before enumeration; conflicting current files and uncertain artifacts are preserved and reported. Arbitrary hard-link aliases are refused; recognizable Capture temporary links retain the original inode while only the Record name is replaced. Capture replay accepts exact request bytes or their exact pending-normalized form, returning the current revision; all other changes conflict.

## Processing and runtime state ownership

Source Record Properties own `processing_status`: `pending / compiled / reviewed / planned / archived`. Core stores a rebuildable projection. Source, Draft, and formal knowledge Properties independently own `lifecycle_status: active | discarded`, preserving the content stage. Core separately owns registration (`ready / invalid / missing / unsupported`) and Job execution (`queued / running / succeeded / failed / interrupted`). Error details and retry/recompile counts remain Core runtime data.

Source Registry fills an absent or empty processing property with `pending`, preserving submitted body, Annotation, and other metadata. This includes historical material. Database rebuilding reads intact stage properties rather than resetting them; file damage is handled through file history or backup recovery.

Current Jobs are still scan-only; their errors and retention remain Core data. Retry and recompile counters will be persisted by the components that actually produce them, not as empty future tables in A. Ordinary rebuild preserves existing Job history under retention; missing/corrupt database reconstruction does not promise recovery of runtime history or counters from user files.

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

One Source Record has one Draft work line with revisions, not parallel candidates; Planner can integrate it into multiple formal files. Capture-owned Assets under `20_Sources` are dedicated to individual Records. Source Record deletion removes its associated derived data and dedicated Asset; external shared Assets are never modified or deleted. Default cleanup skips Sources referenced by active formal content; explicit reference confirmation permits user override without repairing broken links.

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
