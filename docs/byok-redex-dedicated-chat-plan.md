# REDEX Dedicated Chat Plan

This document is the focused implementation plan for turning this fork into a dedicated contributed chat surface named REDEX that coexists with native Copilot Chat instead of taking it over.

It builds on the broader transport and auth work in `docs/byok-capi-decoupling.md`. That document explains how standalone and BYOK routing should work. This document explains how the extension should own its UI and chat sessions.

## Target Outcome

- REDEX appears as its own dedicated contributed chat surface in VS Code, separate from the default Chat surface.
- REDEX carries the existing chat experience under its own branded shell, session list, and composer instead of being buried inside the default Chat UI.
- Native Copilot Chat remains available and is not overridden by this extension.
- REDEX runs in standalone mode with BYOK or local providers when usable models exist.
- REDEX reuses the existing prompt, tool, MCP, attachment, and agent orchestration pipeline where possible.
- GitHub or Microsoft auth should not be required for REDEX when standalone providers and models are already configured.

## Non-Goals

- Recreate Codex internals one-for-one when this repo's existing pipeline and session primitives already cover the behavior.
- Keep this extension as the default owner of the built-in Copilot panel/editor/notebook/terminal chat surfaces.
- Preserve cloud-agent, review, PR, quota, or GitHub-specific flows in standalone mode unless they are explicitly reimplemented.

## Deep Review

### 1. The current manifest mixes two incompatible ownership models

The manifest currently tries to do both of these at the same time:

- Own the default chat experience through `chatParticipants` with `isDefault: true` in panel, editor, notebook, and terminal contexts.
- Contribute a dedicated `chatSessions` type named `reea-copilot`.

That mixed model is the root of the takeover behavior. A dedicated contributed chat surface can coexist cleanly with native Copilot. A default chat owner cannot.

Current manifest findings:

- `package.json` still contributes multiple default `chatParticipants` for `panel`, `editor`, `notebook`, and `terminal`.
- `package.json` still contributes `interactiveSession` with id `reea-copilot`.
- `package.json` already contributes a dedicated `chatSessions` entry for `reea-copilot`.

Conclusion:

- The extension already has the right dedicated-session primitive.
- It also still claims the legacy default chat ownership surface.
- Those two ideas need to be separated.

### 2. Runtime registration repeats the same mixed ownership mistake

The runtime wiring in `src/extension/conversation/vscode-node/chatParticipants.ts` couples the dedicated `reea-copilot` session directly to the default agent path.

Current behavior:

- `registerDefaultAgent()` creates the default panel agent.
- The same method also creates `vscode.chat.createChatSessionItemController('reea-copilot', ...)`.
- The same method also registers `vscode.chat.registerChatSessionContentProvider('reea-copilot', ..., defaultAgent)`.

That means the dedicated session is not actually owned by a dedicated REDEX session contribution. It is an extra surface hung off the default chat agent.

Conclusion:

- REDEX session registration must move out of `registerDefaultAgent()`.
- The dedicated session must have its own contribution and lifecycle.

### 3. Standalone mode exists, but dedicated sessions are not first-class in standalone

The standalone and BYOK work already added important pieces:

- `ConversationFeature` activates in standalone mode without waiting for a Copilot token.
- `LanguageModelAccess` skips Copilot LM publication in standalone mode.
- `ContextKeysContribution` has a standalone short-circuit for welcome and auth contexts.

But the dedicated session path is still not consistently loaded in standalone mode.

Current behavior:

- `src/extension/extension/vscode-node/contributions.ts` includes `ChatSessionsContrib` in `vscodeNodeChatContributions`.
- The standalone contribution set does not include `ChatSessionsContrib`.

Conclusion:

- REDEX session availability is still treated as part of the logged-in chat bundle instead of a first-class standalone surface.
- Dedicated REDEX session contributions must load in both standalone and Copilot modes.

### 4. This repo already has the session infrastructure REDEX should reuse

The repo already contains two valid chat-session patterns:

- Native content-provider sessions using `registerChatSessionContentProvider`.
- Item-provider sessions using `registerChatSessionItemProvider`.

Existing examples:

- Claude uses a dedicated session type and `registerChatSessionContentProvider`.
- Copilot CLI uses a dedicated session type and `registerChatSessionContentProvider`.
- Copilot CLI V1 and cloud sessions also demonstrate `registerChatSessionItemProvider`.

The repo also already supports session-scoped model targeting:

