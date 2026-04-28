/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ExtensionContext, SecretStorage } from 'vscode';
import { describe, expect, it } from 'vitest';
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

		expect(context.globalState.get('copilot-byok-CustomOAI-models-config')).toEqual({
			'local-embed': {
				isCustomModel: true,
				deploymentUrl: 'http://localhost:8080/v1/embeddings',
				isRegistered: true,
				modelCapabilities: undefined,
			}
		});
		expect(await context.secrets.get('copilot-byok-CustomOAI-local-embed-api-key')).toBe('local-key');
	});
});

function createStorageService(): BYOKStorageService {
	return new BYOKStorageService(createExtensionContext());
}

function createExtensionContext(): IVSCodeExtensionContext {
	const state = new Map<string, unknown>();
	const secrets = new Map<string, string>();

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
