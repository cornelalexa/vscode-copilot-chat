/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LanguageModelChat, lm, type ChatRequest } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ChatEndpointFamily, EmbeddingsEndpointFamily, IChatModelInformation, ICompletionModelInformation, IEmbeddingModelInformation, IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { AutoChatEndpoint } from '../../../platform/endpoint/node/autoChatEndpoint';
import { IAutomodeService } from '../../../platform/endpoint/node/automodeService';
import { CopilotChatEndpoint } from '../../../platform/endpoint/node/copilotChatEndpoint';
import { EmbeddingEndpoint } from '../../../platform/endpoint/node/embeddingsEndpoint';
import { IModelMetadataFetcher, ModelMetadataFetcher } from '../../../platform/endpoint/node/modelMetadataFetcher';
import { ExtensionContributedChatEndpoint } from '../../../platform/endpoint/vscode-node/extChatEndpoint';
import { ILogService } from '../../../platform/log/common/logService';
import { IChatEndpoint, IEmbeddingsEndpoint } from '../../../platform/networking/common/networking';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';


export class ProductionEndpointProvider extends Disposable implements IEndpointProvider {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidModelsRefresh = this._register(new Emitter<void>());
	readonly onDidModelsRefresh: Event<void> = this._onDidModelsRefresh.event;

	private _chatEndpoints: Map<string, IChatEndpoint> = new Map();
	private _embeddingEndpoints: Map<string, IEmbeddingsEndpoint> = new Map();
	private readonly _modelFetcher: IModelMetadataFetcher;

	constructor(
		@IAutomodeService private readonly _autoModeService: IAutomodeService,
		@ILogService protected readonly _logService: ILogService,
		@IConfigurationService protected readonly _configService: IConfigurationService,
		@IInstantiationService protected readonly _instantiationService: IInstantiationService,
		@IAuthenticationService protected readonly _authService: IAuthenticationService,
	) {
		super();

		this._modelFetcher = this._instantiationService.createInstance(ModelMetadataFetcher,
			false,
		);

		// When new models come in from CAPI we want to clear our local caches and let the endpoints be recreated since there may be new info
		this._register(this._modelFetcher.onDidModelsRefresh(() => {
			this._chatEndpoints.clear();
			this._embeddingEndpoints.clear();
			this._onDidModelsRefresh.fire();
		}));
	}

	private getOrCreateChatEndpointInstance(modelMetadata: IChatModelInformation): IChatEndpoint {
		const modelId = modelMetadata.id;
		let chatEndpoint = this._chatEndpoints.get(modelId);
		if (!chatEndpoint) {
			chatEndpoint = this._instantiationService.createInstance(CopilotChatEndpoint, modelMetadata);
			this._chatEndpoints.set(modelId, chatEndpoint);
		}
		return chatEndpoint;
	}

	async getChatEndpoint(requestOrFamilyOrModel: LanguageModelChat | ChatRequest | ChatEndpointFamily): Promise<IChatEndpoint> {
		this._logService.trace(`Resolving chat model`);

		if (typeof requestOrFamilyOrModel === 'string') {
			if (this.isStandaloneMode()) {
				return this.resolveStandaloneEndpoint(this.getStandaloneRoleForFamily(requestOrFamilyOrModel));
			}
			const modelMetadata = await this._modelFetcher.getChatModelFromFamily(requestOrFamilyOrModel);
			return this.getOrCreateChatEndpointInstance(modelMetadata!);
		}

		const model = 'model' in requestOrFamilyOrModel ? requestOrFamilyOrModel.model : requestOrFamilyOrModel;

		if (!model) {
			if (this.isStandaloneMode()) {
				return this.resolveStandaloneEndpoint('default');
			}
			return this.getChatEndpoint('copilot-base');
		}

		if (model.vendor !== 'copilot') {
			return this._instantiationService.createInstance(ExtensionContributedChatEndpoint, model);
		}

		if (this.isStandaloneMode()) {
			return this.resolveStandaloneEndpoint('default');
		}

		if (model.id === AutoChatEndpoint.pseudoModelId) {
			try {
				const allEndpoints = await this.getAllChatEndpoints();
				return this._autoModeService.resolveAutoModeEndpoint(requestOrFamilyOrModel as ChatRequest, allEndpoints);
			} catch {
				return this.getChatEndpoint('copilot-base');
			}
		}

		const modelMetadata = await this._modelFetcher.getChatModelFromApiModel(model);
		// If we fail to resolve a model since this is panel we give copilot base. This really should never happen as the picker is powered by the same service.
		return modelMetadata ? this.getOrCreateChatEndpointInstance(modelMetadata) : this.getChatEndpoint('copilot-base');
	}

