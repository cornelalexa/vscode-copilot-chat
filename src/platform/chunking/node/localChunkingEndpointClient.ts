/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { CallTracker } from '../../../util/common/telemetryCorrelationId';
import { TokenizerType } from '../../../util/common/tokenizer';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { raceCancellationError } from '../../../util/vs/base/common/async';
import { Embedding, EmbeddingType, IEmbeddingsComputer } from '../../embeddings/common/embeddingsComputer';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { FileChunkWithEmbedding, FileChunkWithOptionalEmbedding } from '../common/chunk';
import { ChunkableContent, ComputeBatchInfo, EmbeddingsComputeQos, IChunkingEndpointClient } from '../common/chunkingEndpointClient';
import { NaiveChunker } from './naiveChunker';

export class LocalChunkingEndpointClient implements IChunkingEndpointClient {
	declare readonly _serviceBrand: undefined;
	private readonly _chunker: NaiveChunker;

	constructor(
		@IEmbeddingsComputer private readonly _embeddingsComputer: IEmbeddingsComputer,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
	) {
		this._chunker = new NaiveChunker(localChunkingTokenizerEndpoint, tokenizerProvider);
	}

	computeChunks(
		authToken: string,
		embeddingType: EmbeddingType,
		content: ChunkableContent,
		batchInfo: ComputeBatchInfo,
		qos: EmbeddingsComputeQos,
		cache: ReadonlyMap<string, FileChunkWithEmbedding> | undefined,
		telemetryInfo: CallTracker,
		token: CancellationToken,
	): Promise<readonly FileChunkWithOptionalEmbedding[] | undefined> {
		return this.computeLocalChunks(embeddingType, content, batchInfo, false, cache, token);
	}

	async computeChunksAndEmbeddings(
		authToken: string,
		embeddingType: EmbeddingType,
		content: ChunkableContent,
		batchInfo: ComputeBatchInfo,
		qos: EmbeddingsComputeQos,
		cache: ReadonlyMap<string, FileChunkWithEmbedding> | undefined,
		telemetryInfo: CallTracker,
		token: CancellationToken,
	): Promise<readonly FileChunkWithEmbedding[] | undefined> {
		const chunks = await this.computeLocalChunks(embeddingType, content, batchInfo, true, cache, token);
		return chunks as readonly FileChunkWithEmbedding[] | undefined;
	}

	private async computeLocalChunks(
		embeddingType: EmbeddingType,
		content: ChunkableContent,
		batchInfo: ComputeBatchInfo,
		computeEmbeddings: boolean,
		cache: ReadonlyMap<string, FileChunkWithEmbedding> | undefined,
		token: CancellationToken,
	): Promise<readonly FileChunkWithOptionalEmbedding[] | undefined> {
		const text = await raceCancellationError(content.getText(), token);
		const chunks = await this._chunker.chunkFile(content.uri, text, {}, token);
		if (!chunks.length) {
			return [];
		}

		batchInfo.recomputedFileCount++;
		batchInfo.sentContentTextLength += text.length;

		const uncachedChunks = chunks.filter(chunk => !cache?.get(getChunkHash(content.uri.toString(), chunk.text)));
		const embeddings = computeEmbeddings && uncachedChunks.length
			? await this._embeddingsComputer.computeEmbeddings(embeddingType, uncachedChunks.map(chunk => chunk.text), { inputType: 'document' }, undefined, token)
			: undefined;
		const embeddingsByHash = new Map<string, Embedding>();
		for (let i = 0; i < uncachedChunks.length; i++) {
			const embedding = embeddings?.values[i];
			if (embedding) {
				embeddingsByHash.set(getChunkHash(content.uri.toString(), uncachedChunks[i].text), embedding);
			}
		}

		const result: FileChunkWithOptionalEmbedding[] = [];
		for (const chunk of chunks) {
			const chunkHash = getChunkHash(content.uri.toString(), chunk.text);
			const cached = cache?.get(chunkHash);
			if (cached) {
				result.push(cached);
				continue;
			}

			const embedding = embeddingsByHash.get(chunkHash);
			if (computeEmbeddings && !embedding) {
				continue;
			}

			result.push({
				chunk,
				chunkHash,
				embedding,
			});
		}
		return result;
	}
}

function getChunkHash(uri: string, text: string): string {
	return createHash('sha256').update(uri).update('\0').update(text).digest('hex');
}

export const localChunkingTokenizerEndpoint = { tokenizer: TokenizerType.O200K };
