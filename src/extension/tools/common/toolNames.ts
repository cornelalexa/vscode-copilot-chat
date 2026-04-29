/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cloneAndChange } from '../../../util/vs/base/common/objects';

/**
 * Categories for tool grouping in the virtual tools system
 */
export enum ToolCategory {
	JupyterNotebook = 'Jupyter Notebook Tools',
	WebInteraction = 'Web Interaction',
	VSCodeInteraction = 'VS Code Interaction',
	Testing = 'Testing',
	RedundantButSpecific = 'Redundant but Specific',
	// Core tools that should not be grouped
	Core = 'Core'
}

export enum ToolName {
	ApplyPatch = 'apply_patch',
	Codebase = 'semantic_search',
	VSCodeAPI = 'get_vscode_api',
	TestFailure = 'test_failure',
	FindFiles = 'file_search',
	FindTextInFiles = 'grep_search',
	ReadFile = 'read_file',
	ViewImage = 'view_image',
	ListDirectory = 'list_dir',
	GetErrors = 'get_errors',
	GetScmChanges = 'get_changed_files',
	ReadProjectStructure = 'read_project_structure',
	CreateNewWorkspace = 'create_new_workspace',
	CreateNewJupyterNotebook = 'create_new_jupyter_notebook',
	SearchWorkspaceSymbols = 'search_workspace_symbols',
	EditFile = 'insert_edit_into_file',
	CreateFile = 'create_file',
	ReplaceString = 'replace_string_in_file',
	MultiReplaceString = 'multi_replace_string_in_file',
	EditNotebook = 'edit_notebook_file',
	RunNotebookCell = 'run_notebook_cell',
	GetNotebookSummary = 'reea_copilot_getNotebookSummary',
	ReadCellOutput = 'read_notebook_cell_output',
	InstallExtension = 'install_extension',
	FetchWebPage = 'fetch_webpage',
	Memory = 'memory',
	FindTestFiles = 'test_search',
	GetProjectSetupInfo = 'get_project_setup_info',
	SearchViewResults = 'get_search_view_results',
	GithubRepo = 'github_repo',
	CreateDirectory = 'create_directory',
	RunVscodeCmd = 'run_vscode_command',
	CoreManageTodoList = 'manage_todo_list',
	CoreRunInTerminal = 'run_in_terminal',
	CoreGetTerminalOutput = 'get_terminal_output',
	CoreTerminalSelection = 'terminal_selection',
	CoreTerminalLastCommand = 'terminal_last_command',
	CoreCreateAndRunTask = 'create_and_run_task',
	CoreRunTask = 'run_task',
	CoreGetTaskOutput = 'get_task_output',
	CoreRunTest = 'runTests',
	EditFilesPlaceholder = 'edit_files',
	CoreRunSubagent = 'runSubagent',
	CoreConfirmationTool = 'vscode_get_confirmation',
	CoreConfirmationToolWithOptions = 'vscode_get_confirmation_with_options',
	CoreTerminalConfirmationTool = 'vscode_get_terminal_confirmation',
	SearchSubagent = 'reea_search_subagent',
	CoreAskQuestions = 'vscode_askQuestions',
	SwitchAgent = 'switch_agent',
	ToolSearch = 'tool_search',
	ResolveMemoryFileUri = 'resolve_memory_file_uri',
	ExecutionSubagent = 'reea_execution_subagent',
}

