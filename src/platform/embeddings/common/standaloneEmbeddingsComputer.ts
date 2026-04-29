/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { legacyModelApiKeySecretKey, legacyModelsConfigKey, legacyProviderApiKeySecretKey, migrationKey, modelApiKeySecretKey, modelsConfigKey, providerApiKeySecretKey } from '../../byok/common/byokStorageKeys';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { FetchOptions, IFetcherService } from '../../networking/common/fetcherService';
import { ComputeEmbeddingsOptions, Embedding, Embeddings, EmbeddingType, IEmbeddingsComputer } from './embeddingsComputer';

const migrationVersion = 'v1';

type StoredCustomOAIModelConfig = {
	readonly deploymentUrl?: string;
};

type DeprecatedCustomOAIModelConfig = {
	readonly url?: string;
};

type OpenAIEmbeddingResponse = {
	readonly data?: Array<{
		readonly index?: number;
		readonly embedding?: readonly number[];
	}>;
	readonly error?: unknown;
};

export function resolveStandaloneEmbeddingsUrl(url: string): string {
	url = url.trim();
	while (url.endsWith('/')) {
		url = url.slice(0, -1);
	}

	if (url.endsWith('/embeddings')) {
		return url;
	}

	if (url.endsWith('/chat/completions')) {
		return `${url.slice(0, -'/chat/completions'.length)}/embeddings`;
	}

	if (url.endsWith('/responses')) {
		return `${url.slice(0, -'/responses'.length)}/embeddings`;
	}

	if (/\/v\d+$/.test(url)) {
		return `${url}/embeddings`;
	}

	return `${url}/v1/embeddings`;
}

export class StandaloneEmbeddingsComputer implements IEmbeddingsComputer {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
	) { }

	async computeEmbeddings(
		type: EmbeddingType,
		inputs: readonly string[],
		options?: ComputeEmbeddingsOptions,
		telemetryInfo?: TelemetryCorrelationId,
		cancellationToken?: CancellationToken,
	): Promise<Embeddings> {
		if (!inputs.length) {
			return { type, values: [] };
		}

		const modelRef = this._configurationService.getConfig(ConfigKey.Advanced.StandaloneEmbeddingsModel).trim();
		if (!modelRef) {
			return { type, values: [] };
		}

		const providerModel = parseProviderModelRef(modelRef);
		if (!providerModel) {
			return { type, values: [] };
		}

		const endpoint = await this.resolveOpenAICompatibleEmbeddingsEndpoint(providerModel.provider, providerModel.modelId);
		if (!endpoint) {
			return { type, values: [] };
		}

		const response = await this.fetchEmbeddings(resolveStandaloneEmbeddingsUrl(endpoint.url), providerModel.modelId, inputs, endpoint.apiKey, endpoint.headers, cancellationToken);
		const embeddings = parseOpenAIEmbeddingResponse(type, inputs.length, response);
		return { type, values: embeddings };
	}

	private async resolveOpenAICompatibleEmbeddingsEndpoint(provider: string, modelId: string): Promise<{ readonly url: string; readonly apiKey: string | undefined; readonly headers?: Record<string, string> } | undefined> {
		const providerInfo = getOpenAICompatibleProviderInfo(provider);
		if (!providerInfo) {
			return undefined;
		}

		const modelConfig = await this.getStoredModelConfig(providerInfo.storageName, modelId);
		const url = modelConfig?.deploymentUrl ?? modelConfig?.url ?? providerInfo.defaultBaseUrl;
		if (!url) {
			return undefined;
		}

		const apiKey = await this.getApiKey(providerInfo.storageName, modelId);

		return { url, apiKey, headers: providerInfo.headers };
	}

	private async getStoredModelConfig(providerName: string, modelId: string): Promise<(StoredCustomOAIModelConfig & DeprecatedCustomOAIModelConfig) | undefined> {
		await this.migrateProviderStorage(providerName);
		const storedModels = this._extensionContext.globalState.get<Record<string, StoredCustomOAIModelConfig>>(modelsConfigKey(providerName), {});
		const storedModel = storedModels?.[modelId];
		if (storedModel?.deploymentUrl) {
			return storedModel;
		}

		if (providerName !== 'CustomOAI') {
			return storedModel;
		}

		const deprecatedModels = this._configurationService.getConfig(ConfigKey.Deprecated.CustomOAIModels) as Record<string, DeprecatedCustomOAIModelConfig>;
		return deprecatedModels?.[modelId];
	}

	private async getApiKey(providerName: string, modelId: string): Promise<string | undefined> {
		await this.migrateProviderStorage(providerName);

		const modelKey = await this._extensionContext.secrets.get(modelApiKeySecretKey(providerName, modelId));
		if (modelKey?.trim()) {
			return modelKey.trim();
		}

		const providerKey = await this._extensionContext.secrets.get(providerApiKeySecretKey(providerName));
		return providerKey?.trim() || undefined;
	}

	private async migrateProviderStorage(providerName: string): Promise<void> {
		const providerMigrationKey = migrationKey(providerName, migrationVersion);
		if (this._extensionContext.globalState.get<boolean>(providerMigrationKey, false)) {
			return;
		}

		const currentModels = this._extensionContext.globalState.get<Record<string, StoredCustomOAIModelConfig>>(modelsConfigKey(providerName), {});
		const legacyModels = this._extensionContext.globalState.get<Record<string, StoredCustomOAIModelConfig>>(legacyModelsConfigKey(providerName), {});
		const mergedModels = { ...legacyModels, ...currentModels };
		if (Object.keys(legacyModels).length && Object.keys(currentModels).length !== Object.keys(mergedModels).length) {
			await this._extensionContext.globalState.update(modelsConfigKey(providerName), mergedModels);
		} else if (Object.keys(legacyModels).length && !Object.keys(currentModels).length) {
			await this._extensionContext.globalState.update(modelsConfigKey(providerName), legacyModels);
		}

		await this.migrateSecretIfMissing(legacyProviderApiKeySecretKey(providerName), providerApiKeySecretKey(providerName));
		for (const storedModelId of Object.keys(mergedModels)) {
			await this.migrateSecretIfMissing(legacyModelApiKeySecretKey(providerName, storedModelId), modelApiKeySecretKey(providerName, storedModelId));
		}

		await this._extensionContext.globalState.update(providerMigrationKey, true);
	}

	private async migrateSecretIfMissing(legacyKey: string, currentKey: string): Promise<void> {
		const currentValue = await this._extensionContext.secrets.get(currentKey);
		if (currentValue?.trim()) {
			return;
		}

		const legacyValue = await this._extensionContext.secrets.get(legacyKey);
		if (legacyValue?.trim()) {
			await this._extensionContext.secrets.store(currentKey, legacyValue);
		}
	}

	private async fetchEmbeddings(url: string, modelId: string, inputs: readonly string[], apiKey: string | undefined, providerHeaders: Record<string, string> | undefined, cancellationToken: CancellationToken | undefined): Promise<OpenAIEmbeddingResponse> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			...providerHeaders,
		};
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		const dimensions = this._configurationService.getConfig(ConfigKey.Advanced.StandaloneEmbeddingsDimensions);
		const body: { input: readonly string[]; model: string; dimensions?: number } = {
			input: inputs,
			model: modelId,
		};
		if (dimensions > 0) {
			body.dimensions = dimensions;
		}

		const request: FetchOptions = {
			method: 'POST',
			callSite: 'standalone-embeddings',
			headers,
			json: body,
		};

		if (cancellationToken) {
			const abort = this._fetcherService.makeAbortController();
			cancellationToken.onCancellationRequested(() => abort.abort());
			request.signal = abort.signal;
		}

		const rawResponse = await this._fetcherService.fetch(url, request);
		if (!rawResponse.ok) {
			throw new Error(`Standalone embeddings request failed: ${rawResponse.status}`);
		}

		const responseBody = await rawResponse.json() as OpenAIEmbeddingResponse;
		return responseBody;
	}
}

