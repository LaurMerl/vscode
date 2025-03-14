/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancelablePromise, createCancelablePromise, Delayer, RunOnceScheduler } from 'vs/base/common/async';
import { CancellationToken } from 'vs/base/common/cancellation';
import { onUnexpectedError } from 'vs/base/common/errors';
import { KeyChord, KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { escapeRegExpCharacters } from 'vs/base/common/strings';
import * as types from 'vs/base/common/types';
import 'vs/css!./folding';
import { StableEditorScrollState } from 'vs/editor/browser/stableEditorScroll';
import { ICodeEditor, IEditorMouseEvent, MouseTargetType } from 'vs/editor/browser/editorBrowser';
import { EditorAction, registerEditorAction, registerEditorContribution, registerInstantiatedEditorAction, ServicesAccessor } from 'vs/editor/browser/editorExtensions';
import { ConfigurationChangedEvent, EditorOption } from 'vs/editor/common/config/editorOptions';
import { IPosition } from 'vs/editor/common/core/position';
import { IRange } from 'vs/editor/common/core/range';
import { IEditorContribution, ScrollType } from 'vs/editor/common/editorCommon';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { ITextModel } from 'vs/editor/common/model';
import { IModelContentChangedEvent } from 'vs/editor/common/textModelEvents';
import { FoldingRangeKind } from 'vs/editor/common/languages';
import { ILanguageConfigurationService } from 'vs/editor/common/languages/languageConfigurationRegistry';
import { CollapseMemento, FoldingModel, getNextFoldLine, getParentFoldLine as getParentFoldLine, getPreviousFoldLine, setCollapseStateAtLevel, setCollapseStateForMatchingLines, setCollapseStateForRest, setCollapseStateForType, setCollapseStateLevelsDown, setCollapseStateLevelsUp, setCollapseStateUp, toggleCollapseState } from 'vs/editor/contrib/folding/browser/foldingModel';
import { HiddenRangeModel } from 'vs/editor/contrib/folding/browser/hiddenRangeModel';
import { IndentRangeProvider } from 'vs/editor/contrib/folding/browser/indentRangeProvider';
import { ID_INIT_PROVIDER, InitializingRangeProvider } from 'vs/editor/contrib/folding/browser/intializingRangeProvider';
import * as nls from 'vs/nls';
import { IContextKey, IContextKeyService, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { editorSelectionBackground, iconForeground, registerColor, transparent } from 'vs/platform/theme/common/colorRegistry';
import { registerThemingParticipant, ThemeIcon } from 'vs/platform/theme/common/themeService';
import { foldingCollapsedIcon, FoldingDecorationProvider, foldingExpandedIcon } from './foldingDecorations';
import { FoldingRegion, FoldingRegions } from './foldingRanges';
import { ID_SYNTAX_PROVIDER, SyntaxRangeProvider } from './syntaxRangeProvider';
import { INotificationService } from 'vs/platform/notification/common/notification';
import Severity from 'vs/base/common/severity';
import { IFeatureDebounceInformation, ILanguageFeatureDebounceService } from 'vs/editor/common/services/languageFeatureDebounce';
import { StopWatch } from 'vs/base/common/stopwatch';
import { ILanguageFeaturesService } from 'vs/editor/common/services/languageFeatures';


const CONTEXT_FOLDING_ENABLED = new RawContextKey<boolean>('foldingEnabled', false);

export interface RangeProvider {
	readonly id: string;
	compute(cancelationToken: CancellationToken, notifyTooMany: (max: number) => void): Promise<FoldingRegions | null>;
	dispose(): void;
}

interface FoldingStateMemento {
	collapsedRegions?: CollapseMemento;
	lineCount?: number;
	provider?: string;
	foldedImports?: boolean
}

export class FoldingController extends Disposable implements IEditorContribution {

	public static readonly ID = 'editor.contrib.folding';

	public static get(editor: ICodeEditor): FoldingController | null {
		return editor.getContribution<FoldingController>(FoldingController.ID);
	}

	private readonly editor: ICodeEditor;
	private _isEnabled: boolean;
	private _useFoldingProviders: boolean;
	private _unfoldOnClickAfterEndOfLine: boolean;
	private _restoringViewState: boolean;
	private _foldingImportsByDefault: boolean;
	private _currentModelHasFoldedImports: boolean;
	private _maxFoldingRegions: number;
	private _notifyTooManyRegions: (m: number) => void;
	private _tooManyRegionsNotified = false;

	private readonly foldingDecorationProvider: FoldingDecorationProvider;

	private foldingModel: FoldingModel | null;
	private hiddenRangeModel: HiddenRangeModel | null;

	private rangeProvider: RangeProvider | null;
	private foldingRegionPromise: CancelablePromise<FoldingRegions | null> | null;

	private foldingStateMemento: FoldingStateMemento | null;

	private foldingModelPromise: Promise<FoldingModel | null> | null;
	private updateScheduler: Delayer<FoldingModel | null> | null;
	private readonly updateDebounceInfo: IFeatureDebounceInformation;

	private foldingEnabled: IContextKey<boolean>;
	private cursorChangedScheduler: RunOnceScheduler | null;

	private readonly localToDispose = this._register(new DisposableStore());
	private mouseDownInfo: { lineNumber: number, iconClicked: boolean } | null;

	constructor(
		editor: ICodeEditor,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ILanguageConfigurationService private readonly languageConfigurationService: ILanguageConfigurationService,
		@INotificationService notificationService: INotificationService,
		@ILanguageFeatureDebounceService languageFeatureDebounceService: ILanguageFeatureDebounceService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
	) {
		super();
		this.editor = editor;
		const options = this.editor.getOptions();
		this._isEnabled = options.get(EditorOption.folding);
		this._useFoldingProviders = options.get(EditorOption.foldingStrategy) !== 'indentation';
		this._unfoldOnClickAfterEndOfLine = options.get(EditorOption.unfoldOnClickAfterEndOfLine);
		this._restoringViewState = false;
		this._currentModelHasFoldedImports = false;
		this._foldingImportsByDefault = options.get(EditorOption.foldingImportsByDefault);
		this._maxFoldingRegions = options.get(EditorOption.foldingMaximumRegions);
		this.updateDebounceInfo = languageFeatureDebounceService.for(languageFeaturesService.foldingRangeProvider, 'Folding', { min: 200 });

		this.foldingModel = null;
		this.hiddenRangeModel = null;
		this.rangeProvider = null;
		this.foldingRegionPromise = null;
		this.foldingStateMemento = null;
		this.foldingModelPromise = null;
		this.updateScheduler = null;
		this.cursorChangedScheduler = null;
		this.mouseDownInfo = null;

		this.foldingDecorationProvider = new FoldingDecorationProvider(editor);
		this.foldingDecorationProvider.autoHideFoldingControls = options.get(EditorOption.showFoldingControls) === 'mouseover';
		this.foldingDecorationProvider.showFoldingHighlights = options.get(EditorOption.foldingHighlight);
		this.foldingEnabled = CONTEXT_FOLDING_ENABLED.bindTo(this.contextKeyService);
		this.foldingEnabled.set(this._isEnabled);

		this._notifyTooManyRegions = (maxFoldingRegions: number) => {
			// Message will display once per time vscode runs. Once per file would be tricky.
			if (!this._tooManyRegionsNotified) {
				notificationService.notify({
					severity: Severity.Warning,
					sticky: true,
					message: nls.localize('maximum fold ranges', "The number of foldable regions is limited to a maximum of {0}. Increase configuration option ['Folding Maximum Regions'](command:workbench.action.openSettings?[\"editor.foldingMaximumRegions\"]) to enable more.", maxFoldingRegions)
				});
				this._tooManyRegionsNotified = true;
			}
		};

		this._register(this.editor.onDidChangeModel(() => this.onModelChanged()));

		this._register(this.editor.onDidChangeConfiguration((e: ConfigurationChangedEvent) => {
			if (e.hasChanged(EditorOption.folding)) {
				this._isEnabled = this.editor.getOptions().get(EditorOption.folding);
				this.foldingEnabled.set(this._isEnabled);
				this.onModelChanged();
			}
			if (e.hasChanged(EditorOption.foldingMaximumRegions)) {
				this._maxFoldingRegions = this.editor.getOptions().get(EditorOption.foldingMaximumRegions);
				this._tooManyRegionsNotified = false;
				this.onModelChanged();
			}
			if (e.hasChanged(EditorOption.showFoldingControls) || e.hasChanged(EditorOption.foldingHighlight)) {
				const options = this.editor.getOptions();
				this.foldingDecorationProvider.autoHideFoldingControls = options.get(EditorOption.showFoldingControls) === 'mouseover';
				this.foldingDecorationProvider.showFoldingHighlights = options.get(EditorOption.foldingHighlight);
				this.triggerFoldingModelChanged();
			}
			if (e.hasChanged(EditorOption.foldingStrategy)) {
				this._useFoldingProviders = this.editor.getOptions().get(EditorOption.foldingStrategy) !== 'indentation';
				this.onFoldingStrategyChanged();
			}
			if (e.hasChanged(EditorOption.unfoldOnClickAfterEndOfLine)) {
				this._unfoldOnClickAfterEndOfLine = this.editor.getOptions().get(EditorOption.unfoldOnClickAfterEndOfLine);
			}
			if (e.hasChanged(EditorOption.foldingImportsByDefault)) {
				this._foldingImportsByDefault = this.editor.getOptions().get(EditorOption.foldingImportsByDefault);
			}
		}));
		this.onModelChanged();
	}

	/**
	 * Store view state.
	 */
	public saveViewState(): FoldingStateMemento | undefined {
		let model = this.editor.getModel();
		if (!model || !this._isEnabled || model.isTooLargeForTokenization()) {
			return {};
		}
		if (this.foldingModel) { // disposed ?
			let collapsedRegions = this.foldingModel.isInitialized ? this.foldingModel.getMemento() : this.hiddenRangeModel!.getMemento();
			let provider = this.rangeProvider ? this.rangeProvider.id : undefined;
			return { collapsedRegions, lineCount: model.getLineCount(), provider, foldedImports: this._currentModelHasFoldedImports };
		}
		return undefined;
	}

	/**
	 * Restore view state.
	 */
	public restoreViewState(state: FoldingStateMemento): void {
		let model = this.editor.getModel();
		if (!model || !this._isEnabled || model.isTooLargeForTokenization() || !this.hiddenRangeModel) {
			return;
		}
		if (!state || state.lineCount !== model.getLineCount()) {
			return;
		}

		this._currentModelHasFoldedImports = !!state.foldedImports;
		if (!state.collapsedRegions) {
			return;
		}

		if (state.provider === ID_SYNTAX_PROVIDER || state.provider === ID_INIT_PROVIDER) {
			this.foldingStateMemento = state;
		}

		const collapsedRegions = state.collapsedRegions;
		// set the hidden ranges right away, before waiting for the folding model.
		if (this.hiddenRangeModel.applyMemento(collapsedRegions)) {
			const foldingModel = this.getFoldingModel();
			if (foldingModel) {
				foldingModel.then(foldingModel => {
					if (foldingModel) {
						this._restoringViewState = true;
						try {
							foldingModel.applyMemento(collapsedRegions);
						} finally {
							this._restoringViewState = false;
						}
					}
				}).then(undefined, onUnexpectedError);
			}
		}
	}

	private onModelChanged(): void {
		this.localToDispose.clear();

		let model = this.editor.getModel();
		if (!this._isEnabled || !model || model.isTooLargeForTokenization()) {
			// huge files get no view model, so they cannot support hidden areas
			return;
		}

		this._currentModelHasFoldedImports = false;
		this.foldingModel = new FoldingModel(model, this.foldingDecorationProvider);
		this.localToDispose.add(this.foldingModel);

		this.hiddenRangeModel = new HiddenRangeModel(this.foldingModel);
		this.localToDispose.add(this.hiddenRangeModel);
		this.localToDispose.add(this.hiddenRangeModel.onDidChange(hr => this.onHiddenRangesChanges(hr)));

		this.updateScheduler = new Delayer<FoldingModel>(this.updateDebounceInfo.get(model));

		this.cursorChangedScheduler = new RunOnceScheduler(() => this.revealCursor(), 200);
		this.localToDispose.add(this.cursorChangedScheduler);
		this.localToDispose.add(this.languageFeaturesService.foldingRangeProvider.onDidChange(() => this.onFoldingStrategyChanged()));
		this.localToDispose.add(this.editor.onDidChangeModelLanguageConfiguration(() => this.onFoldingStrategyChanged())); // covers model language changes as well
		this.localToDispose.add(this.editor.onDidChangeModelContent(e => this.onDidChangeModelContent(e)));
		this.localToDispose.add(this.editor.onDidChangeCursorPosition(() => this.onCursorPositionChanged()));
		this.localToDispose.add(this.editor.onMouseDown(e => this.onEditorMouseDown(e)));
		this.localToDispose.add(this.editor.onMouseUp(e => this.onEditorMouseUp(e)));
		this.localToDispose.add({
			dispose: () => {
				if (this.foldingRegionPromise) {
					this.foldingRegionPromise.cancel();
					this.foldingRegionPromise = null;
				}
				if (this.updateScheduler) {
					this.updateScheduler.cancel();
				}
				this.updateScheduler = null;
				this.foldingModel = null;
				this.foldingModelPromise = null;
				this.hiddenRangeModel = null;
				this.cursorChangedScheduler = null;
				this.foldingStateMemento = null;
				if (this.rangeProvider) {
					this.rangeProvider.dispose();
				}
				this.rangeProvider = null;
			}
		});
		this.triggerFoldingModelChanged();
	}

	private onFoldingStrategyChanged() {
		if (this.rangeProvider) {
			this.rangeProvider.dispose();
		}
		this.rangeProvider = null;
		this.triggerFoldingModelChanged();
	}

	private getRangeProvider(editorModel: ITextModel): RangeProvider {
		if (this.rangeProvider) {
			return this.rangeProvider;
		}
		this.rangeProvider = new IndentRangeProvider(editorModel, this.languageConfigurationService, this._maxFoldingRegions); // fallback

		if (this._useFoldingProviders && this.foldingModel) {
			let foldingProviders = this.languageFeaturesService.foldingRangeProvider.ordered(this.foldingModel.textModel);
			if (foldingProviders.length === 0 && this.foldingStateMemento && this.foldingStateMemento.collapsedRegions) {
				const rangeProvider = this.rangeProvider = new InitializingRangeProvider(editorModel, this.foldingStateMemento.collapsedRegions, () => {
					// if after 30 the InitializingRangeProvider is still not replaced, force a refresh
					this.foldingStateMemento = null;
					this.onFoldingStrategyChanged();
				}, 30000);
				return rangeProvider; // keep memento in case there are still no foldingProviders on the next request.
			} else if (foldingProviders.length > 0) {
				this.rangeProvider = new SyntaxRangeProvider(editorModel, foldingProviders, () => this.triggerFoldingModelChanged(), this._maxFoldingRegions);
			}
		}
		this.foldingStateMemento = null;
		return this.rangeProvider;
	}

	public getFoldingModel() {
		return this.foldingModelPromise;
	}

	private onDidChangeModelContent(e: IModelContentChangedEvent) {
		this.hiddenRangeModel?.notifyChangeModelContent(e);
		this.triggerFoldingModelChanged();
	}

	private triggerFoldingModelChanged() {
		if (this.updateScheduler) {
			if (this.foldingRegionPromise) {
				this.foldingRegionPromise.cancel();
				this.foldingRegionPromise = null;
			}
			this.foldingModelPromise = this.updateScheduler.trigger(() => {
				const foldingModel = this.foldingModel;
				if (!foldingModel) { // null if editor has been disposed, or folding turned off
					return null;
				}
				const sw = new StopWatch(true);
				const provider = this.getRangeProvider(foldingModel.textModel);
				let foldingRegionPromise = this.foldingRegionPromise = createCancelablePromise(token => provider.compute(token, this._notifyTooManyRegions));
				return foldingRegionPromise.then(foldingRanges => {
					if (foldingRanges && foldingRegionPromise === this.foldingRegionPromise) { // new request or cancelled in the meantime?
						let scrollState: StableEditorScrollState | undefined;

						if (this._foldingImportsByDefault && !this._currentModelHasFoldedImports) {
							const hasChanges = foldingRanges.setCollapsedAllOfType(FoldingRangeKind.Imports.value, true);
							if (hasChanges) {
								scrollState = StableEditorScrollState.capture(this.editor);
								this._currentModelHasFoldedImports = hasChanges;
							}
						}

						// some cursors might have moved into hidden regions, make sure they are in expanded regions
						let selections = this.editor.getSelections();
						let selectionLineNumbers = selections ? selections.map(s => s.startLineNumber) : [];
						foldingModel.update(foldingRanges, selectionLineNumbers);

						if (scrollState) {
							scrollState.restore(this.editor);
						}

						// update debounce info
						const newValue = this.updateDebounceInfo.update(foldingModel.textModel, sw.elapsed());
						if (this.updateScheduler) {
							this.updateScheduler.defaultDelay = newValue;
						}
					}
					return foldingModel;
				});
			}).then(undefined, (err) => {
				onUnexpectedError(err);
				return null;
			});
		}
	}

	private onHiddenRangesChanges(hiddenRanges: IRange[]) {
		if (this.hiddenRangeModel && hiddenRanges.length && !this._restoringViewState) {
			let selections = this.editor.getSelections();
			if (selections) {
				if (this.hiddenRangeModel.adjustSelections(selections)) {
					this.editor.setSelections(selections);
				}
			}
		}
		this.editor.setHiddenAreas(hiddenRanges);
	}

	private onCursorPositionChanged() {
		if (this.hiddenRangeModel && this.hiddenRangeModel.hasRanges()) {
			this.cursorChangedScheduler!.schedule();
		}
	}

	private revealCursor() {
		const foldingModel = this.getFoldingModel();
		if (!foldingModel) {
			return;
		}
		foldingModel.then(foldingModel => { // null is returned if folding got disabled in the meantime
			if (foldingModel) {
				let selections = this.editor.getSelections();
				if (selections && selections.length > 0) {
					let toToggle: FoldingRegion[] = [];
					for (let selection of selections) {
						let lineNumber = selection.selectionStartLineNumber;
						if (this.hiddenRangeModel && this.hiddenRangeModel.isHidden(lineNumber)) {
							toToggle.push(...foldingModel.getAllRegionsAtLine(lineNumber, r => r.isCollapsed && lineNumber > r.startLineNumber));
						}
					}
					if (toToggle.length) {
						foldingModel.toggleCollapseState(toToggle);
						this.reveal(selections[0].getPosition());
					}
				}
			}
		}).then(undefined, onUnexpectedError);

	}

	private onEditorMouseDown(e: IEditorMouseEvent): void {
		this.mouseDownInfo = null;


		if (!this.hiddenRangeModel || !e.target || !e.target.range) {
			return;
		}
		if (!e.event.leftButton && !e.event.middleButton) {
			return;
		}
		const range = e.target.range;
		let iconClicked = false;
		switch (e.target.type) {
			case MouseTargetType.GUTTER_LINE_DECORATIONS: {
				const data = e.target.detail;
				const offsetLeftInGutter = (e.target.element as HTMLElement).offsetLeft;
				const gutterOffsetX = data.offsetX - offsetLeftInGutter;

				// const gutterOffsetX = data.offsetX - data.glyphMarginWidth - data.lineNumbersWidth - data.glyphMarginLeft;

				// TODO@joao TODO@alex TODO@martin this is such that we don't collide with dirty diff
				if (gutterOffsetX < 5) { // the whitespace between the border and the real folding icon border is 5px
					return;
				}

				iconClicked = true;
				break;
			}
			case MouseTargetType.CONTENT_EMPTY: {
				if (this._unfoldOnClickAfterEndOfLine && this.hiddenRangeModel.hasRanges()) {
					const data = e.target.detail;
					if (!data.isAfterLines) {
						break;
					}
				}
				return;
			}
			case MouseTargetType.CONTENT_TEXT: {
				if (this.hiddenRangeModel.hasRanges()) {
					let model = this.editor.getModel();
					if (model && range.startColumn === model.getLineMaxColumn(range.startLineNumber)) {
						break;
					}
				}
				return;
			}
			default:
				return;
		}

		this.mouseDownInfo = { lineNumber: range.startLineNumber, iconClicked };
	}

	private onEditorMouseUp(e: IEditorMouseEvent): void {
		const foldingModel = this.getFoldingModel();
		if (!foldingModel || !this.mouseDownInfo || !e.target) {
			return;
		}
		let lineNumber = this.mouseDownInfo.lineNumber;
		let iconClicked = this.mouseDownInfo.iconClicked;

		let range = e.target.range;
		if (!range || range.startLineNumber !== lineNumber) {
			return;
		}

		if (iconClicked) {
			if (e.target.type !== MouseTargetType.GUTTER_LINE_DECORATIONS) {
				return;
			}
		} else {
			let model = this.editor.getModel();
			if (!model || range.startColumn !== model.getLineMaxColumn(lineNumber)) {
				return;
			}
		}

		foldingModel.then(foldingModel => {
			if (foldingModel) {
				let region = foldingModel.getRegionAtLine(lineNumber);
				if (region && region.startLineNumber === lineNumber) {
					let isCollapsed = region.isCollapsed;
					if (iconClicked || isCollapsed) {
						let surrounding = e.event.altKey;
						let toToggle = [];
						if (surrounding) {
							let filter = (otherRegion: FoldingRegion) => !otherRegion.containedBy(region!) && !region!.containedBy(otherRegion);
							let toMaybeToggle = foldingModel.getRegionsInside(null, filter);
							for (const r of toMaybeToggle) {
								if (r.isCollapsed) {
									toToggle.push(r);
								}
							}
							// if any surrounding regions are folded, unfold those. Otherwise, fold all surrounding
							if (toToggle.length === 0) {
								toToggle = toMaybeToggle;
							}
						}
						else {
							let recursive = e.event.middleButton || e.event.shiftKey;
							if (recursive) {
								for (const r of foldingModel.getRegionsInside(region)) {
									if (r.isCollapsed === isCollapsed) {
										toToggle.push(r);
									}
								}
							}
							// when recursive, first only collapse all children. If all are already folded or there are no children, also fold parent.
							if (isCollapsed || !recursive || toToggle.length === 0) {
								toToggle.push(region);
							}
						}
						foldingModel.toggleCollapseState(toToggle);
						this.reveal({ lineNumber, column: 1 });
					}
				}
			}
		}).then(undefined, onUnexpectedError);
	}

	public reveal(position: IPosition): void {
		this.editor.revealPositionInCenterIfOutsideViewport(position, ScrollType.Smooth);
	}
}

abstract class FoldingAction<T> extends EditorAction {

	abstract invoke(foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor, args: T, languageConfigurationService: ILanguageConfigurationService): void;

	public override runEditorCommand(accessor: ServicesAccessor, editor: ICodeEditor, args: T): void | Promise<void> {
		const languageConfigurationService = accessor.get(ILanguageConfigurationService);
		const foldingController = FoldingController.get(editor);
		if (!foldingController) {
			return;
		}
		const foldingModelPromise = foldingController.getFoldingModel();
		if (foldingModelPromise) {
			this.reportTelemetry(accessor, editor);
			return foldingModelPromise.then(foldingModel => {
				if (foldingModel) {
					this.invoke(foldingController, foldingModel, editor, args, languageConfigurationService);
					const selection = editor.getSelection();
					if (selection) {
						foldingController.reveal(selection.getStartPosition());
					}
				}
			});
		}
	}

	protected getSelectedLines(editor: ICodeEditor) {
		let selections = editor.getSelections();
		return selections ? selections.map(s => s.startLineNumber) : [];
	}

	protected getLineNumbers(args: FoldingArguments, editor: ICodeEditor) {
		if (args && args.selectionLines) {
			return args.selectionLines.map(l => l + 1); // to 0-bases line numbers
		}
		return this.getSelectedLines(editor);
	}

	public run(_accessor: ServicesAccessor, _editor: ICodeEditor): void {
	}
}

interface FoldingArguments {
	levels?: number;
	direction?: 'up' | 'down';
	selectionLines?: number[];
}

function foldingArgumentsConstraint(args: any) {
	if (!types.isUndefined(args)) {
		if (!types.isObject(args)) {
			return false;
		}
		const foldingArgs: FoldingArguments = args;
		if (!types.isUndefined(foldingArgs.levels) && !types.isNumber(foldingArgs.levels)) {
			return false;
		}
		if (!types.isUndefined(foldingArgs.direction) && !types.isString(foldingArgs.direction)) {
			return false;
		}
		if (!types.isUndefined(foldingArgs.selectionLines) && (!types.isArray(foldingArgs.selectionLines) || !foldingArgs.selectionLines.every(types.isNumber))) {
			return false;
		}
	}
	return true;
}

class UnfoldAction extends FoldingAction<FoldingArguments> {

	constructor() {
		super({
			id: 'editor.unfold',
			label: nls.localize('unfoldAction.label', "Unfold"),
			alias: 'Unfold',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.BracketRight,
				mac: {
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.BracketRight
				},
				weight: KeybindingWeight.EditorContrib
			},
			description: {
				description: 'Unfold the content in the editor',
				args: [
					{
						name: 'Unfold editor argument',
						description: `Property-value pairs that can be passed through this argument:
						* 'levels': Number of levels to unfold. If not set, defaults to 1.
						* 'direction': If 'up', unfold given number of levels up otherwise unfolds down.
						* 'selectionLines': The start lines (0-based) of the editor selections to apply the unfold action to. If not set, the active selection(s) will be used.
						`,
						constraint: foldingArgumentsConstraint,
						schema: {
							'type': 'object',
							'properties': {
								'levels': {
									'type': 'number',
									'default': 1
								},
								'direction': {
									'type': 'string',
									'enum': ['up', 'down'],
									'default': 'down'
								},
								'selectionLines': {
									'type': 'array',
									'items': {
										'type': 'number'
									}
								}
							}
						}
					}
				]
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor, args: FoldingArguments): void {
		let levels = args && args.levels || 1;
		let lineNumbers = this.getLineNumbers(args, editor);
		if (args && args.direction === 'up') {
			setCollapseStateLevelsUp(foldingModel, false, levels, lineNumbers);
		} else {
			setCollapseStateLevelsDown(foldingModel, false, levels, lineNumbers);
		}
	}
}

class UnFoldRecursivelyAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.unfoldRecursively',
			label: nls.localize('unFoldRecursivelyAction.label', "Unfold Recursively"),
			alias: 'Unfold Recursively',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.BracketRight),
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor, _args: any): void {
		setCollapseStateLevelsDown(foldingModel, false, Number.MAX_VALUE, this.getSelectedLines(editor));
	}
}

class FoldAction extends FoldingAction<FoldingArguments> {

	constructor() {
		super({
			id: 'editor.fold',
			label: nls.localize('foldAction.label', "Fold"),
			alias: 'Fold',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.BracketLeft,
				mac: {
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.BracketLeft
				},
				weight: KeybindingWeight.EditorContrib
			},
			description: {
				description: 'Fold the content in the editor',
				args: [
					{
						name: 'Fold editor argument',
						description: `Property-value pairs that can be passed through this argument:
							* 'levels': Number of levels to fold.
							* 'direction': If 'up', folds given number of levels up otherwise folds down.
							* 'selectionLines': The start lines (0-based) of the editor selections to apply the fold action to. If not set, the active selection(s) will be used.
							If no levels or direction is set, folds the region at the locations or if already collapsed, the first uncollapsed parent instead.
						`,
						constraint: foldingArgumentsConstraint,
						schema: {
							'type': 'object',
							'properties': {
								'levels': {
									'type': 'number',
								},
								'direction': {
									'type': 'string',
									'enum': ['up', 'down'],
								},
								'selectionLines': {
									'type': 'array',
									'items': {
										'type': 'number'
									}
								}
							}
						}
					}
				]
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor, args: FoldingArguments): void {
		let lineNumbers = this.getLineNumbers(args, editor);

		const levels = args && args.levels;
		const direction = args && args.direction;

		if (typeof levels !== 'number' && typeof direction !== 'string') {
			// fold the region at the location or if already collapsed, the first uncollapsed parent instead.
			setCollapseStateUp(foldingModel, true, lineNumbers);
		} else {
			if (direction === 'up') {
				setCollapseStateLevelsUp(foldingModel, true, levels || 1, lineNumbers);
			} else {
				setCollapseStateLevelsDown(foldingModel, true, levels || 1, lineNumbers);
			}
		}
	}
}


class ToggleFoldAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.toggleFold',
			label: nls.localize('toggleFoldAction.label', "Toggle Fold"),
			alias: 'Toggle Fold',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyL),
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor): void {
		let selectedLines = this.getSelectedLines(editor);
		toggleCollapseState(foldingModel, 1, selectedLines);
	}
}


class FoldRecursivelyAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.foldRecursively',
			label: nls.localize('foldRecursivelyAction.label', "Fold Recursively"),
			alias: 'Fold Recursively',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.BracketLeft),
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor): void {
		let selectedLines = this.getSelectedLines(editor);
		setCollapseStateLevelsDown(foldingModel, true, Number.MAX_VALUE, selectedLines);
	}
}

class FoldAllBlockCommentsAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.foldAllBlockComments',
			label: nls.localize('foldAllBlockComments.label', "Fold All Block Comments"),
			alias: 'Fold All Block Comments',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.Slash),
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor, args: void, languageConfigurationService: ILanguageConfigurationService): void {
		if (foldingModel.regions.hasTypes()) {
			setCollapseStateForType(foldingModel, FoldingRangeKind.Comment.value, true);
		} else {
			const editorModel = editor.getModel();
			if (!editorModel) {
				return;
			}
			const comments = languageConfigurationService.getLanguageConfiguration(editorModel.getLanguageId()).comments;
			if (comments && comments.blockCommentStartToken) {
				let regExp = new RegExp('^\\s*' + escapeRegExpCharacters(comments.blockCommentStartToken));
				setCollapseStateForMatchingLines(foldingModel, regExp, true);
			}
		}
	}
}

class FoldAllRegionsAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.foldAllMarkerRegions',
			label: nls.localize('foldAllMarkerRegions.label', "Fold All Regions"),
			alias: 'Fold All Regions',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.Digit8),
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor, args: void, languageConfigurationService: ILanguageConfigurationService): void {
		if (foldingModel.regions.hasTypes()) {
			setCollapseStateForType(foldingModel, FoldingRangeKind.Region.value, true);
		} else {
			const editorModel = editor.getModel();
			if (!editorModel) {
				return;
			}
			const foldingRules = languageConfigurationService.getLanguageConfiguration(editorModel.getLanguageId()).foldingRules;
			if (foldingRules && foldingRules.markers && foldingRules.markers.start) {
				let regExp = new RegExp(foldingRules.markers.start);
				setCollapseStateForMatchingLines(foldingModel, regExp, true);
			}
		}
	}
}

class UnfoldAllRegionsAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.unfoldAllMarkerRegions',
			label: nls.localize('unfoldAllMarkerRegions.label', "Unfold All Regions"),
			alias: 'Unfold All Regions',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.Digit9),
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor, args: void, languageConfigurationService: ILanguageConfigurationService): void {
		if (foldingModel.regions.hasTypes()) {
			setCollapseStateForType(foldingModel, FoldingRangeKind.Region.value, false);
		} else {
			const editorModel = editor.getModel();
			if (!editorModel) {
				return;
			}
			const foldingRules = languageConfigurationService.getLanguageConfiguration(editorModel.getLanguageId()).foldingRules;
			if (foldingRules && foldingRules.markers && foldingRules.markers.start) {
				let regExp = new RegExp(foldingRules.markers.start);
				setCollapseStateForMatchingLines(foldingModel, regExp, false);
			}
		}
	}
}

class FoldAllRegionsExceptAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.foldAllExcept',
			label: nls.localize('foldAllExcept.label', "Fold All Regions Except Selected"),
			alias: 'Fold All Regions Except Selected',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.Minus),
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor): void {
		let selectedLines = this.getSelectedLines(editor);
		setCollapseStateForRest(foldingModel, true, selectedLines);
	}

}

class UnfoldAllRegionsExceptAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.unfoldAllExcept',
			label: nls.localize('unfoldAllExcept.label', "Unfold All Regions Except Selected"),
			alias: 'Unfold All Regions Except Selected',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.Equal),
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor): void {
		let selectedLines = this.getSelectedLines(editor);
		setCollapseStateForRest(foldingModel, false, selectedLines);
	}
}

class FoldAllAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.foldAll',
			label: nls.localize('foldAllAction.label', "Fold All"),
			alias: 'Fold All',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.Digit0),
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, _editor: ICodeEditor): void {
		setCollapseStateLevelsDown(foldingModel, true);
	}
}

class UnfoldAllAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.unfoldAll',
			label: nls.localize('unfoldAllAction.label', "Unfold All"),
			alias: 'Unfold All',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyJ),
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, _editor: ICodeEditor): void {
		setCollapseStateLevelsDown(foldingModel, false);
	}
}

class FoldLevelAction extends FoldingAction<void> {
	private static readonly ID_PREFIX = 'editor.foldLevel';
	public static readonly ID = (level: number) => FoldLevelAction.ID_PREFIX + level;

	private getFoldingLevel() {
		return parseInt(this.id.substr(FoldLevelAction.ID_PREFIX.length));
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor): void {
		setCollapseStateAtLevel(foldingModel, this.getFoldingLevel(), true, this.getSelectedLines(editor));
	}
}

/** Action to go to the parent fold of current line */
class GotoParentFoldAction extends FoldingAction<void> {
	constructor() {
		super({
			id: 'editor.gotoParentFold',
			label: nls.localize('gotoParentFold.label', "Go to Parent Fold"),
			alias: 'Go to Parent Fold',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor): void {
		let selectedLines = this.getSelectedLines(editor);
		if (selectedLines.length > 0) {
			let startLineNumber = getParentFoldLine(selectedLines[0], foldingModel);
			if (startLineNumber !== null) {
				editor.setSelection({
					startLineNumber: startLineNumber,
					startColumn: 1,
					endLineNumber: startLineNumber,
					endColumn: 1
				});
			}
		}
	}
}

/** Action to go to the previous fold of current line */
class GotoPreviousFoldAction extends FoldingAction<void> {
	constructor() {
		super({
			id: 'editor.gotoPreviousFold',
			label: nls.localize('gotoPreviousFold.label', "Go to Previous Folding Range"),
			alias: 'Go to Previous Folding Range',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor): void {
		let selectedLines = this.getSelectedLines(editor);
		if (selectedLines.length > 0) {
			let startLineNumber = getPreviousFoldLine(selectedLines[0], foldingModel);
			if (startLineNumber !== null) {
				editor.setSelection({
					startLineNumber: startLineNumber,
					startColumn: 1,
					endLineNumber: startLineNumber,
					endColumn: 1
				});
			}
		}
	}
}

/** Action to go to the next fold of current line */
class GotoNextFoldAction extends FoldingAction<void> {
	constructor() {
		super({
			id: 'editor.gotoNextFold',
			label: nls.localize('gotoNextFold.label', "Go to Next Folding Range"),
			alias: 'Go to Next Folding Range',
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	invoke(_foldingController: FoldingController, foldingModel: FoldingModel, editor: ICodeEditor): void {
		let selectedLines = this.getSelectedLines(editor);
		if (selectedLines.length > 0) {
			let startLineNumber = getNextFoldLine(selectedLines[0], foldingModel);
			if (startLineNumber !== null) {
				editor.setSelection({
					startLineNumber: startLineNumber,
					startColumn: 1,
					endLineNumber: startLineNumber,
					endColumn: 1
				});
			}
		}
	}
}

registerEditorContribution(FoldingController.ID, FoldingController);
registerEditorAction(UnfoldAction);
registerEditorAction(UnFoldRecursivelyAction);
registerEditorAction(FoldAction);
registerEditorAction(FoldRecursivelyAction);
registerEditorAction(FoldAllAction);
registerEditorAction(UnfoldAllAction);
registerEditorAction(FoldAllBlockCommentsAction);
registerEditorAction(FoldAllRegionsAction);
registerEditorAction(UnfoldAllRegionsAction);
registerEditorAction(FoldAllRegionsExceptAction);
registerEditorAction(UnfoldAllRegionsExceptAction);
registerEditorAction(ToggleFoldAction);
registerEditorAction(GotoParentFoldAction);
registerEditorAction(GotoPreviousFoldAction);
registerEditorAction(GotoNextFoldAction);

for (let i = 1; i <= 7; i++) {
	registerInstantiatedEditorAction(
		new FoldLevelAction({
			id: FoldLevelAction.ID(i),
			label: nls.localize('foldLevelAction.label', "Fold Level {0}", i),
			alias: `Fold Level ${i}`,
			precondition: CONTEXT_FOLDING_ENABLED,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | (KeyCode.Digit0 + i)),
				weight: KeybindingWeight.EditorContrib
			}
		})
	);
}

export const foldBackgroundBackground = registerColor('editor.foldBackground', { light: transparent(editorSelectionBackground, 0.3), dark: transparent(editorSelectionBackground, 0.3), hc: null }, nls.localize('foldBackgroundBackground', "Background color behind folded ranges. The color must not be opaque so as not to hide underlying decorations."), true);
export const editorFoldForeground = registerColor('editorGutter.foldingControlForeground', { dark: iconForeground, light: iconForeground, hc: iconForeground }, nls.localize('editorGutter.foldingControlForeground', 'Color of the folding control in the editor gutter.'));

registerThemingParticipant((theme, collector) => {
	const foldBackground = theme.getColor(foldBackgroundBackground);
	if (foldBackground) {
		collector.addRule(`.monaco-editor .folded-background { background-color: ${foldBackground}; }`);
	}

	const editorFoldColor = theme.getColor(editorFoldForeground);
	if (editorFoldColor) {
		collector.addRule(`
		.monaco-editor .cldr${ThemeIcon.asCSSSelector(foldingExpandedIcon)},
		.monaco-editor .cldr${ThemeIcon.asCSSSelector(foldingCollapsedIcon)} {
			color: ${editorFoldColor} !important;
		}
		`);
	}
});
