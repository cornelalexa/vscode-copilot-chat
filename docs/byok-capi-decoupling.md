# BYOK and CAPI Decoupling Assessment

This document summarizes the current GitHub/Copilot CAPI dependency map and a coherent path for stripping direct GitHub subscription, Copilot token, and CAPI dependencies while preserving local IDE-integrated agentic functionality where possible.

The target direction is not to preserve Microsoft/GitHub cloud behavior. The target is to keep local VS Code integration, tools, MCP, editing, diagnostics, terminal/task/test workflows, and provider-neutral chat/agent orchestration working through BYOK or local model providers.

## Goals

- Remove the requirement for a GitHub account or Copilot subscription.
- Keep local agentic IDE functionality working with BYOK/local model providers.
- Keep tool calling, MCP, filesystem edits, diagnostics, terminal/task/test integration, workspace context gathering, and prompt orchestration where possible.
- Replace or gracefully disable GitHub/Copilot-specific cloud capabilities.
- Leave clean extension points for future local or BYOK replacements.

## Non-Goals

- Preserve Copilot subscription entitlements, quotas, premium/free plans, GitHub account upgrade prompts, or Copilot CAPI model rollouts.
- Preserve GitHub-hosted remote code indexing/search as-is.
- Preserve Microsoft/GitHub telemetry/experimentation semantics as product-critical behavior.
- Preserve Copilot-specific review/cloud-agent features unless independently reimplemented.

## Current High-Level Architecture

The core chat and agent pipeline is already mostly model-provider agnostic:

1. VS Code chat participants receive the request.
2. Intent selection builds a prompt.
3. Tool loops execute local tools and MCP tools.
4. `IChatEndpoint` sends the model request.
5. Responses and tool calls are streamed back into VS Code.

The key abstraction is `IChatEndpoint` in `src/platform/networking/common/networking.ts`. Most prompt and tool orchestration depends on this abstraction rather than directly on CAPI.

The current product gate, model metadata, authentication, embeddings, remote code search, quotas, and some feature flags are still strongly tied to GitHub/Copilot services.

Second-pass qualification:

- The prompt/tool pipeline is mostly endpoint-abstraction based, but the conversation feature activation is not. `ConversationFeature` waits for `authenticationService.copilotToken` before registering participants, commands, providers, settings search, semantic search, and chat contributions.
- BYOK provider registration is gated by Copilot auth, and OpenAI-compatible BYOK transport currently still passes through `ChatMLFetcherImpl`, which unconditionally calls `getCopilotToken()` before network fetch. Ungating registration alone is not sufficient.
- The standalone path must therefore decouple both activation and transport, not only model registration.

## Existing BYOK Path

BYOK already exists and is structurally useful.

Key files:

- `src/extension/byok/common/byokProvider.ts`
- `src/extension/byok/vscode-node/byokContribution.ts`
- `src/extension/byok/vscode-node/abstractLanguageModelChatProvider.ts`
- `src/extension/byok/node/openAIEndpoint.ts`
- `src/extension/byok/node/azureOpenAIEndpoint.ts`
- `src/platform/endpoint/vscode-node/extChatEndpoint.ts`

Existing providers:

- OpenAI
- Azure OpenAI
- Anthropic
- Gemini
- xAI
- OpenRouter
- Custom OpenAI-compatible endpoint
- Ollama

Current issue: BYOK registration is gated by Copilot auth.

`BYOKContrib` only registers providers when `authService.copilotToken` exists and `isBYOKEnabled(...)` returns true. `isBYOKEnabled` currently requires an internal or individual Copilot token and dotcom CAPI.

This is one of the first gates to remove.

### BYOK Provider Implementation Style

The existing provider implementation is in-house. There is no LiteLLM or equivalent generic provider router in the runtime path.

Dependencies observed in `package.json`:

- `openai` is present, but the OpenAI-compatible BYOK runtime primarily uses internal endpoint/fetch code rather than the OpenAI SDK.
- `@anthropic-ai/sdk` is used for native Anthropic BYOK.
- `@google/genai` is used for native Gemini BYOK.
- No `litellm` dependency was found.

Provider hierarchy:

- `src/extension/byok/vscode-node/abstractLanguageModelChatProvider.ts` defines `AbstractLanguageModelChatProvider` and `AbstractOpenAICompatibleLMProvider`.
- OpenAI-compatible providers create `OpenAIEndpoint` and delegate through `CopilotLanguageModelWrapper`.
- `src/extension/byok/node/openAIEndpoint.ts` extends the shared `ChatEndpoint` transport shape for BYOK auth and raw HTTP URLs.
- `src/extension/byok/vscode-node/customOAIProvider.ts` handles user-configured OpenAI-compatible models.
- `src/extension/byok/vscode-node/anthropicProvider.ts` uses the Anthropic SDK directly and converts VS Code messages/tools to Anthropic messages.
- `src/extension/byok/vscode-node/geminiNativeProvider.ts` uses the Google GenAI SDK directly and converts VS Code messages/tools to Gemini contents/function declarations.

OpenAI-compatible path:

1. BYOK provider registers as a VS Code `LanguageModelChatProvider`.
2. VS Code calls `provideLanguageModelChatResponse(...)`.
3. `AbstractOpenAICompatibleLMProvider` creates an `OpenAIEndpoint`.
4. `CopilotLanguageModelWrapper` converts VS Code LM messages/tools into the internal raw message format.
5. `ChatEndpoint.createRequestBody(...)` builds a Chat Completions or Responses API request.
6. `ChatMLFetcherImpl` posts through the repo's fetch/SSE machinery.

Native provider path:

- Anthropic and Gemini bypass the OpenAI-compatible transport and use provider SDK clients directly.
- They still plug into the same VS Code language model provider interface and convert streamed provider output back into VS Code response parts.