- Claude models publish `targetChatSessionType: 'claude-code'`.
- Copilot CLI models publish `targetChatSessionType: 'copilotcli'` and mark a session-scoped default.

Conclusion:

- REDEX does not need a brand new session architecture.
- The most direct path is to extract the existing `reea-copilot` session into its own dedicated contribution, surface it through a REDEX-owned shell, and scope models to it.

### 5. Codex is the right comparison, but only for coexistence boundaries

Codex proves that a dedicated contributed chat surface can coexist with native chat UI without taking over the default Copilot experience.

Verified Codex findings:

- Its manifest contributes a dedicated `chatSessions` type named `openai-codex`.
- Its manifest contributes `menus.chatSessions/newSession` for that session type.
- Its manifest contributes a custom editor for `openai-codex:` URIs.
- Its runtime registers `registerChatSessionItemProvider('openai-codex', ...)`.
- Its runtime registers `registerCustomEditorProvider('chatgpt.conversationEditor', ...)`.

What matters for REDEX:

- Codex uses a dedicated chat session type.
- Codex does not need to own the default Copilot participant surface.
- Codex proves the coexistence model is valid.

What REDEX should take from Codex on day one:

- A dedicated surfaced shell is required if REDEX is supposed to be visible as its own tab instead of living inside default Chat.
- The shell does not need to clone Codex internals exactly; it only needs to own the REDEX UI container while reusing this repo's existing request pipeline.

Conclusion:

- Codex is the correct reference for ownership boundaries.
- REDEX should copy the dedicated-session plus dedicated-shell coexistence model because that is the requested UX target.
- REDEX should reuse the existing conversation pipeline behind that shell instead of cloning Codex end to end.

### 6. UI ownership and transport/auth are separate problems

This is the core architectural conclusion from the review.

Problem A:

- Which extension surface owns the chat UI, session type, commands, and session lifecycle.

Problem B:

- Which model registry, auth path, and network transport are used once a REDEX session is running.

The current fork partially addressed Problem B through standalone and BYOK work, but it still mixes REDEX into the default ownership path from Problem A.

Conclusion:

- The REDEX refactor must split ownership first.
- After that, standalone and BYOK routing can be made session-aware and much easier to reason about.

## Recommended Architecture

### Control-Plane Split

REDEX should be designed around two separate control planes.

UI and session ownership:

- Dedicated `chatSessions` type for REDEX.
- REDEX-specific new-session command wiring.
- REDEX-specific welcome text, icon, and session metadata.
- No default chat ownership for panel, editor, notebook, or terminal.

Transport, auth, and models:

- Standalone mode decides whether GitHub auth is needed.
- REDEX resolves BYOK or local models first.
- Copilot-specific fallbacks remain optional and isolated.
- Session-aware model resolution prevents REDEX standalone requests from getting forced back onto Copilot defaults.

### Chosen Phase 1 Implementation

Use the dedicated surfaced-session model first:

- `chatSessions`
- `registerChatSessionItemProvider(...)`
- custom-editor-backed REDEX URIs or equivalent REDEX-owned session shell
- optional view container or secondary-sidebar contribution if that is the cleanest way to surface the REDEX shell in VS Code

Why this is the required first move:

- It is the only approach that matches the stated REDEX outcome: a separately surfaced UI that does not override default Chat.
- It keeps native Copilot Chat intact while giving REDEX an actual place to live in the UI.
- It can still reuse the existing prompt, tool, attachment, summarization, and agent orchestration path behind the shell.

Implementation constraint:

- `createChatSessionItemController(...)` and `registerChatSessionContentProvider(...)` are still useful internal primitives.
- They are not sufficient as the user-facing milestone on their own because they do not produce the separate REDEX surface that was explicitly requested.

## Implementation Plan

### Phase 0. Lock the public shape

Decisions to lock before editing behavior:

- Public brand name: `REDEX`.
- Public session display name: `REDEX`.
- Internal session type: prefer a dedicated type such as `redex` or `reea-redex` rather than overloading `reea-copilot` forever.
- Compatibility strategy: either keep `reea-copilot` temporarily as a migrated alias or rename immediately and accept a clean break.

Recommendation:

- Use a new dedicated session type for the public REDEX surface.
- Keep a small compatibility bridge only if existing saved sessions need to remain discoverable.

### Phase 1. Surface REDEX as its own shell and untangle UI ownership

Goal:

- Give REDEX an actual dedicated UI surface while stopping the extension from acting like the default Copilot chat owner.

