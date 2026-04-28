/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { isLikelyEmbeddingModelId } from '../standaloneEmbeddingsPicker';

describe('standalone embeddings picker', () => {
	it('recognizes common embedding model names', () => {
		expect(isLikelyEmbeddingModelId('text-embedding-3-small')).toBe(true);
		expect(isLikelyEmbeddingModelId('openai/text-embedding-3-large')).toBe(true);
		expect(isLikelyEmbeddingModelId('nomic-embed-text')).toBe(true);
		expect(isLikelyEmbeddingModelId('bge-m3')).toBe(true);
		expect(isLikelyEmbeddingModelId('jina-embeddings-v3')).toBe(true);
	});

	it('does not treat ordinary chat models as embedding models', () => {
		expect(isLikelyEmbeddingModelId('gpt-4o')).toBe(false);
		expect(isLikelyEmbeddingModelId('anthropic/claude-sonnet-4.5')).toBe(false);
		expect(isLikelyEmbeddingModelId('qwen/qwen3-coder')).toBe(false);
	});
});
