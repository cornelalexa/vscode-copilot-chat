/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const currentStoragePrefix = 'reea-copilot-byok';
const legacyStoragePrefix = 'copilot-byok';

export function providerApiKeySecretKey(providerName: string): string {
	return `${currentStoragePrefix}-${providerName}-api-key`;
}

export function modelApiKeySecretKey(providerName: string, modelId: string): string {
	return `${currentStoragePrefix}-${providerName}-${modelId}-api-key`;
}

export function modelsConfigKey(providerName: string): string {
	return `${currentStoragePrefix}-${providerName}-models-config`;
}

export function migrationKey(providerName: string, version: string): string {
	return `${currentStoragePrefix}-migration-${providerName}-${version}`;
}

export function legacyProviderApiKeySecretKey(providerName: string): string {
	return `${legacyStoragePrefix}-${providerName}-api-key`;
}

export function legacyModelApiKeySecretKey(providerName: string, modelId: string): string {
	return `${legacyStoragePrefix}-${providerName}-${modelId}-api-key`;
}

export function legacyModelsConfigKey(providerName: string): string {
	return `${legacyStoragePrefix}-${providerName}-models-config`;
}
