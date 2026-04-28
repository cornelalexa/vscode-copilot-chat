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

Third-pass source verification:

- No source-level contradiction was found that makes the staged path infeasible. The repo already has the needed VS Code language model provider seams, endpoint wrapping seams, and local tool infrastructure, but the auth/product gates are real blockers.
- Native Anthropic and Gemini BYOK providers have the shortest runtime path after registration is ungated because they bypass `ChatMLFetcherImpl` and call provider SDKs directly. They still depend on `BYOKContrib` registration and conversation activation being available without a Copilot token.
- OpenAI-compatible BYOK providers, including OpenAI, xAI, OpenRouter, Ollama, Azure API-key mode, and CustomOAI, still need the `ChatMLFetcherImpl.fetchMany(...)` token gate removed or bypassed for raw provider URLs.
- `ProductionEndpointProvider` falls back to `copilot-base` not only for unresolved Copilot models, but also when `request.model` is missing and when Auto model resolution fails. Standalone mode therefore needs a provider-neutral default model resolution path for undefined or failed model selection, not just replacement of explicit `copilot-base` call sites.
- `BYOKContrib.fetchKnownModelList(...)` currently has no local fallback or caught failure path. A CDN/network failure before provider construction can block the whole BYOK registration batch, including CustomOAI and Ollama providers that do not strictly need known-model metadata.
- The `CodebaseTool` already has an anonymous prompt-driven agent path via `provideInput(...)` and `_isCodebaseAgentCall(...)`, but direct tool invocation without that prompt context still falls through to semantic search and returns “Semantic workspace search is not currently available”. The standalone fallback should handle both routes.

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

## Settled MVP Decisions

These decisions are the implementation baseline. Reopen them only if coding exposes a concrete blocker.

## Secondary Opinion Review

The file `docs/byok-op-opinion.md` was reviewed as a secondary implementation opinion. The primary plan in this document remains authoritative, especially its test-driven, configuration-driven standalone mode. Several concrete hints from the secondary opinion are useful and should be incorporated as implementation checks.

### Useful Hints Accepted

- `StaticExtendedTokenInfoCopilotTokenManager` exists in `src/platform/authentication/node/copilotTokenManager.ts` and can be useful for tests or as a temporary compatibility shim. It should not replace the planned standalone activation policy as the primary design, because a synthetic Copilot token can hide remaining cloud/CAPI dependencies by making token-gated code look available.
- Native Anthropic/Gemini BYOK providers have a shorter standalone path after `BYOKContrib` registration because they use provider SDKs directly. OpenAI-compatible providers still need the `ChatMLFetcherImpl` raw-provider token bypass.
- `NullTelemetryService` and `NullExperimentationService` already exist and are registered in test paths. Standalone mode should use these or equivalent no-op services instead of production telemetry/experimentation.
- OTel wiring in `src/extension/extension/vscode-node/services.ts` dynamically loads OTLP exporters. Given the production audit findings around OpenTelemetry/protobufjs, standalone mode should explicitly force no-op/in-memory OTel and avoid OTLP exporter loading.
- `FetcherTelemetryContribution` and `OTelContrib` are concrete contribution entries in `src/extension/extension/vscode-node/contributions.ts`. They should be gated or removed in standalone mode.
- `customoai` is present in `package.json` and should be checked for product-quality gating during Phase 10 so OpenAI-compatible local gateways are available in the target internal build.
- `onLanguageModelChat:copilot` is a package activation event. Do not remove activation events or proposed API declarations until manual activation testing proves they are unnecessary; rebrand/cleanup is intentionally deferred.
- Contribution pruning should be centralized in `src/extension/extension/vscode-node/contributions.ts`. The secondary opinion's keep/remove tables are useful as a concrete checklist for Phase 9.
- CAPI stubbing can be useful as a later safety tripwire after the BYOK path is working. A throwing CAPI service can reveal hidden cloud callers during manual testing.

### Ideas Rejected Or Deferred

- Do not make a fake paid Copilot token the main MVP strategy. It is expedient, but it preserves Copilot-shaped product state and risks accidentally enabling quota, cloud, review, semantic search, or telemetry paths that should be disabled in standalone mode.
- Do not globally force `isBYOKEnabled()` to `true` without checking provider mode. In Copilot mode, existing behavior should remain unchanged. In standalone mode, BYOK should be always available without token.
- Do not immediately replace all `CAPIClientImpl.makeRequest(...)` behavior with a throwing stub before basic standalone chat works. First make BYOK registration, activation, model resolution, and raw transport pass tests. Then add a standalone-only CAPI tripwire or disabled-cloud feature gates.
- Do not rewrite `ProductionEndpointProvider.getChatEndpoint(...)` to route every string request blindly to the default model without role semantics. The primary plan's role-based resolution is safer because helper flows can use `fast`, `default`, or `reasoning` intentionally.
- Do not rely on synthetic token flags such as `sku: individual_pro` or `telemetry: disabled` as security controls. Use explicit standalone capability checks and no-op services.

### Plan Adjustments From Review

- Add test cases for standalone OTel behavior: OTLP exporter packages are not dynamically imported when standalone mode is active.
- Add Phase 9 contribution-pruning checklist entries for `FetcherTelemetryContribution`, `OTelContrib`, `WorkspaceRecorderFeature`, `ChatQuotaContribution`, `GitHubMcpContrib`, `RemoteAgentContribution`, `IgnoredFileProviderContribution`, and cloud session/review/completion surfaces.
- Add Phase 10 package-surface check for `customoai` availability in the intended internal distribution channel.
- Add an early package identity change because current VS Code builds may ship Copilot Chat internally and cannot reliably disable it as a separate marketplace extension.
- Add optional post-MVP safety step: enable a standalone-only CAPI throw-stub once the direct BYOK path is proven, then use manual testing to catch unexpected cloud callers.
- Add validation requirement: verify no startup traffic to Microsoft/GitHub/CDN telemetry or cloud endpoints in standalone mode, including `applicationinsights`, `exp-tas`, `api.github.com`, `api.githubcopilot.com`, and `main.vscode-cdn.net`.

