# Standalone Strip-Down Plan — Chat & Agents Against Your Own LLM Endpoints

> Goal: a buildable, runnable fork of `vscode-copilot-chat` that talks **only** to user-provided LLM endpoints (OpenAI, Anthropic, Azure OpenAI, Ollama, vLLM, OpenRouter, any OpenAI-compatible). No GitHub login, no Microsoft cloud calls, no telemetry. Chat panel + agent mode + tool-calling loop + inline chat + MCP work. Cloud agents, code review, NES, completions, semantic workspace search are explicitly out of scope.
>
> Context: read [`MICROSOFT_DECOUPLING_ANALYSIS.md`](./MICROSOFT_DECOUPLING_ANALYSIS.md) first for the architectural inventory. This file is the action plan.

## Strategy

Three architectural facts make this tractable:

1. **VS Code's `LanguageModelChatProvider` API is the chat dispatcher.** When the model picker has a non-`copilot` vendor selected, requests bypass `CAPIClient` entirely and route through the provider's `provideLanguageModelChatResponse` callback (`src/platform/endpoint/vscode-node/extChatEndpoint.ts:163-200`). The eight existing BYOK providers (Anthropic, OpenAI, Ollama, OpenRouter, Gemini, xAI, Azure, OpenAI-compatible) already prove the path works end-to-end.

2. **`StaticExtendedTokenInfoCopilotTokenManager` already exists** (`src/platform/authentication/node/copilotTokenManager.ts:409-437`). It accepts a base64-encoded synthetic token envelope and never makes network calls. Used today for `IS_SCENARIO_AUTOMATION` mode, but it works in any context.

3. **`vscodeNodeChatContributions` (the contribution set that registers tools, MCP setup, tool-result rendering, etc.) is gated on `authenticationService.copilotToken` being set** (`src/extension/conversation/vscode-node/conversationFeature.ts:91-152`). Once you make a synthetic token always present, the entire chat surface activates.

The plan: **synthesize a token, neutralize CAPI, gate-flip BYOK to always-on, replace `IEndpointProvider` with a BYOK-only resolver, then prune dead cloud features.** Each phase has a runnable checkpoint.

---

## Phase 0 — Branch hygiene and build verification (1–2 hours)

Before changing anything:

1. Branch from `main` to `standalone`.
2. Run `npm install`.
3. Confirm baseline build:
   - `npm run watch` (or "Launch Copilot Extension - Watch Mode" in VS Code)
   - `npm run typecheck` should be green
4. Skip `npm run get_token`. We will not need a real Copilot token.

Mark this commit as the strip baseline.

---

## Phase 1 — Synthesize a Copilot token (4–6 hours)

**Why first:** every chat-related contribution in `vscodeNodeChatContributions` waits for `authenticationService.copilotToken !== undefined` before activating. Until this is fixed, you'll see "Copilot is starting" forever.

### 1.1 Add a standalone token manager

Create `src/platform/authentication/node/standaloneCopilotTokenManager.ts`:

```ts
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { Emitter } from '../../../util/vs/base/common/event';
import { CopilotToken, ExtendedTokenInfo } from '../common/copilotToken';
import { ICopilotTokenManager } from '../common/copilotTokenManager';

export class StandaloneCopilotTokenManager extends Disposable implements ICopilotTokenManager {
    declare readonly _serviceBrand: undefined;
    private readonly _onDidCopilotTokenRefresh = this._register(new Emitter<void>());
    readonly onDidCopilotTokenRefresh = this._onDidCopilotTokenRefresh.event;

    private readonly _info: ExtendedTokenInfo = {
        token: 'standalone:none',
        expires_at: 2_000_000_000, // year 2033
        refresh_in: 86400,
        sku: 'individual_pro',                // pretend a paid user — unblocks gates that hide on free
        individual: true,
        blackbird_clientside_indexing: false,
        code_quote_enabled: false,
        code_review_enabled: false,
        codesearch: false,
        copilotignore_enabled: false,
        vsc_electron_fetcher_v2: false,
        public_suggestions: 'disabled',
        telemetry: 'disabled',                // critical: prevents telemetry from firing
        username: 'standalone',
        isVscodeTeamMember: false,
        copilot_plan: 'individual_pro',
        organization_login_list: [],
    };

    async getCopilotToken(): Promise<CopilotToken> {
        return new CopilotToken(this._info);
    }

    resetCopilotToken(): void { /* no-op */ }
}
```

