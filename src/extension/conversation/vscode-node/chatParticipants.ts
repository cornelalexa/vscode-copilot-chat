/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { IChatAgentService, defaultAgentName, editingSessionAgentEditorName, editingSessionAgentName, editsAgentName, getChatParticipantIdFromName, notebookEditorAgentName, terminalAgentName, vscodeAgentName } from '../../../platform/chat/common/chatAgents';
import { IChatSessionService } from '../../../platform/chat/common/chatSessionService';
import { clearChatExtMarks } from '../../../util/common/performance';
import { DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { autorun } from '../../../util/vs/base/common/observableInternal';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Intent } from '../../common/constants';
import { IFeedbackReporter } from '../../prompt/node/feedbackReporter';
import { ChatSummarizerProvider } from '../../prompt/node/summarizer';
import { ChatTitleProvider } from '../../prompt/node/title';
import { IntentOrGetter, ReeaChatRequestHandlerFactory } from './reeaChatRequestHandlerFactory';
import { IUserFeedbackService } from './userActions';
import { getAdditionalWelcomeMessage } from './welcomeMessageProvider';

export class ChatAgentService implements IChatAgentService {
	declare readonly _serviceBrand: undefined;

	private _lastChatAgents: ChatAgents | undefined; // will be cleared when disposed

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }
	public debugGetCurrentChatAgents(): ChatAgents | undefined {
		return this._lastChatAgents;
	}

	register(): IDisposable {
		const chatAgents = this.instantiationService.createInstance(ChatAgents);
		chatAgents.register();
		this._lastChatAgents = chatAgents;
		return {
			dispose: () => {
				chatAgents.dispose();
				this._lastChatAgents = undefined;
			}
		};
	}
}

class ChatAgents implements IDisposable {
	private readonly _disposables = new DisposableStore();

