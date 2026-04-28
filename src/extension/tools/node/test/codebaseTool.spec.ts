/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { CodebaseTool } from '../codebaseTool';

describe('CodebaseTool', () => {
	function createTool(providerMode: 'copilot' | 'standalone') {
		return new CodebaseTool(
			{} as any,
			{ getConfig: () => providerMode } as any,
			{} as any,
			{ isAvailable: async () => false } as any,
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
});