### 1.2 Register it in `services.ts`

In `src/extension/extension/vscode-node/services.ts:194` replace:

```ts
builder.define(ICopilotTokenManager, new SyncDescriptor(VSCodeCopilotTokenManager));
```

with:

```ts
builder.define(ICopilotTokenManager, new SyncDescriptor(StandaloneCopilotTokenManager));
```

### 1.3 Make `_handleAuthChangeEvent` populate the cached token immediately

`AuthenticationService` calls `getCopilotToken()` only after detecting a GitHub session change (`src/platform/authentication/common/authentication.ts:283-336`). Without a GitHub session it never fires. Two options:

- **Option A (clean):** override `AuthenticationService` with a `StandaloneAuthenticationService` whose `_handleAuthChangeEvent` unconditionally calls `getCopilotToken(true)` and fires `onDidAuthenticationChange` once on construction.
- **Option B (cheap):** in `BaseAuthenticationService.constructor` (look in `authentication.ts`), trigger an initial `await this.getCopilotToken()` in a `setImmediate`. Less invasive.

Option A is recommended. New file `src/platform/authentication/vscode-node/standaloneAuthenticationService.ts`:

```ts
import { authentication, AuthenticationGetSessionOptions, AuthenticationSession } from 'vscode';
import { BaseAuthenticationService, StrictAuthenticationPresentationOptions } from '../common/authentication';

export class StandaloneAuthenticationService extends BaseAuthenticationService {
    protected override async _handleAuthChangeEvent(): Promise<void> {
        // Bypass GitHub session checks entirely — synthetic token is always available.
        try {
            await this.getCopilotToken(true);
        } catch { /* swallow */ }
        this.fireAuthenticationChange('standalone-bootstrap');
    }

    override async getGitHubSession(): Promise<AuthenticationSession | undefined> {
        return undefined;  // no GitHub auth in standalone
    }

    protected async getAnyAdoSession(): Promise<AuthenticationSession | undefined> {
        return undefined;
    }

    async getAdoAccessTokenBase64(): Promise<string | undefined> {
        return undefined;
    }
}
```

In `services.ts:202` replace:

```ts
builder.define(IAuthenticationService, new SyncDescriptor(AuthenticationService));
```

with:

```ts
builder.define(IAuthenticationService, new SyncDescriptor(StandaloneAuthenticationService));
```

### 1.4 Checkpoint

`npm run watch` should compile clean. Launch the extension. The chat panel may not yet show models, but the extension should *activate without hanging on the Copilot token*. Look for `ConversationFeature: Copilot token already available` in the "GitHub Copilot Chat" output channel. If you see `Waiting for copilot token to activate conversation feature`, phase 1 is incomplete.

---

## Phase 2 — Disable telemetry & experimentation (30 minutes)

This is trivially small but earns you isolation immediately.

### 2.1 Swap two service registrations

In `src/extension/extension/vscode-node/services.ts`:

- Find `setupTelemetry(builder, ...)` — comment out both call sites (lines around 185, 193). Replace with:

  ```ts
  builder.define(ITelemetryService, new SyncDescriptor(NullTelemetryService));
  ```

  Add the import: `import { NullTelemetryService } from '../../../platform/telemetry/common/nullTelemetryService';`

- Find `builder.define(IExperimentationService, new SyncDescriptor(MicrosoftExperimentationService));` (around line 307). Replace with:

  ```ts
  builder.define(IExperimentationService, new SyncDescriptor(NullExperimentationService));
  ```

  The import is already present at the top.

### 2.2 Remove the OTel exporter wiring

In the same file, the OTel block at lines ~268-300 starts a SQLite/OTLP exporter. Set `otelConfig.enabled = false` unconditionally or just always pick the null branch:

```ts
const { NullOTelService } = require('../../../platform/otel/common/nullOTelService') as typeof import('../../../platform/otel/common/nullOTelService');
builder.define(IOTelService, new NullOTelService());
```

