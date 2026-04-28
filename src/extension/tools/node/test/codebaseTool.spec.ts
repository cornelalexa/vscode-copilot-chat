/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { Range } from '../../../../util/vs/editor/common/core/range';
import { CodebaseTool } from '../codebaseTool';

describe('CodebaseTool', () => {
	function createTool(providerMode: 'copilot' | 'standalone', localResults: readonly any[] = []) {
		return new CodebaseTool(
			{} as any,
			{ getConfig: () => providerMode } as any,
			{} as any,
			{ isAvailable: async () => false } as any,
			{ search: async () => localResults } as any,
			{ sendMSFTTelemetryEvent: () => undefined } as any,
		);
	}

	it('returns unavailable message when semantic workspace search is not available in copilot mode', async () => {
		const tool = createTool('copilot');

		const result = await tool.invoke({ input: { query: '#codebase find auth code' }, chatRequestId: 'test-request' } as any, CancellationToken.None) as any;

		expect(result.content).toEqual([]);
		expect(result.toolResultMessage?.value).toContain('Semantic workspace search is not currently available');
	});

	it('returns local search fallback instructions in standalone mode when semantic search is unavailable', async () => {
		const tool = createTool('standalone');

		const result = await tool.invoke({ input: { query: '#codebase find auth code' }, chatRequestId: 'test-request' } as any, CancellationToken.None) as any;

		expect(result.content.length).toBeGreaterThan(0);
		expect(result.content[0].value).toContain('Semantic workspace search is not available');
		expect(result.content[0].value).toContain('findTextInFiles');
		expect(result.toolResultMessage?.value).toContain('Using local search fallback instructions');
	});

	it('returns local TF-IDF fallback results in standalone mode when available', async () => {
		const file = URI.file('/workspace/src/auth.ts');
		const tool = createTool('standalone', [{
			file,
			text: 'export function authenticateUser() { return true; }',
			rawText: 'export function authenticateUser() { return true; }',
			range: Range.lift({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 51 }),
			isFullFile: true,
		}]);

		const result = await tool.invoke({ input: { query: '#codebase find auth code' }, chatRequestId: 'test-request' } as any, CancellationToken.None) as any;

		expect(result.content[0].value).toContain('Using local lexical TF-IDF fallback');
		expect(result.content[0].value).toContain('/workspace/src/auth.ts');
		expect(result.content[0].value).toContain('authenticateUser');
		expect(result.toolResultMessage?.value).toContain('Searched local codebase fallback');
		expect(result.toolResultDetails).toEqual([file]);
	});
});