### Decision 1: Standalone Is a User-Configurable Mode

Standalone/BYOK mode should be a configuration-driven mode inside the current extension shape, not an immediate fork-wide removal of Copilot code.

Rationale:

- It minimizes first-pass blast radius.
- It lets existing Copilot paths remain available for comparison tests.
- It avoids a large package rebrand before the core BYOK/local path works.

Implementation implication:

- Add a provider mode setting, for example `github.copilot.chat.providerMode`.
- Supported initial values should be `copilot` and `standalone`.
- Default can remain `copilot` during development unless this fork wants standalone as its packaged default.
- All new no-auth behavior should key from this mode, not from absence of auth alone.

### Decision 2: Use Explicit Model Roles

Standalone model routing should use provider-neutral model roles.

Initial roles:

- `default`: main chat/agent model.
- `fast`: cheap helper model for title, intent, MCP config, terminal fix, patch healing, and similar helper flows.
- `reasoning`: optional high-capability model for expensive agent/review-like flows.
- `embeddings`: deferred until provider-neutral embeddings are implemented.

Implementation implication:

- Add settings for role-to-model mapping.
- Replace hardcoded `copilot-base` and `copilot-fast` resolution with role resolution.
- If a role is unset, fall back to `default`.
- If `default` is unset, use the selected VS Code chat request model or first available standalone/BYOK model.
- If no model is available, fail with a clear local configuration error instead of prompting for GitHub auth.

### Decision 3: Register BYOK Without Copilot Auth in Standalone Mode

BYOK providers should register in standalone mode without requiring `authService.copilotToken`.

Implementation implication:

- `BYOKContrib` should check standalone mode before applying `isBYOKEnabled(...)`.
- CDN known-model fetch failure must not block provider registration.
- Providers that do not need known-model metadata, especially CustomOAI and Ollama, must still register with empty or provider-discovered metadata.

### Decision 4: Minimal Transport Bypass First

The MVP should minimally bypass `getCopilotToken()` for raw BYOK/OpenAI-compatible URLs, not immediately split the whole fetcher stack.

Rationale:

- It preserves existing request shaping, logging, token counting, streaming, and tool-call behavior.
- It is smaller and easier to test.
- A provider-neutral transport split can follow after standalone is working.

Implementation implication:

- In `ChatMLFetcherImpl.fetchMany(...)`, detect raw BYOK/OpenAI-compatible endpoints before token acquisition.
- Do not call `getCopilotToken()` for raw BYOK endpoints.
- Continue requiring Copilot token for CAPI/Copilot request metadata outside standalone mode.
- Map provider HTTP errors to generic provider errors, not subscription/quota UI.

### Decision 5: Disable Semantic Search in MVP, Add Local Fallback Immediately After

The first working standalone chat/agent path should not require embeddings.

Implementation implication:

- Do not register VS Code AI semantic search provider in standalone mode unless embeddings are configured.
- Direct `#codebase` tool invocation should not dead-end with only “Semantic workspace search is not currently available”.
- Use the existing prompt-driven local exploration route first.
- Add TF-IDF fallback as the first search-quality improvement after basic standalone chat works.

### Decision 6: Defer Provider-Neutral Embeddings

Provider-neutral embeddings are outside the first MVP.

Implementation implication:

- Keep `IEmbeddingsComputer` replacement as Stage 4.
- Keep local semantic workspace index as Stage 5.
- MVP acceptance should not require `copilot.text-embedding-3-small`, GitHub embedding type discovery, or CAPI chunking.

### Decision 7: Use A Distinct Extension Identity From The Start

Use a distinct extension identity immediately so the fork can load beside the Copilot Chat extension that ships with current VS Code builds.

Implementation implication:

- Change package identity early:
  - `publisher`: `reea-srl`
  - `name`: `reea-copilot`
  - `displayName`: `Reea Copilot Chat`
- This gives the fork a distinct extension id: `reea-srl.reea-copilot`.
- `Reea.Srl` is the organization name, but `vsce` requires a publisher identifier. Use `reea-srl` as the VS Code publisher id.
- Keep deeper command IDs, participant IDs, settings namespaces, and vendor IDs stable during the first behavior-focused pass unless they cause real conflicts.
- Hide or neutralize cloud/auth/subscription UI in standalone mode.
- Avoid renaming every contribution up front because broad ID churn increases risk.
- Full product rebrand/package cleanup belongs after the core no-auth path is proven.

### Decision 8: Disable Cloud-Only Features in Standalone Mode

The first standalone implementation should disable:

- remote agents
- cloud sessions
- GitHub review/cloud review agent
- remote GitHub/ADO semantic search
- external ingest indexing
- Copilot CLI/cloud agent session providers
- completions/NES/Xtab
- snippy/public-code remote checks
- remote content exclusion

Implementation implication:

- Do not attempt local equivalents in MVP.
- Hide commands, menus, participants, or providers where their entry points would otherwise produce GitHub auth prompts or CAPI calls.

### Decision 9: Use Local Defaults Instead of Experiment-Controlled Behavior

Standalone mode should use explicit local defaults and local settings instead of Microsoft/GitHub experimentation as behavior input.

Implementation implication:

- Keep telemetry and experimentation services present where required by constructors.
- Route standalone behavior through deterministic defaults/configuration.
- Do not let missing experiment assignments or Copilot token fields disable the local/BYOK path.