Implication for decoupling:

- There is already enough in-house provider infrastructure to proceed without adopting LiteLLM.
- A LiteLLM-style abstraction could still be added later, but it would be a new architectural choice, not something the repo currently relies on.
- The shortest path is to ungate and harden the existing BYOK provider stack rather than replacing it.

### Custom OpenAI-Compatible Provider Details

Key file:

- `src/extension/byok/vscode-node/customOAIProvider.ts`

Capabilities supported by configured models:

- model id and display name
- endpoint URL
- max input/output tokens
- tool calling
- vision
- thinking
- streaming
- edit tool hints
- extra request headers with sanitization
- zero data retention metadata

URL handling:

- If the URL already includes `/responses` or `/chat/completions`, it is used as explicit API path.
- Otherwise `/v1/chat/completions` is appended by default.
- If a model's URL includes `/responses`, the model metadata advertises both Chat Completions and Responses support.

This is a strong starting point for provider-neutral standalone mode, especially for local gateways such as Ollama-compatible proxies, vLLM, LM Studio, llama.cpp servers, OpenRouter-style routers, or a future LiteLLM gateway.

## Critical CAPI/GitHub Dependency Areas

### Authentication and Product Gate

Key files:

- `src/platform/authentication/common/authentication.ts`
- `src/platform/authentication/vscode-node/authenticationService.ts`
- `src/platform/authentication/vscode-node/session.ts`
- `src/platform/authentication/vscode-node/copilotTokenManager.ts`
- `src/platform/authentication/node/copilotTokenManager.ts`
- `src/platform/authentication/common/copilotToken.ts`

Current behavior:

- GitHub OAuth sessions are acquired through VS Code authentication.
- GitHub OAuth tokens are exchanged for Copilot tokens.
- Copilot tokens carry plan, entitlement, quota, organization, internal-user, and feature flags.
- Subscription errors such as `not_signed_up`, `subscription_ended`, and `enterprise_managed_user_account` are mapped into product state.

Breakage if removed without replacement:

- Chat participants and most conversation contributions do not activate because `ConversationFeature` waits for `copilotToken`.
- BYOK providers do not register.
- Copilot model provider cannot list models.
- Embeddings provider does not register.
- Model picker can be empty.
- Subscription/quota UI and context keys become meaningless.
- Many features checking `copilotToken` may disable themselves or throw.

Shortest preservation path:

- Add a provider mode such as `byok` or `standalone`.
- In standalone mode, do not prompt for GitHub auth.
- Activate `ConversationFeature` based on standalone mode plus at least one usable model provider, not on `copilotToken`.
- Introduce a local product/session state service that reports capability availability without requiring Copilot token fields.
- Keep `IAuthenticationService` only where needed for optional GitHub features, or split it into narrower services.
- Make BYOK registration independent from `copilotToken`.

Future replacement path:

- Replace Copilot token feature flags with explicit local configuration and provider capability discovery.
- Split GitHub session APIs from generic provider credential APIs.

### Model Metadata and Endpoint Selection

Key files:

- `src/extension/prompt/vscode-node/endpointProviderImpl.ts`
- `src/platform/endpoint/node/modelMetadataFetcher.ts`
- `src/platform/endpoint/node/chatEndpoint.ts`
- `src/platform/endpoint/node/copilotChatEndpoint.ts`
- `src/platform/endpoint/vscode-node/extChatEndpoint.ts`
- `src/extension/conversation/vscode-node/languageModelAccess.ts`

Current behavior:

- `ProductionEndpointProvider` defaults to `copilot-base`.
- Copilot model metadata is fetched from CAPI `/models` through `ModelMetadataFetcher`.
- Non-Copilot VS Code language models are wrapped as `ExtensionContributedChatEndpoint`.
- `LanguageModelAccess` registers the Copilot language model provider and requires `getCopilotToken()` before publishing Copilot model info or embeddings. BYOK providers publish their own VS Code language model providers separately.

Breakage if removed without replacement:

- Default model resolution fails.
- Model picker can be empty.
- Any hardcoded `getChatEndpoint('copilot-fast')` or `getChatEndpoint('copilot-base')` call fails.
- Copilot-specific auto model behavior becomes unavailable.

Shortest preservation path:

- Make BYOK/local provider models the source of truth in standalone mode.
- Replace hardcoded `copilot-base` fallback with configured default BYOK model or first available model.
- Guard or replace hardcoded `copilot-fast` helper calls.
- Do not rely on `LanguageModelAccess` to publish BYOK/local models; instead ensure BYOK provider registration and endpoint resolution work without Copilot LM publication.
- Disable Copilot auto model if no Copilot model metadata exists.

Future replacement path:

- Add a provider-neutral `ModelRegistry` service.
- Model metadata should come from local config, provider discovery, or provider-specific known-model manifests.
- Treat Copilot CAPI metadata as only one optional model source.

### Embedded Prompts and Model-Specific Prompt Profiles

The repo has a substantial embedded prompt system. These prompts are not inherently tied to CAPI transport, but some model selection logic is tied to CAPI model ids/families and hidden hashed identifiers.

Prompt infrastructure:

- `src/extension/prompts/node/base/promptRenderer.ts`
- `src/extension/prompts/node/agent/agentPrompt.tsx`
- `src/extension/prompts/node/agent/promptRegistry.ts`
- `src/extension/prompts/node/agent/allAgentPrompts.ts`
- `src/extension/prompts/node/agent/defaultAgentInstructions.tsx`
- `assets/prompts/*.prompt.md`
- `assets/prompts/skills/**`

Prompt registry behavior:

