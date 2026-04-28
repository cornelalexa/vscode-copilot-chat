/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { URI } from '../../../util/vs/base/common/uri';
import { FileChunk } from '../../chunking/common/chunk';

export const ILocalCodeSearchService = createServiceIdentifier<ILocalCodeSearchService>('ILocalCodeSearchService');

export interface LocalCodeSearchOptions {
	readonly maxResults?: number;
	readonly scopedDirectories?: readonly URI[];
}

export interface ILocalCodeSearchService {
	readonly _serviceBrand: undefined;
	search(query: string, options?: LocalCodeSearchOptions): Promise<readonly FileChunk[]>;
}
