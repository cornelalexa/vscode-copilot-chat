/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';
import { BYOKStorageService, StoredModelConfig } from './byokStorageService';

export const selectStandaloneEmbeddingsModelCommandId = 'github.copilot.chat.standalone.selectEmbeddingsModel';

type ProviderInfo = {
	readonly displayName: string;
	readonly storageName: string;
	readonly vendor: string;
	readonly modelsUrl?: string;
	readonly commonEmbeddingModels?: readonly string[];
};

type EmbeddingsQuickPickItem = vscode.QuickPickItem & {
	readonly modelRef: string;
};

const embeddingProviders: readonly ProviderInfo[] = [
	{
		displayName: 'OpenAI',
		storageName: 'OpenAI',
		vendor: 'openai',
		modelsUrl: 'https://api.openai.com/v1/models',
		commonEmbeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],
	},
	{
		displayName: 'OpenRouter',
		storageName: 'OpenRouter',
		vendor: 'openrouter',
		modelsUrl: 'https://openrouter.ai/api/v1/models',
		commonEmbeddingModels: ['openai/text-embedding-3-small', 'openai/text-embedding-3-large'],
	},
	{
		displayName: 'OpenAI Compatible',
		storageName: 'CustomOAI',
		vendor: 'customoai',
	},
];

export class StandaloneEmbeddingsPickerContribution extends Disposable implements IExtensionContribution {
	readonly id = 'standalone-embeddings-picker';
	private readonly _storageService: BYOKStorageService;

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._storageService = new BYOKStorageService(extensionContext);
		this._register(vscode.commands.registerCommand(selectStandaloneEmbeddingsModelCommandId, () => this.selectEmbeddingsModel()));
	}

	private async selectEmbeddingsModel(): Promise<void> {
		const items = await this.getEmbeddingModelItems();
		if (!items.length) {
			void vscode.window.showInformationMessage('No embedding-capable standalone provider models were found. Configure an OpenAI, OpenRouter, or OpenAI Compatible provider first.');
			return;
		}

		const current = this._configurationService.getConfig(ConfigKey.Advanced.StandaloneEmbeddingsModel);
		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select a standalone embeddings model',
			title: 'Standalone Embeddings Model',
			matchOnDescription: true,
			matchOnDetail: true,
		});

		if (!picked) {
			return;
		}

		await vscode.workspace.getConfiguration('github.copilot.chat').update('standalone.model.embeddings', picked.modelRef, vscode.ConfigurationTarget.Global);
		void vscode.window.showInformationMessage(`Standalone embeddings model set to ${picked.modelRef}${current === picked.modelRef ? ' (unchanged)' : ''}.`);
	}

	private async getEmbeddingModelItems(): Promise<EmbeddingsQuickPickItem[]> {
		const items = new Map<string, EmbeddingsQuickPickItem>();
		for (const provider of embeddingProviders) {
			for (const modelId of await this.getProviderModelIds(provider)) {
				if (!isLikelyEmbeddingModelId(modelId)) {
					continue;
				}
				const modelRef = `${provider.vendor}/${modelId}`;
				items.set(modelRef, {
					label: modelId,
					description: provider.displayName,
					detail: modelRef,
					modelRef,
				});
			}
		}
		return Array.from(items.values()).sort((a, b) => `${a.description}/${a.label}`.localeCompare(`${b.description}/${b.label}`));
	}

	private async getProviderModelIds(provider: ProviderInfo): Promise<string[]> {
		const storedModels = await this._storageService.getStoredModelConfigs(provider.storageName);
		const storedModelIds = Object.entries(storedModels)
			.filter(([, config]) => isStoredModelAvailable(config))
			.map(([modelId]) => modelId);

		const discoveredModelIds = provider.modelsUrl ? await this.fetchProviderModelIds(provider) : [];
		const hasApiKey = !!await this._storageService.getAPIKey(provider.storageName);
		const commonModelIds = hasApiKey ? provider.commonEmbeddingModels ?? [] : [];

		return Array.from(new Set([...storedModelIds, ...discoveredModelIds, ...commonModelIds]));
	}

	private async fetchProviderModelIds(provider: ProviderInfo): Promise<string[]> {
		const apiKey = await this._storageService.getAPIKey(provider.storageName);
		if (!apiKey || !provider.modelsUrl) {
			return [];
		}

		try {
			const response = await this._fetcherService.fetch(provider.modelsUrl, {
				method: 'GET',
				callSite: 'standalone-embeddings-model-picker',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
				},
			});
			if (!response.ok) {
				return [];
			}
			const body = await response.json() as { readonly data?: Array<{ readonly id?: string }>; readonly models?: Array<{ readonly id?: string }> };
			const models = body.data ?? body.models ?? [];
			return models.map(model => model.id).filter((id): id is string => typeof id === 'string');
		} catch (e) {
			this._logService.warn(`Failed to discover ${provider.displayName} embedding models: ${e instanceof Error ? e.message : String(e)}`);
			return [];
		}
	}
}

function isStoredModelAvailable(config: StoredModelConfig): boolean {
	return config.isRegistered !== false;
}

export function isLikelyEmbeddingModelId(modelId: string): boolean {
	return /(^|[-_/])(?:text-)?embed(?:ding|dings)?(?:[-_/]|$)/i.test(modelId)
		|| /text-embedding/i.test(modelId)
		|| /bge-|e5-|nomic-embed|gte-|jina-embed/i.test(modelId);
}
