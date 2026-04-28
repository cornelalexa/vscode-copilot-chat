/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../../../platform/configuration/common/defaultsOnlyConfigurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { IEnvService } from '../../../../platform/env/common/envService';
import { ILogService } from '../../../../platform/log/common/logService';
import { NullTelemetryService } from '../../../../platform/telemetry/common/nullTelemetryService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { Event } from '../../../../util/vs/base/common/event';
import { InstantiationServiceBuilder } from '../../../../util/common/services';
import { ContextKeysContribution, standaloneContextKey } from '../contextKeys.contribution';

suite('ContextKeysContribution', () => {
	let sandbox: sinon.SinonSandbox;

	setup(() => {
		sandbox = sinon.createSandbox();
	});

	teardown(() => {
		sandbox.restore();
	});

	test('standalone mode sets standalone/activated contexts without requesting Copilot auth', async () => {
		const setContextCalls: Array<[string, unknown]> = [];
		sandbox.stub(vscode.commands, 'executeCommand').callsFake(async (command: string, key?: string, value?: unknown) => {
			if (command === 'setContext' && key) {
				setContextCalls.push([key, value]);
			}
			return undefined;
		});
		sandbox.stub(vscode.commands, 'registerCommand').returns({ dispose() { } });
		sandbox.stub(vscode.window, 'onDidChangeWindowState').returns({ dispose() { } });
		sandbox.stub(vscode.extensions, 'onDidChange').returns({ dispose() { } });

		const configurationService = new InMemoryConfigurationService(new DefaultsOnlyConfigurationService());
		configurationService.setConfig(ConfigKey.Advanced.ProviderMode, 'standalone');
		const getCopilotToken = sandbox.stub().rejects(new Error('must not request Copilot token'));
		const getGitHubSession = sandbox.stub().rejects(new Error('must not request GitHub session'));

		const instantiationService = new InstantiationServiceBuilder([
			[IAuthenticationService, {
				isMinimalMode: false,
				onDidAuthenticationChange: Event.None,
				copilotToken: undefined,
				permissiveGitHubSession: undefined,
				getCopilotToken,
				getGitHubSession,
			} as unknown as IAuthenticationService],
			[ITelemetryService, new NullTelemetryService()],
			[ILogService, { debug() { }, trace() { }, info() { }, warn() { }, error() { } } as unknown as ILogService],
			[IConfigurationService, configurationService],
			[IEnvService, { isProduction: () => true } as unknown as IEnvService],
		]).seal();

		const contribution = instantiationService.createInstance(ContextKeysContribution);
		try {
			await new Promise(resolve => setTimeout(resolve, 0));
			await new Promise(resolve => setTimeout(resolve, 0));

			assert.strictEqual(getCopilotToken.callCount, 0);
			assert.strictEqual(getGitHubSession.callCount, 0);
			assert.ok(setContextCalls.some(([key, value]) => key === standaloneContextKey && value === true));
			assert.ok(setContextCalls.some(([key, value]) => key === 'github.copilot-chat.activated' && value === true));
			assert.ok(setContextCalls.some(([key, value]) => key === 'github.copilot.chat.quotaExceeded' && value === false));
			assert.ok(setContextCalls.some(([key, value]) => key === 'github.copilot.auth.missingPermissiveSession' && value === false));
		} finally {
			contribution.dispose();
		}
	});
});
