/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ConfigKey } from '../../common/configurationService';

describe('configuration service settings', () => {
	it('defines standalone provider mode with copilot as the default', () => {
		expect(ConfigKey.Advanced.ProviderMode.id).toBe('chat.providerMode');
		expect(ConfigKey.Advanced.ProviderMode.fullyQualifiedId).toBe('github.copilot.chat.providerMode');
		expect(ConfigKey.Advanced.ProviderMode.defaultValue).toBe('copilot');
		expect(ConfigKey.Advanced.ProviderMode.isPublic).toBe(true);
	});
});