(Verify the null impl exists; if not, write a no-op.)

### 2.3 Remove fetcher telemetry probe contribution

In `src/extension/extension/vscode-node/contributions.ts:72` remove `asContributionFactory(FetcherTelemetryContribution),` from `vscodeNodeContributions`. This kills the periodic POST to `api.github.com` from `loggingActions.ts:519,554`.

### 2.4 Checkpoint

Compile clean. Launch. Confirm in the network tab / `tcpdump` that no requests go to `*.applicationinsights.azure.com`, `*.exp-tas.com`, or `api.github.com` from the extension on startup.

---

## Phase 3 — Always-on BYOK (1 hour)

Today BYOK is gated on `(copilotToken.isInternal || copilotToken.isIndividual) && !isGHE`. With our synthetic individual token this gate already passes — but a few other things still depend on it. Make BYOK fearless.

### 3.1 Force `isBYOKEnabled` true

`src/extension/byok/common/byokProvider.ts:157-165`:

```ts
export function isBYOKEnabled(_copilotToken: Omit<CopilotToken, 'token'>, _capi: ICAPIClientService): boolean {
    return true;
}
```

### 3.2 Make the known-models fetch tolerant

`src/extension/byok/vscode-node/byokContribution.ts:70-83` calls `https://main.vscode-cdn.net/extensions/copilotChat.json`. Wrap in try/catch and default to `{}`:

```ts
private async fetchKnownModelList(fetcherService: IFetcherService): Promise<Record<string, BYOKKnownModels>> {
    try {
        const data = await (await fetcherService.fetch('https://main.vscode-cdn.net/extensions/copilotChat.json',
            { method: 'GET', callSite: 'byok-known-models' })).json();
        if (data?.version === 1) { return data.modelInfo; }
    } catch (e) {
        this._logService.warn('BYOK: known-models fetch failed, using empty list (standalone mode).');
    }
    return {};
}
```

This means BYOK still works fully — providers will treat any user-entered model id as a custom model. You lose the "preset capabilities" UX but you don't depend on Microsoft's CDN.

### 3.3 Reveal the customoai (OpenAI Compatible) provider on stable channels

`package.json:1837` has `"when": "productQualityType != 'stable'"` on the `customoai` provider — it's hidden on stable VS Code today. Remove that `when` so vLLM / LM Studio / generic OpenAI-compatible servers are first-class:

```diff
  {
      "vendor": "customoai",
-     "when": "productQualityType != 'stable'",
      "displayName": "OpenAI Compatible",
```

### 3.4 Checkpoint

Reload the extension. Open the model picker. Add an Ollama or OpenAI provider. Confirm models list and a chat round-trip works.

**At this point chat against your own LLM works.** The remaining phases are about removing dead code and dead network paths.

---

## Phase 4 — Replace the `@vscode/copilot-api` routing kernel with a stub (1 day)

Goal: the package is still imported (cheaper than ripping every import site), but its `CAPIClient` is replaced with a class that throws `NotSupportedError` for every routed request type. This gives you a screaming failure if any feature you didn't disable tries to hit CAPI.

### 4.1 Inventory CAPI callers

```bash
grep -rn "RequestType\." src/ | grep -v test/ | wc -l
grep -rn "@vscode/copilot-api" src/ | grep -v test/
```

You'll see ~42 import sites and ~37 distinct RequestType values. None of them matter for chat-via-BYOK except the implicit `'copilot-base'` fallback (covered in Phase 6).

### 4.2 Write a stub CAPIClient

Replace `src/platform/endpoint/common/capiClient.ts:20-61`:

```ts
export class StandaloneCAPIClientService extends BaseCAPIClientService {
    declare readonly _serviceBrand: undefined;

    override makeRequest<T>(_request: MakeRequestOptions, requestMetadata: RequestMetadata): Promise<T> {
        throw new Error(`[standalone] CAPI request blocked: ${RequestType[requestMetadata.type]}. ` +
            `Configure a BYOK provider in the model picker instead.`);
    }

    public override get dotcomAPIURL(): string {
        return 'https://api.github.com';  // many call sites read this just to check === api.github.com (i.e. is-not-GHE)
    }
}
```