## Detailed Execution Plan

The goal of this plan is to make coding work mostly mechanical: add tests, make the smallest implementation changes, and verify local behavior at each seam.

## Progress Tracker

Use this checklist as the implementation ledger. Mark items as `[x]` only after the phase acceptance criteria are met and the relevant tests pass.

- [x] Phase 0: Test Harness and Characterization
- [x] Phase 0A: Distinct Extension Identity
- [x] Phase 1: Provider Mode Configuration
- [x] Phase 2: BYOK Registration Without Copilot Auth
- [x] Phase 3: Conversation Activation Policy
- [x] Phase 4: Model Registry and Endpoint Role Resolution
- [x] Phase 5: OpenAI-Compatible Transport Token Bypass
- [x] Phase 6: Language Model Access and Embeddings Exposure
- [ ] Phase 7: Local Tool and Helper Flow Preservation
- [ ] Phase 8: Search Fallbacks Without Embeddings
- [x] Phase 9: Cloud/Auth-Only Feature Gating
- [ ] Phase 10: Context Keys, Menus, Walkthroughs, and Package Surface
- [ ] Phase 10A: Stable VS Code Proposed API Audit
- [ ] Phase 11: Telemetry and Experiment Defaults
- [ ] Phase 12: Deferred Embeddings and Local Semantic Index
- [ ] Phase 13: End-to-End Verification

Per-phase completion rule:

- [ ] Tests for the phase are written or updated first.
- [ ] Implementation is complete with the smallest practical code change.
- [ ] Focused tests for the phase pass.
- [ ] Relevant broader checks pass or are documented as intentionally deferred.
- [ ] Any new blocker or scope change is reflected back into this document.

### Phase 0: Test Harness and Characterization

Purpose:

- Freeze current behavior before changing auth, endpoint, and transport assumptions.
- Add tests around the seams that will be edited.

Primary files:

- `src/extension/byok/vscode-node/byokContribution.ts`
- `src/extension/byok/common/byokProvider.ts`
- `src/extension/prompt/node/chatMLFetcher.ts`
- `src/extension/prompt/vscode-node/endpointProviderImpl.ts`
- `src/extension/conversation/vscode-node/conversationFeature.ts`
- `src/extension/conversation/vscode-node/languageModelAccess.ts`
- `src/extension/tools/node/codebaseTool.tsx`
- `src/extension/contextKeys/vscode-node/contextKeys.contribution.ts`

Tests to add or extend:

- `src/extension/byok/vscode-node/test/byokContribution.test.ts`
- `src/extension/byok/common/test/byokProvider.spec.ts`
- `src/extension/prompt/node/test/chatMLFetcher.spec.ts`
- `src/extension/test/vscode-node/endpoints.test.ts`
- `src/extension/conversation/vscode-node/test/conversationFeature.test.ts`
- `src/extension/conversation/vscode-node/test/languageModelAccess.test.ts`
- `src/extension/tools/node/test/codebaseTool.spec.ts`
- `src/extension/contextKeys/vscode-node/test/contextKeys.contribution.test.ts`

Characterization cases:

- [x] `isBYOKEnabled(...)` currently allows individual/internal users on dotcom and blocks non-individual/non-internal users or GHE.
- [x] `BYOKContrib` currently registers no providers without `copilotToken` in Copilot mode.
- [x] `BYOKContrib` currently waits for `isBYOKEnabled(...)` outside scenario automation in Copilot mode.
- [x] CDN known-model failure is now characterized by the standalone extension-host test that verifies registration still proceeds with empty metadata.
- [x] `ChatMLFetcherImpl.fetchMany(...)` previously called `getCopilotToken()` before fetching raw OpenAI-compatible endpoints; focused tests now cover both token-required and token-bypass cases.
- [x] `ProductionEndpointProvider.getChatEndpoint(...)` falls back to `copilot-base` when request model is missing and wraps non-Copilot VS Code language models as extension-contributed endpoints.
- [x] `ConversationFeature` standalone activation is covered by extension-host test and verifies no Copilot token is needed and semantic search providers are skipped.
- [x] `LanguageModelAccess` standalone behavior is covered by extension-host test and verifies Copilot LM/embedding providers are not registered.
- [x] Direct `CodebaseTool.invoke(...)` without semantic search returns an empty tool result with the unavailable message.

Phase 0 test pattern decision:

- `BYOKContrib`, `ConversationFeature`, and `LanguageModelAccess` are covered by extension-host `.test.ts` tests because they depend on real VS Code APIs and contribution activation behavior.
- Fast pure/unit seams remain covered by Vitest `*.spec.ts` tests.
- This follows the repo's existing pattern: individual providers can be tested directly in Vitest, while contribution-level behavior that needs real `vscode` APIs belongs in extension-host tests.

Acceptance:

- Tests pass before behavior is considered complete for the seam.
- Future phase changes should update these tests from current behavior to standalone behavior without broad fixture rewrites.
- Verified commands:
  - `npm exec vitest -- --run src/extension/tools/node/test/codebaseTool.spec.ts src/extension/byok/common/test/byokProvider.spec.ts src/platform/configuration/test/common/configurationService.spec.ts src/extension/prompt/node/test/chatMLFetcherRetry.spec.ts src/extension/test/vscode-node/endpoints.spec.ts --pool=forks`
  - `npm run compile && npm run test:extension -- --grep "BYOKContrib|Standalone mode activates|standalone mode does not register"`

### Phase 0A: Distinct Extension Identity

Purpose:

- Allow the fork to load in current VS Code builds where Copilot Chat may be shipped/bundled and cannot be disabled as a normal marketplace extension.
- Avoid extension id collisions before manual testing starts.

