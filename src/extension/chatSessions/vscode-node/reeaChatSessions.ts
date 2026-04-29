/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { defaultAgentName } from '../../../platform/chat/common/chatAgents';
import { IChatSessionService } from '../../../platform/chat/common/chatSessionService';
import { ISessionTranscriptService, TranscriptEntry } from '../../../platform/chat/common/sessionTranscriptService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { ReeaChatRequestHandlerFactory } from '../../conversation/vscode-node/reeaChatRequestHandlerFactory';
import { getAdditionalWelcomeMessage } from '../../conversation/vscode-node/welcomeMessageProvider';
import { IConversationStore } from '../../conversationStore/node/conversationStore';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { ChatSummarizerProvider } from '../../prompt/node/summarizer';
import { ChatTitleProvider } from '../../prompt/node/title';
import { JSONL } from '../../workspaceRecorder/common/jsonlUtil';
import { reeaChatSessionStore } from './reeaChatSessionStore';

export const reeaChatSessionType = 'reea-copilot';

interface IReeaChatSessionMetadata {
	readonly internalSessionId?: string;
	readonly [key: string]: unknown;
}

interface IReeaTranscriptSession {
	readonly sessionId: string;
	readonly title: string;
	readonly created: number;
	readonly lastRequestEnded?: number;
	readonly history: ReadonlyArray<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2>;
}

function getDefaultSessionTitle(): string {
	return vscode.l10n.t('Reea Copilot Chat');
}

function getInternalSessionId(item: vscode.ChatSessionItem | undefined): string | undefined {
	const metadata = item?.metadata as IReeaChatSessionMetadata | undefined;
	return typeof metadata?.internalSessionId === 'string' ? metadata.internalSessionId : undefined;
}

function getResourceSessionId(resource: vscode.Uri): string | undefined {
	const path = resource.path.startsWith('/') ? resource.path.slice(1) : resource.path;
	return path || undefined;
}

function getSessionLabel(prompt: string | undefined): string {
	const normalizedPrompt = prompt?.replace(/\s+/g, ' ').trim();
	if (!normalizedPrompt) {
		return getDefaultSessionTitle();
	}

	return normalizedPrompt.slice(0, 80);
}

