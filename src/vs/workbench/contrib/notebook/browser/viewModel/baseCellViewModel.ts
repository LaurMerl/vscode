/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, dispose, IDisposable, IReference } from 'vs/base/common/lifecycle';
import { Mimes } from 'vs/base/common/mime';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { IPosition } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { Selection } from 'vs/editor/common/core/selection';
import * as editorCommon from 'vs/editor/common/editorCommon';
import * as model from 'vs/editor/common/model';
import { SearchParams } from 'vs/editor/common/model/textModelSearch';
import { IResolvedTextEditorModel, ITextModelService } from 'vs/editor/common/services/resolverService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IUndoRedoService } from 'vs/platform/undoRedo/common/undoRedo';
import { IWordWrapTransientState, readTransientState, writeTransientState } from 'vs/workbench/contrib/codeEditor/browser/toggleWordWrap';
import { CellEditState, CellFocusMode, CursorAtBoundary, IEditableCellViewModel, INotebookCellDecorationOptions } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { CellViewModelStateChangeEvent } from 'vs/workbench/contrib/notebook/browser/notebookViewEvents';
import { ViewContext } from 'vs/workbench/contrib/notebook/browser/viewModel/viewContext';
import { NotebookCellTextModel } from 'vs/workbench/contrib/notebook/common/model/notebookCellTextModel';
import { CellKind, INotebookCellStatusBarItem, INotebookSearchOptions } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { NotebookOptionsChangeEvent } from 'vs/workbench/contrib/notebook/common/notebookOptions';

export abstract class BaseCellViewModel extends Disposable {

	protected readonly _onDidChangeEditorAttachState = this._register(new Emitter<void>());
	// Do not merge this event with `onDidChangeState` as we are using `Event.once(onDidChangeEditorAttachState)` elsewhere.
	readonly onDidChangeEditorAttachState = this._onDidChangeEditorAttachState.event;
	protected readonly _onDidChangeState = this._register(new Emitter<CellViewModelStateChangeEvent>());
	public readonly onDidChangeState: Event<CellViewModelStateChangeEvent> = this._onDidChangeState.event;

	get handle() {
		return this.model.handle;
	}
	get uri() {
		return this.model.uri;
	}
	get lineCount() {
		return this.model.textBuffer.getLineCount();
	}
	get metadata() {
		return this.model.metadata;
	}
	get internalMetadata() {
		return this.model.internalMetadata;
	}
	get language() {
		return this.model.language;
	}

	get mime(): string {
		if (typeof this.model.mime === 'string') {
			return this.model.mime;
		}

		switch (this.language) {
			case 'markdown':
				return Mimes.markdown;

			default:
				return Mimes.text;
		}
	}

	abstract cellKind: CellKind;

	private _editState: CellEditState = CellEditState.Preview;

	// get editState(): CellEditState {
	// 	return this._editState;
	// }

	// set editState(newState: CellEditState) {
	// 	if (newState === this._editState) {
	// 		return;
	// 	}

	// 	this._editState = newState;
	// 	this._onDidChangeState.fire({ editStateChanged: true });
	// 	if (this._editState === CellEditState.Preview) {
	// 		this.focusMode = CellFocusMode.Container;
	// 	}
	// }

	private _lineNumbers: 'on' | 'off' | 'inherit' = 'inherit';
	get lineNumbers(): 'on' | 'off' | 'inherit' {
		return this._lineNumbers;
	}

	set lineNumbers(lineNumbers: 'on' | 'off' | 'inherit') {
		if (lineNumbers === this._lineNumbers) {
			return;
		}

		this._lineNumbers = lineNumbers;
		this._onDidChangeState.fire({ cellLineNumberChanged: true });
	}

	private _focusMode: CellFocusMode = CellFocusMode.Container;
	get focusMode() {
		return this._focusMode;
	}
	set focusMode(newMode: CellFocusMode) {
		if (this._focusMode !== newMode) {
			this._focusMode = newMode;
			this._onDidChangeState.fire({ focusModeChanged: true });
		}
	}

