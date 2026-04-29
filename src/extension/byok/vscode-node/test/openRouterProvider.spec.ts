/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { Response } from '../../../../platform/networking/common/fetcherService';
import { OpenRouterLMProvider } from '../openRouterProvider';

describe('OpenRouterLMProvider', () => {
	it('discovers models without making them immediately user selectable', async () => {
		const provider = new OpenRouterLMProvider(
			{ getAPIKey: async () => undefined, storeAPIKey: async () => undefined, deleteAPIKey: async () => undefined, getStoredModelConfigs: async () => ({}), saveModelConfig: async () => undefined, removeModelConfig: async () => undefined },
			{
				_serviceBrand: undefined,
				fetch: vi.fn(async () => Response.fromText(200, 'OK', new Headers(), JSON.stringify({ data: [{ id: 'openai/gpt-5.4', name: 'OpenAI: GPT-5.4', supported_parameters: ['tools'], architecture: { input_modalities: ['text'] }, top_provider: { context_length: 128000 } }] }), 'test-stub')),
				makeAbortController: () => new AbortController() as any,
			} as any,
			{ error: () => undefined } as any,
			{ createInstance: () => ({}) } as any,
			{} as any,
			{} as any,
		);

		const models = await provider.provideLanguageModelChatInformation({ silent: false, configuration: { apiKey: 'key' } }, undefined as any);

		expect(models).toHaveLength(1);
		expect(models[0].id).toBe('openai/gpt-5.4');
		expect(models[0].isUserSelectable).toBe(false);
	});
});
