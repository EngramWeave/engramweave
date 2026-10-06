# EngramWeave Core and Desktop Context

Shared product semantics belong in [the system context](../doc/CONTEXT.md). This document distinguishes current P1 contracts from planned extensions; it does not claim that compilation, review, or integration is implemented.

## Current P1 boundary

Core runs independently and owns explicit scanning, Source registration, current file reads, basic search, Capture, and database projection recovery. Desktop hosts or connects to Core. [P1 contracts](docs/p1-contracts.md) define supported behavior.

P1 accepts only `archived` or an empty/absent Source `processing_status`. Scanning does not write Source metadata, and Capture does not automatically scan or compile. The planned status contract below requires a coordinated extension of parsing, contracts, registration, projection recovery, and clients.

## Intended processing and runtime state ownership

Source Record Properties own `processing_status`: `pending / compiled / reviewed / planned / archived`. Core stores a rebuildable projection. Source, Draft, and formal knowledge Properties independently own `lifecycle_status: active | discarded`, preserving the content stage. Core separately owns registration (`ready / invalid / missing / unsupported`) and Job execution (`queued / running / succeeded / failed / interrupted`). Error details and retry/recompile counts remain Core runtime data.

Source Registry fills an absent or empty processing property with `pending`, preserving submitted body, Annotation, and other metadata. This includes historical material. Database rebuilding reads intact stage properties rather than resetting them; file damage is handled through file history or backup recovery.

## Intended scheduling and Recompile

Configured time or interval schedules select active, valid, supported pending Sources for compilation and reviewed Sources for integration proposals, excluding ongoing work. Desktop can explicitly start a selected batch. Missed scheduled runs are not replayed on startup.

Recompile preserves old Draft edits and returns the Source to pending without invoking the model immediately. It waits for a scheduled or manually started batch. Desktop may derive a recompile filter from the Core-held count.

Each round re-reads file stage and lifecycle. Temporary failures permit finite configurable retries within that round. Explicit failures or exhausted retries end the round and record failed Jobs without replacing the Source stage; a later eligible round can try again. A failed analysis step does not regenerate an already completed Draft body or block Review Complete. Desktop supports batch reanalysis of failed Draft Analyzer work.

## Intended model task separation

Body compilation consumes submitted material and Annotation and returns title and body. Core separately orchestrates Draft Analyzer as Review Analyzer followed by Relation Analyzer. Analysis Profiles combine templates, models, and execution paths; the sub-tasks bind the same Source/Draft versions, obtain template-specific context, and store independent sidebar-only results.

The API path prepares context in Core and performs separate model calls without an initial dynamic tool loop. The Agent path reuses the runner loop with Core Tools/MCP. Relation may reuse Review input context, Review output as reference, or neither. Core-built tool loops and broader orchestration are deferred; human approval and deterministic Executor boundaries remain intact.

## Intended lifecycle operations

Source discard stops further processing without replacing its stage. Before archival it also marks related Draft/ChangeSet discarded; archived Source references to formal knowledge are checked for user-selected marking. Restoration and physical cleanup must have explicit dependency and confirmation rules.

Successful integration marks related Drafts discarded for user-managed cleanup. Source, Annotation, and formal content are not discarded by that Draft cleanup.