	protected _textEditor?: ICodeEditor;
	get editorAttached(): boolean {
		return !!this._textEditor;
	}
	private _editorListeners: IDisposable[] = [];
	private _editorViewStates: editorCommon.ICodeEditorViewState | null = null;
	private _editorTransientState: IWordWrapTransientState | null = null;
	private _resolvedCellDecorations = new Map<string, INotebookCellDecorationOptions>();

	private readonly _cellDecorationsChanged = this._register(new Emitter<{ added: INotebookCellDecorationOptions[], removed: INotebookCellDecorationOptions[] }>());
	onCellDecorationsChanged: Event<{ added: INotebookCellDecorationOptions[], removed: INotebookCellDecorationOptions[] }> = this._cellDecorationsChanged.event;

	private _resolvedDecorations = new Map<string, {
		id?: string;
		options: model.IModelDeltaDecoration;
	}>();
	private _lastDecorationId: number = 0;

	private _cellStatusBarItems = new Map<string, INotebookCellStatusBarItem>();
	private readonly _onDidChangeCellStatusBarItems = this._register(new Emitter<void>());
	readonly onDidChangeCellStatusBarItems: Event<void> = this._onDidChangeCellStatusBarItems.event;
	private _lastStatusBarId: number = 0;

	get textModel(): model.ITextModel | undefined {
		return this.model.textModel;
	}

	hasModel(): this is IEditableCellViewModel {
		return !!this.textModel;
	}

	private _dragging: boolean = false;
	get dragging(): boolean {
		return this._dragging;
	}

	set dragging(v: boolean) {
		this._dragging = v;
	}

	protected _textModelRef: IReference<IResolvedTextEditorModel> | undefined;

	private _inputCollapsed: boolean = false;
	get isInputCollapsed(): boolean {
		return this._inputCollapsed;
	}
	set isInputCollapsed(v: boolean) {
		this._inputCollapsed = v;
		this._onDidChangeState.fire({ inputCollapsedChanged: true });
	}

	private _outputCollapsed: boolean = false;
	get isOutputCollapsed(): boolean {
		return this._outputCollapsed;
	}
	set isOutputCollapsed(v: boolean) {
		this._outputCollapsed = v;
		this._onDidChangeState.fire({ outputCollapsedChanged: true });
	}

