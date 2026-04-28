/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, suite, test } from 'vitest';
import { isBYOKEnabled, isBYOKRegistrationEnabled } from '../byokProvider';

suite('BYOK provider policy', function () {

	function token({ isInternal = false, isIndividual = false }: { isInternal?: boolean; isIndividual?: boolean }) {
		return { isInternal, isIndividual } as any;
	}

	function capi(dotcomAPIURL = 'https://api.github.com') {
		return { dotcomAPIURL } as any;
	}

	test('enables BYOK for individual users on dotcom', function () {
		expect(isBYOKEnabled(token({ isIndividual: true }), capi())).toBe(true);
	});

	test('enables BYOK for internal users on dotcom', function () {
		expect(isBYOKEnabled(token({ isInternal: true }), capi())).toBe(true);
	});

	test('disables BYOK for users that are neither individual nor internal', function () {
		expect(isBYOKEnabled(token({}), capi())).toBe(false);
	});

	test('disables BYOK when CAPI is not dotcom', function () {
		expect(isBYOKEnabled(token({ isIndividual: true }), capi('https://github.example.com/api'))).toBe(false);
	});

	test('enables BYOK registration in standalone mode without a Copilot token', function () {
		expect(isBYOKRegistrationEnabled(undefined, capi(), 'standalone')).toBe(true);
	});

	test('keeps BYOK registration gated by token policy in copilot mode', function () {
		expect(isBYOKRegistrationEnabled(undefined, capi(), 'copilot')).toBe(false);
		expect(isBYOKRegistrationEnabled(token({ isIndividual: true }), capi(), 'copilot')).toBe(true);
	});
});
