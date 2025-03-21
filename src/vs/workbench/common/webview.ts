/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CharCode } from 'vs/base/common/charCode';
import { Schemas } from 'vs/base/common/network';
import { URI } from 'vs/base/common/uri';

export interface WebviewInitData {
	readonly remote: {
		readonly isRemote: boolean;
		readonly authority: string | undefined
	};
}

/**
 * Root from which resources in webviews are loaded.
 *
 * This is hardcoded because we never expect to actually hit it. Instead these requests
 * should always go to a service worker.
 */
export const webviewResourceBaseHost = 'vscode-webview.net';

export const webviewRootResourceAuthority = `vscode-resource.${webviewResourceBaseHost}`;

export const webviewGenericCspSource = `https://*.${webviewResourceBaseHost}`;

/**
 * Construct a uri that can load resources inside a webview
 *
 * We encode the resource component of the uri so that on the main thread
 * we know where to load the resource from (remote or truly local):
 *
 * ```txt
 * ${scheme}+${resource-authority}.vscode-resource.vscode-webview.net/${path}
 * ```
 *
 * @param resource Uri of the resource to load.
 * @param remoteInfo Optional information about the remote that specifies where `resource` should be resolved from.
 */
export function asWebviewUri(
	resource: URI,
	remoteInfo?: { authority: string | undefined, isRemote: boolean }
): URI {
	if (resource.scheme === Schemas.http || resource.scheme === Schemas.https) {
		return resource;
	}

	if (remoteInfo && remoteInfo.authority && remoteInfo.isRemote && resource.scheme === Schemas.file) {
		resource = URI.from({
			scheme: Schemas.vscodeRemote,
			authority: remoteInfo.authority,
			path: resource.path,
		});
	}

	return URI.from({
		scheme: Schemas.https,
		authority: `${resource.scheme}+${encodeAuthority(resource.authority)}.${webviewRootResourceAuthority}`,
		path: resource.path,
		fragment: resource.fragment,
		query: resource.query,
	});
}

function encodeAuthority(authority: string): string {
	return authority.replace(/./g, char => {
		const code = char.charCodeAt(0);
		if (
			(code >= CharCode.a && code <= CharCode.z)
			|| (code >= CharCode.A && code <= CharCode.Z)
			|| (code >= CharCode.Digit0 && code <= CharCode.Digit9)
		) {
			return char;
		}
		return '-' + code.toString(16).padStart(4, '0');
	});
}

export function decodeAuthority(authority: string) {
	return authority.replace(/-([0-9a-f]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}