export enum ContributedToolName {
	ApplyPatch = 'reea_copilot_applyPatch',
	Codebase = 'reea_copilot_searchCodebase',
	SearchWorkspaceSymbols = 'reea_copilot_searchWorkspaceSymbols',
	VSCodeAPI = 'reea_copilot_getVSCodeAPI',
	TestFailure = 'reea_copilot_testFailure',
	/** @deprecated moving to core soon */
	RunTests = 'reea_copilot_runTests1',
	FindFiles = 'reea_copilot_findFiles',
	FindTextInFiles = 'reea_copilot_findTextInFiles',
	ReadFile = 'reea_copilot_readFile',
	ViewImage = 'reea_copilot_viewImage',
	ListDirectory = 'reea_copilot_listDirectory',
	GetErrors = 'reea_copilot_getErrors',
	GetScmChanges = 'reea_copilot_getChangedFiles',
	ReadProjectStructure = 'reea_copilot_readProjectStructure',
	CreateNewWorkspace = 'reea_copilot_createNewWorkspace',
	CreateNewJupyterNotebook = 'reea_copilot_createNewJupyterNotebook',
	EditFile = 'reea_copilot_insertEdit',
	CreateFile = 'reea_copilot_createFile',
	ReplaceString = 'reea_copilot_replaceString',
	MultiReplaceString = 'reea_copilot_multiReplaceString',
	EditNotebook = 'reea_copilot_editNotebook',
	RunNotebookCell = 'reea_copilot_runNotebookCell',
	GetNotebookSummary = 'reea_copilot_getNotebookSummary',
	ReadCellOutput = 'reea_copilot_readNotebookCellOutput',
	InstallExtension = 'reea_copilot_installExtension',
	FetchWebPage = 'reea_copilot_fetchWebPage',
	Memory = 'reea_copilot_memory',
	FindTestFiles = 'reea_copilot_findTestFiles',
	GetProjectSetupInfo = 'reea_copilot_getProjectSetupInfo',
	SearchViewResults = 'reea_copilot_getSearchResults',
	GithubRepo = 'reea_copilot_githubRepo',
	CreateAndRunTask = 'reea_copilot_createAndRunTask',
	CreateDirectory = 'reea_copilot_createDirectory',
	RunVscodeCmd = 'reea_copilot_runVscodeCommand',
	EditFilesPlaceholder = 'reea_copilot_editFiles',
	SwitchAgent = 'reea_copilot_switchAgent',
	ResolveMemoryFileUri = 'reea_copilot_resolveMemoryFileUri',
}

export const byokEditToolNamesToToolNames = {
	'find-replace': ToolName.ReplaceString,
	'multi-find-replace': ToolName.MultiReplaceString,
	'apply-patch': ToolName.ApplyPatch,
	'code-rewrite': ToolName.EditFile,
} as const;

const toolNameToContributedToolNames = new Map<ToolName, ContributedToolName>();
const contributedToolNameToToolNames = new Map<ContributedToolName, ToolName>();
for (const [contributedNameKey, contributedName] of Object.entries(ContributedToolName)) {
	const toolName = ToolName[contributedNameKey as keyof typeof ToolName];
	if (toolName) {
		toolNameToContributedToolNames.set(toolName, contributedName);
		contributedToolNameToToolNames.set(contributedName, toolName);
	}
}

export function getContributedToolName(name: string | ToolName): string | ContributedToolName {
	return toolNameToContributedToolNames.get(name as ToolName) ?? name;
}

export function getToolName(name: string | ContributedToolName): string | ToolName {
	return contributedToolNameToToolNames.get(name as ContributedToolName) ?? name;
}

export function mapContributedToolNamesInString(str: string): string {
	contributedToolNameToToolNames.forEach((value, key) => {
		const re = new RegExp(`\\b${key}\\b`, 'g');
		str = str.replace(re, value);
	});
	return str;
}

export function mapContributedToolNamesInSchema(inputSchema: object): object {
	return cloneAndChange(inputSchema, value => typeof value === 'string' ? mapContributedToolNamesInString(value) : undefined);
}

/**
 * Type-safe mapping of all ToolName enum values to their categories.
 * This ensures that every tool is properly categorized and provides compile-time safety.
 * When new tools are added to ToolName, they must be added here or TypeScript will error.
 */