function getSessionTimestamp(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

function getSessionItemKey(item: vscode.ChatSessionItem): string {
	return getInternalSessionId(item) ?? item.resource.toString();
}

function getSessionItemSortTimestamp(item: vscode.ChatSessionItem): number {
	return item.timing?.lastRequestEnded ?? item.timing?.lastRequestStarted ?? item.timing?.created ?? 0;
}

function getControllerItems(controller: vscode.ChatSessionItemController): vscode.ChatSessionItem[] {
	return Array.from(controller.items, ([, item]) => item);
}

function mergeSessionItems(...collections: ReadonlyArray<readonly vscode.ChatSessionItem[]>): vscode.ChatSessionItem[] {
	const mergedItems = new Map<string, vscode.ChatSessionItem>();
	for (const collection of collections) {
		for (const item of collection) {
			mergedItems.set(getSessionItemKey(item), item);
		}
	}

	return Array.from(mergedItems.values()).sort((left, right) => getSessionItemSortTimestamp(right) - getSessionItemSortTimestamp(left));
}

function buildTranscriptSession(sessionId: string, entries: readonly TranscriptEntry[]): IReeaTranscriptSession | undefined {
	const defaultTitle = getDefaultSessionTitle();
	let title = defaultTitle;
	let created: number | undefined;
	let lastRequestEnded: number | undefined;
	let pendingPrompt: string | undefined;
	let pendingRequestId: string | undefined;
	let pendingResponseChunks: string[] = [];
	const history: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> = [];

	const pushPendingTurn = () => {
		if (pendingPrompt === undefined) {
			return;
		}

		history.push(new vscode.ChatRequestTurn2(
			pendingPrompt,
			undefined,
			[],
			reeaChatSessionType,
			[],
			undefined,
			pendingRequestId,
			undefined,
			undefined,
		));

		const responseText = pendingResponseChunks
			.map(chunk => chunk.trim())
			.filter(chunk => chunk.length > 0)
			.join('\n\n');
		if (responseText.length > 0) {
			const transcriptResult: vscode.ChatResult = { metadata: { sessionId } };
			history.push(new vscode.ChatResponseTurn2([
				new vscode.ChatResponseMarkdownPart(responseText)
			], transcriptResult, reeaChatSessionType));
		}

		pendingPrompt = undefined;
		pendingRequestId = undefined;
		pendingResponseChunks = [];
	};

	for (const entry of entries) {
		const entryTimestamp = getSessionTimestamp(entry.timestamp);
		created ??= entryTimestamp;
		lastRequestEnded = entryTimestamp ?? lastRequestEnded;

		switch (entry.type) {
			case 'session.start': {
				created ??= getSessionTimestamp(entry.data.startTime);
				break;
			}
			case 'user.message': {
				pushPendingTurn();
				pendingPrompt = entry.data.content;
				pendingRequestId = entry.id;
				if (title === defaultTitle) {
					title = getSessionLabel(entry.data.content);
				}
				break;
			}
			case 'assistant.message': {
				if (pendingPrompt !== undefined && entry.data.content.trim().length > 0) {
					pendingResponseChunks.push(entry.data.content);
				}
				break;
			}
		}
	}

	pushPendingTurn();

	if (created === undefined) {
		return undefined;
	}

	return {
		sessionId,
		title,
		created,
		lastRequestEnded,
		history,
	};
}

async function loadTranscriptSession(
	fileSystemService: IFileSystemService,
	extensionContext: IVSCodeExtensionContext,
	logService: ILogService,
	sessionId: string,
): Promise<IReeaTranscriptSession | undefined> {
	const storageUri = extensionContext.storageUri;
	if (!storageUri) {
		return undefined;
	}

	const transcriptUri = vscode.Uri.joinPath(storageUri, 'transcripts', `${sessionId}.jsonl`);
	try {
		const transcriptContents = new TextDecoder().decode(await fileSystemService.readFile(transcriptUri, true));
		return buildTranscriptSession(sessionId, JSONL.parse<TranscriptEntry>(transcriptContents));
	} catch (error) {
		if (!(error instanceof Error && error.message === 'ENOENT')) {
			logService.warn(`[ReeaChatSessions] Failed to read transcript for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return undefined;
	}
}

function createTranscriptSessionItem(controller: vscode.ChatSessionItemController, session: IReeaTranscriptSession): vscode.ChatSessionItem {
	const item = controller.createChatSessionItem(vscode.Uri.from({ scheme: reeaChatSessionType, path: `/${session.sessionId}` }), session.title);
	item.iconPath = new vscode.ThemeIcon('copilot');
	item.timing = {
		created: session.created,
		lastRequestEnded: session.lastRequestEnded,
		startTime: session.created,
		endTime: session.lastRequestEnded,
	};
	item.metadata = { internalSessionId: session.sessionId };
	item.tooltip = session.title;
	return item;
}

async function loadTranscriptSessionItems(
	controller: vscode.ChatSessionItemController,
	fileSystemService: IFileSystemService,
	extensionContext: IVSCodeExtensionContext,
	logService: ILogService,
): Promise<vscode.ChatSessionItem[]> {
	const storageUri = extensionContext.storageUri;
	if (!storageUri) {
		return [];
	}

	const transcriptDirectory = vscode.Uri.joinPath(storageUri, 'transcripts');
	let transcriptEntries: [string, FileType][];
	try {
		transcriptEntries = await fileSystemService.readDirectory(transcriptDirectory);
	} catch (error) {
		if (!(error instanceof Error && error.message === 'ENOENT')) {
			logService.warn(`[ReeaChatSessions] Failed to read transcript directory: ${error instanceof Error ? error.message : String(error)}`);
		}
		return [];
	}

	const sessionItems: vscode.ChatSessionItem[] = [];
	for (const [name, type] of transcriptEntries) {
		if (type !== FileType.File || !name.endsWith('.jsonl')) {
			continue;
		}

		const sessionId = name.slice(0, -'.jsonl'.length);
		const transcriptSession = await loadTranscriptSession(fileSystemService, extensionContext, logService, sessionId);
		if (transcriptSession) {
			sessionItems.push(createTranscriptSessionItem(controller, transcriptSession));
		}
	}

	return sessionItems;
}

function getHistoryReferences(turn: Turn): readonly vscode.ChatPromptReference[] {
	return turn.promptVariables ? Array.from(turn.promptVariables, variable => variable.reference) : [];
}

function buildResponseTurn(turn: Turn): vscode.ChatResponseTurn2 | undefined {
	if (!turn.responseMessage && !turn.responseChatResult) {
		return;
	}

	const responseParts = turn.responseMessage?.message
		? [new vscode.ChatResponseMarkdownPart(turn.responseMessage.message)]
		: [];

	return new vscode.ChatResponseTurn2(responseParts, turn.responseChatResult ?? {}, reeaChatSessionType);
}

function buildSessionHistory(conversation: Conversation | undefined): ReadonlyArray<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> {
	if (!conversation) {
		return [];
	}

	const history: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> = [];
	for (const turn of conversation.turns) {
		history.push(new vscode.ChatRequestTurn2(
			turn.request.message,
			turn.resultMetadata?.command,
			[...getHistoryReferences(turn)],
			reeaChatSessionType,
			[],
			turn.editedFileEvents,
			turn.id,
			turn.resultMetadata?.resolvedModel,
			undefined,
		));

		const responseTurn = buildResponseTurn(turn);
		if (responseTurn) {
			history.push(responseTurn);
		}
	}

	return history;
}

export class ReeaChatSessionsContrib extends Disposable implements IExtensionContribution {
	readonly id = 'reeaChatSessions';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IConversationStore conversationStore: IConversationStore,
		@IFileSystemService fileSystemService: IFileSystemService,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@IChatSessionService chatSessionService: IChatSessionService,
		@ISessionTranscriptService sessionTranscriptService: ISessionTranscriptService,
		@ILogService logService: ILogService,
	) {
		super();

		const requestHandlerFactory = instantiationService.createInstance(ReeaChatRequestHandlerFactory);
		const intentGetter = requestHandlerFactory.getDefaultIntentGetter();
		const baseRequestHandler = requestHandlerFactory.createRequestHandler(reeaChatSessionType, defaultAgentName, intentGetter) as vscode.ChatRequestHandler;
		const updateSessionCollections = (controller: vscode.ChatSessionItemController, ...collections: ReadonlyArray<readonly vscode.ChatSessionItem[]>) => {
			const mergedItems = mergeSessionItems(...collections, getControllerItems(controller), reeaChatSessionStore.values());
			reeaChatSessionStore.replace(mergedItems);
			controller.items.replace(mergedItems);
		};
		async function refreshPersistedSessions(): Promise<void> {
			const persistedItems = await loadTranscriptSessionItems(reeaSessionController, fileSystemService, extensionContext, logService);
			updateSessionCollections(reeaSessionController, persistedItems);
		}
		const reeaSessionController = this._register(vscode.chat.createChatSessionItemController(reeaChatSessionType, refreshPersistedSessions));
		const requestHandler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
			const result = await baseRequestHandler(request, context, stream, token);
			const chatSessionItem = context.chatSessionContext?.chatSessionItem;
			const internalSessionId = result?.metadata?.sessionId ?? request.sessionId;

			if (chatSessionItem && internalSessionId) {
				const metadata = chatSessionItem.metadata as IReeaChatSessionMetadata | undefined;
				if (metadata?.internalSessionId !== internalSessionId) {
					chatSessionItem.metadata = { ...metadata, internalSessionId };
				}
				reeaSessionController.items.add(chatSessionItem);
				updateSessionCollections(reeaSessionController, [chatSessionItem]);
			}

			return result;
		};
		const reeaSessionParticipant = vscode.chat.createChatParticipant(reeaChatSessionType, requestHandler);
		const additionalWelcomeMessage = instantiationService.invokeFunction(getAdditionalWelcomeMessage);

		reeaSessionParticipant.iconPath = new vscode.ThemeIcon('copilot');
		reeaSessionParticipant.additionalWelcomeMessage = additionalWelcomeMessage;
		reeaSessionParticipant.titleProvider = instantiationService.createInstance(ChatTitleProvider);
		reeaSessionParticipant.summarizer = instantiationService.createInstance(ChatSummarizerProvider);

		reeaSessionController.newChatSessionItemHandler = (context: vscode.ChatSessionItemControllerNewItemHandlerContext) => {
			const id = generateUuid();
			const item = reeaSessionController.createChatSessionItem(vscode.Uri.from({ scheme: reeaChatSessionType, path: `/${id}` }), context.request.prompt || vscode.l10n.t('New Reea Chat'));
			item.iconPath = new vscode.ThemeIcon('copilot');
			item.timing = { created: Date.now() };
			reeaChatSessionStore.set(item);
			return Promise.resolve(item);
		};

		this._register(chatSessionService.onDidDisposeChatSession(sessionId => {
			sessionTranscriptService.endSession(sessionId).catch(error => {
				logService.warn(`[ReeaChatSessions] Failed to end transcript session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
			});
		}));

		this._register(vscode.chat.registerChatSessionContentProvider(reeaChatSessionType, {
			provideChatSessionContent: async resource => {
				let chatSessionItem = reeaSessionController.items.get(resource) ?? reeaChatSessionStore.get(resource);
				let transcriptSession: IReeaTranscriptSession | undefined;
				const persistedSessionId = getInternalSessionId(chatSessionItem) ?? getResourceSessionId(resource);

				if (!chatSessionItem && persistedSessionId) {
					transcriptSession = await loadTranscriptSession(fileSystemService, extensionContext, logService, persistedSessionId);
					if (transcriptSession) {
						chatSessionItem = createTranscriptSessionItem(reeaSessionController, transcriptSession);
						updateSessionCollections(reeaSessionController, [chatSessionItem]);
					}
				} else if (chatSessionItem) {
					updateSessionCollections(reeaSessionController, [chatSessionItem]);
				}

				const internalSessionId = getInternalSessionId(chatSessionItem) ?? persistedSessionId;
				const conversation = internalSessionId ? conversationStore.getLatestConversationForSession(internalSessionId) : undefined;
				transcriptSession ??= !conversation && internalSessionId
					? await loadTranscriptSession(fileSystemService, extensionContext, logService, internalSessionId)
					: undefined;
				const history = conversation ? buildSessionHistory(conversation) : (transcriptSession?.history ?? []);

				return {
					title: chatSessionItem?.label ?? transcriptSession?.title ?? getDefaultSessionTitle(),
					history,
					requestHandler,
				};
			},
		}, reeaSessionParticipant));

		void refreshPersistedSessions();
	}
}