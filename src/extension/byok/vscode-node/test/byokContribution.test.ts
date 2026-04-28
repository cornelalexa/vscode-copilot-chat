/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../../platform/endpoint/common/capiClient';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../platform/log/common/logService';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKContrib } from '../byokContribution';

suite('BYOKContrib', () => {
	let sandbox: sinon.SinonSandbox;
	let registerStub: sinon.SinonStub;

	setup(() => {
		sandbox = sinon.createSandbox();
		registerStub = sandbox.stub(vscode.lm, 'registerLanguageModelChatProvider').returns({ dispose() { } });
	});

	teardown(() => {
		sandbox.restore();
	});

	function createContribution(options: { providerMode?: 'copilot' | 'standalone'; copilotToken?: { isIndividual: boolean; isInternal: boolean }; fetchThrows?: boolean; knownModelsVersion?: number } = {}) {
		const authListeners: Array<() => void> = [];
		const fetcherService = {
			fetch: sandbox.stub().callsFake(async () => {
				if (options.fetchThrows) {
					throw new Error('known models unavailable');
				}

				return { json: async () => ({ version: options.knownModelsVersion ?? 1, modelInfo: {} }) };
			})
		};
		const authService = {
			copilotToken: options.copilotToken,
			onDidAuthenticationChange: (listener: () => void) => {
				authListeners.push(listener);
				return { dispose() { } };
			},
			getGitHubSession: sandbox.stub().rejects(new Error('must not request GitHub session')),
			getCopilotToken: sandbox.stub().rejects(new Error('must not request Copilot token')),
		};
		const instantiationService = {
			createInstance: sandbox.stub().callsFake((_ctor: unknown) => ({}))
		};

		const contribution = new BYOKContrib(
			fetcherService as unknown as IFetcherService,
			{ info() { }, warn() { }, error() { }, debug() { }, trace() { } } as unknown as ILogService,
			{ dotcomAPIURL: 'https://api.github.com' } as unknown as ICAPIClientService,
			{ getConfig: (key: unknown) => key === ConfigKey.Advanced.ProviderMode ? (options.providerMode ?? 'copilot') : undefined } as unknown as IConfigurationService,
			{
				secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
				globalState: { get: (_key: string, defaultValue: unknown) => defaultValue, update: async () => undefined }
			} as unknown as IVSCodeExtensionContext,
			authService as unknown as IAuthenticationService,
			instantiationService as unknown as IInstantiationService,
		);

		return { contribution, fetcherService, authService, instantiationService, fireAuthChange: () => authListeners.forEach(listener => listener()) };
	}

	async function flushAsyncRegistration() {
		await new Promise(resolve => setTimeout(resolve, 0));
		await new Promise(resolve => setTimeout(resolve, 0));
	}

	test('does not register providers in copilot mode without a cached Copilot token', async () => {
		const { contribution, fetcherService, instantiationService } = createContribution({ providerMode: 'copilot' });
		try {
			await flushAsyncRegistration();

			assert.strictEqual(fetcherService.fetch.callCount, 0);
			assert.strictEqual(instantiationService.createInstance.callCount, 0);
			assert.strictEqual(registerStub.callCount, 0);
		} finally {
			contribution.dispose();
		}
	});

	test('registers all providers once in copilot mode when BYOK policy allows it', async () => {
		const { contribution, fetcherService, instantiationService } = createContribution({ providerMode: 'copilot', copilotToken: { isIndividual: true, isInternal: false } });
		try {
			await flushAsyncRegistration();

			assert.strictEqual(fetcherService.fetch.callCount, 1);
			assert.strictEqual(instantiationService.createInstance.callCount, 8);
			assert.deepStrictEqual(registerStub.getCalls().map(call => call.args[0]), ['ollama', 'anthropic', 'gemini', 'xai', 'openai', 'openrouter', 'azure', 'customoai']);
		} finally {
			contribution.dispose();
		}
	});

	test('registers providers in standalone mode without Copilot token or GitHub session', async () => {
		const { contribution, authService, instantiationService } = createContribution({ providerMode: 'standalone' });
		try {
			await flushAsyncRegistration();

			assert.strictEqual(authService.getGitHubSession.callCount, 0);
			assert.strictEqual(authService.getCopilotToken.callCount, 0);
			assert.strictEqual(instantiationService.createInstance.callCount, 8);
			assert.strictEqual(registerStub.callCount, 8);
		} finally {
			contribution.dispose();
		}
	});

	test('known-model fetch failure still registers local/custom providers in standalone mode', async () => {
		const { contribution, fetcherService, instantiationService } = createContribution({ providerMode: 'standalone', fetchThrows: true });
		try {
			await flushAsyncRegistration();

			assert.strictEqual(fetcherService.fetch.callCount, 1);
			assert.strictEqual(instantiationService.createInstance.callCount, 8);
			assert.strictEqual(registerStub.callCount, 8);
		} finally {
			contribution.dispose();
		}
	});

	test('unexpected known-model version still registers all providers in standalone mode', async () => {
		const { contribution, fetcherService, instantiationService } = createContribution({ providerMode: 'standalone', knownModelsVersion: 999 });
		try {
			await flushAsyncRegistration();

			assert.strictEqual(fetcherService.fetch.callCount, 1);
			assert.strictEqual(instantiationService.createInstance.callCount, 8);
			assert.strictEqual(registerStub.callCount, 8);
		} finally {
			contribution.dispose();
		}
	});

	test('auth changes do not double-register providers after initial standalone registration', async () => {
		const { contribution, fetcherService, instantiationService, fireAuthChange } = createContribution({ providerMode: 'standalone' });
		try {
			await flushAsyncRegistration();
			fireAuthChange();
			await flushAsyncRegistration();

			assert.strictEqual(fetcherService.fetch.callCount, 1);
			assert.strictEqual(instantiationService.createInstance.callCount, 8);
			assert.strictEqual(registerStub.callCount, 8);
		} finally {
			contribution.dispose();
		}
	});
});