In `services.ts:177` swap `CAPIClientImpl` for `StandaloneCAPIClientService`. (Or just edit `CAPIClientImpl.makeRequest` directly — same effect.)

### 4.3 Why this is safer than ripping the imports

The `RequestType` enum and `RequestMetadata` type stay, so 42 files keep compiling. If a code path you didn't expect tries to fetch via CAPI, you get a useful runtime error instead of a silent compile break or a hung request. As you observe failures, you can disable the corresponding contribution.

### 4.4 Checkpoint

Reload, send a chat message via your BYOK provider. Confirm in the request log ("Show Chat Debug View") that the request goes directly to your endpoint, not via CAPI.

---

## Phase 5 — Make `IEndpointProvider` BYOK-aware (4–8 hours)

The chat-panel happy path works after Phases 1–4, but a number of features call `endpointProvider.getChatEndpoint('copilot-base')` for sub-tasks (agent codebase tool, devcontainer config, feedback generator, search-panel intent, settings-search, see grep below). They will throw via Phase 4's stub.

```bash
grep -rn "getChatEndpoint('copilot-base')\|copilot-base'" src/ | grep -v test/
```

The fix: route `'copilot-base'` (and any string family request) to the user-selected default BYOK model.

### 5.1 Add a "default model" config key

In `src/platform/configuration/common/configurationService.ts` add a key like:

```ts
StandaloneDefaultChatModel = 'standalone.defaultChatModel',  // e.g. "ollama/llama3.1" or "openai/gpt-4o-mini"
```

Register it in `package.json` `contributes.configuration` so users can set it.

### 5.2 Resolver

Replace `ProductionEndpointProvider.getChatEndpoint` (`src/extension/prompt/vscode-node/endpointProviderImpl.ts:65-95`):

```ts
async getChatEndpoint(req: LanguageModelChat | ChatRequest | ChatEndpointFamily): Promise<IChatEndpoint> {
    // String family request → resolve to default BYOK model
    if (typeof req === 'string') {
        const lm = await this._resolveDefaultBYOK();
        if (!lm) { throw new Error(`No default standalone model configured. Set "${ConfigKey.StandaloneDefaultChatModel}".`); }
        return this._instantiationService.createInstance(ExtensionContributedChatEndpoint, lm);
    }

    const model = 'model' in req ? req.model : req;
    if (!model) { return this.getChatEndpoint('copilot-base'); }

    // All non-copilot vendors → wrap as ExtensionContributedChatEndpoint (already the production behavior)
    return this._instantiationService.createInstance(ExtensionContributedChatEndpoint, model);
}

private async _resolveDefaultBYOK(): Promise<LanguageModelChat | undefined> {
    const configured = this._configService.getConfig(ConfigKey.StandaloneDefaultChatModel);
    const all = await vscode.lm.selectChatModels({});
    return configured ? all.find(m => `${m.vendor}/${m.id}` === configured) ?? all[0] : all[0];
}
```

### 5.3 Make `getEmbeddingsEndpoint` either work or fail loudly

It calls `RequestType.EmbeddingsModels` to fetch model metadata then uses CAPI. Two choices:

- **Stub-throw:** make it throw `'standalone: embeddings disabled'`. Workspace semantic search and settings-semantic-search will fail; code chat is unaffected.
- **Implement:** write a `StandaloneEmbeddingsEndpoint` that POSTs to the user-configured `/v1/embeddings`. This is non-trivial because the existing `EmbeddingEndpoint` uses CAPI's response format. Defer unless you actually need workspace search.

Recommendation: stub-throw initially.

### 5.4 Checkpoint

Trigger any feature that uses `'copilot-base'` (e.g. dev container generation, search panel) and confirm it either works (resolved to your default BYOK) or fails with a clear standalone-mode error.

---

## Phase 6 — Prune dead cloud contributions (2–4 hours)

These are pure removals from the contribution registries. Everything still compiles afterwards because the *services* they depend on stay registered (some still get DI-injected even if no contribution uses them); we just stop wiring up the entry points.

### 6.1 Remove from `vscodeNodeContributions` (`src/extension/extension/vscode-node/contributions.ts:65-101`)