	private isStandaloneMode(): boolean {
		return this._configService.getConfig(ConfigKey.Advanced.ProviderMode) === 'standalone';
	}

	private getStandaloneRoleForFamily(family: string): 'default' | 'fast' | 'reasoning' {
		if (family === 'copilot-fast') {
			return 'fast';
		}
		return 'default';
	}

	private getStandaloneRoleConfig(role: 'default' | 'fast' | 'reasoning'): string {
		switch (role) {
			case 'fast':
				return this._configService.getConfig(ConfigKey.Advanced.StandaloneFastModel) || this._configService.getConfig(ConfigKey.Advanced.StandaloneDefaultModel);
			case 'reasoning':
				return this._configService.getConfig(ConfigKey.Advanced.StandaloneReasoningModel) || this._configService.getConfig(ConfigKey.Advanced.StandaloneDefaultModel);
			default:
				return this._configService.getConfig(ConfigKey.Advanced.StandaloneDefaultModel);
		}
	}

	private async resolveStandaloneEndpoint(role: 'default' | 'fast' | 'reasoning'): Promise<IChatEndpoint> {
		const models = await this.selectStandaloneModels();
		const configuredModel = this.getStandaloneRoleConfig(role);
		const model = configuredModel ? this.findStandaloneModel(models, configuredModel) : models.find(model => model.vendor !== 'copilot');

		if (!model) {
			throw new Error(configuredModel
				? `Standalone model '${configuredModel}' is not available. Configure github.copilot.chat.standalone.model.${role} with a valid vendor/model-id.`
				: 'No standalone language model is available. Configure a BYOK provider or set github.copilot.chat.standalone.model.default.');
		}

		return this._instantiationService.createInstance(ExtensionContributedChatEndpoint, model);
	}

	protected async selectStandaloneModels(): Promise<readonly LanguageModelChat[]> {
		return lm.selectChatModels({});
	}

	private findStandaloneModel(models: readonly LanguageModelChat[], configuredModel: string): LanguageModelChat | undefined {
		const separator = configuredModel.indexOf('/');
		if (separator < 1 || separator === configuredModel.length - 1) {
			return undefined;
		}

		const vendor = configuredModel.slice(0, separator);
		const id = configuredModel.slice(separator + 1);
		return models.find(model => model.vendor === vendor && model.id === id);
	}

	async getEmbeddingsEndpoint(family?: EmbeddingsEndpointFamily): Promise<IEmbeddingsEndpoint> {
		this._logService.trace(`Resolving embedding model`);
		const modelMetadata = await this._modelFetcher.getEmbeddingsModel('text-embedding-3-small');
		const model = await this.getOrCreateEmbeddingEndpointInstance(modelMetadata);
		this._logService.trace(`Resolved embedding model`);
		return model;
	}

	private async getOrCreateEmbeddingEndpointInstance(modelMetadata: IEmbeddingModelInformation): Promise<IEmbeddingsEndpoint> {
		const modelId = 'text-embedding-3-small';
		let embeddingEndpoint = this._embeddingEndpoints.get(modelId);
		if (!embeddingEndpoint) {
			embeddingEndpoint = this._instantiationService.createInstance(EmbeddingEndpoint, modelMetadata);
			this._embeddingEndpoints.set(modelId, embeddingEndpoint);
		}
		return embeddingEndpoint;
	}

	async getAllCompletionModels(forceRefresh?: boolean): Promise<ICompletionModelInformation[]> {
		return this._modelFetcher.getAllCompletionModels(forceRefresh ?? false);
	}

	async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
		const models: IChatModelInformation[] = await this._modelFetcher.getAllChatModels();
		return models.map(model => this.getOrCreateChatEndpointInstance(model));
	}
}