Changes:

- In `package.json`, keep or replace the dedicated `chatSessions` entry with the final REDEX session type and branding.
- In `package.json`, add the contributed surface needed to make REDEX visible as its own shell, such as the REDEX session menus, custom editor, and any dedicated view container wiring required by the chosen shell.
- In `package.json`, remove or disable the default `chatParticipants` that currently set `isDefault: true` for panel, editor, notebook, and terminal.
- In `package.json`, remove the `interactiveSession` contribution for the dedicated REDEX build.
- Add REDEX-specific new-session command wiring under the chat session menus.

Runtime refactor:

- Move REDEX session registration out of `registerDefaultAgent()` in `src/extension/conversation/vscode-node/chatParticipants.ts`.
- Create a dedicated REDEX session contribution instead of binding the session to the default agent.
- Register the REDEX surfaced session through `registerChatSessionItemProvider(...)` and connect it to a REDEX-owned shell.

Likely implementation surface:

- Add a focused contribution under `src/extension/chatSessions/vscode-node/` for REDEX session ownership.
- Add the REDEX shell provider under the same area or the nearest existing custom-editor or webview contribution surface.
- Keep `chatParticipants.ts` only for participants that still make sense after default ownership is removed.

Acceptance criteria:

- Installing this extension no longer replaces the native Copilot Chat default UI.
- REDEX is visibly surfaced in the UI as its own dedicated tab or shell.
- Opening REDEX sessions lands inside the REDEX-owned shell instead of the default Chat surface.

### Checks

These checks gate the Phase 1 work and should be treated as required, not optional.

- Registration check: the REDEX session provider must register independently of the default panel chat participant path.
- Standalone loading check: the REDEX session contribution must load when `reea.copilot.chat.providerMode == standalone`.
- Coexistence check: native Chat remains available and REDEX registration does not require taking over default Chat ownership.
- Surface check: launching REDEX opens the REDEX-owned surface, not the default Chat surface.
- Validation check: `start-watch-tasks` must be clean when available; if the workspace task wiring is broken, record that failure and fall back to `Typecheck` plus Problems validation on touched files.

### Phase 2. Make REDEX sessions available in standalone and Copilot modes

Goal:

- Dedicated REDEX sessions must load regardless of whether the extension is in standalone or Copilot mode.

Changes:

- In `src/extension/extension/vscode-node/contributions.ts`, ensure the REDEX session contribution loads in both `vscodeNodeChatContributions` and `vscodeNodeStandaloneChatContributions`.
- If `ChatSessionsContrib` remains too broad because it also carries cloud-agent or Copilot-only behavior, split out a smaller REDEX-specific session contribution and load that in both paths.

Conversation activation:

- In `src/extension/conversation/vscode-node/conversationFeature.ts`, keep standalone activation independent from `copilotToken`.
- Ensure the context key that disables legacy interactive chat does not block REDEX session creation.

Acceptance criteria:

- REDEX session creation works in standalone mode.
- REDEX session creation also works when logged in.

### Phase 3. Make model routing session-aware

Goal:

- A REDEX session should use REDEX-appropriate models and should not fall back into Copilot defaults by accident.

Changes:

- Scope REDEX models using `targetChatSessionType`, following the Claude and Copilot CLI patterns.
- Define a session-scoped default model for REDEX standalone mode based on:
  - `reea.copilot.chat.standalone.model.default`
  - or the first available non-Copilot provider model if no explicit default is set.
- Stop REDEX standalone requests from taking the `switchToBaseModel()` and `switchToAutoModel()` Copilot path when the request did not originate from a Copilot session.

Implementation surfaces to audit:

- `src/extension/conversation/vscode-node/chatParticipants.ts`
- `src/extension/conversation/vscode-node/languageModelAccess.ts`
- `src/extension/prompt/vscode-node/endpointProviderImpl.ts`
- any `ProductionEndpointProvider` or fallback helpers that still assume `copilot-base`.

Acceptance criteria:

- REDEX standalone sessions resolve BYOK or local models without selecting Copilot vendor models.
- Missing-model fallback chooses the configured standalone default or first available REDEX-capable model.

### Phase 4. Silence auth and cloud requirements in standalone REDEX

Goal:

- Once standalone providers and models are configured, REDEX should have no practical reason to talk to GitHub or Microsoft just to start and run.

Changes:

