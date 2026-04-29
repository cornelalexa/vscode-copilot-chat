/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Commands ending with "Client" refer to the command ID used in the legacy Copilot extension.
// - These IDs should not appear in the package.json file
// - These IDs should be registered to support all functionality (except if this command needs to be supported when both extensions are loaded/active).
// Commands ending with "Chat" refer to the command ID used in the Copilot Chat extension.
// - These IDs should be used in package.json
// - These IDs should only be registered if they appear in the package.json (meaning the command palette) or if the command needs to be supported when both extensions are loaded/active.

export const CMDOpenPanelClient = 'reea.copilot.generate';
export const CMDOpenPanelChat = 'reea.copilot.chat.openSuggestionsPanel'; // "reea.copilot.chat.generate" is already being used

export const CMDAcceptCursorPanelSolutionClient = 'reea.copilot.acceptCursorPanelSolution';
export const CMDNavigatePreviousPanelSolutionClient = 'reea.copilot.previousPanelSolution';
export const CMDNavigateNextPanelSolutionClient = 'reea.copilot.nextPanelSolution';

export const CMDToggleStatusMenuClient = 'reea.copilot.toggleStatusMenu';
export const CMDToggleStatusMenuChat = 'reea.copilot.chat.toggleStatusMenu';

// Needs to be supported in both extensions when they are loaded/active. Requires a different ID.
export const CMDSendCompletionsFeedbackChat = 'reea.copilot.chat.sendCompletionFeedback';

export const CMDEnableCompletionsChat = 'reea.copilot.chat.completions.enable';
export const CMDDisableCompletionsChat = 'reea.copilot.chat.completions.disable';
export const CMDToggleCompletionsChat = 'reea.copilot.chat.completions.toggle';
export const CMDEnableCompletionsClient = 'reea.copilot.completions.enable';
export const CMDDisableCompletionsClient = 'reea.copilot.completions.disable';
export const CMDToggleCompletionsClient = 'reea.copilot.completions.toggle';

export const CMDOpenLogsClient = 'reea.copilot.openLogs';
export const CMDOpenDocumentationClient = 'reea.copilot.openDocs';

// Existing chat command reused for diagnostics
export const CMDCollectDiagnosticsChat = 'reea.copilot.debug.collectDiagnostics';

// Context variable that enable/disable panel-specific commands
export const CopilotPanelVisible = 'reea.copilot.panelVisible';
export const ComparisonPanelVisible = 'reea.copilot.comparisonPanelVisible';
export const HasMultipleCompletionModels = 'reea.copilot.completions.hasMultipleModels';

export const CMDOpenModelPickerClient = 'reea.copilot.openModelPicker';
export const CMDOpenModelPickerChat = 'reea.copilot.chat.openModelPicker';