| Remove | Why |
|---|---|
| `LoggingActionsContrib`, `FetcherTelemetryContribution` | Microsoft telemetry probes (`FetcherTelemetryContribution` already removed in Phase 2.3) |
| `WorkspaceRecorderFeature` | Telemetry-adjacent recorder |
| `ChatQuotaContribution` | CAPI quota enforcement |
| `SurveyCommandContribution` | Microsoft user surveys |
| `FeedbackCommandContribution` | "Send feedback" routes to GitHub |
| `WalkthroughCommandContribution` | Onboarding walkthrough referring to Copilot signup |
| `JointCompletionsProviderContribution`, `InlineCompletionContribution`, `NesRenameContribution` | NES / inline completions — out of scope |
| `CompletionsUnificationContribution` | Same |
| `workspaceIndexingContribution` | Remote workspace embeddings |
| `ChatSessionsContrib` | Cloud sessions surface |
| `GitHubMcpContrib` | Auto-registers `https://api.githubcopilot.com/mcp/`. Remove unless you want it |
| `OTelContrib` | OTel exporter (already neutered in Phase 2.2) |

### 6.2 Remove from `vscodeNodeChatContributions` (lines 109-128)

| Remove | Why |
|---|---|
| `RemoteAgentContribution` | Cloud agent jobs |
| `RenameSuggestionsContrib` | Calls `'copilot-base'` for rename — remove unless you want to wire it through Phase 5 |
| `SetupTestsContribution`, `FixTestFailureContribution` | Test scaffolding agents that call CAPI sub-tasks; remove unless wired |
| `IgnoredFileProviderContribution` | `RequestType.ContentExclusion` — fetches GitHub policy |

Keep:
- `ToolsContribution` — built-in tools (read/edit/run/search). Essential.
- `BYOKContrib` — model providers. Essential.
- `McpSetupCommands` — MCP server setup commands.
- `LanguageModelProxyContrib` — local language-model proxy (Anthropic-compatible HTTP server in `src/extension/agents/node/langModelServer.ts`). Useful for letting Claude Code connect to your provider.
- `PromptFileContribution` — `.prompt.md` support.
- `ConfigurationMigrationContribution` — config migration, harmless.
- `OnboardTerminalTestsContribution`, `LogWorkspaceStateContribution` — minor helpers.
- `AiMappedEditsContrib` — inline edit application; depends on chat endpoint, which now works.
- `OTelChatDebugLogProviderContribution`, `ChatDebugFileLoggerContribution`, `RequestLogTree` — local debug log surfaces, no network calls.

### 6.3 Remove the `chatParticipants` quota auto-switch

`src/extension/conversation/vscode-node/chatParticipants.ts:277-308` switches to `copilot-base` on quota exhaustion. With BYOK this code path is dead but the call to `vscode.lm.selectChatModels({ vendor: 'copilot' })` returns `[]`, the function just returns the request unchanged. No-op in standalone — leave it, or short-circuit:

```ts
private async switchToBaseModel(request: vscode.ChatRequest, _stream: vscode.ChatResponseStream): Promise<ChatRequest> {
    return request;  // standalone: no quota system
}
```

### 6.4 Strip `copilotToken.is*` flag readers (mostly cosmetic)

```bash
grep -rn "copilotToken?\?\.is" src/ | grep -v test/
```

Each is a one-line change. Examples:

| Site | Today | Standalone |
|---|---|---|
| `byokProvider.ts:163` | `(isInternal \|\| isIndividual) && !isGHE` | always true (Phase 3.1) |
| `chatMLFetcher.ts:1197,1258` | quota-exceeded handling | dead code, leave |
| `inlineEditProviderFeature.ts:78` | internal-only UI | already false (synthetic token has `isInternal:false`) |
| `welcomeMessageProvider.ts:16` | internal welcome | same |
| `settingsEditorSearchServiceImpl.ts:75` | disable for free user | dead code |
| `renameSuggestionsProvider.ts:73` | same | same |

These mostly resolve to the right branch automatically given the synthetic token. Touch them only if a feature misbehaves.

### 6.5 Checkpoint

Compile, reload, run a full agent task with tool calls. Verify (a) the agent loop completes, (b) no requests leave to non-user-configured hosts, (c) the request log shows the BYOK endpoint as the destination.

