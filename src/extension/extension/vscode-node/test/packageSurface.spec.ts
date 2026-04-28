/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

function collectObjects(value: unknown, predicate: (obj: Record<string, unknown>) => boolean, results: Record<string, unknown>[] = []): Record<string, unknown>[] {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectObjects(item, predicate, results);
		}
	} else if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		if (predicate(obj)) {
			results.push(obj);
		}
		for (const child of Object.values(obj)) {
			collectObjects(child, predicate, results);
		}
	}

	return results;
}

describe('standalone package surface', () => {
	it('contributes a command to select the standalone embeddings model', () => {
		const commands = packageJson.contributes.commands as Array<{ command: string; title: string }>;
		expect(commands.some(command => command.command === 'github.copilot.chat.standalone.selectEmbeddingsModel')).toBe(true);
	});

	it('hides Copilot sign-in and subscription welcome surfaces in standalone mode', () => {
		const authWelcomeEntries = collectObjects(packageJson.contributes.chatViewsWelcome, obj => typeof obj.when === 'string' && /interactiveSession|offline|chatDisabled|switchToReleaseChannel/.test(obj.when));
		const walkthroughEntries = collectObjects(packageJson.contributes.walkthroughs, obj => typeof obj.id === 'string' && /^copilot\.setup\.(signIn|signUp)/.test(obj.id));

		for (const entry of [...authWelcomeEntries, ...walkthroughEntries]) {
			expect(entry.when).toContain('!github.copilot.chat.standalone');
		}
	});

	it('hides review and cloud-session menu entries in standalone mode', () => {
		const menuEntries = collectObjects(packageJson.contributes.menus, obj => {
			const command = String(obj.command ?? obj.submenu ?? '');
			const when = String(obj.when ?? '');
			return command.includes('github.copilot.chat.review') || command.includes('github.copilot.cloud.sessions') || when.includes('copilot-cloud-agent') || when.includes('github-copilot-review') || when.includes('reviewDiff.enabled');
		});

		for (const entry of menuEntries) {
			const when = String(entry.when ?? '');
			expect(when === 'false' || when.includes('!github.copilot.chat.standalone')).toBe(true);
		}
	});
});