Primary files:

- `package.json`
- `package-lock.json`, if package metadata changes cause npm lock metadata updates
- `package.nls.json`, only if display strings need adjustment

Implementation tasks:

- Change package identity:
  - `publisher`: `reea-srl`
  - `name`: `reea-copilot`
  - `displayName`: `Reea Copilot Chat`
- Remove or neutralize Microsoft/GitHub marketplace metadata only if it causes package/install confusion during local VSIX testing.
- Keep command ids, settings namespaces, chat participant ids, provider/vendor ids, and proposed API declarations unchanged for the first pass unless they demonstrably conflict.

Tests/checks:

- `npm run typecheck` after identity edits.
- Package metadata inspection confirms extension id is `reea-srl.reea-copilot`.
- Manual dev-host launch confirms both the built-in Copilot Chat and this fork can coexist without extension id collision.

Acceptance:

- The fork can be launched or installed locally without replacing/conflicting with the built-in `GitHub.copilot-chat` identity.
- No broad rebrand has been done beyond the minimum identity split.

### Phase 1: Provider Mode Configuration

Purpose:

- Add the central switch that every standalone decision can use.

Primary files:

- `src/platform/configuration/common/configurationService.ts`
- `src/platform/configuration/vscode/configurationServiceImpl.ts`
- `package.json`
- `package.nls.json`

Implementation tasks:

- Add config key for provider mode, for example `github.copilot.chat.providerMode`.
- [x] Add config key for provider mode, `github.copilot.chat.providerMode`.
- Define helper API such as `isStandaloneMode()` or `getProviderMode()` near configuration service utilities.
- [x] Add config keys for model roles:
  - `github.copilot.chat.standalone.model.default`
  - `github.copilot.chat.standalone.model.fast`
  - `github.copilot.chat.standalone.model.reasoning`
  - `github.copilot.chat.standalone.model.embeddings`
- Decide accepted model reference format. Recommended format:
  - VS Code LM selector style: `{ vendor, family?, id? }` if the settings schema can support objects cleanly.
  - String fallback format: `vendor/model-id`, for example `customoai/qwen3-coder` or `ollama/llama3.1`.
- Add validation helpers that parse role settings without throwing during extension activation.

Tests:

- [x] Provider mode defaults to `copilot`.
- [x] Provider mode can be read from configuration metadata.
- Unknown provider mode values fall back to `copilot` or produce a clear config validation error.
- [x] Role settings resolve independently and `fast` falls back to `default` when unset.

Acceptance:

- No existing Copilot tests change behavior when mode is unset.
- Standalone checks can be added without duplicating config parsing logic.

### Phase 2: BYOK Registration Without Copilot Auth

Purpose:

- Make BYOK/local providers visible in VS Code LM APIs with no GitHub account.

Primary files:

- `src/extension/byok/vscode-node/byokContribution.ts`
- `src/extension/byok/common/byokProvider.ts`
- `src/extension/byok/vscode-node/abstractLanguageModelChatProvider.ts`
- `src/extension/byok/vscode-node/customOAIProvider.ts`
- `src/extension/byok/vscode-node/ollamaProvider.ts`

Implementation tasks:

- [x] Add provider-registration policy helper:
  - standalone mode: allow without `copilotToken`.
  - copilot mode: preserve existing `copilotToken && isBYOKEnabled(...)`.
- Rename `_authChange` if useful, because standalone registration will also respond to config changes.
- Register on configuration change for provider mode and BYOK provider settings if the service exposes a suitable event.
- [x] Make known-model fetch best-effort:
  - catch fetch/JSON/version errors.
  - log a warning.
  - continue with `{}`.
- Only set `_byokProvidersRegistered = true` once registration is actually proceeding and not before an awaited operation that can fail.
- Ensure provider construction tolerates missing known-model entries:
  - Anthropic/Gemini/OpenAI/xAI get `knownModels[ProviderName] ?? {}` or `undefined` only where constructors support it.
  - CustomOAI, Azure, OpenRouter, and Ollama should not depend on CDN metadata.

Tests:

- [x] Standalone mode registers providers when `authService.copilotToken` is undefined.
- [x] Copilot mode keeps existing `isBYOKEnabled(...)` behavior.
- [x] CDN fetch failure still registers CustomOAI and Ollama.
- [x] CDN fetch with unexpected `version` still registers all providers with empty metadata.
- [x] Multiple auth/config changes do not double-register providers.
- [x] Registration does not call `getGitHubSession()` or `getCopilotToken()` in standalone mode.

Acceptance:

- [x] VS Code LM provider contributions for CustomOAI/Ollama/OpenAI/etc. exist without GitHub auth in standalone mode.
- [x] Existing Copilot/BYOK gating remains unchanged in default mode.

### Phase 3: Conversation Activation Policy

Purpose:

- Make chat participants, tools, commands, and local providers activate without Copilot token in standalone mode.

Primary files:

- `src/extension/conversation/vscode-node/conversationFeature.ts`
- `src/extension/extension/vscode-node/contributions.ts`
- `src/extension/workspaceSemanticSearch/node/semanticSearchTextSearchProvider.ts`
- `src/extension/prompt/vscode-node/settingsEditorSearchServiceImpl.ts`

Implementation tasks:

- [x] Add an activation policy helper:
  - `copilot` mode: activated when `authenticationService.copilotToken` exists.
  - `standalone` mode: activated immediately or after basic provider registration readiness.
- [x] Avoid activating Copilot-only providers in standalone:
  - semantic search provider stays disabled until embeddings replacement exists.
  - settings semantic provider disabled or registered only if it has a lexical fallback.
  - remote agent/cloud/review contributions disabled.
