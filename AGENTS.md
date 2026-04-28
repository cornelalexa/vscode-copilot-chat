# Agent Project Manual

This file is the root-level manual for agents working in this repository. It maps the project guidance, coding rules, test patterns, and reusable skills already present in the repo.

Before implementing, changing tests, or adding new conventions, consult the relevant file from this index. Prefer existing repo patterns over inventing new ones.

## Primary Project Guidance

- `.github/copilot-instructions.md` - Main project overview, architecture map, coding standards, and validation expectations.
- `.claude/CLAUDE.md` - Parallel project guidance for Claude-style agents. It largely mirrors the Copilot instructions and includes architecture, coding, validation, and testing notes.

## Targeted GitHub Instructions

- `.github/instructions/prompt-tsx.instructions.md` - Prompt TSX authoring rules, priority handling, `<br />` line breaks, token-budget management, references, metadata, and `PromptElement` patterns.
- `.github/instructions/model-prompts.instructions.md` - Model-specific prompt resolver and `PromptRegistry` guidance, including matching order, resolver interface, prompt authoring principles, and test expectations.
- `.github/instructions/vitest-unit-tests.instructions.md` - Vitest `*.spec.ts` guidance. Prefer explicit mock/test classes, use `createExtensionUnitTestingServices` where appropriate, keep tests deterministic, and avoid broad ad hoc mocks.

## Agent Skills

- `.agents/skills/anthropic-sdk-upgrader/SKILL.md` - Procedure for upgrading `@anthropic-ai/sdk` and `@anthropic-ai/claude-agent-sdk`, including changelog review, API type diffing, migration checks, and validation.
- `.agents/skills/launch/SKILL.md` - VS Code Insiders launch and UI automation workflow using `agent-browser` and Chrome DevTools Protocol.
- `.claude/skills/anthropic-sdk-upgrader/SKILL.md` - Claude skill counterpart for Anthropic SDK upgrades.
- `.claude/skills/launch/SKILL.md` - Claude skill counterpart for VS Code UI launch/automation.

## GitHub Metadata And Automation

- `.github/CODEOWNERS` - Ownership metadata for upstream contribution review.
- `.github/CODENOTIFY` - Code notification metadata.
- `.github/commands.json` - GitHub/Copilot command metadata.
- `.github/dependabot.yml` - Dependency update automation.
- `.github/prompts/updateCopilotCLIToolMapping.prompt.md` - Prompt for updating Copilot CLI tool mapping.
- `.github/prompts/updateGithubCopilotSDK.prompt.md` - Prompt for updating GitHub Copilot SDK.
- `.github/workflows/pr.yml` - Upstream PR validation workflow reference.
- `.github/workflows/copilot-setup-steps.yml` - Copilot setup workflow reference.
- `.github/workflows/ensure-node-modules-cache.yml` - Dependency cache workflow reference.
- `.github/workflows/npm-package.yml` - npm package workflow reference.

## Testing Pattern Notes

- Fast unit tests are `*.spec.ts` and should follow `.github/instructions/vitest-unit-tests.instructions.md`.
- VS Code API integration tests are `*.test.ts` and run in the extension host. Existing examples include `src/extension/conversation/vscode-node/test/conversationFeature.test.ts` and `src/extension/test/vscode-node/sanity.sanity-test.ts`.
- Individual BYOK provider tests instantiate one provider directly with fake services, for example `src/extension/byok/vscode-node/test/ollamaProvider.spec.ts`.
- Contribution-level tests that need real `vscode` APIs should use extension-host tests rather than broad `vscode` mocks.