- Audit `getCopilotToken()` call sites that are still reachable from standalone REDEX flows.
- Short-circuit or isolate those paths when `providerMode == standalone`.
- Keep auth-dependent features behind explicit non-standalone checks.

First-priority audit surfaces:

- `src/extension/contextKeys/vscode-node/contextKeys.contribution.ts`
- `src/extension/conversation/vscode-node/languageModelAccess.ts`
- any remaining endpoint fallback paths that still assume Copilot auth or Copilot models

Acceptance criteria:

- REDEX starts in standalone mode without GitHub sign-in when a usable standalone model exists.
- No startup or request path in the REDEX standalone flow requires Copilot token fetch just to remain usable.

### Phase 5. Cut or isolate unsupported cloud-only features for REDEX v1

Goal:

- Keep the first standalone REDEX surface coherent instead of half-cloud, half-local.

Disable or hide from standalone REDEX v1:

- cloud agent
- GitHub review and PR flows
- GitHub-dependent remote search flows
- GitHub MCP integration unless explicitly configured and intended
- quota and entitlement UX that only makes sense for Copilot subscriptions

Keep in REDEX v1:

- dedicated REDEX shell
- prompt pipeline
- local tool calling
- MCP for local or configured servers
- attachments and references
- BYOK and local provider model selection

Acceptance criteria:

- Standalone REDEX does not expose obviously broken GitHub-only features.
- The remaining feature set feels intentional rather than partially disabled.

### Phase 6. Branding, migration, and polish

Goal:

- Make the dedicated REDEX surface feel deliberate and supportable.

Changes:

- Rename welcome text, session titles, and placeholders to REDEX.
- Add a provider-setup-first empty state for standalone mode when no usable models exist.
- Add one obvious command path to configure providers or select a default model.
- Decide whether to migrate old `reea-copilot` session resources into the new REDEX namespace or leave them as legacy artifacts.

Acceptance criteria:

- REDEX branding is consistent.
- A first-time standalone user has a visible path from empty state to configured model to usable session.

## File Map

The files most likely to change in this plan are:

- `package.json`
- `src/extension/conversation/vscode-node/chatParticipants.ts`
- `src/extension/conversation/vscode-node/conversationFeature.ts`
- `src/extension/conversation/vscode-node/languageModelAccess.ts`
- `src/extension/contextKeys/vscode-node/contextKeys.contribution.ts`
- `src/extension/extension/vscode-node/contributions.ts`
- `src/extension/chatSessions/vscode-node/chatSessions.ts`
- a new REDEX session contribution file under `src/extension/chatSessions/vscode-node/`
- any session-aware model fallback code in the endpoint provider layer

## Recommended Delivery Sequence

### Milestone A. Coexistence first

- REDEX becomes a dedicated surfaced shell.
- Native Copilot UI is no longer overridden.
- REDEX session creation works from its own surfaced entry point.

This should land before deeper standalone cleanup because it fixes the architectural boundary.

### Milestone B. Standalone routing correctness

- REDEX standalone uses BYOK or local models.
- Standalone REDEX no longer depends on Copilot auth to remain usable.
- Session-scoped model defaults behave correctly.

### Milestone C. Cleanup and polish

- remove dead legacy ownership paths
- hide unsupported cloud-only surfaces from standalone REDEX
- finish naming, welcome states, and migration behavior

## Decisions Still To Lock

These should be answered before implementation starts so the refactor does not churn:

- Should the internal session type remain `reea-copilot` temporarily or change immediately to a REDEX-specific id?
- Is inline chat or editor-specific REDEX behavior required in v1, or is the dedicated REDEX shell the first milestone?
- Should the dedicated build completely remove legacy Copilot participant ownership, or keep it only behind an explicit `providerMode == copilot` path?
- In the long run, should REDEX ever expose Copilot vendor models, or should it be BYOK and local only?

## Recommended Answers

- Start with a REDEX-specific dedicated session type.
- Make the dedicated REDEX shell the first milestone.
- Remove default ownership from the dedicated build rather than trying to multiplex both models in the same activation path.
- Treat Copilot vendor models as optional legacy compatibility, not as the defining REDEX experience.

## Implementation Principle

The first milestone is not “clone Codex.”

The first milestone is:

- use Codex's coexistence boundary,
- use this repo's native session pipeline,
- and make standalone BYOK REDEX a first-class dedicated chat surface.

That is the shortest path to a REDEX extension that feels native, keeps the existing Copilot functionality stack, and does not override the standard UI.