- `PromptRegistry.resolveAllCustomizations(...)` first checks explicit `matchesModel(endpoint)` resolvers.
- If no matcher resolves, it checks `endpoint.family.startsWith(prefix)` against registered family prefixes.
- It then returns model-specific system prompt, reminder instructions, tool reference hints, identity rules, safety rules, and user-query tag name.

Model/provider prompt families observed:

- OpenAI/GPT prompts under `src/extension/prompts/node/agent/openai/**`.
- Anthropic prompts in `src/extension/prompts/node/agent/anthropicPrompts.tsx`.
- Gemini prompts in `src/extension/prompts/node/agent/geminiPrompts.tsx`.
- xAI/Grok prompts in `src/extension/prompts/node/agent/xAIPrompts.tsx`.
- Z.ai/GLM prompts in `src/extension/prompts/node/agent/zaiPrompts.tsx`.
- MiniMax prompts in `src/extension/prompts/node/agent/minimaxPrompts.tsx`.
- Hidden/VSC model prompts in `src/extension/prompts/node/agent/vscModelPrompts.tsx`, `hiddenModelBPrompt.tsx`, and `familyHPrompts.tsx`.

Portable prompt cases:

- Public family/prefix prompts are mostly portable.
- BYOK model metadata currently sets `family = modelId` in `resolveModelInfo(...)`, so models named like `gpt-*`, `claude-*`, `gemini-*`, `grok-code-*`, or matching known GLM/MiniMax patterns can naturally select the same prompt customizations.
- This means a BYOK `gpt-5.4`-equivalent model can reuse the `gpt-5.4` prompt path if its family/id is normalized to `gpt-5.4...`.
- Anthropic and Gemini BYOK models can reuse Anthropic/Gemini prompt logic if their model ids/families match the expected prefixes.

Non-portable prompt cases:

- Hidden Copilot/VSC prompts are matched through SHA-256 hashes in `src/platform/endpoint/common/chatModelCapabilities.ts`.
- These are CAPI/model-rollout-specific and cannot be reliably mapped to external BYOK models by name.
- Some model capability functions also use hidden hashes to choose edit tools or prompt behavior.

Important capability logic:

- `src/platform/endpoint/common/chatModelCapabilities.ts` controls model families, hidden model detection, edit tool preferences, notebook representation preferences, PDF support, and some model-specific behavior.
- Examples include `isGpt54(...)`, `modelSupportsApplyPatch(...)`, `modelSupportsReplaceString(...)`, `modelSupportsMultiReplaceString(...)`, and `modelCanUseReplaceStringExclusively(...)`.

Shortest preservation path:

- Preserve the embedded prompt system and registry.
- Normalize BYOK/local model `family` values so public model-family prompts continue to match.
- Add explicit user/provider configuration for model prompt profile, for example `promptProfile: gpt-5.4`, `promptProfile: claude-4.5`, `promptProfile: gemini`, or `promptProfile: default-agent`.
- Use prompt profiles to replace hidden hash matching in standalone mode.

Future replacement path:

- Move from model-id/hash predicates to provider-neutral capability/profile metadata.
- Model metadata should include explicit fields such as `promptProfile`, `toolCallingStyle`, `editToolPreference`, `reasoningStyle`, `supportsThinking`, `supportsContextManagement`, and `supportsToolDeferral`.
- Prompt selection should prefer explicit profile metadata over CAPI family/hash heuristics.

Prompt portability answer:

- Yes, many prompts can be preserved and applied to equivalent external models.
- This is safest for public model families like GPT, Claude, Gemini, Grok, GLM, and MiniMax.
- It is unsafe for hidden CAPI/VSC prompts unless the fork introduces explicit profile mapping.

### Chat Transport

Key files:

- `src/extension/prompt/node/chatMLFetcher.ts`
- `src/platform/networking/common/networking.ts`
- `src/platform/endpoint/common/capiClient.ts`
- `src/platform/endpoint/node/capiClientImpl.ts`
- `src/extension/byok/node/openAIEndpoint.ts`

Current behavior:

- Copilot endpoints go through `ChatMLFetcherImpl` and require `getCopilotToken()`.
- `postRequest` can send either raw HTTP URLs or CAPI `RequestMetadata`.
- BYOK OpenAI-compatible endpoints can supply their own raw URL and API key.
- Extension-contributed endpoints call `vscode.LanguageModelChat.sendRequest(...)` instead of CAPI directly.

Second-pass correction:

- OpenAI-compatible BYOK endpoints still pass through `ChatMLFetcherImpl`.
- `ChatMLFetcherImpl.fetchMany(...)` currently calls `this._authenticationService.getCopilotToken()` before `_fetchAndStreamChat(...)` regardless of whether the endpoint URL is CAPI or raw BYOK HTTP.
- This means standalone OpenAI-compatible BYOK requires a transport change, not just registration changes.

Breakage if removed without replacement:

- Copilot endpoints stop working, expected.
- BYOK OpenAI-compatible requests should still be viable if they do not hit `getCopilotToken()` gates before transport.
- Error handling and telemetry still use Copilot-shaped quota/rate-limit assumptions in several places.

Shortest preservation path:

- Ensure standalone chat uses `ExtensionContributedChatEndpoint` or BYOK `OpenAIEndpoint`, not `CopilotChatEndpoint`.
- Split Copilot fetcher behavior from generic OpenAI-compatible fetcher behavior where needed.
- Remove or bypass the unconditional `getCopilotToken()` call for raw BYOK endpoints.
- Strip CAPI-specific error handling from standalone mode or map provider errors generically.

Future replacement path:

- Generalize `ChatMLFetcherImpl` into provider-neutral HTTP transport.
- Keep CAPI request metadata support behind an optional Copilot module or remove it entirely for the fork.

## Embeddings and Semantic Search

Embeddings are important for high-quality semantic workspace search, but they are not critical for basic agentic IDE work.

