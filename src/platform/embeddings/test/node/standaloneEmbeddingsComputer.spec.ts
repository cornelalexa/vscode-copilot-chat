/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConfigurationScope, ExtensionContext } from 'vscode';
import { describe, expect, it } from 'vitest';
import { Event } from '../../../../util/vs/base/common/event';
import { modelApiKeySecretKey, modelsConfigKey, providerApiKeySecretKey } from '../../../byok/common/byokStorageKeys';
import { Config, ConfigKey, IConfigurationService } from '../../../configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../extContext/common/extensionContext';
import { FetchOptions, IAbortController, IAbortSignal, IFetcherService, Response, WebSocketConnection } from '../../../networking/common/fetcherService';
import { StandaloneAvailableEmbeddingTypesService } from '../../../workspaceChunkSearch/common/githubAvailableEmbeddingTypes';
import { EmbeddingType } from '../../common/embeddingsComputer';
import { resolveStandaloneEmbeddingsUrl, StandaloneEmbeddingsComputer } from '../../common/standaloneEmbeddingsComputer';

describe('StandaloneEmbeddingsComputer', () => {
	it('returns no embeddings when standalone embeddings are not configured', async () => {
		const service = new StandaloneEmbeddingsComputer(
			createConfigurationService({}),
			createFetcherService(),
			createExtensionContext()
		);

		const result = await service.computeEmbeddings(EmbeddingType.text3small_512, ['hello']);

		expect(result).toEqual({ type: EmbeddingType.text3small_512, values: [] });
	});

	it('posts OpenAI-compatible embeddings without Copilot auth', async () => {
		let fetchCall: { url: string; options: FetchOptions } | undefined;
		const service = new StandaloneEmbeddingsComputer(
			createConfigurationService({
				[ConfigKey.Advanced.StandaloneEmbeddingsModel.fullyQualifiedId]: 'customoai/local-embed',
				[ConfigKey.Advanced.StandaloneEmbeddingsDimensions.fullyQualifiedId]: 3,
			}),
			createFetcherService((url, options) => {
				fetchCall = { url, options };
				return Response.fromText(200, 'OK', new Headers(), JSON.stringify({
					data: [
						{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] },
						{ object: 'embedding', index: 1, embedding: [0.4, 0.5, 0.6] },
					]
				}), 'test-stub');
			}),
			createExtensionContext({
				storedModels: {
					'local-embed': { deploymentUrl: 'http://localhost:8080/v1/chat/completions' }
				},
				secrets: {
					[modelApiKeySecretKey('CustomOAI', 'local-embed')]: 'local-key'
				}
			})
		);

		const result = await service.computeEmbeddings(EmbeddingType.text3small_512, ['one', 'two']);

		expect(fetchCall?.url).toBe('http://localhost:8080/v1/embeddings');
		expect(fetchCall?.options.callSite).toBe('standalone-embeddings');
		expect(fetchCall?.options.headers).toMatchObject({
			'Content-Type': 'application/json',
			Authorization: 'Bearer local-key',
		});
		expect(fetchCall?.options.json).toEqual({
			input: ['one', 'two'],
			model: 'local-embed',
			dimensions: 3,
		});
		expect(result).toEqual({
			type: EmbeddingType.text3small_512,
			values: [
				{ type: EmbeddingType.text3small_512, value: [0.1, 0.2, 0.3] },
				{ type: EmbeddingType.text3small_512, value: [0.4, 0.5, 0.6] },
			]
		});
	});

	it('supports configured OpenAI embedding models directly', async () => {
		let fetchCall: { url: string; options: FetchOptions } | undefined;
		const service = new StandaloneEmbeddingsComputer(
			createConfigurationService({
				[ConfigKey.Advanced.StandaloneEmbeddingsModel.fullyQualifiedId]: 'openai/text-embedding-3-small',
			}),
			createFetcherService((url, options) => {
				fetchCall = { url, options };
				return Response.fromText(200, 'OK', new Headers(), JSON.stringify({
					data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }]
				}), 'test-stub');
			}),
			createExtensionContext({
				secrets: { [providerApiKeySecretKey('OpenAI')]: 'openai-key' }
			})
		);

		const result = await service.computeEmbeddings(EmbeddingType.text3small_512, ['one']);

		expect(fetchCall?.url).toBe('https://api.openai.com/v1/embeddings');
		expect(fetchCall?.options.headers).toMatchObject({ Authorization: 'Bearer openai-key' });
		expect(fetchCall?.options.json).toMatchObject({ model: 'text-embedding-3-small', input: ['one'] });
		expect(result.values[0].value).toEqual([0.1, 0.2]);
	});

	it('supports configured OpenRouter embedding models directly', async () => {
		let fetchCall: { url: string; options: FetchOptions } | undefined;
		const service = new StandaloneEmbeddingsComputer(
			createConfigurationService({
				[ConfigKey.Advanced.StandaloneEmbeddingsModel.fullyQualifiedId]: 'openrouter/openai/text-embedding-3-small',
			}),
			createFetcherService((url, options) => {
				fetchCall = { url, options };
				return Response.fromText(200, 'OK', new Headers(), JSON.stringify({
					data: [{ object: 'embedding', index: 0, embedding: [0.3, 0.4] }]
				}), 'test-stub');
			}),
			createExtensionContext({
				secrets: { [providerApiKeySecretKey('OpenRouter')]: 'openrouter-key' }
			})
		);

		const result = await service.computeEmbeddings(EmbeddingType.text3small_512, ['one']);

		expect(fetchCall?.url).toBe('https://openrouter.ai/api/v1/embeddings');
		expect(fetchCall?.options.headers).toMatchObject({
			Authorization: 'Bearer openrouter-key',
			'HTTP-Referer': 'https://code.visualstudio.com/',
			'X-Title': 'Reea Copilot Chat',
		});
		expect(fetchCall?.options.json).toMatchObject({ model: 'openai/text-embedding-3-small', input: ['one'] });
		expect(result.values[0].value).toEqual([0.3, 0.4]);
	});

	it('resolves common OpenAI-compatible chat URLs to embeddings URLs', () => {
		expect(resolveStandaloneEmbeddingsUrl('http://localhost:8080')).toBe('http://localhost:8080/v1/embeddings');
		expect(resolveStandaloneEmbeddingsUrl('http://localhost:8080/v1')).toBe('http://localhost:8080/v1/embeddings');
		expect(resolveStandaloneEmbeddingsUrl('http://localhost:8080/v1/chat/completions')).toBe('http://localhost:8080/v1/embeddings');
		expect(resolveStandaloneEmbeddingsUrl('http://localhost:8080/v1/responses')).toBe('http://localhost:8080/v1/embeddings');
		expect(resolveStandaloneEmbeddingsUrl('http://localhost:8080/v1/embeddings')).toBe('http://localhost:8080/v1/embeddings');
	});

	it('uses standalone embedding config as local embedding type cache key', async () => {
		const service = new StandaloneAvailableEmbeddingTypesService(createConfigurationService({
			[ConfigKey.Advanced.StandaloneEmbeddingsModel.fullyQualifiedId]: 'customoai/local-embed',
			[ConfigKey.Advanced.StandaloneEmbeddingsDimensions.fullyQualifiedId]: 384,
		}));

		const type = await service.getPreferredType(true);

		expect(type?.id).toBe('providerModel=customoai/local-embed#chunker=naive-v1#dimensions=384');
	});
});