function getOpenAICompatibleProviderInfo(provider: string): { readonly storageName: string; readonly defaultBaseUrl?: string; readonly headers?: Record<string, string> } | undefined {
	switch (provider) {
		case 'customoai':
			return { storageName: 'CustomOAI' };
		case 'openai':
			return { storageName: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1' };
		case 'openrouter':
			return {
				storageName: 'OpenRouter',
				defaultBaseUrl: 'https://openrouter.ai/api/v1',
				headers: {
					'HTTP-Referer': 'https://code.visualstudio.com/',
					'X-Title': 'Reea Copilot Chat',
				}
			};
	}
	return undefined;
}

function parseProviderModelRef(modelRef: string): { readonly provider: string; readonly modelId: string } | undefined {
	const separator = modelRef.indexOf('/');
	if (separator <= 0 || separator === modelRef.length - 1) {
		return undefined;
	}

	return {
		provider: modelRef.slice(0, separator).toLowerCase(),
		modelId: modelRef.slice(separator + 1),
	};
}

function parseOpenAIEmbeddingResponse(type: EmbeddingType, inputCount: number, response: OpenAIEmbeddingResponse): Embedding[] {
	if (!Array.isArray(response.data)) {
		throw new Error('Standalone embeddings response did not include embedding data');
	}

	const embeddings = [...response.data]
		.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
		.map(entry => entry.embedding);

	if (embeddings.length !== inputCount) {
		throw new Error(`Mismatched standalone embeddings result count. Expected: ${inputCount}. Got: ${embeddings.length}`);
	}

	return embeddings.map(value => {
		if (!Array.isArray(value) || !value.every(item => typeof item === 'number')) {
			throw new Error('Standalone embeddings response included invalid embedding data');
		}

		return { type, value };
	});
}