If embeddings are unavailable, the agent can still operate with:

- file search
- text search
- workspace symbol search
- diagnostics
- file reads
- terminal/bash/task tools
- MCP tools
- iterative exploration through local tools

What is lost without replacement is fast semantic retrieval of relevant code by meaning.

### Embedding Abstraction

Key file:

- `src/platform/embeddings/common/embeddingsComputer.ts`

Service:

- `IEmbeddingsComputer.computeEmbeddings(...)`

Known types:

- `text-embedding-3-small-512`
- `metis-1024-I16-Binary`

Similarity:

- `distance(...)`
- `rankEmbeddings(...)`

Current implementation:

- `src/platform/embeddings/common/remoteEmbeddingsComputer.ts`

Current behavior:

- Calls `getCopilotToken()`.
- Authenticated users use GitHub dotcom embeddings.
- No-auth users use CAPI embeddings.

Breakage if removed without replacement:

- Workspace semantic search is unavailable.
- URL/webpage semantic chunk search is unavailable.
- Settings semantic search quality drops or fails.
- Virtual tool prediction/grouping based on embeddings is unavailable or degraded.
- VS Code embeddings provider `copilot.text-embedding-3-small` is unavailable.

Shortest preservation path:

- Disable semantic embeddings features when no embedding provider is configured.
- Keep agentic local workflows available through text search, symbols, diagnostics, and tool-based exploration.
- Use TF-IDF/local lexical search as a fallback for codebase context.

Future replacement path:

- Implement `IEmbeddingsComputer` for BYOK embeddings, local embeddings, or both.
- Candidate providers:
  - OpenAI-compatible `/v1/embeddings`
  - Ollama embeddings
  - local llama.cpp/ONNX/Transformers.js service
  - custom user-configured embedding HTTP endpoint
- Add config for embedding provider, embedding model, vector dimensions, quantization, batch size, and max input size.

### Workspace Semantic Search

Key files:

- `src/platform/workspaceChunkSearch/node/workspaceChunkSearchService.ts`
- `src/platform/workspaceChunkSearch/common/githubAvailableEmbeddingTypes.ts`
- `src/platform/workspaceChunkSearch/node/codeSearch/codeSearchChunkSearch.ts`
- `src/platform/workspaceChunkSearch/node/embeddingsChunkSearch.ts`
- `src/platform/workspaceChunkSearch/node/workspaceChunkEmbeddingsIndex.ts`
- `src/platform/workspaceChunkSearch/node/workspaceChunkAndEmbeddingCache.ts`
- `src/platform/chunking/common/chunkingEndpointClientImpl.ts`
- `src/extension/tools/node/codebaseTool.tsx`
- `src/extension/workspaceSemanticSearch/node/semanticSearchTextSearchProvider.ts`

Current behavior:

- `WorkspaceChunkSearchService` initializes only with a non-no-auth Copilot token.
- It asks GitHub for available embedding models.
- It computes query embeddings.
- It searches remote code indexes and/or local cached embeddings.
- Local embedding cache exists, but cache population uses remote chunking and embeddings endpoints.

Important point:

- The cache is local, but the current chunk-and-embed pipeline is not fully local.
- `ChunkingEndpointClientImpl` calls CAPI `RequestType.Chunks` with `embed: true`.

Breakage if removed without replacement:

- `#codebase` semantic search returns “Semantic workspace search is not currently available”.
- VS Code AI semantic text search provider cannot work.
- Fast codebase retrieval by meaning is lost.

Shortest preservation path:

- Make `codebase` tool fall back to an agent/tool exploration path when semantic search is disabled.
- Use local file/text/symbol tools as fallback.
- Add TF-IDF search as a local `codebase` fallback to provide ranked chunks without embeddings.
- Keep semantic search disabled until an embedding provider is configured.

Future replacement path:

- Replace GitHub embedding type discovery with local config.
- Replace remote chunking with local chunkers.
- Replace remote embeddings with `IEmbeddingsComputer` BYOK/local implementation.
- Keep `WorkspaceChunkSearchService` and cache/ranking structure, but remove GitHub/CAPI initialization gates.

### Local TF-IDF Fallback

Key files:

- `src/platform/tfidf/node/tfidf.ts`
- `src/platform/tfidf/node/tfidfWorker.ts`

Current behavior:

- Fully local SQLite-backed lexical/statistical index.
- Uses local chunking and tokenization.
- No GitHub/Copilot auth or remote service dependency.

Usefulness:

- Good candidate for local fallback.
- Not equivalent to semantic embeddings, but enough for many agentic workflows.

Shortest preservation path:

- Wire TF-IDF into the `codebase` tool when semantic search is unavailable.
- Prefer exact text search and symbol search for high-confidence queries.
- Use TF-IDF to discover candidate files/chunks for broader natural-language queries.

Future replacement path:

- Keep TF-IDF as fallback even after local/BYOK embeddings are added.

## Search Features by Dependency

### Preservable Local Search

Key files:

- `src/platform/search/common/searchService.ts`
- `src/platform/search/vscode/baseSearchServiceImpl.ts`
- `src/platform/search/vscode-node/searchServiceImpl.ts`
- `src/extension/tools/node/findFilesTool.tsx`
- `src/extension/tools/node/findTextInFilesTool.tsx`
- `src/extension/tools/node/searchWorkspaceSymbolsTool.tsx`

These use VS Code local APIs:

- `workspace.findFiles`
- `workspace.findTextInFiles`
- workspace symbol providers
- language server indexes

Dependency risk:

- Low. These can remain with selected BYOK/local chat endpoint.

### Remote Semantic Search to Remove or Replace

Key files:

