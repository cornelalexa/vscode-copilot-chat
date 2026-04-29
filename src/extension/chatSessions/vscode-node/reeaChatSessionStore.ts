/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

function getInternalSessionId(item: vscode.ChatSessionItem): string | undefined {
	const metadata = item.metadata as { internalSessionId?: string } | undefined;
	return typeof metadata?.internalSessionId === 'string' ? metadata.internalSessionId : undefined;
}

class ReeaChatSessionStore {
	private readonly _items = new Map<string, vscode.ChatSessionItem>();
	private readonly _onDidChangeItems = new vscode.EventEmitter<void>();

	readonly onDidChangeItems = this._onDidChangeItems.event;

	get(resource: vscode.Uri | string): vscode.ChatSessionItem | undefined {
		const key = typeof resource === 'string' ? resource : resource.toString();
		return this._items.get(key);
	}

	values(): vscode.ChatSessionItem[] {
		return Array.from(this._items.values());
	}

	set(item: vscode.ChatSessionItem): void {
		this._setItem(item);
		this._onDidChangeItems.fire();
	}

	replace(items: readonly vscode.ChatSessionItem[]): void {
		this._items.clear();
		for (const item of items) {
			this._setItem(item);
		}
		this._onDidChangeItems.fire();
	}

	private _setItem(item: vscode.ChatSessionItem): void {
		const internalSessionId = getInternalSessionId(item);
		if (internalSessionId) {
			for (const [key, existingItem] of this._items) {
				if (key !== item.resource.toString() && getInternalSessionId(existingItem) === internalSessionId) {
					this._items.delete(key);
				}
			}
		}

		this._items.set(item.resource.toString(), item);
	}
}

export const reeaChatSessionStore = new ReeaChatSessionStore();