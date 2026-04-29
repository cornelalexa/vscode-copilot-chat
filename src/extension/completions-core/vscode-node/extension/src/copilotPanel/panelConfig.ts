/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as constants from '../constants';
import { CopilotPanelVisible } from '../constants';
import { PanelConfig } from '../panelShared/basePanelTypes';

// Configuration for the Reea Copilot Suggestions Panel
export const copilotPanelConfig: PanelConfig = {
	panelTitle: 'Reea Copilot Suggestions',
	webviewId: 'Reea Copilot Suggestions',
	webviewScriptName: 'suggestionsPanelWebview.js',
	contextVariable: CopilotPanelVisible,
	commands: {
		accept: constants.CMDAcceptCursorPanelSolutionClient,
		navigatePrevious: constants.CMDNavigatePreviousPanelSolutionClient,
		navigateNext: constants.CMDNavigateNextPanelSolutionClient,
	},
	renderingMode: 'streaming',
	shuffleSolutions: false,
};