- Preserve local chat participant registration and `vscodeNodeChatContributions` needed for:
  - tools
  - intents
  - terminal commands that do not require cloud
  - MCP execution
  - local file/edit/search workflows
- [x] Ensure `activationBlocker` completes in standalone mode without waiting for token.
- [x] Set `github.copilot.interactiveSession.disabled` based on standalone chat availability, not missing Copilot token.

Tests:

- [x] Standalone mode activates `ConversationFeature` with no token.
- [x] Standalone activation registers participants and local command contributions.
- [x] Standalone activation does not register semantic text search provider without embeddings.
- Copilot mode still waits for token.
- Deactivation on sign-out only applies in Copilot mode.

Acceptance:

- Chat UI can open and route to local/BYOK models in standalone mode.
- Missing GitHub auth does not hide the local/BYOK chat surface.

### Phase 4: Model Registry and Endpoint Role Resolution

Purpose:

- Replace hardcoded Copilot endpoint fallback with provider-neutral resolution.

Primary files:

- `src/extension/prompt/vscode-node/endpointProviderImpl.ts`
- `src/platform/endpoint/common/endpointProvider.ts`
- `src/platform/endpoint/common/modelAliasRegistry.ts`
- `src/platform/endpoint/node/modelMetadataFetcher.ts`
- `src/platform/endpoint/vscode-node/extChatEndpoint.ts`
- `src/extension/conversation/vscode-node/languageModelAccess.ts`

Implementation tasks:

- [x] Add role-aware endpoint resolution:
  - `getChatEndpointForRole('default' | 'fast' | 'reasoning')`, or equivalent helper outside the public interface if preferred.
  - Existing `getChatEndpoint('copilot-base' | 'copilot-fast')` can stay for Copilot mode initially.
- Standalone resolution order:
  1. Request model if supplied.
  2. Configured role model.
  3. Configured default model.
  4. First available non-Copilot VS Code LM model.
  5. Clear “no standalone model configured” error.
- [x] Keep `ExtensionContributedChatEndpoint` as the bridge for BYOK/local VS Code LM models.
- [x] Do not call `ModelMetadataFetcher.getAllChatModels()` in standalone just to populate Copilot metadata.
- [x] Do not synthesize `AutoChatEndpoint` in standalone until there is a provider-neutral auto router.
- Update helper flows that hardcode `copilot-fast` or `copilot-base` to use role resolution:
  - `src/extension/mcp/vscode-node/mcpToolCallingLoop.tsx`
  - `src/extension/tools/node/applyPatchTool.tsx`
  - `src/extension/tools/node/abstractReplaceStringTool.tsx`
  - `src/extension/prompt/node/intentDetector.tsx`
  - `src/extension/prompt/node/title.ts`
  - `src/extension/prompt/node/gitCommitMessageGenerator.ts`
  - `src/extension/conversation/vscode-node/terminalFixGenerator.ts`
  - `src/extension/prompt/vscode-node/settingsEditorSearchServiceImpl.ts`
  - `src/extension/workspaceSemanticSearch/node/semanticSearchTextSearchProvider.ts`
- Leave less critical cloud/debug/test generation call sites for later only if their commands are disabled in standalone.

Tests:

- [x] Missing request model resolves to configured standalone default.
- Failed Auto resolution resolves to configured standalone default, not `copilot-base`.
- [x] `fast` role falls back to `default`.
- [x] Non-Copilot VS Code LM model still becomes `ExtensionContributedChatEndpoint`.
- [x] Copilot mode still uses `ModelMetadataFetcher` and existing aliases.
- No standalone endpoint resolution calls `getCopilotToken()`.

Acceptance:

- A configured CustomOAI/Ollama/Anthropic/Gemini model can be selected as the chat endpoint.
- Helper flows use configured `fast`/`default` roles instead of hardcoded Copilot families.

### Phase 5: OpenAI-Compatible Transport Token Bypass

Purpose:

- Make OpenAI-compatible BYOK endpoints send requests without Copilot token.

Primary files:

- `src/extension/prompt/node/chatMLFetcher.ts`
- `src/extension/byok/node/openAIEndpoint.ts`
- `src/platform/networking/common/networking.ts`
- `src/platform/endpoint/common/capiClient.ts`
- `src/platform/endpoint/node/capiClientImpl.ts`

Implementation tasks:

- Add a reliable raw-provider detection helper:
  - `OpenAIEndpoint` instance check is available in extension layer.
  - `isBYOKModel(endpoint)` currently returns client-side/server-side/non-BYOK and can be reused or made more explicit.
  - `endpoint.urlOrRequestMetadata` string means raw URL; CAPI metadata object means Copilot/CAPI route.
- In `ChatMLFetcherImpl.fetchMany(...)`:
  - validate payload before token acquisition as today.
  - if raw BYOK endpoint, skip `getCopilotToken()`.
  - scrub provider auth using endpoint `getExtraHeaders()` and request logger rules, not Copilot username.
  - call `_fetchAndStreamChat(...)` with optional Copilot token or split the internal call enough that raw providers do not need it.
- Keep CAPI path unchanged for Copilot mode.
- For raw BYOK path:
  - use `requestOptions.secretKey` or endpoint headers as intended.
  - avoid quota dialog/reporting based on Copilot token fields.
  - map HTTP 401/403/429/5xx to generic provider errors with provider status details.
- Ensure WebSocket path is disabled or bypassed for raw BYOK unless explicitly supported.

Tests:

