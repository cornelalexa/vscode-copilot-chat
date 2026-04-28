/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { ChatRequest, LanguageModelChat } from 'vscode';
import { IChatModelInformation, ICompletionModelInformation, IEmbeddingModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { IModelMetadataFetcher } from '../../../platform/endpoint/node/modelMetadataFetcher';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { TokenizerType } from '../../../util/common/tokenizer';
import { Event } from '../../../util/vs/base/common/event';
import { ProductionEndpointProvider } from '../../prompt/vscode-node/endpointProviderImpl';

class FakeModelMetadataFetcher implements IModelMetadataFetcher {
	public onDidModelsRefresh = Event.None;
	public readonly requestedFamilies: string[] = [];

	async getAllChatModels(): Promise<IChatModelInformation[]> {
		return [];
	}

	async getAllCompletionModels(_forceRefresh: boolean): Promise<ICompletionModelInformation[]> {
		return [];
	}

	async getChatModelFromApiModel(_model: LanguageModelChat): Promise<IChatModelInformation | undefined> {
		return undefined;
	}

	async getChatModelFromFamily(modelId: string): Promise<IChatModelInformation> {
		this.requestedFamilies.push(modelId);
		return {
			id: modelId,
			vendor: 'fake-vendor',
			name: 'fake-name',
			version: 'fake-version',
			model_picker_enabled: false,
			is_chat_default: false,
			is_chat_fallback: false,
			capabilities: {
				supports: { streaming: true },
				type: 'chat',
				tokenizer: TokenizerType.O200K,
				family: 'fake-family'
			}
		};
	}

	async getEmbeddingsModel(): Promise<IEmbeddingModelInformation> {
		throw new Error('Not needed for this spec');
	}
}

describe('ProductionEndpointProvider characterization', () => {
	function createProvider() {
		const modelFetcher = new FakeModelMetadataFetcher();
		const instantiationService = {
			createInstance: (ctor: { name: string }, ...args: unknown[]) => {
				if (ctor.name === 'ModelMetadataFetcher') {
					return modelFetcher;
				}
				if (ctor.name === 'ExtensionContributedChatEndpoint') {
					const model = args[0] as LanguageModelChat;
					return { isExtensionContributed: true, model: model.id, modelProvider: model.vendor } satisfies Partial<IChatEndpoint>;
				}
				if (ctor.name === 'CopilotChatEndpoint') {
					const model = args[0] as IChatModelInformation;
					return { model: model.id, modelProvider: model.vendor } satisfies Partial<IChatEndpoint>;
				}
				throw new Error(`Unexpected createInstance call for ${ctor.name}`);
			}
		};
		const provider = new ProductionEndpointProvider(
			{ resolveAutoModeEndpoint: async () => { throw new Error('not used'); } } as any,
			{ trace: () => { } } as any,
			{} as any,
			instantiationService as any,
			{} as any,
		);
		return { provider, modelFetcher };
	}

	it('wraps non-Copilot VS Code language models as extension contributed endpoints', async () => {
		const { provider } = createProvider();

		const endpoint = await provider.getChatEndpoint({
			id: 'local-model',
			vendor: 'local-vendor',
			name: 'Local Model',
			version: '1.0.0',
			family: 'local-model',
			maxInputTokens: 4096,
			capabilities: {},
		} as LanguageModelChat);

		expect((endpoint as any).isExtensionContributed).toBe(true);
		expect(endpoint.model).toBe('local-model');
		expect(endpoint.modelProvider).toBe('local-vendor');
	});

	it('falls back to copilot-base family resolution when a chat request has no model', async () => {
		const { provider, modelFetcher } = createProvider();

		await provider.getChatEndpoint({ model: undefined } as unknown as ChatRequest);

		expect(modelFetcher.requestedFamilies).toEqual(['copilot-base']);
	});
});
