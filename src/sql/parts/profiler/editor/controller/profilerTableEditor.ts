/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProfilerController } from './interfaces';
import { ProfilerInput } from 'sql/parts/profiler/editor/profilerInput';
import { Table } from 'sql/base/browser/ui/table/table';
import { attachTableStyler } from 'sql/common/theme/styler';
import { RowSelectionModel } from 'sql/base/browser/ui/table/plugins/rowSelectionModel.plugin';
import { IProfilerStateChangedEvent } from 'sql/parts/profiler/editor/profilerState';
import { FindWidget, ITableController, IConfigurationChangedEvent, ACTION_IDS } from './profilerFindWidget';
import { ProfilerFindNext, ProfilerFindPrevious } from 'sql/parts/profiler/contrib/profilerActions';

import { TPromise } from 'vs/base/common/winjs.base';
import { IWorkbenchThemeService } from 'vs/workbench/services/themes/common/workbenchThemeService';
import { IDisposable } from 'vs/base/common/lifecycle';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IEditorAction } from 'vs/editor/common/editorCommon';
import { IOverlayWidget } from 'vs/editor/browser/editorBrowser';
import { FindReplaceState, FindReplaceStateChangedEvent } from 'vs/editor/contrib/find/findState';
import { BaseEditor } from 'vs/workbench/browser/parts/editor/baseEditor';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { Event, Emitter } from 'vs/base/common/event';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Dimension } from 'vs/base/browser/dom';
import { textFormatter } from 'sql/parts/grid/services/sharedServices';

export class ProfilerTableEditor extends BaseEditor implements IProfilerController, ITableController {

	public static ID: string = 'workbench.editor.profiler.table';
	protected _input: ProfilerInput;
	private _profilerTable: Table<Slick.SlickData>;
	private _columnListener: IDisposable;
	private _stateListener: IDisposable;
	private _findCountChangeListener: IDisposable;
	private _findState: FindReplaceState;
	private _finder: FindWidget;
	private _overlay: HTMLElement;
	private _currentDimensions: Dimension;
	private _actionMap: { [x: string]: IEditorAction } = {};

	private _onDidChangeConfiguration = new Emitter<IConfigurationChangedEvent>();
	public onDidChangeConfiguration: Event<IConfigurationChangedEvent> = this._onDidChangeConfiguration.event;

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IWorkbenchThemeService private _themeService: IWorkbenchThemeService,
		@IContextViewService private _contextViewService: IContextViewService,
		@IKeybindingService private _keybindingService: IKeybindingService,
		@IContextKeyService private _contextKeyService: IContextKeyService,
		@IInstantiationService private _instantiationService: IInstantiationService
	) {
		super(ProfilerTableEditor.ID, telemetryService, _themeService);
		this._actionMap[ACTION_IDS.FIND_NEXT] = this._instantiationService.createInstance(ProfilerFindNext, this);
		this._actionMap[ACTION_IDS.FIND_PREVIOUS] = this._instantiationService.createInstance(ProfilerFindPrevious, this);
	}

	public createEditor(parent: HTMLElement): void {

		this._overlay = document.createElement('div');
		this._overlay.className = 'overlayWidgets';
		this._overlay.style.width = '100%';
		this._overlay.style.zIndex = '4';
		parent.appendChild(this._overlay);

		this._profilerTable = new Table(parent);
		this._profilerTable.setSelectionModel(new RowSelectionModel());
		attachTableStyler(this._profilerTable, this._themeService);

		this._findState = new FindReplaceState();
		this._findState.onFindReplaceStateChange(e => this._onFindStateChange(e));

		this._finder = new FindWidget(
			this,
			this._findState,
			this._contextViewService,
			this._keybindingService,
			this._contextKeyService,
			this._themeService
		);
	}

	public setInput(input: ProfilerInput): TPromise<void> {
		this._input = input;
		if (this._columnListener) {
			this._columnListener.dispose();
		}
		this._columnListener = input.onColumnsChanged(e => {
			this._profilerTable.columns = e.map(e => {
				e.formatter = textFormatter;
				return e;
			});
			this._profilerTable.autosizeColumns();
		});
		if (this._stateListener) {
			this._stateListener.dispose();
		}
		this._stateListener = input.state.addChangeListener(e => this._onStateChange(e));

		if (this._findCountChangeListener) {
			this._findCountChangeListener.dispose();
		}
		this._findCountChangeListener = input.data.onFindCountChange(() => this._updateFinderMatchState());

		this._profilerTable.setData(input.data);
		this._profilerTable.columns = input.columns;
		this._profilerTable.autosizeColumns();
		this._input.data.currentFindPosition.then(val => {
			this._profilerTable.setActiveCell(val.row, val.col);
			this._updateFinderMatchState();
		}, er => { });
		return TPromise.as(null);
	}

	public toggleSearch(): void {
		this._findState.change({
			isRevealed: true
		}, false);
		this._finder.focusFindInput();
	}

	public findNext(): void {
		this._input.data.findNext().then(p => {
			this._profilerTable.setActiveCell(p.row, p.col);
			this._updateFinderMatchState();
		}, er => { });
	}

	public findPrevious(): void {
		this._input.data.findPrevious().then(p => {
			this._profilerTable.setActiveCell(p.row, p.col);
			this._updateFinderMatchState();
		}, er => { });
	}

	public getConfiguration() {
		return {
			layoutInfo: {
				width: this._currentDimensions ? this._currentDimensions.width : 0
			}
		};
	}

	public layoutOverlayWidget(widget: IOverlayWidget): void {
		// no op
	}

	public addOverlayWidget(widget: IOverlayWidget): void {
		let domNode = widget.getDomNode();
		domNode.style.right = '28px';
		this._overlay.appendChild(widget.getDomNode());
		this._findState.change({ isRevealed: false }, false);
	}

	public getAction(id: string): IEditorAction {
		return this._actionMap[id];
	}

	public focus(): void {
		this._profilerTable.focus();
	}

	public layout(dimension: Dimension): void {
		this._currentDimensions = dimension;
		this._profilerTable.layout(dimension);
		this._onDidChangeConfiguration.fire({ layoutInfo: true });
	}

	public onSelectedRowsChanged(fn: (e: Slick.EventData, args: Slick.OnSelectedRowsChangedEventArgs<Slick.SlickData>) => any): void {
		if (this._profilerTable) {
			this._profilerTable.onSelectedRowsChanged(fn);
		}
	}

	private _onStateChange(e: IProfilerStateChangedEvent): void {
		if (e.autoscroll) {
			this._profilerTable.autoScroll = this._input.state.autoscroll;
		}
	}

	public updateState(): void {
		this._onStateChange({ autoscroll: true });
	}

	private _onFindStateChange(e: FindReplaceStateChangedEvent): void {
		if (e.isRevealed) {
			if (this._findState.isRevealed) {
				this._finder.getDomNode().style.top = '0px';
				this._updateFinderMatchState();
			} else {
				this._finder.getDomNode().style.top = '';
			}
		}

		if (e.searchString) {
			if (this._input && this._input.data) {
				if (this._findState.searchString) {
					this._input.data.find(this._findState.searchString).then(p => {
						if (p) {
							this._profilerTable.setActiveCell(p.row, p.col);
							this._updateFinderMatchState();
						}
					});
				} else {
					this._input.data.clearFind();
				}
			}
		}
	}

	private _updateFinderMatchState(): void {
		if (this._input && this._input.data) {
			this._findState.changeMatchInfo(this._input.data.findPosition, this._input.data.findCount, undefined);
		} else {
			this._findState.changeMatchInfo(0, 0, undefined);
		}
	}
}
