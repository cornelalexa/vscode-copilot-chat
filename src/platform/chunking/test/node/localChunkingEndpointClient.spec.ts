/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OutputMode, Raw } from '@vscode/prompt-tsx';
import { describe, expect, it } from 'vitest';
import { CallTracker } from '../../../../util/common/telemetryCorrelationId';
import { ITokenizer } from '../../../../util/common/tokenizer';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { EmbeddingType, IEmbeddingsComputer } from '../../../embeddings/common/embeddingsComputer';
import { ITokenizerProvider } from '../../../tokenizer/node/tokenizer';
import { ComputeBatchInfo, EmbeddingsComputeQos } from '../../common/chunkingEndpointClient';
import { LocalChunkingEndpointClient } from '../../node/localChunkingEndpointClient';

describe('LocalChunkingEndpointClient', () => {
	it('chunks and embeds locally without requiring an auth token', async () => {
		const client = new LocalChunkingEndpointClient(createEmbeddingsComputer(), createTokenizerProvider());
		const batchInfo = new ComputeBatchInfo();

		const result = await client.computeChunksAndEmbeddings(
			'',
			new EmbeddingType('providerModel=customoai/local-embed#chunker=naive-v1#dimensions=2'),
			{
				uri: URI.file('/workspace/file.ts'),
				getText: async () => 'export function hello() {\n\treturn "world";\n}',
			},
			batchInfo,
			EmbeddingsComputeQos.Batch,
			undefined,
			new CallTracker('test'),
			CancellationToken.None,
		);

		expect(result?.length).toBeGreaterThan(0);
		expect(result?.[0].embedding.value).toEqual([1, 2]);
		expect(result?.[0].chunkHash).toBeTruthy();
		expect(batchInfo.recomputedFileCount).toBe(1);
	});
});

function createEmbeddingsComputer(): IEmbeddingsComputer {
	return {
		_serviceBrand: undefined,
		computeEmbeddings: async (type, inputs) => ({
			type,
			values: inputs.map(() => ({ type, value: [1, 2] }))
		})
	};
}

function createTokenizerProvider(): ITokenizerProvider {
	return {
		_serviceBrand: undefined,
		acquireTokenizer: () => new TestTokenizer(),
	};
}

class TestTokenizer implements ITokenizer {
	readonly mode = OutputMode.Raw;

	tokenLength(text: string | Raw.ChatCompletionContentPart): Promise<number> {
		if (typeof text === 'string') {
			return Promise.resolve(text.length);
		}
		return Promise.resolve(0);
	}

	countMessageTokens(): Promise<number> {
		return Promise.resolve(0);
	}

	countMessagesTokens(): Promise<number> {
		return Promise.resolve(0);
	}

	countToolTokens(): Promise<number> {
		return Promise.resolve(0);
	}

	tokenize(value: string): Promise<number[]> {
		return Promise.resolve(Array.from(value, (_, index) => index));
	}

	detokenize(tokens: readonly number[]): Promise<string> {
		return Promise.resolve(tokens.map(() => 'x').join(''));
	}

	countTokens(value: string): Promise<number> {
		return Promise.resolve(value.length);
	}

	takeTokens(value: string, maxTokens: number): Promise<string> {
		return Promise.resolve(value.slice(0, maxTokens));
	}

	takeLastTokens(value: string, maxTokens: number): Promise<string> {
		return Promise.resolve(value.slice(Math.max(0, value.length - maxTokens)));
	}
}