export const toolCategories: Record<ToolName, ToolCategory> = {
	// Core tools (not grouped - expanded by default)
	[ToolName.Codebase]: ToolCategory.Core,
	[ToolName.FindTextInFiles]: ToolCategory.Core,
	[ToolName.ReadFile]: ToolCategory.Core,
	[ToolName.ViewImage]: ToolCategory.Core,
	[ToolName.CreateFile]: ToolCategory.Core,
	[ToolName.ApplyPatch]: ToolCategory.Core,
	[ToolName.ReplaceString]: ToolCategory.Core,
	[ToolName.EditFile]: ToolCategory.Core,
	[ToolName.CoreRunInTerminal]: ToolCategory.Core,
	[ToolName.ListDirectory]: ToolCategory.Core,
	[ToolName.CoreGetTerminalOutput]: ToolCategory.Core,
	[ToolName.CoreManageTodoList]: ToolCategory.Core,
	[ToolName.MultiReplaceString]: ToolCategory.Core,
	[ToolName.FindFiles]: ToolCategory.Core,
	[ToolName.CreateDirectory]: ToolCategory.Core,
	[ToolName.ReadProjectStructure]: ToolCategory.Core,
	[ToolName.CoreRunSubagent]: ToolCategory.Core,
	[ToolName.SearchSubagent]: ToolCategory.Core,
	[ToolName.ExecutionSubagent]: ToolCategory.Core,

	// already enabled only when tasks are enabled
	[ToolName.CoreRunTask]: ToolCategory.Core,
	[ToolName.CoreGetTaskOutput]: ToolCategory.Core,
	// never enabled, so it doesn't matter where it's categorized
	[ToolName.EditFilesPlaceholder]: ToolCategory.Core,


	// Jupyter Notebook Tools
	[ToolName.CreateNewJupyterNotebook]: ToolCategory.JupyterNotebook,
	[ToolName.EditNotebook]: ToolCategory.JupyterNotebook,
	[ToolName.RunNotebookCell]: ToolCategory.JupyterNotebook,
	[ToolName.GetNotebookSummary]: ToolCategory.JupyterNotebook,
	[ToolName.ReadCellOutput]: ToolCategory.JupyterNotebook,

	// Web Interaction
	[ToolName.FetchWebPage]: ToolCategory.WebInteraction,
	[ToolName.GithubRepo]: ToolCategory.WebInteraction,

	// VS Code Interaction
	[ToolName.SearchWorkspaceSymbols]: ToolCategory.VSCodeInteraction,
	[ToolName.GetErrors]: ToolCategory.VSCodeInteraction,
	[ToolName.VSCodeAPI]: ToolCategory.VSCodeInteraction,
	[ToolName.GetScmChanges]: ToolCategory.VSCodeInteraction,
	[ToolName.CreateNewWorkspace]: ToolCategory.VSCodeInteraction,
	[ToolName.InstallExtension]: ToolCategory.VSCodeInteraction,
	[ToolName.GetProjectSetupInfo]: ToolCategory.VSCodeInteraction,
	[ToolName.CoreCreateAndRunTask]: ToolCategory.VSCodeInteraction,
	[ToolName.RunVscodeCmd]: ToolCategory.VSCodeInteraction,
	[ToolName.SearchViewResults]: ToolCategory.VSCodeInteraction,
	[ToolName.CoreTerminalSelection]: ToolCategory.VSCodeInteraction,
	[ToolName.CoreTerminalLastCommand]: ToolCategory.VSCodeInteraction,

	// Testing
	[ToolName.TestFailure]: ToolCategory.Testing,
	[ToolName.FindTestFiles]: ToolCategory.Testing,
	[ToolName.CoreRunTest]: ToolCategory.Testing,

	// Other tools - categorize appropriately
	[ToolName.CoreConfirmationTool]: ToolCategory.VSCodeInteraction,
	[ToolName.CoreConfirmationToolWithOptions]: ToolCategory.VSCodeInteraction,
	[ToolName.CoreTerminalConfirmationTool]: ToolCategory.VSCodeInteraction,
	[ToolName.CoreAskQuestions]: ToolCategory.VSCodeInteraction,
	[ToolName.SwitchAgent]: ToolCategory.VSCodeInteraction,
	[ToolName.Memory]: ToolCategory.VSCodeInteraction,
	[ToolName.ToolSearch]: ToolCategory.Core,
	[ToolName.ResolveMemoryFileUri]: ToolCategory.Core,
} as const;



/**
 * Get the category for a tool, checking both ToolName enum and external tools.
 */
export function getToolCategory(toolName: string): ToolCategory | undefined {
	return toolCategories.hasOwnProperty(toolName) ? toolCategories[toolName as ToolName] : undefined;
}

/**
 * Get all tools for a specific category.
 */
export function getToolsForCategory(category: ToolCategory): string[] {
	const result: string[] = [];

	// Add tools from ToolName enum
	for (const [toolName, toolCategory] of Object.entries(toolCategories)) {
		if (toolCategory === category) {
			result.push(toolName);
		}
	}

	return result;
}
