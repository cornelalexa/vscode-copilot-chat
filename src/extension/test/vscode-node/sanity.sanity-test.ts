/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { SpyChatResponseStream } from '../../../util/common/test/mockChatResponseStream';
import { timeout } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Event } from '../../../util/vs/base/common/event';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { reeaChatSessionStore } from '../../chatSessions/vscode-node/reeaChatSessionStore';
import { Intent } from '../../common/constants';
import { ConversationFeature } from '../../conversation/vscode-node/conversationFeature';
import { IConversationStore } from '../../conversationStore/node/conversationStore';
import { activate } from '../../extension/vscode-node/extension';
import { Conversation, Turn, TurnStatus } from '../../prompt/common/conversation';
import { ChatParticipantRequestHandler } from '../../prompt/node/chatParticipantRequestHandler';
import { ContributedToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';
import { TestChatRequest } from '../node/testHelpers';

/**
 * Running these locally? You may have to run `npm run setup` again
 */

suite('Copilot Chat Sanity Test', function () {
	this.timeout(1000 * 60 * 1); // 1 minute

	let realInstaAccessor: IInstantiationService;
	let realContext: vscode.ExtensionContext;
	let sandbox: sinon.SinonSandbox;
	const fakeToken = CancellationToken.None;
	const sessionItemProviders = new Map<string, vscode.ChatSessionItemProvider>();
	const sessionContentProviders = new Map<string, vscode.ChatSessionContentProvider>();
	const treeDataProviders = new Map<string, vscode.TreeDataProvider<vscode.TreeItem>>();
	// Before everything, activate the extension
	suiteSetup(async function () {
		sandbox = sinon.createSandbox();
		sandbox.stub(vscode.commands, 'registerCommand').returns({ dispose: () => { } });
		sandbox.stub(vscode.workspace, 'registerFileSystemProvider').returns({ dispose: () => { } });
		sandbox.stub(vscode.window, 'registerTreeDataProvider').callsFake((viewId, provider) => {
			treeDataProviders.set(viewId, provider as vscode.TreeDataProvider<vscode.TreeItem>);
			return { dispose: () => { } };
		});
		sandbox.stub(vscode.chat, 'registerChatSessionContentProvider').callsFake((scheme, provider) => {
			sessionContentProviders.set(scheme, provider as vscode.ChatSessionContentProvider);
			return { dispose: () => { } };
		});
		sandbox.stub(vscode.chat, 'registerChatSessionItemProvider').callsFake((scheme, sessionItemProvider) => {
			sessionItemProviders.set(scheme, sessionItemProvider);
			return { dispose: () => { } };
		});
		const extension = vscode.extensions.getExtension('Github.reea-copilot-chat');
		assert.ok(extension, 'Extension is not available');
		realContext = await extension.activate();
		assert.ok(realContext, '`extension.activate()` did not return context`');
		assert.ok(realContext.extensionMode, 'extension context does not have `extensionMode`');
		const activateResult = await activate(realContext, true);
		assert.ok(activateResult, 'Activation result is not available');
		// Assert that the activateResult is a service accessor
		assert.strictEqual(typeof (activateResult as IInstantiationService).createInstance, 'function', 'createInstance is not a function');
		assert.strictEqual(typeof (activateResult as IInstantiationService).invokeFunction, 'function', 'invokeFunction is not a function');
		realInstaAccessor = activateResult as IInstantiationService;
	});

	suiteTeardown(async function () {
		sandbox.restore();
		// Dispose of all subscriptions
		realContext.subscriptions.forEach((sub) => {
			try {
				sub.dispose();
			} catch (e) {
				console.error(e);
			}
		});
	});

	test('E2E Production Panel Chat Test', async function () {
		assert.ok(realInstaAccessor, 'Instantiation service accessor is not available');

		await realInstaAccessor.invokeFunction(async (accessor) => {

			const conversationStore = accessor.get(IConversationStore);
			const instaService = accessor.get(IInstantiationService);
			const conversationFeature = instaService.createInstance(ConversationFeature);
			try {
				conversationFeature.activated = true;
				let stream = new SpyChatResponseStream();
				let interactiveSession = instaService.createInstance(ChatParticipantRequestHandler, [], new TestChatRequest('Write me a for loop in javascript'), stream, fakeToken, { agentName: '', agentId: '', intentId: '' }, () => false, undefined);

				await interactiveSession.getResult();

				assert.ok(stream.currentProgress, 'Expected progress after first request');
				const oldText = stream.currentProgress;

				stream = new SpyChatResponseStream();
				interactiveSession = instaService.createInstance(ChatParticipantRequestHandler, [], new TestChatRequest('Can you make it in typescript instead'), stream, fakeToken, { agentName: '', agentId: '', intentId: '' }, () => false, undefined);
				const result2 = await interactiveSession.getResult();

				assert.ok(stream.currentProgress, 'Expected progress after second request');
				assert.notStrictEqual(stream.currentProgress, oldText, 'Expected different progress text after second request');

				const conversation = conversationStore.getConversation(result2.metadata.responseId);
				assert.ok(conversation, 'Expected conversation to be available');
			} finally {
				conversationFeature.activated = false;
			}
		});
	});

	/**
	 * Runs tools outside of a real chat session which is unusual but lets us spy more
	 * Uses an empty window with no folder open
	 */
	test('E2E Production agent mode', async function () {
		assert.ok(realInstaAccessor, 'Instantiation service accessor is not available');

		await realInstaAccessor.invokeFunction(async (accessor) => {

			const conversationStore = accessor.get(IConversationStore);
			const instaService = accessor.get(IInstantiationService);
			const toolsService = accessor.get(IToolsService);
			const conversationFeature = instaService.createInstance(ConversationFeature);
			try {
				conversationFeature.activated = true;
				let stream = new SpyChatResponseStream();
				const testRequest = new TestChatRequest(`You must use the get_errors tool to check the window for errors. It may fail, that's ok, just testing, don't retry.`);
				testRequest.tools.set(ContributedToolName.GetErrors, true);
				let interactiveSession = instaService.createInstance(ChatParticipantRequestHandler, [], testRequest, stream, fakeToken, { agentName: '', agentId: '', intentId: Intent.Agent }, () => false, undefined);

				const onWillInvokeTool = Event.toPromise(toolsService.onWillInvokeTool);
				const getResultPromise = interactiveSession.getResult();
				await Promise.race([onWillInvokeTool, timeout(20_000).then(() => Promise.reject(new Error('timed out waiting for tool call. ' + (stream.currentProgress ? ('Got progress: ' + stream.currentProgress) : ''))))]);
				await getResultPromise;

				assert.ok(stream.currentProgress, 'Expected output');
				const oldText = stream.currentProgress;

				stream = new SpyChatResponseStream();
				interactiveSession = instaService.createInstance(ChatParticipantRequestHandler, [], new TestChatRequest('And what is 1+1'), stream, fakeToken, { agentName: '', agentId: '', intentId: Intent.Agent }, () => false, undefined);
				const result2 = await interactiveSession.getResult();

				assert.ok(stream.currentProgress, 'Expected progress after second request');
				assert.notStrictEqual(stream.currentProgress, oldText, 'Expected different progress text after second request');

				const conversation = conversationStore.getConversation(result2.metadata.responseId);
				assert.ok(conversation, 'Expected conversation to be available');
			} finally {
				conversationFeature.activated = false;
			}
		});
	});

	test('Slash Commands work properly', async function () {
		assert.ok(realInstaAccessor);

		await realInstaAccessor.invokeFunction(async (accessor) => {

			const instaService = accessor.get(IInstantiationService);
			const conversationFeature = instaService.createInstance(ConversationFeature);
			try {
				conversationFeature.activated = true;
				const progressReport = new SpyChatResponseStream();
				const interactiveSession = instaService.createInstance(ChatParticipantRequestHandler, [], new TestChatRequest('What is a fibonacci sequence?'), progressReport, fakeToken, { agentName: '', agentId: '', intentId: 'explain' }, () => false, undefined);

				// Ask a `/explain` question
				await interactiveSession.getResult();
				assert.ok(progressReport.currentProgress);
			} finally {
				conversationFeature.activated = false;
			}
		});
	});

	test('Copilot CLI lists sessions', async function () {
		assert.ok(realInstaAccessor);

		await realInstaAccessor.invokeFunction(async (accessor) => {

			const instaService = accessor.get(IInstantiationService);
			const conversationFeature = instaService.createInstance(ConversationFeature);
			try {
				conversationFeature.activated = true;
				const provider = sessionItemProviders.get('copilotcli');
				assert.ok(provider);
				await provider.provideChatSessionItems(CancellationToken.None);
			} finally {
				conversationFeature.activated = false;
			}
		});
	});

	test('REDEX surface registers a dedicated sessions view', async function () {
		const provider = treeDataProviders.get('reea-copilot-redex.sessions');
		assert.ok(provider);

		const items = await provider.getChildren();
		assert.ok(items);
		assert.ok(items.some(item => item.label === 'New REDEX Session'));
	});

	test('REDEX registers its dedicated chat session provider', async function () {
		const provider = sessionContentProviders.get('reea-copilot');
		assert.ok(provider);
	});

	test('REDEX restores in-memory session history for reopened sessions', async function () {
		const provider = sessionContentProviders.get('reea-copilot');
		assert.ok(provider);

		const resource = vscode.Uri.from({ scheme: 'reea-copilot', path: '/restored-session' });
		const previousItems = reeaChatSessionStore.values();
		const chatSessionItem = {
			resource,
			label: 'Restored REDEX Session',
			metadata: { internalSessionId: 'session-restore-1' },
		} as vscode.ChatSessionItem;

		reeaChatSessionStore.replace([...previousItems, chatSessionItem]);

		try {
			await realInstaAccessor.invokeFunction(async accessor => {
				const conversationStore = accessor.get(IConversationStore);
				const turn = new Turn('turn-restore-1', { message: 'Explain this', type: 'user' });
				turn.setResponse(TurnStatus.Success, { message: 'Restored answer', type: 'model' }, 'resp-restore-1', {
					metadata: {
						responseId: 'resp-restore-1',
						sessionId: 'session-restore-1',
						agentId: 'reea-copilot',
					},
				});
				conversationStore.addConversation('resp-restore-1', new Conversation('session-restore-1', [turn]));
			});

			const session = await provider.provideChatSessionContent(resource, CancellationToken.None, {
				inputState: undefined as unknown as vscode.ChatSessionInputState,
				sessionOptions: [],
			});

			assert.strictEqual(session.history.length, 2);
			assert.ok(session.history[0] instanceof vscode.ChatRequestTurn2);
			assert.ok(session.history[1] instanceof vscode.ChatResponseTurn2);
			assert.strictEqual((session.history[0] as vscode.ChatRequestTurn2).prompt, 'Explain this');
			assert.strictEqual(((session.history[1] as vscode.ChatResponseTurn2).result.metadata as { responseId: string }).responseId, 'resp-restore-1');
		} finally {
			reeaChatSessionStore.replace(previousItems);
		}
	});

	test('REDEX restores transcript-backed history and surfaces the session in the REDEX list', async function () {
		const provider = sessionContentProviders.get('reea-copilot');
		const treeProvider = treeDataProviders.get('reea-copilot-redex.sessions');
		assert.ok(provider);
		assert.ok(treeProvider);
		assert.ok(realContext.storageUri);

		const previousItems = reeaChatSessionStore.values();
		const sessionId = 'session-transcript-restore-1';
		const resource = vscode.Uri.from({ scheme: 'reea-copilot', path: `/${sessionId}` });
		const transcriptDirectory = vscode.Uri.joinPath(realContext.storageUri!, 'transcripts');
		const transcriptFile = vscode.Uri.joinPath(transcriptDirectory, `${sessionId}.jsonl`);

		mkdirSync(transcriptDirectory.fsPath, { recursive: true });
		writeFileSync(transcriptFile.fsPath, [
			JSON.stringify({
				id: 'entry-1',
				type: 'session.start',
				timestamp: '2026-04-29T10:00:00.000Z',
				parentId: null,
				data: {
					sessionId,
					version: 1,
					producer: 'copilot-agent',
					copilotVersion: '1.0.0',
					vscodeVersion: '1.100.0',
					startTime: '2026-04-29T10:00:00.000Z',
				},
			}),
			JSON.stringify({
				id: 'entry-2',
				type: 'user.message',
				timestamp: '2026-04-29T10:00:01.000Z',
				parentId: 'entry-1',
				data: {
					content: 'Transcript question',
					attachments: [],
				},
			}),
			JSON.stringify({
				id: 'entry-3',
				type: 'assistant.message',
				timestamp: '2026-04-29T10:00:02.000Z',
				parentId: 'entry-2',
				data: {
					messageId: 'message-1',
					content: 'Transcript answer',
					toolRequests: [],
				},
			}),
		].join('\n'));

		try {
			const session = await provider.provideChatSessionContent(resource, CancellationToken.None, {
				inputState: undefined as unknown as vscode.ChatSessionInputState,
				sessionOptions: [],
			});

			assert.strictEqual(session.history.length, 2);
			assert.ok(session.history[0] instanceof vscode.ChatRequestTurn2);
			assert.ok(session.history[1] instanceof vscode.ChatResponseTurn2);
			assert.strictEqual((session.history[0] as vscode.ChatRequestTurn2).prompt, 'Transcript question');
			assert.strictEqual(((session.history[1] as vscode.ChatResponseTurn2).response[0] as vscode.ChatResponseMarkdownPart).value.value, 'Transcript answer');

			const items = await treeProvider.getChildren();
			assert.ok(items);
			assert.ok(items.some(item => item.label === 'Transcript question'));
		} finally {
			rmSync(transcriptFile.fsPath, { force: true });
			reeaChatSessionStore.replace(previousItems);
		}
	});

	test.skip('E2E Production Inline Chat Test', async function () {
		assert.ok(realInstaAccessor);

		await realInstaAccessor.invokeFunction(async (accessor) => {

			const r = vscode.lm.registerLanguageModelChatProvider('test', new class implements vscode.LanguageModelChatProvider {
				async provideLanguageModelChatInformation(options: { silent: boolean }, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
					return [{
						id: 'test',
						name: 'test',
						family: 'test',
						version: '0.0.0',
						maxInputTokens: 1000,
						maxOutputTokens: 1000,
						requiresAuthorization: true,
						capabilities: {}
					}];
				}
				async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>, options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart2>, token: vscode.CancellationToken): Promise<void> {
					throw new Error('Method not implemented.');
				}
				async provideTokenCount(model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2, token: vscode.CancellationToken): Promise<number> {
					return 0;
				}
			});

			const instaService = accessor.get(IInstantiationService);
			const conversationFeature = instaService.createInstance(ConversationFeature);
			try {
				conversationFeature.activated = true;

				// Create and open a new file
				const document = await vscode.workspace.openTextDocument({ language: 'javascript' });
				await vscode.window.showTextDocument(document);

				// Wait for a document change event or 10 seconds whatever comes first then assert the text
				const textPromise = new Promise<string>((resolve, reject) => {
					const listener = vscode.workspace.onDidChangeTextDocument(async (e) => {
						if (e.document.uri.scheme !== 'untitled') {
							return;
						}
						if (e.document.getText().length !== 0) {
							listener.dispose();
							resolve(e.document.getText());
						}
					});
				});

				await vscode.commands.executeCommand('vscode.editorChat.start', {
					autoSend: true,
					message: 'Write me a for loop in javascript',
					position: new vscode.Position(0, 0),
					initialSelection: new vscode.Selection(0, 0, 0, 0),
					initialRange: new vscode.Range(0, 0, 0, 0),
				});
				const text = await textPromise;
				assert.ok(text.length > 0);
			} finally {
				conversationFeature.activated = false;
				r.dispose();
			}
		});
	});
});
