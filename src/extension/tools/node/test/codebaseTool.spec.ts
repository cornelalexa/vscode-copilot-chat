/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { CodebaseTool } from '../codebaseTool';

describe('CodebaseTool', () => {
	it('returns unavailable message when semantic workspace search is not available', async () => {
		const tool = new CodebaseTool(
			{} as any,
			{ getConfig: () => false } as any,
			{} as any,
			{ isAvailable: async () => false } as any,
			{ sendMSFTTelemetryEvent: () => undefined } as any,
		);

		const result = await tool.invoke({ input: { query: '#codebase find auth code' }, chatRequestId: 'test-request' } as any, CancellationToken.None) as any;

		expect(result.content).toEqual([]);
		expect(result.toolResultMessage?.value).toContain('Semantic workspace search is not currently available');
	});
});