function createConfigurationService(values: Record<string, unknown>): IConfigurationService {
	return {
		_serviceBrand: undefined,
		getConfig<T>(key: Config<T>, scope?: ConfigurationScope): T {
			return (values[key.fullyQualifiedId] ?? key.defaultValue) as T;
		},
	} as IConfigurationService;
}

function createFetcherService(fetch?: (url: string, options: FetchOptions) => Response | Promise<Response>): IFetcherService {
	return new TestFetcherService(fetch);
}

class TestFetcherService implements IFetcherService {
	declare readonly _serviceBrand: undefined;
	readonly onDidFetch = Event.None;
	readonly onDidCompleteFetch = Event.None;

	constructor(private readonly _fetch?: (url: string, options: FetchOptions) => Response | Promise<Response>) { }

	getUserAgentLibrary(): string {
		return 'test';
	}

	fetch(url: string, options: FetchOptions): Promise<Response> {
		return Promise.resolve(this._fetch?.(url, options) ?? Response.fromText(500, 'Unexpected', new Headers(), '', 'test-stub'));
	}

	createWebSocket(): WebSocketConnection {
		throw new Error('Unexpected websocket use in test');
	}

	disconnectAll(): Promise<unknown> {
		return Promise.resolve();
	}

	makeAbortController(): IAbortController {
		return new TestAbortController();
	}

	isAbortError(): boolean {
		return false;
	}

	isInternetDisconnectedError(): boolean {
		return false;
	}

	isFetcherError(): boolean {
		return false;
	}

	isNetworkProcessCrashedError(): boolean {
		return false;
	}

	getUserMessageForFetcherError(err: Error): string {
		return err.message;
	}

	fetchWithPagination<T>(): Promise<T[]> {
		return Promise.resolve([]);
	}
}

class TestAbortController implements IAbortController {
	private readonly _abortController = new AbortController();

	get signal(): IAbortSignal {
		return this._abortController.signal;
	}

	abort(): void {
		this._abortController.abort();
	}
}

function createExtensionContext(options?: {
	readonly storedModels?: Record<string, { readonly deploymentUrl?: string }>;
	readonly providerStoredModels?: Record<string, Record<string, { readonly deploymentUrl?: string }>>;
	readonly secrets?: Record<string, string>;
}): IVSCodeExtensionContext {
	return {
		globalState: {
			get: (key: string, defaultValue?: unknown) => {
				if (key === modelsConfigKey('CustomOAI')) {
					return options?.storedModels ?? options?.providerStoredModels?.CustomOAI ?? {};
				}
				const match = /^reea-copilot-byok-(.+)-models-config$/.exec(key);
				if (key.startsWith('reea-copilot-byok-migration-')) {
					return false;
				}
				return match ? options?.providerStoredModels?.[match[1]] ?? {} : defaultValue;
			},
			update: async () => undefined,
		} as unknown as ExtensionContext['globalState'],
		secrets: {
			get: async (key: string) => options?.secrets?.[key],
		} as unknown as ExtensionContext['secrets'],
	} as IVSCodeExtensionContext;
}
