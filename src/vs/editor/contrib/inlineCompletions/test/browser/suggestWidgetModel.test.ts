/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from 'vs/base/common/async';
import { Event } from 'vs/base/common/event';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { mock } from 'vs/base/test/common/mock';
import { runWithFakedTimers } from 'vs/base/test/common/timeTravelScheduler';
import { Range } from 'vs/editor/common/core/range';
import { CompletionItemKind, CompletionItemProvider } from 'vs/editor/common/languages';
import { IEditorWorkerService } from 'vs/editor/common/services/editorWorker';
import { ViewModel } from 'vs/editor/common/viewModel/viewModelImpl';
import { SharedInlineCompletionCache } from 'vs/editor/contrib/inlineCompletions/browser/ghostTextModel';
import { SuggestWidgetPreviewModel } from 'vs/editor/contrib/inlineCompletions/browser/suggestWidgetPreviewModel';
import { GhostTextContext } from 'vs/editor/contrib/inlineCompletions/test/browser/utils';
import { SnippetController2 } from 'vs/editor/contrib/snippet/browser/snippetController2';
import { SuggestController } from 'vs/editor/contrib/suggest/browser/suggestController';
import { ISuggestMemoryService } from 'vs/editor/contrib/suggest/browser/suggestMemory';
import { ITestCodeEditor, TestCodeEditorInstantiationOptions, withAsyncTestCodeEditor } from 'vs/editor/test/browser/testCodeEditor';
import { IMenu, IMenuService } from 'vs/platform/actions/common/actions';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { MockKeybindingService } from 'vs/platform/keybinding/test/common/mockKeybindingService';
import { ILogService, NullLogService } from 'vs/platform/log/common/log';
import { InMemoryStorageService, IStorageService } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { NullTelemetryService } from 'vs/platform/telemetry/common/telemetryUtils';
import assert = require('assert');
import { createTextModel } from 'vs/editor/test/common/testTextModel';
import { ILabelService } from 'vs/platform/label/common/label';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { minimizeInlineCompletion } from 'vs/editor/contrib/inlineCompletions/browser/inlineCompletionsModel';
import { rangeStartsWith } from 'vs/editor/contrib/inlineCompletions/browser/suggestWidgetInlineCompletionProvider';
import { LanguageFeaturesService } from 'vs/editor/common/services/languageFeaturesService';
import { ILanguageFeaturesService } from 'vs/editor/common/services/languageFeatures';

suite('Suggest Widget Model', () => {
	test('rangeStartsWith', () => {
		assert.strictEqual(rangeStartsWith(new Range(1, 1, 10, 5), new Range(1, 1, 1, 1)), true);
		assert.strictEqual(rangeStartsWith(new Range(1, 1, 10, 5), new Range(1, 1, 10, 5)), true);
		assert.strictEqual(rangeStartsWith(new Range(1, 1, 10, 5), new Range(1, 1, 10, 4)), true);
		assert.strictEqual(rangeStartsWith(new Range(1, 1, 10, 5), new Range(1, 1, 9, 6)), true);

		assert.strictEqual(rangeStartsWith(new Range(2, 1, 10, 5), new Range(1, 1, 10, 5)), false);
		assert.strictEqual(rangeStartsWith(new Range(1, 1, 10, 5), new Range(1, 1, 10, 6)), false);
		assert.strictEqual(rangeStartsWith(new Range(1, 1, 10, 5), new Range(1, 1, 11, 4)), false);
	});

	test('Active', async () => {
		await withAsyncTestCodeEditorAndInlineCompletionsModel('',
			{ fakeClock: true, provider, },
			async ({ editor, editorViewModel, context, model }) => {
				let last: boolean | undefined = undefined;
				const history = new Array<boolean>();
				model.onDidChange(() => {
					if (last !== model.isActive) {
						last = model.isActive;
						history.push(last);
					}
				});

				context.keyboardType('h');
				const suggestController = (editor.getContribution(SuggestController.ID) as SuggestController);
				suggestController.triggerSuggest();
				await timeout(1000);
				assert.deepStrictEqual(history.splice(0), [false, true]);

				context.keyboardType('.');
				await timeout(1000);

				// No flicker here
				assert.deepStrictEqual(history.splice(0), []);
				suggestController.cancelSuggestWidget();
				await timeout(1000);

				assert.deepStrictEqual(history.splice(0), [false]);
			}
		);
	});

	test('Ghost Text', async () => {
		await withAsyncTestCodeEditorAndInlineCompletionsModel('',
			{ fakeClock: true, provider, suggest: { preview: true } },
			async ({ editor, editorViewModel, context, model }) => {
				context.keyboardType('h');
				const suggestController = (editor.getContribution(SuggestController.ID) as SuggestController);
				suggestController.triggerSuggest();
				await timeout(1000);
				assert.deepStrictEqual(context.getAndClearViewStates(), ['', 'h', 'h[ello]']);

				context.keyboardType('.');
				await timeout(1000);
				assert.deepStrictEqual(context.getAndClearViewStates(), ['hello', 'hello.', 'hello.[hello]']);

				suggestController.cancelSuggestWidget();

				await timeout(1000);
				assert.deepStrictEqual(context.getAndClearViewStates(), ['hello.']);
			}
		);
	});

	test('minimizeInlineCompletion', async () => {
		const model = createTextModel('fun');
		const result = minimizeInlineCompletion(model, { range: new Range(1, 1, 1, 4), text: 'function' })!;

		assert.deepStrictEqual({
			range: result.range.toString(),
			text: result.text
		}, {
			range: '[1,4 -> 1,4]',
			text: 'ction'
		});

		model.dispose();
	});
});