- [x] Raw endpoint request with `requestOptions.secretKey` does not call `getCopilotToken()`.
- [x] Raw URL request includes BYOK `Authorization` or `api-key` headers.
- [x] Raw endpoint request without `requestOptions.secretKey` still calls `getCopilotToken()`.
- [x] CAPI request still calls `getCopilotToken()` in Copilot mode.
- [x] Raw BYOK 401 maps to generic auth/provider error, not Copilot subscription error.
- [x] Raw BYOK 429 maps to generic provider rate-limit error, not Copilot quota dialog.
- [x] Existing Copilot fetcher tests continue to pass.

Acceptance:

- [x] CustomOAI/OpenAI/Ollama/xAI/OpenRouter/Azure API-key mode can stream responses without GitHub auth.
- [x] Native Anthropic/Gemini continue to work through their SDK provider path.

### Phase 6: Language Model Access and Embeddings Exposure

Purpose:

- Prevent Copilot model publication and embedding provider registration from blocking standalone chat.

Primary files:

- `src/extension/conversation/vscode-node/languageModelAccess.ts`
- `src/platform/embeddings/common/remoteEmbeddingsComputer.ts`
- `src/platform/endpoint/node/modelMetadataFetcher.ts`
- `src/platform/endpoint/node/embeddingsEndpoint.ts`

Implementation tasks:

- [x] In standalone mode, either:
  - do not register the Copilot `vscode.lm` provider, or
  - register it with no Copilot models and no auth prompt.
- [x] Do not call `_getToken()` for model info in standalone mode.
- [x] Do not register `copilot.text-embedding-3-small` in standalone mode.
- Keep BYOK providers registered through `BYOKContrib`; do not force them through `LanguageModelAccess`.
- Ensure external extensions using `vscode.lm.selectChatModels({ vendor: 'copilot' })` get no standalone models unless a deliberate compatibility shim is added later.

Tests:

- [x] Standalone mode does not call `getCopilotToken()` from `LanguageModelAccess`.
- [x] Standalone mode does not register Copilot embeddings provider.
- Copilot mode still registers Copilot LM and embeddings provider after token.
- BYOK providers remain independently visible.

Acceptance:

- Missing Copilot token does not cause model picker or embeddings registration churn in standalone.

### Phase 7: Local Tool and Helper Flow Preservation

Purpose:

- Keep the high-value agentic workflows working with standalone endpoints.

Primary files:

- `src/extension/tools/node/readFileTool.tsx`
- `src/extension/tools/node/listDirTool.tsx`
- `src/extension/tools/node/findFilesTool.tsx`
- `src/extension/tools/node/findTextInFilesTool.tsx`
- `src/extension/tools/node/searchWorkspaceSymbolsTool.tsx`
- `src/extension/tools/node/applyPatchTool.tsx`
- `src/extension/tools/node/abstractReplaceStringTool.tsx`
- `src/extension/tools/node/createFileTool.tsx`
- `src/extension/tools/node/insertEditTool.tsx`
- `src/extension/tools/node/getErrorsTool.tsx`
- `src/extension/tools/node/testFailureTool.tsx`
- `src/extension/mcp/vscode-node/mcpToolCallingLoop.tsx`
- `src/extension/mcp/vscode-node/commands.ts`

Implementation tasks:

- Confirm local filesystem/search/edit/terminal/test tools do not require Copilot token after conversation activation is decoupled.
- Replace helper endpoint resolution with model roles where helper model calls exist.
- Disable only healing/helper flows if no role endpoint is available; keep core edit tools functional.
- Ensure tool availability does not depend on semantic search or embeddings.
- Keep MCP registry/config/tool execution active.
- For assisted MCP config generation, use `fast` role.

Tests:

- Core file tools invoke in standalone mode with a mock BYOK endpoint.
- Apply patch succeeds without `copilot-fast`.
- Patch healing uses `fast` role when configured.
- MCP config generation uses `fast` role.
- MCP execution does not require Copilot token.
- `findFiles`, `findTextInFiles`, and workspace symbols remain available in standalone.

Acceptance:

- Agent mode can read, edit, search, run terminal/test/diagnostic workflows, and call MCP tools with a configured standalone model.

### Phase 8: Search Fallbacks Without Embeddings

Purpose:

- Prevent semantic-search loss from making codebase exploration unusable.

Primary files:

- `src/extension/tools/node/codebaseTool.tsx`
- `src/extension/prompt/node/codebaseToolCalling.ts`
- `src/platform/tfidf/node/tfidf.ts`
- `src/platform/tfidf/node/tfidfWorker.ts`
- `src/platform/workspaceChunkSearch/node/workspaceChunkSearchService.ts`
- `src/platform/search/common/searchService.ts`
- `src/extension/tools/node/findFilesTool.tsx`
- `src/extension/tools/node/findTextInFilesTool.tsx`
- `src/extension/tools/node/searchWorkspaceSymbolsTool.tsx`

Implementation tasks:

- First fallback:
  - direct `CodebaseTool.invoke(...)` should route to local agent/tool exploration when semantic search is unavailable and no scoped directories force semantic path.
  - preserve existing prompt-driven `provideInput(...)` route.
- Second fallback:
  - add TF-IDF search strategy for direct `#codebase` queries.
  - respect ignore rules and scoped directories.
  - return chunk-like prompt references compatible with `WorkspaceContextWrapper` or a new local context prompt element.
- Do not register `SemanticSearchTextSearchProvider` in standalone until embeddings exist.
- Add clear tool result messages distinguishing:
  - local lexical/codebase fallback used
  - semantic search unavailable
  - no local results found

Tests:

- Direct `#codebase` invocation in standalone does not return empty solely because semantic search is unavailable.
- Prompt-driven anonymous codebase agent path still works.
- TF-IDF fallback respects ignored files.
- Scoped directories are honored.
- Semantic provider remains unregistered without embeddings.

Acceptance:

- Agent can discover relevant files without embeddings using local search and/or TF-IDF.

### Phase 9: Cloud/Auth-Only Feature Gating

Purpose:

- Stop standalone mode from surfacing commands that inevitably require GitHub/CAPI.

Primary files:

- `src/extension/conversation/vscode-node/remoteAgents.ts`
- `src/extension/chatSessions/vscode-node/copilotCloudSessionsProvider.ts`
- `src/extension/review/node/githubReviewAgent.ts`
- `src/extension/review/node/doReview.ts`
- `src/extension/completions/vscode-node/completionsCoreContribution.ts`
- `src/extension/inlineEdits/vscode-node/inlineEditProviderFeature.ts`
- `src/extension/xtab/node/xtabProvider.ts`
- `src/extension/xtab/node/xtabNextCursorPredictor.ts`
- `src/platform/ignore/node/remoteContentExclusion.ts`
- `src/platform/snippy/common/snippyFetcher.ts`
- `src/extension/extension/vscode-node/contributions.ts`

Implementation tasks:

- Add centralized capability checks, for example:
  - `isCopilotCloudEnabled()`
  - `isStandaloneMode()`
  - `isSemanticSearchEnabled()`
  - `isInlineCompletionsEnabledInStandalone()` initially false.
- [x] In standalone mode, do not instantiate or register:
  - `FetcherTelemetryContribution`
  - `OTelContrib` when it would enable/export telemetry rather than local debug views
  - `WorkspaceRecorderFeature`
  - `ChatQuotaContribution`
  - `SurveyCommandContribution`
  - `FeedbackCommandContribution`
  - `WalkthroughCommandContribution` entries that require Copilot signup
  - `GitHubMcpContrib`
  - `RemoteAgentContribution`
  - cloud session providers
  - GitHub review agent commands/providers
  - completions/NES/Xtab providers
  - remote content exclusion/snippy remote fetchers
- Preserve local ignore service behavior.
- Keep local git commit message generation if it uses standalone endpoint roles and does not require GitHub APIs.

Tests:

- [x] Standalone contribution collection skips remote/cloud/review/completions providers.
- Commands hidden or disabled in standalone do not prompt for GitHub auth.
- Local ignore service still filters context.
- Copilot mode still registers existing features.

Acceptance:

- [x] Standalone mode does not unexpectedly open GitHub sign-in for cloud-only features.
- Optional post-MVP safety: a standalone-only CAPI throw-stub can be enabled after the BYOK path works to catch any remaining unexpected cloud callers.

### Phase 10: Context Keys, Menus, Walkthroughs, and Package Surface

Purpose:

- Make the UI coherent enough for standalone users without full rebrand.

Primary files:

- `package.json`
- `package.nls.json`
- `src/extension/contextKeys/vscode-node/contextKeys.contribution.ts`
- `src/extension/conversation/vscode-node/conversationFeature.ts`
- `src/platform/authentication/common/authentication.ts`
- `src/platform/authentication/vscode-node/session.ts`

Implementation tasks:

- Add standalone context key, for example `github.copilot.chat.standalone`.
- Verify the early identity split remains intact: `reea-srl.reea-copilot` / `Reea Copilot Chat`.
- In standalone mode:
  - missing Copilot auth should not set visible disabled/expired/subscription failure states.
  - quota exceeded and subscription prompts should be suppressed.
  - sign-in walkthrough entries should be hidden or deprioritized.
  - cloud/review/session menus should be hidden.
  - [x] CustomOAI provider contribution must be available in target product quality; remove or bypass `productQualityType != 'stable'` for standalone packaging if needed.
- Keep command IDs stable in MVP.
- Add minimal user-facing configuration messages for “No standalone model configured”.

Tests:

- Context keys reflect standalone active state.
- Missing token does not set subscription-disabled views welcome in standalone.
- [x] CustomOAI contribution is available for intended product channel.
- Cloud-only menus are hidden in standalone context.
- Package activation still occurs when opening chat/model picker after any future activation-event cleanup.

Acceptance:

- A standalone user sees a local/BYOK chat path, not a broken Copilot sign-in funnel.
- OpenAI-compatible local gateways are available in the intended internal distribution channel.

### Phase 10A: Stable VS Code Proposed API Audit

Purpose:

- Make the internal build target regular VS Code Stable instead of VS Code Insiders-only proposed API behavior.
- The current extension-host test runner uses VS Code Insiders and prints proposed API warnings. Those warnings are not blockers for the current automated test slice, but they are a distribution blocker if the extension must install/run on Stable without an Insiders/product override channel.

Primary files:

- `package.json`
- `src/**/*.ts`
- `src/**/*.tsx`
- `src/vscode.proposed.*.d.ts`

Implementation tasks:

- Inventory `enabledApiProposals` in `package.json`.
- For each proposal, classify it as:
  - required for MVP chat/agent/BYOK operation
  - required only for disabled/deferred features
  - finalized/renamed in the target Stable VS Code API
  - removable with a code path gate
- Remove proposals tied only to disabled features, such as cloud sessions, remote agents, semantic search, embeddings, telemetry/debug surfaces, or completions/NES/Xtab where possible.
- For required MVP APIs, decide whether the internal distribution must:
  - ship with a VS Code product override / Code-OSS style distribution, or
  - wait for APIs to be stable/finalized, or
  - reduce feature scope to avoid proposed APIs.
- Update package activation events and contribution points after pruning proposals.

Tests/checks:

- `npm exec vsce -- ls --tree 0` still passes.
- Extension-host tests still pass after proposal pruning.
- Manual launch against target Stable build verifies activation without proposed API rejection.

Acceptance:

- The fork has a documented Stable-compatible API surface or a documented internal product-override requirement.
- Proposed API warnings from the current Insiders runner are either gone or explicitly mapped to an accepted internal distribution requirement.

### Phase 11: Telemetry and Experiment Defaults

Purpose:

- Keep constructors and metrics code stable while removing experiment-driven behavior from standalone decisions.

Primary files:

- `src/platform/telemetry/common/nullExperimentationService.ts`
- `src/platform/telemetry/vscode-node/experimentationService.ts`
- `src/platform/configuration/common/configurationService.ts`
- `src/extension/prompt/node/chatMLFetcher.ts`
- `src/extension/conversation/vscode-node/languageModelAccess.ts`

Implementation tasks:

- [x] Keep `IExperimentationService` injected for existing code.
- Add standalone-safe wrappers for behavior decisions that currently read experiments:
  - default language model
  - prompt variants
  - tool search behavior
  - semantic search behavior
  - provider-specific feature toggles
- [x] In standalone mode, use explicit config/defaults.
- Avoid reading Copilot token fields for behavior decisions in standalone.
- [x] Telemetry events may remain no-op/null depending on existing service, but must not require token-derived SKU/org/quota data.
- [x] Force no-op or in-memory OTel in standalone mode and avoid loading OTLP exporter packages.

Tests:

- Standalone default model does not depend on `chat.defaultLanguageModel` experiment.
- Missing token fields do not disable tool calling or model picker.
- Telemetry code paths do not throw when Copilot token is undefined.
- Standalone mode does not dynamically import OTLP exporters.
- [x] Standalone startup does not emit fetcher telemetry or OTel activation network requests.

Acceptance:

- Standalone behavior is deterministic from local config.
- Standalone mode has no startup traffic to Microsoft/GitHub/CDN telemetry or cloud endpoints.

### Phase 12: Deferred Embeddings and Local Semantic Index

Purpose:

- Document the later path without blocking MVP.

Primary files:

- `src/platform/embeddings/common/embeddingsComputer.ts`
- `src/platform/embeddings/common/remoteEmbeddingsComputer.ts`
- `src/platform/workspaceChunkSearch/common/githubAvailableEmbeddingTypes.ts`
- `src/platform/workspaceChunkSearch/node/workspaceChunkSearchService.ts`
- `src/platform/workspaceChunkSearch/node/workspaceChunkEmbeddingsIndex.ts`
- `src/platform/workspaceChunkSearch/node/workspaceChunkAndEmbeddingCache.ts`
- `src/platform/chunking/common/chunkingEndpointClientImpl.ts`
- `src/platform/chunking/node/naiveChunker.ts`

Implementation tasks:

- Add `StandaloneEmbeddingsComputer` implementing `IEmbeddingsComputer`.
- Add OpenAI-compatible `/v1/embeddings` endpoint support first.
- Add Ollama/local embeddings support after OpenAI-compatible support if desired.
- Replace GitHub embedding type discovery with local config.
- Replace `ChunkingEndpointClientImpl` CAPI calls with local chunking for standalone index population.
- Include cache invalidation dimensions:
  - file hash
  - embedding model id
  - embedding dimensions
  - chunker version
  - provider id

Tests:

- Embeddings compute without Copilot token.
- Workspace chunk search initializes from local embedding config.
- No CAPI `RequestType.Chunks` call in standalone index build.
- Cache invalidates when embedding dimensions/model changes.

Acceptance:

- Local semantic search can be enabled independently after MVP.

### Phase 13: End-to-End Verification

Purpose:

- Verify standalone behavior through unit tests, integration tests, and UI smoke checks.

Automated checks:

- Focused BYOK tests.
- Focused endpoint provider tests.
- Focused `ChatMLFetcherImpl` transport tests.
- Focused conversation activation tests.
- Focused codebase fallback tests.
- Existing language model access tests.
- Existing OpenAI/Azure endpoint request-shaping tests.
- Typecheck after code changes.

Manual/UI checks:

- Start extension in standalone mode with no GitHub session.
- Configure Ollama or CustomOAI model.
- Confirm model appears in VS Code model picker.
- Send basic chat request.
- Run agent request that reads a file.
- Run agent request that edits a file.
- Run terminal/diagnostics/test-related request.
- Call MCP tool if a local MCP server is configured.
- Invoke `#codebase` with semantic search disabled and confirm local fallback behavior.
- Confirm no GitHub sign-in prompt appears during these flows.
- Confirm cloud/review/completion entry points are hidden or disabled.

Definition of done for MVP:

- Standalone mode can run chat and agent workflows with a configured BYOK/local model and no GitHub auth.
- OpenAI-compatible and native BYOK paths both work without Copilot token where applicable.
- Local tools, editing, terminal, diagnostics, MCP, and local search remain available.
- Semantic/cloud/completion features are disabled cleanly or have explicit fallback.
- Tests cover the auth gate, BYOK registration, endpoint role resolution, transport bypass, conversation activation, and direct `#codebase` fallback.

## Remaining Deferred Decisions

- Whether standalone becomes the packaged default after MVP.
- Whether Copilot code paths are removed entirely after compatibility testing.
- Whether TF-IDF should live inside `IWorkspaceChunkSearchService` long term or remain a separate local search strategy.
- Whether embeddings should support Ollama/local providers in the same phase as OpenAI-compatible `/v1/embeddings`.
- Whether full product rebrand happens after MVP or remains a compatibility layer.

## Summary

Embeddings are not critical for preserving local agentic IDE operation, but they are critical for preserving high-quality semantic workspace search. The fastest working standalone path should keep all local tools and BYOK chat, disable Copilot-backed semantic features, and add local lexical search fallback. A later provider-neutral embedding and local chunking implementation can restore semantic workspace search without GitHub/CAPI.
