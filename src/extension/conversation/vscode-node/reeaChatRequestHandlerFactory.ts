/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IChatQuotaService } from '../../../platform/chat/common/chatQuotaService';
import { IInteractionService } from '../../../platform/chat/common/interactionService';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ChatExtPerfMark, clearChatExtMarks, markChatExt } from '../../../util/common/performance';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequest } from '../../../vscodeTypes';
import { Intent, agentsToCommands } from '../../common/constants';
import { ICopilotChatResultIn } from '../../prompt/common/conversation';
import { getSwitchToAutoOnRateLimitConfirmation, isContinueOnError } from '../../prompt/common/specialRequestTypes';
import { ChatParticipantRequestHandler } from '../../prompt/node/chatParticipantRequestHandler';
import { IPromptCategorizerService } from '../../prompt/node/promptCategorizer';

export type IntentOrGetter = Intent | ((request: vscode.ChatRequest) => Intent);

export class ReeaChatRequestHandlerFactory {
	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IInteractionService private readonly interactionService: IInteractionService,
		@IChatQuotaService private readonly chatQuotaService: IChatQuotaService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@IPromptCategorizerService private readonly promptCategorizerService: IPromptCategorizerService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) { }

	getDefaultIntentGetter(): IntentOrGetter {
		return (request: vscode.ChatRequest) => {
			if (this.configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.AskAgent, this.experimentationService) && request.model.capabilities.supportsToolCalling && this.configurationService.getNonExtensionConfig('chat.agent.enabled')) {
				return Intent.AskAgent;
			}
			return Intent.Unknown;
		};
	}

	createRequestHandler(id: string, name: string, defaultIntentIdOrGetter: IntentOrGetter): vscode.ChatExtendedRequestHandler {
		return async (request, context, stream, token): Promise<vscode.ChatResult> => {
			markChatExt(request.sessionId, ChatExtPerfMark.WillHandleParticipant);
			try {
				request = await this.switchToBaseModel(request, stream);

				const switchToAutoConfirmation = getSwitchToAutoOnRateLimitConfirmation(request);
				if (switchToAutoConfirmation) {
					const action = switchToAutoConfirmation.alwaysSwitchToAuto ? 'switchToAutoAlways' : 'switchToAuto';
					this.telemetryService.sendMSFTTelemetryEvent('chatRateLimitAction', { action, modelId: request.model?.id });
					request = await this.switchToAutoModel(request, stream, switchToAutoConfirmation.alwaysSwitchToAuto);
				} else if (isContinueOnError(request)) {
					this.telemetryService.sendMSFTTelemetryEvent('chatRateLimitAction', { action: 'tryAgain', modelId: request.model?.id });
				}

				if (!request.subAgentInvocationId) {
					this.interactionService.startInteraction();
				}

				const telemetryMessageId = context.history.length === 0 ? generateUuid() : undefined;
				if (telemetryMessageId !== undefined) {
					this.promptCategorizerService.categorizePrompt(request, context, telemetryMessageId);
				}

				const defaultIntentId = typeof defaultIntentIdOrGetter === 'function'
					? defaultIntentIdOrGetter(request)
					: defaultIntentIdOrGetter;

				const commandsForAgent = agentsToCommands[defaultIntentId];
				const intentId = request.command && commandsForAgent
					? commandsForAgent[request.command]
					: defaultIntentId;

				const handler = this.instantiationService.createInstance(ChatParticipantRequestHandler, context.history, request, stream, token, { agentName: name, agentId: id, intentId }, () => context.yieldRequested, telemetryMessageId);
				let result = await handler.getResult();

				if ((result as ICopilotChatResultIn).metadata?.shouldAutoSwitchToAuto) {
					const previousModelId = request.model?.id;
					const switchedRequest = await this.switchToAutoModel(request, stream, false);
					if (switchedRequest.model?.id !== previousModelId) {
						this.telemetryService.sendMSFTTelemetryEvent('chatRateLimitAction', { action: 'autoSwitch', modelId: previousModelId });
						request = switchedRequest;
						const retryHandler = this.instantiationService.createInstance(ChatParticipantRequestHandler, context.history, request, stream, token, { agentName: name, agentId: id, intentId }, () => context.yieldRequested, telemetryMessageId);
						result = await retryHandler.getResult();
					}
				}

				return result;
			} finally {
				markChatExt(request.sessionId, ChatExtPerfMark.DidHandleParticipant);
				clearChatExtMarks(request.sessionId);
			}
		};
	}

	private async switchToBaseModel(request: vscode.ChatRequest, stream: vscode.ChatResponseStream): Promise<ChatRequest> {
		const endpoint = await this.endpointProvider.getChatEndpoint(request);
		const baseEndpoint = await this.endpointProvider.getChatEndpoint('copilot-base');
		if (endpoint.multiplier === 0 || request.model.vendor !== 'reea-copilot' || endpoint.multiplier === undefined) {
			return request;
		}
		if (this.chatQuotaService.overagesEnabled || !this.chatQuotaService.quotaExhausted) {
			return request;
		}
		const baseLmModel = (await vscode.lm.selectChatModels({ id: baseEndpoint.model, family: baseEndpoint.family, vendor: 'copilot' }))[0];
		if (!baseLmModel) {
			return request;
		}
		await vscode.commands.executeCommand('workbench.action.chat.changeModel', { vendor: baseLmModel.vendor, id: baseLmModel.id, family: baseLmModel.family });
		request = { ...request, model: baseLmModel };
		let messageString: vscode.MarkdownString;
		if (this.authenticationService.copilotToken?.isIndividual) {
			messageString = new vscode.MarkdownString(vscode.l10n.t({
				message: 'You have exceeded your premium request allowance. We have automatically switched you to {0} which is included with your plan. [Enable additional paid premium requests]({1}) to continue using premium models.',
				args: [baseEndpoint.name, 'command:chat.enablePremiumOverages'],
				comment: [`{Locked=']({'}`]
			}));
			messageString.isTrusted = { enabledCommands: ['chat.enablePremiumOverages'] };
		} else {
			messageString = new vscode.MarkdownString(vscode.l10n.t('You have exceeded your premium request allowance. We have automatically switched you to {0} which is included with your plan. To enable additional paid premium requests, contact your organization admin.', baseEndpoint.name));
		}
		stream.warning(messageString);
		return request;
	}

	private async switchToAutoModel(request: vscode.ChatRequest, stream: vscode.ChatResponseStream, alwaysSwitchToAuto: boolean): Promise<ChatRequest> {
		const autoModel = (await vscode.lm.selectChatModels({ id: 'auto', vendor: 'copilot' }))[0];
		if (!autoModel) {
			return request;
		}
		await vscode.commands.executeCommand('workbench.action.chat.changeModel', { vendor: autoModel.vendor, id: autoModel.id, family: autoModel.family });
		request = { ...request, model: autoModel };
		if (alwaysSwitchToAuto) {
			await vscode.workspace.getConfiguration('reea.copilot').update('chat.rateLimitAutoSwitchToAuto', true, vscode.ConfigurationTarget.Global);
		}
		stream.warning(new vscode.MarkdownString(vscode.l10n.t('You were rate-limited on the selected model. Switching to Auto and retrying your request.')));
		return request;
	}
}