- `src/platform/remoteCodeSearch/common/githubCodeSearchService.ts`
- `src/platform/remoteCodeSearch/common/adoCodeSearchService.ts`
- `src/platform/workspaceChunkSearch/node/codeSearch/externalIngestClient.ts`
- `src/platform/workspaceChunkSearch/node/codeSearch/externalIngestIndex.ts`

Dependency risk:

- High. These are remote GitHub/ADO semantic indexes.

Shortest preservation path:

- Disable these in standalone mode.
- Fall back to local text/symbol/TF-IDF search.

Future replacement path:

- Optional user-configured remote index service, not GitHub/CAPI-specific.

## Local IDE and Agentic Features That Can Be Preserved

These are mostly local and should survive as long as the selected model supports tool calling well enough.

### Filesystem and Workspace Tools

Key files:

- `src/extension/tools/node/readFileTool.tsx`
- `src/extension/tools/node/listDirTool.tsx`
- `src/extension/tools/node/findFilesTool.tsx`
- `src/extension/tools/node/findTextInFilesTool.tsx`
- `src/platform/filesystem/vscode/fileSystemServiceImpl.ts`
- `src/platform/workspace/vscode/workspaceServiceImpl.ts`

Dependency risk:

- Low.

### Editing and Apply Tools

Key files:

- `src/extension/tools/node/applyPatchTool.tsx`
- `src/extension/tools/node/createFileTool.tsx`
- `src/extension/tools/node/replaceStringTool.tsx`
- `src/extension/tools/node/multiReplaceStringTool.tsx`
- `src/extension/tools/node/insertEditTool.tsx`

Dependency risk:

- Low for normal edit application.
- Medium for recovery/healing paths that hardcode `copilot-fast`.

Shortest preservation path:

- Replace hardcoded `copilot-fast` helper endpoint with current/default configured endpoint.
- If no helper endpoint is configured, disable only the healing path, not the core edit tool.

### Terminal, Tasks, Tests, Diagnostics

Key files:

- `src/platform/terminal/common/terminalService.ts`
- `src/platform/terminal/vscode/terminalServiceImpl.ts`
- `src/extension/tools/node/getErrorsTool.tsx`
- `src/platform/languages/vscode/languageDiagnosticsServiceImpl.ts`
- `src/extension/tools/node/testFailureTool.tsx`
- `src/extension/tools/node/findTestsFilesTool.tsx`
- `src/platform/testing/vscode/testProviderImpl.ts`

Dependency risk:

- Low. These use VS Code local APIs and tool infrastructure.

### MCP

Key files:

- `src/extension/mcp/vscode-node/commands.ts`
- `src/extension/mcp/vscode-node/mcpToolCallingLoop.tsx`

Dependency risk:

- Low for MCP registry/config/tool execution itself.
- Medium for assisted config generation that hardcodes `copilot-fast`.

Shortest preservation path:

- Use configured default BYOK/local model for assisted MCP config generation.
- Keep package validation and MCP execution local/provider-neutral.

## Features That Should Be Disabled Initially

These are deeply tied to GitHub/Copilot cloud or subscription semantics and can be disabled in the first standalone implementation.

- Copilot token acquisition and subscription prompts.
- GitHub auth upgrade prompts for permissive scopes.
- Copilot premium/free model categorization.
- Copilot quota dialogs and token-based quota snapshots.
- CAPI model metadata fetch.
- GitHub remote code search and remote repo indexing.
- ADO semantic remote search, unless explicitly wanted as a separate provider.
- External ingest fileset indexing.
- Copilot cloud/agent/session features.
- GitHub PR/review agent functionality unless reimplemented using local git plus BYOK model.
- Copilot embeddings provider exposed as `copilot.text-embedding-3-small`.
- CAPI experimentation-driven behavior.

## Additional Areas Requiring Detail Before Implementation

The second-pass review identified several areas that were underrepresented in the initial assessment.

### Conversation Activation

Key file:

- `src/extension/conversation/vscode-node/conversationFeature.ts`

Current behavior:

- Registers the main conversation/chat providers only after a Copilot token exists.
- Activation toggles participants, commands, related information providers, semantic search provider, settings search provider, and chat contributions.

Standalone requirement:

- Introduce activation policy that allows local/BYOK mode without Copilot token.
- Keep GitHub/Copilot-specific providers disabled inside that activated state.

### BYOK Known-Model CDN Dependency

Key file:

- `src/extension/byok/vscode-node/byokContribution.ts`

Current behavior:

- Fetches known BYOK model metadata from `https://main.vscode-cdn.net/extensions/copilotChat.json`.

Standalone requirement:

- Do not let CDN failure block provider registration.
- Consider bundling known model metadata, using provider discovery, or allowing empty known models for custom/local providers.

### Package Contributions and Product Surface

Key file:

- `package.json`

Risk areas:

- Activation event `onLanguageModelChat:copilot`.
- Copilot/GitHub chat participant ids.
- Provider/vendor id `copilot`.
- Walkthroughs, views welcome, commands, context keys, menus, and settings names.
- `customoai` contribution is gated by `productQualityType != 'stable'`, which conflicts with using it as a primary standalone path in stable builds.

Standalone requirement:

- Decide whether this is a fork-wide rebrand/removal or an alternate mode inside the existing extension shape.
- Ensure custom/OpenAI-compatible provider configuration is available in the intended product quality channel.

### Telemetry and Experimentation as Behavior Inputs

Key files:

- `src/platform/telemetry/common/nullExperimentationService.ts`
- `src/platform/telemetry/vscode-node/experimentationService.ts`
- `src/platform/configuration/common/configurationService.ts`

Current behavior:

- Experiment values control model routing, prompt variants, search behavior, NES/inline behavior, and provider-specific features.
- Some telemetry/experimentation context derives from Copilot token, org, SKU, and CAPI assignment state.

Standalone requirement:

- Replace experiment-controlled product behavior with explicit local defaults/configuration.
- Keep a no-op or local-only experimentation service for standalone mode.

### Context Keys and UI State

Key file:

- `src/extension/contextKeys/vscode-node/contextKeys.contribution.ts`

Risk areas:

- Auth failure, subscription disabled/expired, quota exceeded, missing permissive session, preview disabled, and sidebar visibility keys are Copilot-shaped.

Standalone requirement:

- Add standalone context keys or neutralize Copilot auth/subscription states.
- Prevent missing Copilot auth from hiding the local/BYOK UI.

### Remote Agents, Cloud Sessions, Review, and Agent Memory

Key files:

- `src/extension/conversation/vscode-node/remoteAgents.ts`
- `src/extension/chatSessions/vscode-node/copilotCloudSessionsProvider.ts`
- `src/extension/review/node/githubReviewAgent.ts`
- `src/extension/tools/common/agentMemoryService.ts`

Current behavior:

- These use GitHub OAuth and CAPI request types such as `RemoteAgent`, `RemoteAgentChat`, `ListSkills`, `CopilotSessions`, `CopilotAgentJob`, `CopilotCustomAgents`, and `CodeReviewAgent`.

Standalone requirement:

- Disable initially.
- Reimplement only if local/BYOK equivalents are explicitly needed.

### Ignore, Content Exclusion, and Snippy

Key files:

- `src/platform/ignore/node/remoteContentExclusion.ts`
- `src/platform/ignore/node/ignoreServiceImpl.ts`
- `src/platform/snippy/common/snippyFetcher.ts`

Current behavior:

- Local ignore handling exists, but remote content exclusion and public-code matching include CAPI/token-backed paths.

Standalone requirement:

- Preserve local ignore behavior.
- Disable or replace remote content exclusion/snippy behavior.
- Be explicit about privacy/safety tradeoffs if remote checks are removed.

### Completions, NES, Xtab, and Inline Edits

Key files:

- `src/extension/completions-core/vscode-node/lib/src/auth/copilotTokenManager.ts`
- `src/extension/completions-core/vscode-node/lib/src/openai/fetch.ts`
- `src/platform/nesFetch/node/completionsFetchServiceImpl.ts`
- `src/extension/inlineEdits/vscode-node/inlineEditProviderFeature.ts`
- `src/extension/xtab/node/xtabProvider.ts`
- `src/extension/xtab/node/xtabNextCursorPredictor.ts`

Current behavior:

- Inline completions/NES/Xtab have their own Copilot token, CAPI/proxy, and experimentation dependencies separate from chat.

Standalone requirement:

- Treat these as a separate project from chat/agent BYOK decoupling.
- Disable initially unless local/BYOK completions are explicitly in scope.

## Hardcoded Copilot Endpoint Calls to Audit

Known examples:

- `endpointProvider.getChatEndpoint('copilot-base')`
- `endpointProvider.getChatEndpoint('copilot-fast')`

Important files observed:

- `src/extension/prompt/vscode-node/endpointProviderImpl.ts`
- `src/extension/workspaceSemanticSearch/node/semanticSearchTextSearchProvider.ts`
- `src/extension/tools/node/applyPatchTool.tsx`
- `src/extension/mcp/vscode-node/commands.ts`
- `src/extension/tools/node/abstractReplaceStringTool.tsx`
- `src/extension/tools/common/virtualTools/virtualToolGrouper.ts`
- `src/extension/prompt/node/intentDetector.tsx`
- `src/extension/prompt/vscode-node/settingsEditorSearchServiceImpl.ts`
- Git commit/rename/settings/notebook helper flows that request fast/default Copilot endpoints.

Required change:

- Replace with configured default model resolution.
- If a feature needs a cheap/fast helper model, define a provider-neutral helper model role such as `default`, `fast`, `reasoning`, and let config map roles to actual BYOK/local models.

Second-pass note:

- The hardcoded endpoint audit is larger than the initial examples. Before implementation, run targeted searches for `copilot-base`, `copilot-fast`, `copilot-chat`, `getChatEndpoint(`, and provider vendor checks.

## Proposed Staged Plan

The implementation should be test-driven. For each stage, write failing tests first, then make the smallest code changes needed to pass them. Existing tests are uneven: provider message conversion and endpoint request shaping have reasonable coverage, but BYOK registration, BYOK enablement policy, endpoint routing, CAPI model metadata isolation, and conversation activation need new tests before code changes.

### Existing Test Seams

Useful existing test locations:

- `src/platform/authentication/test/node/authentication.spec.ts`
- `src/platform/authentication/test/node/copilotToken.spec.ts`
- `src/extension/test/vscode-node/session.test.ts`
- `src/extension/byok/vscode-node/test/azureProvider.spec.ts`
- `src/extension/byok/vscode-node/test/ollamaProvider.spec.ts`
- `src/extension/byok/common/test/anthropicMessageConverter.spec.ts`
- `src/extension/byok/common/test/geminiMessageConverter.spec.ts`
- `src/extension/byok/common/test/geminiFunctionDeclarationConverter.spec.ts`
- `src/extension/byok/node/test/openAIEndpoint.spec.ts`
- `src/extension/byok/node/test/azureOpenAIEndpoint.spec.ts`
- `src/extension/test/vscode-node/endpoints.test.ts`
- `src/extension/conversation/vscode-node/test/languageModelAccess.test.ts`
- `src/platform/endpoint/test/node/chatModelCapabilities.spec.ts`
- `src/platform/workspaceChunkSearch/test/node/externalIngest.spec.ts`
- `src/platform/embeddings/test/node/packEmbedding.spec.ts`
- `src/platform/networking/test/node/networking.spec.ts`

Coverage gaps to fill first:

- `BYOKContrib` has no direct tests.
- `isBYOKEnabled` and BYOK model metadata helpers have no direct tests.
- `ProductionEndpointProvider` has almost no behavior coverage beyond model-name casing.
- `ModelMetadataFetcher` has no direct tests for CAPI/auth coupling and cache behavior.
- `ConversationFeature` activation policy needs tests before standalone activation changes.
- `BaseCAPIClientService` lacks direct tests for request decoration.
- Gemini BYOK provider tests include skipped API-key/user-flow tests that should be stabilized or replaced.

### TDD Stage 0: Characterization Tests

Purpose:

- Freeze current behavior before changing auth, BYOK, and endpoint routing.

Tests to add:

- `BYOKContrib` registers no providers without Copilot token in current mode.
- `BYOKContrib` registers providers once when token and BYOK policy allow it.
- `ChatMLFetcherImpl` currently requests a Copilot token before fetching OpenAI-compatible endpoints.
- `ConversationFeature` currently does not activate contributions without Copilot token.
- `ProductionEndpointProvider` routes non-Copilot VS Code LM models to `ExtensionContributedChatEndpoint`.
- `ProductionEndpointProvider` falls back to `copilot-base` only for unresolved or missing Copilot-style requests.

Expected result:

- Tests document current behavior and create safe refactor boundaries.

### Stage 1: Standalone/BYOK Mode and Gates

Add a standalone mode that does not require GitHub auth.

Tests first:

- `isBYOKEnabled returns true in standalone mode without Copilot token`.
- `isBYOKEnabled preserves existing Copilot-token behavior outside standalone mode`.
- `BYOKContrib registers BYOK providers in standalone mode when copilotToken is undefined`.
- `BYOKContrib does not call GitHub session or Copilot token APIs during standalone registration`.
- `BYOKContrib registers providers only once across auth/config changes`.
- `known model CDN failure does not block custom/Ollama provider registration in standalone mode`.
- `ConversationFeature activates conversation contributions in standalone mode without Copilot token`.
- `ConversationFeature does not register Copilot-only semantic search/cloud providers in standalone mode unless replacements exist`.

Required work:

- Add configuration for provider mode.
- Register BYOK providers unconditionally in standalone mode.
- Disable GitHub auth prompts in standalone mode.
- Activate conversation/chat participants based on standalone mode plus provider availability.
- Make model picker use BYOK/local models.
- Replace default `copilot-base` fallback.
- Disable CAPI model metadata fetch.

Expected preserved functionality:

- Chat.
- Agent mode, if selected model supports tool calling well enough.
- File reads/writes/patches.
- Terminal/task/test/diagnostics tools.
- MCP tool calling.
- Text/file/symbol search.

Expected degraded functionality:

- Semantic `#codebase` search.
- Workspace AI semantic search.
- Settings search and virtual tool prediction if embeddings are unavailable.

### Stage 2: Remove CAPI Transport From Main Path

Tests first:

- `OpenAIEndpoint BYOK request can be sent without getCopilotToken in standalone mode`.
- `ChatMLFetcherImpl does not request Copilot token for raw BYOK URLs`.
- `ChatMLFetcherImpl still requests Copilot token for Copilot/CAPI endpoints outside standalone mode`.
- `provider errors from BYOK HTTP transport map to generic errors, not Copilot quota/subscription errors`.
- `BaseCAPIClientService CAPI request decoration remains unchanged for optional Copilot mode`.

Required work:

- Ensure standalone requests only use BYOK/local endpoints.
- Remove or isolate `@vscode/copilot-api` CAPI request metadata from standalone paths.
- Replace Copilot quota/rate-limit handling with generic provider errors.
- Replace Copilot telemetry/experiment dependencies with local no-op or provider-neutral services.

Expected preserved functionality:

- Same as Stage 1, with fewer hidden CAPI assumptions.

### Stage 3: Local Search Fallbacks

Tests first:

- `codebase tool falls back to local tool/TF-IDF path when semantic search is unavailable`.
- `codebase tool does not throw solely because workspace chunk search has no Copilot token`.
- `local file/text/symbol search tools remain available in standalone mode`.
- `semantic search provider is not registered in standalone mode until an embedding provider is configured`.
- `TF-IDF fallback respects ignore rules and scoped directory options`.

Required work:

- Wire TF-IDF search into `codebase` fallback.
- Keep `findTextInFiles`, `findFiles`, and symbol search available.
- Teach the agent to use local search tools when semantic search is disabled.

Expected preserved functionality:

- Useful codebase exploration without embeddings.
- Lower quality than embeddings for vague semantic queries, but acceptable for agentic iterative work.

### Stage 4: Provider-Neutral Embeddings

Tests first:

- `IEmbeddingsComputer standalone implementation computes query/document embeddings without Copilot token`.
- `workspace chunk search initializes from configured embedding provider, not GitHub embedding model discovery`.
- `embedding provider config validates dimensions, model id, and endpoint type`.
- `tool embedding search degrades to static tool list when embedding provider is unavailable`.
- `settings semantic search is disabled or falls back cleanly when embeddings are unavailable`.

Required work:

- Implement provider-neutral `IEmbeddingsComputer`.
- Add embedding provider config.
- Add OpenAI-compatible `/v1/embeddings` support.
- Add Ollama/local embedding support if desired.
- Replace GitHub embedding type discovery with local config.

Expected preserved/restored functionality:

- Query embeddings.
- Tool embedding ranking.
- Settings semantic search.
- Semantic chunk reranking.

### Stage 5: Fully Local Workspace Semantic Index

Tests first:

- `workspace semantic index chunks files locally without CAPI RequestType.Chunks`.
- `workspace semantic index embeds chunks through configured embedding provider`.
- `workspace semantic index cache invalidates on file hash, embedding model id, and vector dimensions`.
- `remote GitHub/ADO code search is not called in standalone mode`.
- `semantic codebase results are ranked locally and respect token budget/max results`.

