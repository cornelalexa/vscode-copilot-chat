/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ConfigKey } from '../../common/configurationService';

describe('configuration service settings', () => {
	it('defines standalone provider mode with copilot as the default', () => {
		expect(ConfigKey.Advanced.ProviderMode.id).toBe('chat.providerMode');
		expect(ConfigKey.Advanced.ProviderMode.fullyQualifiedId).toBe('reea.copilot.chat.providerMode');
		expect(ConfigKey.Advanced.ProviderMode.defaultValue).toBe('standalone');
		expect(ConfigKey.Advanced.ProviderMode.isPublic).toBe(true);
	});

	it('defines standalone model role settings with empty defaults', () => {
		expect(ConfigKey.Advanced.StandaloneDefaultModel.fullyQualifiedId).toBe('reea.copilot.chat.standalone.model.default');
		expect(ConfigKey.Advanced.StandaloneFastModel.fullyQualifiedId).toBe('reea.copilot.chat.standalone.model.fast');
		expect(ConfigKey.Advanced.StandaloneReasoningModel.fullyQualifiedId).toBe('reea.copilot.chat.standalone.model.reasoning');
		expect(ConfigKey.Advanced.StandaloneEmbeddingsModel.fullyQualifiedId).toBe('reea.copilot.chat.standalone.model.embeddings');
		expect(ConfigKey.Advanced.StandaloneEmbeddingsDimensions.fullyQualifiedId).toBe('reea.copilot.chat.standalone.model.embeddingsDimensions');
		expect(ConfigKey.Advanced.StandaloneDefaultModel.defaultValue).toBe('');
		expect(ConfigKey.Advanced.StandaloneFastModel.defaultValue).toBe('');
		expect(ConfigKey.Advanced.StandaloneReasoningModel.defaultValue).toBe('');
		expect(ConfigKey.Advanced.StandaloneEmbeddingsModel.defaultValue).toBe('');
		expect(ConfigKey.Advanced.StandaloneEmbeddingsDimensions.defaultValue).toBe(0);
	});
});
