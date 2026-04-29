/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ExtensionContext, SecretStorage } from 'vscode';
import { describe, expect, it } from 'vitest';
import { modelApiKeySecretKey, modelsConfigKey, providerApiKeySecretKey } from '../../../../platform/byok/common/byokStorageKeys';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { BYOKAuthType } from '../../common/byokProvider';
import { BYOKStorageService } from '../byokStorageService';

describe('BYOKStorageService', () => {
	it('ignores removal of unknown model configs', async () => {
		const storage = createStorageService();

		await expect(storage.removeModelConfig('missing-model', 'CustomOAI', false)).resolves.toBeUndefined();
	});

	it('saves custom model config and per-model API key', async () => {
		const context = createExtensionContext();
		const storage = new BYOKStorageService(context);

		await storage.saveModelConfig('local-embed', 'CustomOAI', {
			apiKey: 'local-key',
			isCustomModel: true,
			deploymentUrl: 'http://localhost:8080/v1/embeddings',
		}, BYOKAuthType.PerModelDeployment);

		expect(context.globalState.get(modelsConfigKey('CustomOAI'))).toEqual({
			'local-embed': {
				isCustomModel: true,
				deploymentUrl: 'http://localhost:8080/v1/embeddings',
				isRegistered: true,
				modelCapabilities: undefined,
			}
		});
		expect(await context.secrets.get(modelApiKeySecretKey('CustomOAI', 'local-embed'))).toBe('local-key');
	});

	it('migrates legacy provider api keys without deleting legacy values', async () => {
		const context = createExtensionContext({
			secrets: {
				'copilot-byok-OpenAI-api-key': ' legacy-openai-key ',
			}
		});
		const storage = new BYOKStorageService(context);

		await expect(storage.getAPIKey('OpenAI')).resolves.toBe('legacy-openai-key');

		expect(await context.secrets.get(providerApiKeySecretKey('OpenAI'))).toBe(' legacy-openai-key ');
		expect(await context.secrets.get('copilot-byok-OpenAI-api-key')).toBe(' legacy-openai-key ');
		expect(context.globalState.get('reea-copilot-byok-migration-OpenAI-v1')).toBe(true);
	});

	it('migrates legacy model configs and per-model api keys', async () => {
		const context = createExtensionContext({
			state: {
				'copilot-byok-CustomOAI-models-config': {
					'local-embed': {
						isCustomModel: true,
						deploymentUrl: 'http://localhost:8080/v1/embeddings',
						isRegistered: true,
					}
				}
			},
			secrets: {
				'copilot-byok-CustomOAI-local-embed-api-key': 'legacy-local-key',
			}
		});
		const storage = new BYOKStorageService(context);

		await expect(storage.getStoredModelConfigs('CustomOAI')).resolves.toEqual({
			'local-embed': {
				isCustomModel: true,
				deploymentUrl: 'http://localhost:8080/v1/embeddings',
				isRegistered: true,
			}
		});
		await expect(storage.getAPIKey('CustomOAI', 'local-embed')).resolves.toBe('legacy-local-key');

		expect(context.globalState.get(modelsConfigKey('CustomOAI'))).toEqual(context.globalState.get('copilot-byok-CustomOAI-models-config'));
		expect(await context.secrets.get(modelApiKeySecretKey('CustomOAI', 'local-embed'))).toBe('legacy-local-key');
		expect(await context.secrets.get('copilot-byok-CustomOAI-local-embed-api-key')).toBe('legacy-local-key');
	});

	it('does not overwrite existing new api keys during migration', async () => {
		const context = createExtensionContext({
			secrets: {
				'copilot-byok-OpenRouter-api-key': 'legacy-openrouter-key',
				[providerApiKeySecretKey('OpenRouter')]: 'new-openrouter-key',
			}
		});
		const storage = new BYOKStorageService(context);

		await expect(storage.getAPIKey('OpenRouter')).resolves.toBe('new-openrouter-key');
		expect(await context.secrets.get(providerApiKeySecretKey('OpenRouter'))).toBe('new-openrouter-key');
	});
});

function createStorageService(): BYOKStorageService {
	return new BYOKStorageService(createExtensionContext());
}

function createExtensionContext(options?: { readonly state?: Record<string, unknown>; readonly secrets?: Record<string, string> }): IVSCodeExtensionContext {
	const state = new Map<string, unknown>();
	const secrets = new Map<string, string>();
	for (const [key, value] of Object.entries(options?.state ?? {})) {
		state.set(key, value);
	}
	for (const [key, value] of Object.entries(options?.secrets ?? {})) {
		secrets.set(key, value);
	}

	return {
		_serviceBrand: undefined,
		globalState: {
			get: (key: string, defaultValue?: unknown) => state.get(key) ?? defaultValue,
			update: async (key: string, value: unknown) => { state.set(key, value); },
		} as unknown as ExtensionContext['globalState'],
		secrets: {
			get: async (key: string) => secrets.get(key),
			store: async (key: string, value: string) => { secrets.set(key, value); },
			delete: async (key: string) => { secrets.delete(key); },
		} as unknown as SecretStorage,
	} as IVSCodeExtensionContext;
}