const provider: CompletionItemProvider = {
	triggerCharacters: ['.'],
	async provideCompletionItems(model, pos) {
		const word = model.getWordAtPosition(pos);
		const range = word
			? { startLineNumber: 1, startColumn: word.startColumn, endLineNumber: 1, endColumn: word.endColumn }
			: Range.fromPositions(pos);

		return {
			suggestions: [{
				insertText: 'hello',
				kind: CompletionItemKind.Text,
				label: 'hello',
				range,
				commitCharacters: ['.'],
			}]
		};
	},
};

async function withAsyncTestCodeEditorAndInlineCompletionsModel(
	text: string,
	options: TestCodeEditorInstantiationOptions & { provider?: CompletionItemProvider, fakeClock?: boolean, serviceCollection?: never },
	callback: (args: { editor: ITestCodeEditor, editorViewModel: ViewModel, model: SuggestWidgetPreviewModel, context: GhostTextContext }) => Promise<void>
): Promise<void> {
	await runWithFakedTimers({ useFakeTimers: options.fakeClock }, async () => {
		const disposableStore = new DisposableStore();

		try {
			const serviceCollection = new ServiceCollection(
				[ITelemetryService, NullTelemetryService],
				[ILogService, new NullLogService()],
				[IStorageService, new InMemoryStorageService()],
				[IKeybindingService, new MockKeybindingService()],
				[IEditorWorkerService, new class extends mock<IEditorWorkerService>() {
					override computeWordRanges() {
						return Promise.resolve({});
					}
				}],
				[ISuggestMemoryService, new class extends mock<ISuggestMemoryService>() {
					override memorize(): void { }
					override select(): number { return 0; }
				}],
				[IMenuService, new class extends mock<IMenuService>() {
					override createMenu() {
						return new class extends mock<IMenu>() {
							override onDidChange = Event.None;
							override dispose() { }
						};
					}
				}],
				[ILabelService, new class extends mock<ILabelService>() { }],
				[IWorkspaceContextService, new class extends mock<IWorkspaceContextService>() { }],
			);

			if (options.provider) {
				const languageFeaturesService = new LanguageFeaturesService();
				serviceCollection.set(ILanguageFeaturesService, languageFeaturesService);
				const d = languageFeaturesService.completionProvider.register({ pattern: '**' }, options.provider);
				disposableStore.add(d);
			}

			await withAsyncTestCodeEditor(text, { ...options, serviceCollection }, async (editor, editorViewModel, instantiationService) => {
				editor.registerAndInstantiateContribution(SnippetController2.ID, SnippetController2);
				editor.registerAndInstantiateContribution(SuggestController.ID, SuggestController);
				const cache = disposableStore.add(new SharedInlineCompletionCache());
				const model = instantiationService.createInstance(SuggestWidgetPreviewModel, editor, cache);
				const context = new GhostTextContext(model, editor);
				await callback({ editor, editorViewModel, model, context });
				model.dispose();
			});
		} finally {
			disposableStore.dispose();
		}
	});
}