Required work:

- Replace remote chunking endpoint with local chunking.
- Use local/BYOK embeddings to embed chunks.
- Keep local SQLite chunk/vector cache.
- Remove GitHub remote code search and external ingest from standalone mode.

Expected restored functionality:

- Local semantic workspace search without GitHub/CAPI.

### Stage 6: Cleanup and Product Surface

Tests first:

- `standalone mode does not set Copilot subscription/quota failure context keys for missing GitHub auth`.
- `custom OpenAI-compatible provider is available in the target product quality channel`.
- `walkthrough/welcome state does not require GitHub sign-in in standalone mode`.
- `remote agents/cloud sessions/review commands are hidden or disabled in standalone mode`.
- `local ignore rules still filter search/tool context in standalone mode`.

Required work:

- Neutralize Copilot auth/subscription context keys for standalone mode.
- Remove or isolate cloud-only commands, menus, and walkthrough copy.
- Disable remote agents, cloud sessions, GitHub review, remote content exclusion, snippy, completions/NES/Xtab unless replacements are implemented.

## Critical Functionality Matrix

| Feature | Current dependency | Breaks if CAPI/GitHub removed? | Shortest preservation path | Future replacement |
| --- | --- | --- | --- | --- |
| Basic chat | CAPI for Copilot models; BYOK path exists but OpenAI-compatible transport still calls `getCopilotToken()` | Yes until activation and transport are decoupled | Ungate BYOK, activate conversation in standalone mode, and bypass token requirement for raw BYOK endpoints | Provider-neutral model registry and transport |
| Agent/tool loop | Selected endpoint and local tools | Mostly no | Require tool-capable BYOK/local model | Improve tool compatibility adapters |
| File read/write/edit | Local VS Code APIs | No | Keep local tools | None needed |
| Terminal/tasks/tests | Local VS Code APIs/core tools | No | Keep local tools | None needed |
| MCP execution | Local/tool APIs | No | Keep MCP tools | None needed |
| MCP config generation | Hardcoded `copilot-fast` helper | Partially | Use configured helper model | Model role config |
| Patch healing | Hardcoded `copilot-fast` helper | Partially | Use configured helper model or disable healing | Model role config |
| Text/file search | Local VS Code search | No | Keep as-is | None needed |
| Workspace symbols | Local language providers | No | Keep as-is | None needed |
| Semantic `#codebase` search | Copilot token, GitHub embeddings, remote indexes | Yes | Disable or TF-IDF fallback | Local/BYOK embeddings plus local chunking |
| VS Code AI semantic search | Workspace chunk search and `copilot-fast` | Yes | Disable in standalone mode | Local/BYOK embeddings plus local chunking |
| Remote GitHub code search | GitHub/CAPI remote index | Yes | Disable | Optional custom remote index provider |
| Embeddings provider | Copilot token/CAPI/GitHub | Yes | Disable | Provider-neutral embeddings service |
| Settings semantic search | Remote embeddings | Yes/degraded | Disable semantic path or lexical fallback | Provider-neutral embeddings |
| Virtual tool prediction | Remote embeddings and precomputed caches | Yes/degraded | Fall back to static/all tools | Provider-neutral embeddings |
| Quotas/plans | Copilot token | Yes | Remove UI/logic in standalone | Provider-specific limits if needed |
| GitHub review/PR features | GitHub API and Copilot flags | Yes | Disable | Local git review or user-configured SCM providers |
| Chat participant activation | `ConversationFeature` waits for Copilot token | Yes | Standalone activation policy | Capability-based contribution activation |
| Inline completions/NES/Xtab | Separate Copilot token/CAPI/proxy paths | Yes | Disable initially | Separate local/BYOK completions project |

## Recommended MVP

The shortest viable path is not to replace embeddings first.

Recommended MVP:

1. Add standalone/BYOK mode.
2. Add characterization tests for current auth-gated activation, BYOK registration, endpoint routing, and token-gated transport.
3. Ungate BYOK providers in standalone mode.
4. Activate conversation/chat participants in standalone mode without Copilot token.
5. Make model selection work without Copilot metadata.
6. Make raw BYOK/OpenAI-compatible transport work without `getCopilotToken()`.
7. Preserve local tools, MCP, editing, terminal, diagnostics, file/text/symbol search.
8. Disable semantic search, remote code search, cloud agents, completions/NES/Xtab, and GitHub review with clear fallback behavior.
9. Use agentic exploration through local tools as the initial substitute for semantic codebase search.
10. Add TF-IDF codebase fallback as the first local search improvement.
11. Add provider-neutral embeddings later to restore semantic quality.

This preserves the main agentic value quickly while avoiding a large embeddings/indexing rewrite as a prerequisite.

## Open Design Decisions

- Should standalone mode be a fork-wide behavior or a user setting?
- Should Copilot code paths be removed entirely or isolated behind an optional module?
- Which model roles should be configurable: default, fast, reasoning, embeddings?
- Should embedding support require OpenAI-compatible `/v1/embeddings` first, or should Ollama/local embeddings be first-class from the start?
- Should TF-IDF be integrated into the existing `IWorkspaceChunkSearchService` or exposed as a separate local search strategy?
- Should telemetry/experimentation services become no-op in standalone mode or be replaced with local diagnostics logs?

## Summary

Embeddings are not critical for preserving local agentic IDE operation, but they are critical for preserving high-quality semantic workspace search. The fastest working standalone path should keep all local tools and BYOK chat, disable Copilot-backed semantic features, and add local lexical search fallback. A later provider-neutral embedding and local chunking implementation can restore semantic workspace search without GitHub/CAPI.
