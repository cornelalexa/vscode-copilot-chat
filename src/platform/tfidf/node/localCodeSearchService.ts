/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { IFileSystemService } from '../../filesystem/common/fileSystemService';
import { ISearchService } from '../../search/common/searchService';
import { IWorkspaceService } from '../../workspace/common/workspaceService';
import { FileChunk } from '../../chunking/common/chunk';
import { ILocalCodeSearchService, LocalCodeSearchOptions } from '../common/localCodeSearchService';
import { PersistentTfIdf, TfIdfDoc } from './tfidf';
import { Range } from '../../../util/vs/editor/common/core/range';
import { URI } from '../../../util/vs/base/common/uri';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { ExcludeSettingOptions } from '../../../vscodeTypes';

const DEFAULT_MAX_FILES = 250;
const DEFAULT_MAX_RESULTS = 10;

export class LocalCodeSearchService implements ILocalCodeSearchService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ISearchService private readonly searchService: ISearchService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) { }

	async search(query: string, options: LocalCodeSearchOptions = {}): Promise<readonly FileChunk[]> {
		const files = await this.findCandidateFiles(options);
		if (!files.length) {
			return [];
		}

		const docs = await this.createDocs(files);
		if (!docs.length) {
			return [];
		}

		const index = new PersistentTfIdf(':memory:');
		await index.addOrUpdate(docs);
		return index.search(query, { maxResults: options.maxResults ?? DEFAULT_MAX_RESULTS });
	}

	private async findCandidateFiles(options: LocalCodeSearchOptions): Promise<URI[]> {
		const maxFiles = Math.max(DEFAULT_MAX_FILES, options.maxResults ?? 0);
		const patterns = options.scopedDirectories?.length
			? options.scopedDirectories.map(dir => this.toRelativePattern(dir))
			: ['**/*'];

		const result = await this.searchService.findFiles(patterns, { maxResults: maxFiles, useExcludeSettings: ExcludeSettingOptions.SearchAndFilesExclude }, CancellationToken.None);
		return result.map(uri => URI.from(uri));
	}

	private toRelativePattern(dir: URI): vscode.RelativePattern {
		const workspaceFolder = this.workspaceService.getWorkspaceFolder(dir) ?? this.workspaceService.getWorkspaceFolders()[0];
		const pattern = workspaceFolder ? `${this.workspaceService.asRelativePath(dir, false)}/**/*` : '**/*';
		const baseUri = workspaceFolder ?? dir;
		return { base: baseUri.fsPath, baseUri, pattern };
	}

	private async createDocs(files: readonly URI[]): Promise<TfIdfDoc[]> {
		const docs = await Promise.all(files.map(uri => this.createDoc(uri).catch(() => undefined)));
		return docs.filter((doc): doc is TfIdfDoc => !!doc);
	}

	private async createDoc(uri: URI): Promise<TfIdfDoc | undefined> {
		const bytes = await this.fileSystemService.readFile(uri);
		const text = Buffer.from(bytes).toString('utf8');
		if (!text.trim()) {
			return undefined;
		}

		return {
			uri,
			getContentVersionId: async () => String(bytes.byteLength),
			getChunks: async () => [this.createWholeFileChunk(uri, text)],
		};
	}

	private createWholeFileChunk(uri: URI, text: string): FileChunk {
		const lines = text.split(/\r?\n/);
		return {
			file: uri,
			text,
			rawText: text,
			range: Range.lift({ startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: (lines.at(-1)?.length ?? 0) + 1 }),
			isFullFile: true,
		};
	}
}