	constructor(
		readonly viewType: string,
		readonly model: NotebookCellTextModel,
		public id: string,
		private readonly _viewContext: ViewContext,
		private readonly _configurationService: IConfigurationService,
		private readonly _modelService: ITextModelService,
		private readonly _undoRedoService: IUndoRedoService,
		private readonly _codeEditorService: ICodeEditorService,
		// private readonly _keymapService: INotebookKeymapService
	) {
		super();

		this._register(model.onDidChangeMetadata(() => {
			this._onDidChangeState.fire({ metadataChanged: true });
		}));

		this._register(model.onDidChangeInternalMetadata(e => {
			this._onDidChangeState.fire({ internalMetadataChanged: true });
			if (e.lastRunSuccessChanged) {
				// Statusbar visibility may change
				this.layoutChange({});
			}
		}));

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('notebook.lineNumbers')) {
				this.lineNumbers = 'inherit';
			}
		}));

		if (this.model.collapseState?.inputCollapsed) {
			this._inputCollapsed = true;
		}

		if (this.model.collapseState?.outputCollapsed) {
			this._outputCollapsed = true;
		}
	}


	abstract updateOptions(e: NotebookOptionsChangeEvent): void;
	abstract hasDynamicHeight(): boolean;
	abstract getHeight(lineHeight: number): number;
	abstract onDeselect(): void;
	abstract layoutChange(change: any): void;

	assertTextModelAttached(): boolean {
		if (this.textModel && this._textEditor && this._textEditor.getModel() === this.textModel) {
			return true;
		}

		return false;
	}

	// private handleKeyDown(e: IKeyboardEvent) {
	// 	if (this.viewType === IPYNB_VIEW_TYPE && isWindows && e.ctrlKey && e.keyCode === KeyCode.Enter) {
	// 		this._keymapService.promptKeymapRecommendation();
	// 	}
	// }

	attachTextEditor(editor: ICodeEditor) {
		if (!editor.hasModel()) {
			throw new Error('Invalid editor: model is missing');
		}

		if (this._textEditor === editor) {
			if (this._editorListeners.length === 0) {
				this._editorListeners.push(this._textEditor.onDidChangeCursorSelection(() => { this._onDidChangeState.fire({ selectionChanged: true }); }));
				// this._editorListeners.push(this._textEditor.onKeyDown(e => this.handleKeyDown(e)));
				this._onDidChangeState.fire({ selectionChanged: true });
			}
			return;
		}

		this._textEditor = editor;

		if (this._editorViewStates) {
			this._restoreViewState(this._editorViewStates);
		}

		if (this._editorTransientState) {
			writeTransientState(editor.getModel(), this._editorTransientState, this._codeEditorService);
		}

		this._resolvedDecorations.forEach((value, key) => {
			if (key.startsWith('_lazy_')) {
				// lazy ones
				const ret = this._textEditor!.deltaDecorations([], [value.options]);
				this._resolvedDecorations.get(key)!.id = ret[0];
			}
			else {
				const ret = this._textEditor!.deltaDecorations([], [value.options]);
				this._resolvedDecorations.get(key)!.id = ret[0];
			}
		});

		this._editorListeners.push(this._textEditor.onDidChangeCursorSelection(() => { this._onDidChangeState.fire({ selectionChanged: true }); }));
		// this._editorListeners.push(this._textEditor.onKeyDown(e => this.handleKeyDown(e)));
		this._onDidChangeState.fire({ selectionChanged: true });
		this._onDidChangeEditorAttachState.fire();
	}

	detachTextEditor() {
		this.saveViewState();
		this.saveTransientState();
		// decorations need to be cleared first as editors can be resued.
		this._resolvedDecorations.forEach(value => {
			const resolvedid = value.id;

			if (resolvedid) {
				this._textEditor?.deltaDecorations([resolvedid], []);
			}
		});

		this._textEditor = undefined;
		dispose(this._editorListeners);
		this._editorListeners = [];
		this._onDidChangeEditorAttachState.fire();

		if (this._textModelRef) {
			this._textModelRef.dispose();
			this._textModelRef = undefined;
		}
	}

	getText(): string {
		return this.model.getValue();
	}

	getTextLength(): number {
		return this.model.getTextLength();
	}

	private saveViewState(): void {
		if (!this._textEditor) {
			return;
		}

		this._editorViewStates = this._textEditor.saveViewState();
	}

	private saveTransientState() {
		if (!this._textEditor || !this._textEditor.hasModel()) {
			return;
		}

		this._editorTransientState = readTransientState(this._textEditor.getModel(), this._codeEditorService);
	}

	saveEditorViewState() {
		if (this._textEditor) {
			this._editorViewStates = this._textEditor.saveViewState();
		}

		return this._editorViewStates;
	}

	restoreEditorViewState(editorViewStates: editorCommon.ICodeEditorViewState | null, totalHeight?: number) {
		this._editorViewStates = editorViewStates;
	}

	private _restoreViewState(state: editorCommon.ICodeEditorViewState | null): void {
		if (state) {
			this._textEditor?.restoreViewState(state);
		}
	}

	addModelDecoration(decoration: model.IModelDeltaDecoration): string {
		if (!this._textEditor) {
			const id = ++this._lastDecorationId;
			const decorationId = `_lazy_${this.id};${id}`;
			this._resolvedDecorations.set(decorationId, { options: decoration });
			return decorationId;
		}

		const result = this._textEditor.deltaDecorations([], [decoration]);
		this._resolvedDecorations.set(result[0], { id: result[0], options: decoration });
		return result[0];
	}

	removeModelDecoration(decorationId: string) {
		const realDecorationId = this._resolvedDecorations.get(decorationId);

		if (this._textEditor && realDecorationId && realDecorationId.id !== undefined) {
			this._textEditor.deltaDecorations([realDecorationId.id!], []);
		}

		// lastly, remove all the cache
		this._resolvedDecorations.delete(decorationId);
	}

	deltaModelDecorations(oldDecorations: string[], newDecorations: model.IModelDeltaDecoration[]): string[] {
		oldDecorations.forEach(id => {
			this.removeModelDecoration(id);
		});

		const ret = newDecorations.map(option => {
			return this.addModelDecoration(option);
		});

		return ret;
	}

	private _removeCellDecoration(decorationId: string) {
		const options = this._resolvedCellDecorations.get(decorationId);

		if (options) {
			this._cellDecorationsChanged.fire({ added: [], removed: [options] });
			this._resolvedCellDecorations.delete(decorationId);
		}
	}

	private _addCellDecoration(options: INotebookCellDecorationOptions): string {
		const id = ++this._lastDecorationId;
		const decorationId = `_cell_${this.id};${id}`;
		this._resolvedCellDecorations.set(decorationId, options);
		this._cellDecorationsChanged.fire({ added: [options], removed: [] });
		return decorationId;
	}

	getCellDecorations() {
		return [...this._resolvedCellDecorations.values()];
	}

	getCellDecorationRange(decorationId: string): Range | null {
		if (this._textEditor) {
			// (this._textEditor as CodeEditorWidget).decora
			return this._textEditor.getModel()?.getDecorationRange(decorationId) ?? null;
		}

		return null;
	}

	deltaCellDecorations(oldDecorations: string[], newDecorations: INotebookCellDecorationOptions[]): string[] {
		oldDecorations.forEach(id => {
			this._removeCellDecoration(id);
		});

		const ret = newDecorations.map(option => {
			return this._addCellDecoration(option);
		});

		return ret;
	}

	deltaCellStatusBarItems(oldItems: string[], newItems: INotebookCellStatusBarItem[]): string[] {
		oldItems.forEach(id => {
			const item = this._cellStatusBarItems.get(id);
			if (item) {
				this._cellStatusBarItems.delete(id);
			}
		});

		const newIds = newItems.map(item => {
			const id = ++this._lastStatusBarId;
			const itemId = `_cell_${this.id};${id}`;
			this._cellStatusBarItems.set(itemId, item);
			return itemId;
		});

		this._onDidChangeCellStatusBarItems.fire();

		return newIds;
	}

	getCellStatusBarItems(): INotebookCellStatusBarItem[] {
		return Array.from(this._cellStatusBarItems.values());
	}

	revealRangeInCenter(range: Range) {
		this._textEditor?.revealRangeInCenter(range, editorCommon.ScrollType.Immediate);
	}

	setSelection(range: Range) {
		this._textEditor?.setSelection(range);
	}

	setSelections(selections: Selection[]) {
		if (selections.length) {
			this._textEditor?.setSelections(selections);
		}
	}

	getSelections() {
		return this._textEditor?.getSelections() || [];
	}

	getSelectionsStartPosition(): IPosition[] | undefined {
		if (this._textEditor) {
			const selections = this._textEditor.getSelections();
			return selections?.map(s => s.getStartPosition());
		} else {
			const selections = this._editorViewStates?.cursorState;
			return selections?.map(s => s.selectionStart);
		}
	}

	getLineScrollTopOffset(line: number): number {
		if (!this._textEditor) {
			return 0;
		}

		const editorPadding = this._viewContext.notebookOptions.computeEditorPadding(this.internalMetadata, this.uri);
		return this._textEditor.getTopForLineNumber(line) + editorPadding.top;
	}

	getPositionScrollTopOffset(line: number, column: number): number {
		if (!this._textEditor) {
			return 0;
		}

		const editorPadding = this._viewContext.notebookOptions.computeEditorPadding(this.internalMetadata, this.uri);
		return this._textEditor.getTopForPosition(line, column) + editorPadding.top;
	}

	cursorAtBoundary(): CursorAtBoundary {
		if (!this._textEditor) {
			return CursorAtBoundary.None;
		}

		if (!this.textModel) {
			return CursorAtBoundary.None;
		}

		// only validate primary cursor
		const selection = this._textEditor.getSelection();

		// only validate empty cursor
		if (!selection || !selection.isEmpty()) {
			return CursorAtBoundary.None;
		}

		const firstViewLineTop = this._textEditor.getTopForPosition(1, 1);
		const lastViewLineTop = this._textEditor.getTopForPosition(this.textModel!.getLineCount(), this.textModel!.getLineLength(this.textModel!.getLineCount()));
		const selectionTop = this._textEditor.getTopForPosition(selection.startLineNumber, selection.startColumn);

		if (selectionTop === lastViewLineTop) {
			if (selectionTop === firstViewLineTop) {
				return CursorAtBoundary.Both;
			} else {
				return CursorAtBoundary.Bottom;
			}
		} else {
			if (selectionTop === firstViewLineTop) {
				return CursorAtBoundary.Top;
			} else {
				return CursorAtBoundary.None;
			}
		}
	}

	private _editStateSource: string = '';

	get editStateSource(): string {
		return this._editStateSource;
	}

	updateEditState(newState: CellEditState, source: string) {
		this._editStateSource = source;
		if (newState === this._editState) {
			return;
		}

		this._editState = newState;
		this._onDidChangeState.fire({ editStateChanged: true });
		if (this._editState === CellEditState.Preview) {
			this.focusMode = CellFocusMode.Container;
		}
	}

	getEditState() {
		return this._editState;
	}

	get textBuffer() {
		return this.model.textBuffer;
	}

	/**
	 * Text model is used for editing.
	 */
	async resolveTextModel(): Promise<model.ITextModel> {
		if (!this._textModelRef || !this.textModel) {
			this._textModelRef = await this._modelService.createModelReference(this.uri);
			if (!this._textModelRef) {
				throw new Error(`Cannot resolve text model for ${this.uri}`);
			}

			this._register(this.textModel!.onDidChangeContent(() => this.onDidChangeTextModelContent()));
		}

		return this.textModel!;
	}

	protected abstract onDidChangeTextModelContent(): void;

	protected cellStartFind(value: string, options: INotebookSearchOptions): model.FindMatch[] | null {
		let cellMatches: model.FindMatch[] = [];

		if (this.assertTextModelAttached()) {
			cellMatches = this.textModel!.findMatches(
				value,
				false,
				options.regex || false,
				options.caseSensitive || false,
				options.wholeWord ? options.wordSeparators || null : null,
				options.regex || false);
		} else {
			const lineCount = this.textBuffer.getLineCount();
			const fullRange = new Range(1, 1, lineCount, this.textBuffer.getLineLength(lineCount) + 1);
			const searchParams = new SearchParams(value, options.regex || false, options.caseSensitive || false, options.wholeWord ? options.wordSeparators || null : null,);
			const searchData = searchParams.parseSearchRequest();

			if (!searchData) {
				return null;
			}

			cellMatches = this.textBuffer.findMatchesLineByLine(fullRange, searchData, options.regex || false, 1000);
		}

		return cellMatches;
	}

	override dispose() {
		super.dispose();

		dispose(this._editorListeners);
		this._undoRedoService.removeElements(this.uri);

		if (this._textModelRef) {
			this._textModelRef.dispose();
		}
	}

	toJSON(): object {
		return {
			handle: this.handle
		};
	}
}
