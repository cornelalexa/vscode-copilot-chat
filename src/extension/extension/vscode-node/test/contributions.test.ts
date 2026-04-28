/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { vscodeNodeStandaloneChatContributions } from '../contributions';

suite('vscode-node standalone chat contributions', () => {
	test('keeps local chat tools and BYOK/MCP while excluding cloud-only contributions', () => {
		const created: string[] = [];
		const instantiationService = {
			createInstance: (ctor: { name: string }) => {
				created.push(ctor.name);
				return { dispose() { } };
			}
		};
		const accessor = {
			get: () => instantiationService
		};

		for (const contribution of vscodeNodeStandaloneChatContributions) {
			contribution.create(accessor as never);
		}

		for (const expected of [
			'ConfigurationMigrationContribution',
			'RequestLogTree',
			'ToolsContribution',
			'AiMappedEditsContrib',
			'BYOKContrib',
			'McpSetupCommands',
			'LanguageModelProxyContrib',
			'PromptFileContribution',
			'NewWorkspaceInitializer',
		]) {
			assert.ok(created.includes(expected), `Expected standalone contributions to include ${expected}`);
		}

		for (const excluded of [
			'RemoteAgentContribution',
			'RenameSuggestionsContrib',
			'SetupTestsContribution',
			'FixTestFailureContribution',
			'IgnoredFileProviderContribution',
			'ChatSessionsContrib',
		]) {
			assert.ok(!created.includes(excluded), `Expected standalone contributions to exclude ${excluded}`);
		}
	});
});