	private additionalWelcomeMessage: vscode.MarkdownString | undefined;
	private readonly requestHandlerFactory: ReeaChatRequestHandlerFactory;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IUserFeedbackService private readonly userFeedbackService: IUserFeedbackService,
		@IFeedbackReporter private readonly feedbackReporter: IFeedbackReporter,
		@IChatSessionService chatSessionService: IChatSessionService,
	) {
		this.requestHandlerFactory = this.instantiationService.createInstance(ReeaChatRequestHandlerFactory);
		this._disposables.add(chatSessionService.onDidDisposeChatSession(sessionId => clearChatExtMarks(sessionId)));
	}

	dispose() {
		this._disposables.dispose();
	}

	register(): void {
		this.additionalWelcomeMessage = this.instantiationService.invokeFunction(getAdditionalWelcomeMessage);
		this._disposables.add(this.registerDefaultAgent());
		this._disposables.add(this.registerEditingAgent());
		this._disposables.add(this.registerEditingAgentEditor());
		this._disposables.add(this.registerEditsAgent());
		this._disposables.add(this.registerNotebookEditorDefaultAgent());
		this._disposables.add(this.registerNotebookDefaultAgent());
		this._disposables.add(this.registerVSCodeAgent());
		this._disposables.add(this.registerTerminalAgent());
		this._disposables.add(this.registerTerminalPanelAgent());
	}

	private createAgent(name: string, defaultIntentIdOrGetter: IntentOrGetter, options?: { id?: string }): vscode.ChatParticipant {
		const id = options?.id || getChatParticipantIdFromName(name);
		const agent = vscode.chat.createChatParticipant(id, this.requestHandlerFactory.createRequestHandler(id, name, defaultIntentIdOrGetter));
		agent.onDidReceiveFeedback(e => {
			this.userFeedbackService.handleFeedback(e, id);
		});
		agent.onDidPerformAction(e => {
			this.userFeedbackService.handleUserAction(e, id);
		});
		this._disposables.add(autorun(reader => {
			agent.supportIssueReporting = this.feedbackReporter.canReport.read(reader);
		}));

		return agent;
	}

	private registerVSCodeAgent(): IDisposable {
		const useInsidersIcon = vscode.env.appName.includes('Insiders') || vscode.env.appName.includes('OSS');
		const vscodeAgent = this.createAgent(vscodeAgentName, Intent.VSCode);
		vscodeAgent.iconPath = useInsidersIcon ? new vscode.ThemeIcon('vscode-insiders') : new vscode.ThemeIcon('vscode');
		return vscodeAgent;
	}

	private registerTerminalAgent(): IDisposable {
		const terminalAgent = this.createAgent(terminalAgentName, Intent.Terminal);

		terminalAgent.iconPath = new vscode.ThemeIcon('terminal');
		return terminalAgent;
	}

	private registerTerminalPanelAgent(): IDisposable {
		const terminalPanelAgent = this.createAgent(terminalAgentName, Intent.Terminal, { id: 'reea.copilot.terminalPanel' });

		terminalPanelAgent.iconPath = new vscode.ThemeIcon('terminal');

		return terminalPanelAgent;
	}

	private registerEditingAgent(): IDisposable {
		const editingAgent = this.createAgent(editingSessionAgentName, Intent.Edit);
		editingAgent.iconPath = new vscode.ThemeIcon('copilot');
		editingAgent.additionalWelcomeMessage = this.additionalWelcomeMessage;
		editingAgent.titleProvider = this.instantiationService.createInstance(ChatTitleProvider);
		return editingAgent;
	}

	private registerEditingAgentEditor(): IDisposable {
		const editingAgent = this.createAgent(editingSessionAgentEditorName, Intent.InlineChat);
		editingAgent.iconPath = new vscode.ThemeIcon('copilot');
		return editingAgent;
	}

	private registerEditsAgent(): IDisposable {
		const editingAgent = this.createAgent(editsAgentName, Intent.Agent);
		editingAgent.iconPath = new vscode.ThemeIcon('tools');
		editingAgent.additionalWelcomeMessage = this.additionalWelcomeMessage;
		editingAgent.titleProvider = this.instantiationService.createInstance(ChatTitleProvider);
		return editingAgent;
	}

	private getDefaultIntentGetter(): IntentOrGetter {
		return this.requestHandlerFactory.getDefaultIntentGetter();
	}

	private registerDefaultAgent(): IDisposable {
		const intentGetter = this.getDefaultIntentGetter();
		const defaultAgent = this.createAgent(defaultAgentName, intentGetter);
		defaultAgent.iconPath = new vscode.ThemeIcon('copilot');

		defaultAgent.helpTextPrefix = vscode.l10n.t('You can ask me general programming questions, or chat with the following participants which have specialized expertise and can perform actions:');
		const helpPostfix = vscode.l10n.t({
			message: `To have a great conversation, ask me questions as if I was a real programmer:

* **Show me the code** you want to talk about by having the files open and selecting the most important lines.
* **Make refinements** by asking me follow-up questions, adding clarifications, providing errors, etc.
* **Review my suggested code** and tell me about issues or improvements, so I can iterate on it.

You can also ask me questions about your editor selection by [starting an inline chat session](command:inlineChat.start).

Learn more about [Reea Copilot](https://docs.github.com/copilot/using-github-copilot/getting-started-with-github-copilot?tool=vscode&utm_source=editor&utm_medium=chat-panel&utm_campaign=2024q3-em-MSFT-getstarted) in [Visual Studio Code](https://code.visualstudio.com/docs/copilot/overview). Or explore the [Copilot walkthrough](command:reea.copilot.open.walkthrough).`,
			comment: `{Locked='](command:inlineChat.start)'}`
		});
		const markdownString = new vscode.MarkdownString(helpPostfix);
		markdownString.isTrusted = { enabledCommands: ['inlineChat.start', 'reea.copilot.open.walkthrough'] };
		defaultAgent.helpTextPostfix = markdownString;

		defaultAgent.additionalWelcomeMessage = this.additionalWelcomeMessage;
		defaultAgent.titleProvider = this.instantiationService.createInstance(ChatTitleProvider);
		defaultAgent.summarizer = this.instantiationService.createInstance(ChatSummarizerProvider);

		return defaultAgent;
	}

	private registerNotebookEditorDefaultAgent(): IDisposable {
		const defaultAgent = this.createAgent('notebook', Intent.Editor);
		defaultAgent.iconPath = new vscode.ThemeIcon('copilot');

		return defaultAgent;
	}

	private registerNotebookDefaultAgent(): IDisposable {
		const defaultAgent = this.createAgent(notebookEditorAgentName, Intent.notebookEditor);
		defaultAgent.iconPath = new vscode.ThemeIcon('copilot');

		return defaultAgent;
	}

}
