/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';
import { reeaChatSessionStore } from './reeaChatSessionStore';
import { reeaChatSessionType } from './reeaChatSessions';

const redexSurfaceViewId = 'reea-copilot-redex.sessions';
const redexNewSessionCommand = 'reea.copilot.redex.newSession';
const redexOpenSessionCommand = 'reea.copilot.redex.openSession';

export class RedexSurfaceContrib extends Disposable implements IExtensionContribution {
	readonly id = 'redexSurface';

	constructor() {
		super();

		this._register(vscode.window.registerTreeDataProvider(redexSurfaceViewId, this._register(new RedexSurfaceProvider())));
		this._register(vscode.commands.registerCommand(redexNewSessionCommand, async () => {
			await vscode.commands.executeCommand(`workbench.action.chat.openNewSessionEditor.${reeaChatSessionType}`);
		}));
		this._register(vscode.commands.registerCommand(redexOpenSessionCommand, async (resource: vscode.Uri) => {
			try {
				await vscode.commands.executeCommand('vscode.open', resource);
			} catch {
				await vscode.commands.executeCommand(`workbench.action.chat.openSessionWithPrompt.${reeaChatSessionType}`, { resource });
			}
		}));
	}
}

class RedexSurfaceProvider extends Disposable implements vscode.TreeDataProvider<RedexSurfaceItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<RedexSurfaceItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor() {
		super();
		this._register(reeaChatSessionStore.onDidChangeItems(() => {
			this._onDidChangeTreeData.fire(undefined);
		}));
	}

	getTreeItem(element: RedexSurfaceItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: RedexSurfaceItem): vscode.ProviderResult<RedexSurfaceItem[]> {
		if (element) {
			return [];
		}

		return [
			new RedexActionItem(
				l10n.t('New REDEX Session'),
				redexNewSessionCommand,
				'add',
				l10n.t('Open a new dedicated REDEX chat session')
			),
			...reeaChatSessionStore.values().map(item => new RedexSessionItem(item)),
			new RedexInfoItem(l10n.t('REDEX sessions open without taking over the default Chat surface.')),
		];
	}
}

abstract class RedexSurfaceItem extends vscode.TreeItem {
	constructor(label: string) {
		super(label, vscode.TreeItemCollapsibleState.None);
	}
}

class RedexActionItem extends RedexSurfaceItem {
	constructor(label: string, command: string, iconId: string, tooltip: string) {
		super(label);
		this.command = { command, title: label };
		this.iconPath = new vscode.ThemeIcon(iconId);
		this.tooltip = tooltip;
	}
}

class RedexSessionItem extends RedexSurfaceItem {
	constructor(item: vscode.ChatSessionItem) {
		super(item.label);
		this.command = { command: redexOpenSessionCommand, title: item.label, arguments: [item.resource] };
		this.iconPath = item.iconPath ?? new vscode.ThemeIcon('comment-discussion');
		this.description = item.timing?.created ? new Date(item.timing.created).toLocaleString() : l10n.t('Session');
		this.tooltip = item.label;
	}
}

class RedexInfoItem extends RedexSurfaceItem {
	constructor(label: string) {
		super(label);
		this.iconPath = new vscode.ThemeIcon('info');
		this.description = l10n.t('Dedicated entry point');
	}
}