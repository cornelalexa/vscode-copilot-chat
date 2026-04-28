/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { URI } from '../../../../util/vs/base/common/uri';
import { LocalCodeSearchService } from '../localCodeSearchService';

describe('LocalCodeSearchService', () => {
	it('ranks local files with TF-IDF without remote services', async () => {
		const authFile = URI.file('/workspace/src/auth.ts');
		const themeFile = URI.file('/workspace/src/theme.ts');
		const service = new LocalCodeSearchService(
			{ findFiles: async () => [authFile, themeFile] } as never,
			{ readFile: async (uri: URI) => Buffer.from(uri.toString() === authFile.toString() ? 'function authenticateUser() { return token; }' : 'function renderTheme() { return colors; }') } as never,
			createWorkspaceService() as never,
		);

		const results = await service.search('authenticate token', { maxResults: 2 });

		expect(results.map(result => result.file.toString())).toEqual([authFile.toString()]);
		expect(results[0].rawText).toContain('authenticateUser');
	});

	it('returns empty results when candidate files cannot be read', async () => {
		const service = new LocalCodeSearchService(
			{ findFiles: async () => [URI.file('/workspace/missing.ts')] } as never,
			{ readFile: async () => { throw new Error('missing'); } } as never,
			createWorkspaceService() as never,
		);

		await expect(service.search('anything')).resolves.toEqual([]);
	});
});

function createWorkspaceService() {
	const root = URI.file('/workspace');
	return {
		getWorkspaceFolder: (uri: URI) => uri.fsPath.startsWith(root.fsPath) ? root : undefined,
		getWorkspaceFolders: () => [root],
		asRelativePath: (uri: URI) => uri.fsPath.replace(`${root.fsPath}/`, ''),
	};
}