---

## Phase 7 — Identity & distribution (1–3 days, optional)

If you only want this for personal use, skip — the "Launch Copilot Extension" debug config works against any VS Code build that ships the proposed APIs (Insiders or recent Stable).

If you want to publish the fork:

### 7.1 Rename the extension

`package.json`:

```diff
- "name": "copilot-chat",
- "displayName": "GitHub Copilot Chat",
- "publisher": "GitHub",
+ "name": "your-chat",
+ "displayName": "Your Chat",
+ "publisher": "your-publisher-id",
```

Remove `internalAIKey`, `internalLargeStorageAriaKey`, `ariaKey` (telemetry keys).

### 7.2 Strip the GitHub-specific badges, qna, homepage, bugs URLs

Lines 1-100 of `package.json`.

### 7.3 Decide on `enabledApiProposals`

The ~50 proposed APIs at `package.json:90-151` are only available in Microsoft VS Code Insiders by default. Some (`chatProvider@4`, `defaultChatParticipant@4`, `chatSessionsProvider@3`, `chatParticipantPrivate@15`, `languageModelSystem`) are mandatory for the chat panel integration. Two paths:

- **Easiest:** target VS Code Insiders only. Document in the README.
- **Harder:** identify which proposed APIs are not strictly required (e.g. drop chat sessions, code-action AI, etc.) and prune `enabledApiProposals`. Each removal eliminates a feature surface.

### 7.4 Code-OSS distribution

If you want to bundle this with Code-OSS as a vendored extension, follow `CONTRIBUTING.md` "Running with Code OSS" — `product.overrides.json` or direct edits to `src/vs/platform/product/common/product.ts`. Replace the `defaultChatAgent` block's extension IDs with your own publisher.

---

## Validation matrix — what should work

After all phases:

| Feature | Expected | How to verify |
|---|---|---|
| Open chat panel | ✅ Works | Side bar → Copilot Chat icon |
| Add BYOK provider | ✅ Works | Model picker → Manage Models → pick provider |
| Send a chat message | ✅ Round-trips to your LLM | "Show Chat Debug View", inspect request URL |
| Agent mode tool-calling | ✅ Works | Switch to "Agent" mode, ask it to read+edit a file |
| Inline chat (Ctrl+I) | ✅ Works | Triggers selected BYOK model |
| Built-in tools (read/edit/run/search/grep) | ✅ Works | Agent uses them |
| MCP servers | ✅ Works | Add an MCP server in `.vscode/mcp.json` |
| `.prompt.md` files | ✅ Works | File-based |
| Custom instructions, AGENTS.md | ✅ Works | File-based |
| **No** network calls to `*.azure.com`, `*.exp-tas.com`, `api.github.com`, `api.individual.githubcopilot.com`, `*.vscode-cdn.net` | ✅ Verified | `tcpdump` or browser dev tools network panel |

What won't work, and that's by design:
- @workspace semantic search (needs embeddings backend)
- NES / inline completions (separate product, separate routing)
- Cloud agents, code review, public-code matching, copilotignore
- Auto model selection
- Anything reading from Microsoft's experimentation flags (defaults silently)

---

## Per-phase effort estimate (one experienced engineer)

| Phase | Effort | Risk |
|---|---|---|
| 0. Branch + build | 1–2 hr | Low |
| 1. Synthetic token + standalone auth | 4–6 hr | Medium — auth state machine has edge cases |
| 2. Telemetry off | 30 min | Low |
| 3. Always-on BYOK + customoai | 1 hr | Low |
| 4. CAPI stub | 1 day | Medium — surfaces hidden CAPI dependencies |
| 5. EndpointProvider rewrite | 4–8 hr | Medium — `'copilot-base'` is widely used |
| 6. Contribution prune + flag sweep | 2–4 hr | Low |
| 7. Distribution (optional) | 1–3 days | Low (but tedious) |
| **Total** | **2–4 weeks part-time** | |

---

## Maintenance — staying mergeable with `main`

This fork is a thin overlay, not a deep rewrite. The merge cost stays manageable if you:

1. **Keep changes additive where possible.** New files (`StandaloneCopilotTokenManager`, `StandaloneCAPIClientService`, `StandaloneAuthenticationService`) instead of rewriting existing ones. Upstream renames don't break new files.
2. **Concentrate registry edits.** Almost all "ripping" is in three files:
   - `src/extension/extension/vscode-node/services.ts` (DI wiring)
   - `src/extension/extension/vscode-node/contributions.ts` (contribution lists)
   - `package.json` (proposed APIs, vendor metadata, customoai gating)
   Conflicts here are easy to resolve manually.
3. **Don't sweep `copilotToken.is*` callers preemptively.** Most resolve correctly with the synthetic token. Fix them only when a real misbehavior shows up.
4. **Rebase weekly.** The CAPI stub will catch any new `RequestType.X` upstream adds. Just expand the stub's allow/deny accordingly.

Realistic ongoing cost: ~30–60 minutes per upstream merge, dominated by `services.ts`/`contributions.ts` conflicts and verifying that the synthetic-token flags still pass any new gates.

---

## Pitfalls to know about

- **Activation events.** `package.json:84-89` includes `onLanguageModelChat:copilot` as an activation event. This still fires in standalone (the chat provider for `copilot` vendor is registered by `LanguageModelAccess`, line 216). Don't remove it without testing — VS Code may otherwise not activate the extension when chat opens.
- **`AutoChatEndpoint` / model router.** `getChatEndpoint` checks `model.id === 'auto'` and calls `IAutomodeService.resolveAutoModeEndpoint` which hits `RequestType.ModelRouter`. With the CAPI stub this throws. Either filter out the `'auto'` model from the picker, or short-circuit to the default in your modified `ProductionEndpointProvider`.
- **`copilotcli` and `claude-code` vendors.** `package.json:1722-1731` register Copilot CLI and Claude Code as language-model chat vendors with `"when": "false"`. They register session providers, not LM providers. The `claude-code` integration in `src/extension/chatSessions/claude/` is independent and doesn't go through CAPI — it talks to the Claude Code CLI locally. You can keep it.
- **Locale / l10n.** `@vscode/l10n` works fine offline. Don't rip.
- **The model picker shows "Manage Models" UI** that walks the user through API key entry. This is built into VS Code itself, not the extension — should "just work" in standalone.
- **`getCopilotToken().token === 'standalone:none'`** means anything that tries to use it as a Bearer in a real HTTP call will get a 401. The CAPI stub catches the routed cases; if a code path bypasses the stub and makes a raw fetch, you'll see 401s in the log with a useful URL. Add to the stub allow/deny as discovered.

---

## Tasks list (rough TODO you can paste into a tracker)

```
[Phase 0] Create `standalone` branch, verify baseline build
[Phase 1] Write StandaloneCopilotTokenManager + StandaloneAuthenticationService
[Phase 1] Wire them into vscode-node/services.ts
[Phase 1] Verify ConversationFeature activates without GitHub login
[Phase 2] Replace ITelemetryService with NullTelemetryService
[Phase 2] Replace IExperimentationService with NullExperimentationService
[Phase 2] Replace IOTelService with NullOTelService
[Phase 2] Remove FetcherTelemetryContribution from contribution list
[Phase 3] Force isBYOKEnabled() → true in byokProvider.ts
[Phase 3] Make BYOK known-models fetch tolerant of failure
[Phase 3] Remove customoai `when: productQualityType != 'stable'` gate
[Phase 4] Replace CAPIClientImpl.makeRequest with throw-stub
[Phase 5] Add ConfigKey.StandaloneDefaultChatModel
[Phase 5] Rewrite ProductionEndpointProvider.getChatEndpoint
[Phase 5] Stub-throw getEmbeddingsEndpoint
[Phase 6] Remove cloud-only contributions from registries (see table)
[Phase 6] Filter 'auto' model from the picker, or short-circuit
[Phase 7 — optional] Rename publisher/extension id in package.json
[Phase 7 — optional] Audit enabledApiProposals; document VS Code Insiders requirement
[Phase 7 — optional] Code-OSS product.overrides.json setup
[Validation] Confirm tcpdump shows zero traffic to MS/GH hosts at idle
[Validation] Run an end-to-end agent task with tool calls against your LLM
```
