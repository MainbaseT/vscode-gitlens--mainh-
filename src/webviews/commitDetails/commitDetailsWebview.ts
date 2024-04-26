import { EntityIdentifierUtils } from '@gitkraken/provider-apis';
import type { CancellationToken, ConfigurationChangeEvent, TextDocumentShowOptions } from 'vscode';
import { CancellationTokenSource, Disposable, env, Uri, window } from 'vscode';
import type { MaybeEnrichedAutolink } from '../../annotations/autolinks';
import { serializeAutolink } from '../../annotations/autolinks';
import { getAvatarUri } from '../../avatars';
import type { CopyShaToClipboardCommandArgs } from '../../commands/copyShaToClipboard';
import type { ContextKeys } from '../../constants';
import { Commands } from '../../constants';
import type { Container } from '../../container';
import type { CommitSelectedEvent } from '../../eventBus';
import { executeGitCommand } from '../../git/actions';
import {
	openChanges,
	openChangesWithWorking,
	openFile,
	openFileOnRemote,
	showDetailsQuickPick,
} from '../../git/actions/commit';
import * as RepoActions from '../../git/actions/repository';
import { CommitFormatter } from '../../git/formatters/commitFormatter';
import type { GitBranch } from '../../git/models/branch';
import type { GitCommit } from '../../git/models/commit';
import { isCommit } from '../../git/models/commit';
import { uncommitted, uncommittedStaged } from '../../git/models/constants';
import type { GitFileChange, GitFileChangeShape } from '../../git/models/file';
import type { IssueOrPullRequest } from '../../git/models/issue';
import { serializeIssueOrPullRequest } from '../../git/models/issue';
import type { PullRequest } from '../../git/models/pullRequest';
import { serializePullRequest } from '../../git/models/pullRequest';
import type { GitRevisionReference } from '../../git/models/reference';
import { createReference, getReferenceFromRevision, shortenRevision } from '../../git/models/reference';
import type { GitRemote } from '../../git/models/remote';
import type { Repository } from '../../git/models/repository';
import { RepositoryChange, RepositoryChangeComparisonMode } from '../../git/models/repository';
import type { CreateDraftChange, Draft, DraftVisibility } from '../../gk/models/drafts';
import { showPatchesView } from '../../plus/drafts/actions';
import { getEntityIdentifierInput } from '../../plus/integrations/providers/utils';
import { confirmDraftStorage, ensureAccount } from '../../plus/utils';
import type { ShowInCommitGraphCommandArgs } from '../../plus/webviews/graph/protocol';
import type { Change } from '../../plus/webviews/patchDetails/protocol';
import { pauseOnCancelOrTimeoutMapTuplePromise } from '../../system/cancellation';
import { executeCommand, executeCoreCommand, executeCoreGitCommand, registerCommand } from '../../system/command';
import { configuration } from '../../system/configuration';
import { getContext, onDidChangeContext } from '../../system/context';
import { debug } from '../../system/decorators/log';
import type { Deferrable } from '../../system/function';
import { debounce } from '../../system/function';
import { filterMap, map } from '../../system/iterable';
import { Logger } from '../../system/logger';
import { getLogScope } from '../../system/logger.scope';
import { MRU } from '../../system/mru';
import { getSettledValue } from '../../system/promise';
import type { Serialized } from '../../system/serialize';
import { serialize } from '../../system/serialize';
import type { LinesChangeEvent } from '../../trackers/lineTracker';
import type { IpcCallMessageType, IpcMessage } from '../protocol';
import { updatePendingContext } from '../webviewController';
import type { WebviewHost, WebviewProvider, WebviewShowingArgs } from '../webviewProvider';
import type { WebviewShowOptions } from '../webviewsController';
import { isSerializedState } from '../webviewsController';
import type {
	CommitDetails,
	CreatePatchFromWipParams,
	DidChangeWipStateParams,
	DidExplainParams,
	ExecuteFileActionParams,
	GitBranchShape,
	Mode,
	Preferences,
	State,
	SuggestChangesParams,
	SwitchModeParams,
	UpdateablePreferences,
	Wip,
	WipChange,
} from './protocol';
import {
	AutolinkSettingsCommand,
	CreatePatchFromWipCommand,
	DidChangeDraftStateNotification,
	DidChangeNotification,
	DidChangeWipStateNotification,
	ExecuteCommitActionCommand,
	ExecuteFileActionCommand,
	ExplainRequest,
	FetchCommand,
	messageHeadlineSplitterToken,
	NavigateCommand,
	OpenFileCommand,
	OpenFileComparePreviousCommand,
	OpenFileCompareWorkingCommand,
	OpenFileOnRemoteCommand,
	PickCommitCommand,
	PinCommand,
	PublishCommand,
	PullCommand,
	PushCommand,
	SearchCommitCommand,
	ShowCodeSuggestionCommand,
	StageFileCommand,
	SuggestChangesCommand,
	SwitchCommand,
	SwitchModeCommand,
	UnstageFileCommand,
	UpdatePreferencesCommand,
} from './protocol';
import type { CommitDetailsWebviewShowingArgs } from './registration';

type RepositorySubscription = { repo: Repository; subscription: Disposable };

// interface WipContext extends Wip
interface WipContext {
	changes: WipChange | undefined;
	repositoryCount: number;
	branch?: GitBranch;
	pullRequest?: PullRequest;
	repo: Repository;
	codeSuggestions?: Draft[];
}

interface Context {
	mode: Mode;
	navigationStack: {
		count: number;
		position: number;
		hint?: string;
	};
	pinned: boolean;
	preferences: Preferences;

	commit: GitCommit | undefined;
	richStateLoaded: boolean;
	formattedMessage: string | undefined;
	autolinkedIssues: IssueOrPullRequest[] | undefined;
	pullRequest: PullRequest | undefined;
	wip: WipContext | undefined;
	orgSettings: State['orgSettings'];
}

export class CommitDetailsWebviewProvider
	implements WebviewProvider<State, Serialized<State>, CommitDetailsWebviewShowingArgs>
{
	private _bootstraping = true;
	/** The context the webview has */
	private _context: Context;
	/** The context the webview should have */
	private _pendingContext: Partial<Context> | undefined;
	private readonly _disposable: Disposable;
	private _pinned = false;
	private _focused = false;
	private _commitStack = new MRU<GitRevisionReference>(10, (a, b) => a.ref === b.ref);

	constructor(
		private readonly container: Container,
		private readonly host: WebviewHost,
		private readonly options: { attachedTo: 'default' | 'graph' },
	) {
		this._context = {
			mode: 'commit',
			navigationStack: {
				count: 0,
				position: 0,
			},
			pinned: false,
			preferences: this.getPreferences(),

			commit: undefined,
			richStateLoaded: false,
			formattedMessage: undefined,
			autolinkedIssues: undefined,
			pullRequest: undefined,
			wip: undefined,
			orgSettings: this.getOrgSettings(),
		};

		this._disposable = Disposable.from(
			configuration.onDidChangeAny(this.onAnyConfigurationChanged, this),
			onDidChangeContext(this.onContextChanged, this),
		);
	}

	dispose() {
		this._disposable.dispose();
		this._lineTrackerDisposable?.dispose();
		this._repositorySubscription?.subscription.dispose();
		this._selectionTrackerDisposable?.dispose();
		this._wipSubscription?.subscription.dispose();
	}

	private _skipNextRefreshOnVisibilityChange = false;

	async onShowing(
		_loading: boolean,
		options?: WebviewShowOptions,
		...args: WebviewShowingArgs<CommitDetailsWebviewShowingArgs, Serialized<State>>
	): Promise<boolean> {
		let data: Partial<CommitSelectedEvent['data']> | undefined;

		const [arg] = args;
		if (isSerializedState<Serialized<State>>(arg)) {
			const { commit: selected } = arg.state;
			if (selected?.repoPath != null && selected?.sha != null) {
				if (selected.stashNumber != null) {
					data = {
						commit: createReference(selected.sha, selected.repoPath, {
							refType: 'stash',
							name: selected.message,
							number: selected.stashNumber,
						}),
					};
				} else {
					data = {
						commit: createReference(selected.sha, selected.repoPath, {
							refType: 'revision',
							message: selected.message,
						}),
					};
				}
			}
		} else if (arg != null && typeof arg === 'object') {
			data = arg as Partial<CommitSelectedEvent['data']> | undefined;
		} else {
			data = undefined;
		}

		let commit;
		if (data != null) {
			if (data.preserveFocus) {
				if (options == null) {
					options = { preserveFocus: true };
				} else {
					options.preserveFocus = true;
				}
			}
			({ commit, ...data } = data);
		}

		if (commit != null && this.mode === 'wip' && data?.interaction !== 'passive') {
			this.setMode('commit');
		}

		if (commit == null) {
			if (!this._pinned) {
				commit = this.getBestCommitOrStash();
			}
		}

		if (commit != null && !this._context.commit?.ref.startsWith(commit.ref)) {
			await this.updateCommit(commit, { pinned: false });
		}

		if (data?.preserveVisibility && !this.host.visible) return false;

		this._skipNextRefreshOnVisibilityChange = true;
		return true;
	}

	includeBootstrap(): Promise<Serialized<State>> {
		this._bootstraping = true;

		this._context = { ...this._context, ...this._pendingContext };
		this._pendingContext = undefined;

		return this.getState(this._context);
	}

	registerCommands(): Disposable[] {
		return [registerCommand(`${this.host.id}.refresh`, () => this.host.refresh(true))];
	}

	onFocusChanged(focused: boolean): void {
		if (this._focused === focused) return;

		this._focused = focused;
		if (focused && this.isLineTrackerSuspended) {
			this.ensureTrackers();
		}
	}

	onMessageReceived(e: IpcMessage) {
		switch (true) {
			case OpenFileOnRemoteCommand.is(e):
				void this.openFileOnRemote(e.params);
				break;

			case OpenFileCommand.is(e):
				void this.openFile(e.params);
				break;

			case OpenFileCompareWorkingCommand.is(e):
				void this.openFileComparisonWithWorking(e.params);
				break;

			case OpenFileComparePreviousCommand.is(e):
				void this.openFileComparisonWithPrevious(e.params);
				break;

			case ExecuteFileActionCommand.is(e):
				void this.showFileActions(e.params);
				break;

			case ExecuteCommitActionCommand.is(e):
				switch (e.params.action) {
					case 'graph': {
						let ref: GitRevisionReference | undefined;
						if (this._context.mode === 'wip') {
							ref =
								this._context.wip?.changes != null
									? createReference(uncommitted, this._context.wip.changes.repository.path, {
											refType: 'revision',
									  })
									: undefined;
						} else {
							ref =
								this._context.commit != null
									? getReferenceFromRevision(this._context.commit)
									: undefined;
						}
						if (ref == null) return;

						void executeCommand<ShowInCommitGraphCommandArgs>(
							this.options.attachedTo === 'graph'
								? Commands.ShowInCommitGraphView
								: Commands.ShowInCommitGraph,
							{ ref: ref },
						);
						break;
					}
					case 'more':
						this.showCommitActions();
						break;

					case 'scm':
						void executeCoreCommand('workbench.view.scm');
						break;

					case 'sha':
						if (e.params.alt) {
							this.showCommitPicker();
						} else if (this._context.commit != null) {
							void executeCommand<CopyShaToClipboardCommandArgs>(Commands.CopyShaToClipboard, {
								sha: this._context.commit.sha,
							});
						}
						break;
				}
				break;

			case PickCommitCommand.is(e):
				this.showCommitPicker();
				break;

			case SearchCommitCommand.is(e):
				this.showCommitSearch();
				break;

			case SwitchModeCommand.is(e):
				this.switchMode(e.params);
				break;

			case AutolinkSettingsCommand.is(e):
				this.showAutolinkSettings();
				break;

			case PinCommand.is(e):
				this.updatePinned(e.params.pin ?? false, true);
				break;

			case NavigateCommand.is(e):
				this.navigateStack(e.params.direction);
				break;

			case UpdatePreferencesCommand.is(e):
				this.updatePreferences(e.params);
				break;

			case ExplainRequest.is(e):
				void this.explainRequest(ExplainRequest, e);
				break;

			case StageFileCommand.is(e):
				void this.stageFile(e.params);
				break;

			case UnstageFileCommand.is(e):
				void this.unstageFile(e.params);
				break;

			case CreatePatchFromWipCommand.is(e):
				this.createPatchFromWip(e.params);
				break;

			case FetchCommand.is(e):
				this.fetch();
				break;

			case PublishCommand.is(e):
				this.publish();
				break;

			case PushCommand.is(e):
				this.push();
				break;

			case PullCommand.is(e):
				this.pull();
				break;

			case SwitchCommand.is(e):
				this.switch();
				break;
			case SuggestChangesCommand.is(e):
				void this.suggestChanges(e.params);
				break;
			case ShowCodeSuggestionCommand.is(e):
				this.showCodeSuggestion(e.params.id);
				break;
		}
	}

	private getEncodedEntityid(pullRequest = this._context.wip?.pullRequest): string | undefined {
		if (pullRequest == null) return undefined;

		const entity = getEntityIdentifierInput(pullRequest);
		if (entity == null) return undefined;

		return EntityIdentifierUtils.encode(entity);
	}

	private async suggestChanges(e: SuggestChangesParams) {
		if (
			!(await ensureAccount('Code Suggestions require a GitKraken account.', this.container)) ||
			!(await confirmDraftStorage(this.container))
		) {
			return;
		}

		const createChanges: CreateDraftChange[] = [];

		const changes = Object.entries(e.changesets);
		const ignoreChecked = changes.length === 1;

		for (const [_, change] of changes) {
			if (!ignoreChecked && change.checked === false) continue;

			// we only support a single repo for now
			const repository =
				this._context.wip!.repo.id === change.repository.path ? this._context.wip!.repo : undefined;
			if (repository == null) continue;

			const { checked } = change;
			let changeRevision = { to: uncommitted, from: 'HEAD' };
			if (checked === 'staged') {
				changeRevision = { ...changeRevision, to: uncommittedStaged };
			}

			const prEntityId = this.getEncodedEntityid();
			if (prEntityId == null) continue;

			createChanges.push({
				repository: repository,
				revision: changeRevision,
				prEntityId: prEntityId,
			});
		}

		if (createChanges.length === 0) return;

		try {
			const options = {
				description: e.description,
				visibility: 'provider_access' as DraftVisibility,
			};

			const draft = await this.container.drafts.createDraft(
				'suggested_pr_change',
				e.title,
				createChanges,
				options,
			);

			async function showNotification() {
				const view = { title: 'View Code Suggestions' };
				const copy = { title: 'Copy Link' };
				let copied = false;
				while (true) {
					const result = await window.showInformationMessage(
						`Code Suggestion successfully created${copied ? '\u2014 link copied to the clipboard' : ''}`,
						view,
						copy,
					);

					if (result === copy) {
						void env.clipboard.writeText(draft.deepLinkUrl);
						copied = true;
						continue;
					}

					if (result === view) {
						void showPatchesView({ mode: 'view', draft: draft });
					}

					break;
				}
			}

			void showNotification();
			this.notifyEndReview();
		} catch (ex) {
			debugger;

			void window.showErrorMessage(`Unable to create draft: ${ex.message}`);
		}
	}

	private getRepoActionPath() {
		if (this._context.mode === 'wip') {
			return this._context.wip?.repo.path;
		}
		return this._context.commit?.repoPath;
	}

	private fetch() {
		const path = this.getRepoActionPath();
		if (path == null) return;
		void RepoActions.fetch(path);
	}

	private publish() {
		const path = this.getRepoActionPath();
		if (path == null) return;
		void executeCoreGitCommand('git.publish', Uri.file(path));
	}

	private push() {
		const path = this.getRepoActionPath();
		if (path == null) return;
		void RepoActions.push(path);
	}

	private pull() {
		const path = this.getRepoActionPath();
		if (path == null) return;
		void RepoActions.pull(path);
	}

	private switch() {
		const path = this.getRepoActionPath();
		if (path == null) return;
		void RepoActions.switchTo(path);
	}

	onRefresh(_force?: boolean | undefined): void {
		if (this._pinned) return;

		if (this.mode === 'wip') {
			const uri = this._context.wip?.changes?.repository.uri;
			void this.updateWipState(
				this.container.git.getBestRepositoryOrFirst(uri != null ? Uri.parse(uri) : undefined),
			);
		} else {
			const commit = this._pendingContext?.commit ?? this.getBestCommitOrStash();
			void this.updateCommit(commit, { immediate: false });
		}
	}

	onReloaded(): void {
		void this.notifyDidChangeState(true);
	}

	onVisibilityChanged(visible: boolean) {
		this.ensureTrackers();
		if (!visible) return;

		const skipRefresh = this._skipNextRefreshOnVisibilityChange;
		if (skipRefresh) {
			this._skipNextRefreshOnVisibilityChange = false;
		}

		// Since this gets called even the first time the webview is shown, avoid sending an update, because the bootstrap has the data
		if (this._bootstraping) {
			this._bootstraping = false;

			if (this._pendingContext == null) return;

			this.updateState();
		} else {
			if (!skipRefresh) {
				this.onRefresh();
			}
			this.updateState(true);
		}
	}

	private onAnyConfigurationChanged(e: ConfigurationChangeEvent) {
		if (
			configuration.changed(e, [
				'defaultDateFormat',
				'defaultDateStyle',
				'views.commitDetails.files',
				'views.commitDetails.avatars',
			]) ||
			configuration.changedCore(e, 'workbench.tree.renderIndentGuides') ||
			configuration.changedCore(e, 'workbench.tree.indent')
		) {
			this.updatePendingContext({
				preferences: {
					...this._context.preferences,
					...this._pendingContext?.preferences,
					...this.getPreferences(),
				},
			});
			this.updateState();
		}

		if (
			this._context.commit != null &&
			configuration.changed(e, ['views.commitDetails.autolinks', 'views.commitDetails.pullRequests'])
		) {
			void this.updateCommit(this._context.commit, { force: true });
			this.updateState();
		}
	}

	private getPreferences(): Preferences {
		return {
			autolinksExpanded: this.container.storage.getWorkspace('views:commitDetails:autolinksExpanded') ?? true,
			avatars: configuration.get('views.commitDetails.avatars'),
			dateFormat: configuration.get('defaultDateFormat') ?? 'MMMM Do, YYYY h:mma',
			dateStyle: configuration.get('defaultDateStyle') ?? 'relative',
			files: configuration.get('views.commitDetails.files'),
			indentGuides: configuration.getCore('workbench.tree.renderIndentGuides') ?? 'onHover',
			indent: configuration.getCore('workbench.tree.indent'),
		};
	}

	private onContextChanged(key: ContextKeys) {
		if (['gitlens:gk:organization:ai:enabled', 'gitlens:gk:organization:drafts:enabled'].includes(key)) {
			this.updatePendingContext({ orgSettings: this.getOrgSettings() });
			this.updateState();
		}
	}

	private getOrgSettings(): State['orgSettings'] {
		return {
			ai: getContext<boolean>('gitlens:gk:organization:ai:enabled', false),
			drafts: getContext<boolean>('gitlens:gk:organization:drafts:enabled', false),
		};
	}

	private onCommitSelected(e: CommitSelectedEvent) {
		if (
			e.data == null ||
			(this.options.attachedTo === 'graph' && e.source !== 'gitlens.views.graph') ||
			(this.options.attachedTo === 'default' && e.source === 'gitlens.views.graph')
		) {
			return;
		}

		if (this.mode === 'wip') {
			if (e.data.commit.repoPath !== this._context.wip?.changes?.repository.path) {
				void this.updateWipState(this.container.git.getRepository(e.data.commit.repoPath));
			}

			return;
		}

		if (this._pinned && e.data.interaction === 'passive') {
			this._commitStack.insert(getReferenceFromRevision(e.data.commit));
			this.updateNavigation();
		} else {
			void this.host.show(false, { preserveFocus: e.data.preserveFocus }, e.data);
		}
	}

	private _lineTrackerDisposable: Disposable | undefined;
	private _selectionTrackerDisposable: Disposable | undefined;
	private ensureTrackers(): void {
		this._selectionTrackerDisposable?.dispose();
		this._selectionTrackerDisposable = undefined;
		this._lineTrackerDisposable?.dispose();
		this._lineTrackerDisposable = undefined;

		if (!this.host.visible) return;

		this._selectionTrackerDisposable = this.container.events.on('commit:selected', this.onCommitSelected, this);

		if (this._pinned) return;

		if (this.options.attachedTo !== 'graph') {
			const { lineTracker } = this.container;
			this._lineTrackerDisposable = lineTracker.subscribe(
				this,
				lineTracker.onDidChangeActiveLines(this.onActiveEditorLinesChanged, this),
			);
		}
	}

	private get isLineTrackerSuspended() {
		return this.options.attachedTo !== 'graph' ? this._lineTrackerDisposable == null : false;
	}

	private suspendLineTracker() {
		// Defers the suspension of the line tracker, so that the focus change event can be handled first
		setTimeout(() => {
			this._lineTrackerDisposable?.dispose();
			this._lineTrackerDisposable = undefined;
		}, 100);
	}

	private createPatchFromWip(e: CreatePatchFromWipParams) {
		if (e.changes == null) return;

		const change: Change = {
			type: 'wip',
			repository: {
				name: e.changes.repository.name,
				path: e.changes.repository.path,
				uri: e.changes.repository.uri,
			},
			files: e.changes.files,
			revision: { to: uncommitted, from: 'HEAD' },
			checked: e.checked,
		};

		void showPatchesView({ mode: 'create', create: { changes: [change] } });
	}

	private showCodeSuggestion(id: string) {
		const draft = this._context.wip?.codeSuggestions?.find(draft => draft.id === id);
		if (draft == null) return;

		void showPatchesView({ mode: 'view', draft: draft });
	}

	private onActiveEditorLinesChanged(e: LinesChangeEvent) {
		if (e.pending || e.editor == null || e.suspended) return;

		if (this.mode === 'wip') {
			const repo = this.container.git.getBestRepositoryOrFirst(e.editor);
			void this.updateWipState(repo, true);

			return;
		}

		const line = e.selections?.[0]?.active;
		const commit = line != null ? this.container.lineTracker.getState(line)?.commit : undefined;
		void this.updateCommit(commit);
	}

	private _wipSubscription: RepositorySubscription | undefined;

	private get mode(): Mode {
		return this._pendingContext?.mode ?? this._context.mode;
	}

	private setMode(mode: Mode, repository?: Repository) {
		this.updatePendingContext({ mode: mode });
		if (mode === 'commit') {
			this._wipSubscription?.subscription.dispose();
			this._wipSubscription = undefined;

			this.updateState(true);
		} else {
			void this.updateWipState(repository ?? this.container.git.getBestRepositoryOrFirst());
		}

		this.updateTitle();
	}

	private updateTitle() {
		if (this.mode === 'commit') {
			if (this._context.commit == null) {
				this.host.title = this.host.originalTitle;
			} else {
				let following = 'Commit';
				if (this._context.commit.refType === 'stash') {
					following = 'Stash';
				} else if (this._context.commit.isUncommitted) {
					following = 'Uncommitted';
				}

				this.host.title = `${this.host.originalTitle}: ${following}`;
			}
		} else {
			this.host.title = `${this.host.originalTitle}: Repo Status`;
		}
	}

	private async explainRequest<T extends typeof ExplainRequest>(requestType: T, msg: IpcCallMessageType<T>) {
		let params: DidExplainParams;
		try {
			const summary = await (
				await this.container.ai
			)?.explainCommit(this._context.commit!, {
				progress: { location: { viewId: this.host.id } },
			});
			if (summary == null) throw new Error('Error retrieving content');

			params = { summary: summary };
		} catch (ex) {
			debugger;
			params = { error: { message: ex.message } };
		}

		void this.host.respond(requestType, msg, params);
	}

	private navigateStack(direction: 'back' | 'forward') {
		const commit = this._commitStack.navigate(direction);
		if (commit == null) return;

		void this.updateCommit(commit, { immediate: true, skipStack: true });
	}

	private _cancellationTokenSource: CancellationTokenSource | undefined = undefined;

	@debug({ args: false })
	protected async getState(current: Context): Promise<Serialized<State>> {
		if (this._cancellationTokenSource != null) {
			this._cancellationTokenSource.cancel();
			this._cancellationTokenSource = undefined;
		}

		let details;
		if (current.commit != null) {
			details = await this.getDetailsModel(current.commit, current.formattedMessage);

			if (!current.richStateLoaded) {
				this._cancellationTokenSource = new CancellationTokenSource();

				const cancellation = this._cancellationTokenSource.token;
				setTimeout(() => {
					if (cancellation.isCancellationRequested) return;
					void this.updateRichState(current, cancellation);
				}, 100);
			}
		}

		const state = serialize<State>({
			...this.host.baseWebviewState,
			mode: current.mode,
			commit: details,
			navigationStack: current.navigationStack,
			pinned: current.pinned,
			preferences: current.preferences,
			includeRichContent: current.richStateLoaded,
			autolinkedIssues: current.autolinkedIssues?.map(serializeIssueOrPullRequest),
			pullRequest: current.pullRequest != null ? serializePullRequest(current.pullRequest) : undefined,
			wip: serializeWipContext(current.wip),
			orgSettings: current.orgSettings,
		});
		return state;
	}

	@debug({ args: false })
	private async updateWipState(repository: Repository | undefined, onlyOnRepoChange = false): Promise<void> {
		if (this._wipSubscription != null) {
			const { repo, subscription } = this._wipSubscription;
			if (repository?.path !== repo.path) {
				subscription.dispose();
				this._wipSubscription = undefined;
			} else if (onlyOnRepoChange) {
				return;
			}
		}

		let wip: WipContext | undefined = undefined;

		if (repository != null) {
			if (this._wipSubscription == null) {
				this._wipSubscription = { repo: repository, subscription: this.subscribeToRepositoryWip(repository) };
			}

			const changes = await this.getWipChange(repository);
			wip = {
				changes: changes,
				repo: repository,
				repositoryCount: this.container.git.openRepositoryCount,
			};

			if (changes != null) {
				const branchDetails = await this.getWipBranchDetails(repository, changes.branchName);
				if (branchDetails != null) {
					wip.branch = branchDetails.branch;
					wip.pullRequest = branchDetails.pullRequest;
					wip.codeSuggestions = branchDetails.codeSuggestions;
				}
			}

			if (this._pendingContext == null) {
				const success = await this.host.notify(
					DidChangeWipStateNotification,
					serialize({
						wip: serializeWipContext(wip),
					}) as DidChangeWipStateParams,
				);
				if (success) {
					this._context.wip = wip;
					return;
				}
			}
		}

		this.updatePendingContext({ wip: wip });
		this.updateState(true);
	}

	private async getWipBranchDetails(
		repository: Repository,
		branchName: string,
	): Promise<{ branch: GitBranch; pullRequest: PullRequest | undefined; codeSuggestions: Draft[] } | undefined> {
		const branch = await repository.getBranch(branchName);
		if (branch == null) return undefined;

		const pullRequest = await branch.getAssociatedPullRequest();

		const codeSuggestions: Draft[] = [];
		if (pullRequest != null) {
			const results = await this.container.drafts.getCodeSuggestions(pullRequest, repository);
			if (results.length) {
				for (const draft of results) {
					if (draft.author.avatar != null || draft.organizationId == null) continue;
					let email = draft.author.email;
					if (email == null) {
						const user = (
							await this.container.organizations.getOrganizationMembersById(
								[draft.author.id],
								draft.organizationId,
							)
						)[0];
						email = user?.email;
					}
					if (email == null) continue;
					draft.author.avatar = getAvatarUri(email).toString();
				}
				codeSuggestions.push(...results);
			}
		}

		return {
			branch: branch,
			pullRequest: pullRequest,
			codeSuggestions: codeSuggestions,
		};
	}

	@debug({ args: false })
	private async updateRichState(current: Context, cancellation: CancellationToken): Promise<void> {
		const { commit } = current;
		if (commit == null) return;

		const remote = await this.container.git.getBestRemoteWithIntegration(commit.repoPath);

		if (cancellation.isCancellationRequested) return;

		const [enrichedAutolinksResult, prResult] =
			remote?.provider != null
				? await Promise.allSettled([
						configuration.get('views.commitDetails.autolinks.enabled') &&
						configuration.get('views.commitDetails.autolinks.enhanced')
							? pauseOnCancelOrTimeoutMapTuplePromise(commit.getEnrichedAutolinks(remote))
							: undefined,
						configuration.get('views.commitDetails.pullRequests.enabled')
							? commit.getAssociatedPullRequest(remote)
							: undefined,
				  ])
				: [];

		if (cancellation.isCancellationRequested) return;

		const enrichedAutolinks = getSettledValue(enrichedAutolinksResult)?.value;
		const pr = getSettledValue(prResult);

		const formattedMessage = this.getFormattedMessage(commit, remote, enrichedAutolinks);

		this.updatePendingContext({
			richStateLoaded: true,
			formattedMessage: formattedMessage,
			autolinkedIssues:
				enrichedAutolinks != null
					? [...filterMap(enrichedAutolinks.values(), ([issueOrPullRequest]) => issueOrPullRequest?.value)]
					: undefined,
			pullRequest: pr,
		});

		this.updateState();

		// return {
		// 	formattedMessage: formattedMessage,
		// 	pullRequest: pr,
		// 	autolinkedIssues:
		// 		autolinkedIssuesAndPullRequests != null
		// 			? [...autolinkedIssuesAndPullRequests.values()].filter(<T>(i: T | undefined): i is T => i != null)
		// 			: undefined,
		// };
	}

	private _repositorySubscription: RepositorySubscription | undefined;

	private async updateCommit(
		commitish: GitCommit | GitRevisionReference | undefined,
		options?: { force?: boolean; pinned?: boolean; immediate?: boolean; skipStack?: boolean },
	) {
		// this.commits = [commit];
		if (!options?.force && this._context.commit?.sha === commitish?.ref) return;

		let commit: GitCommit | undefined;
		if (isCommit(commitish)) {
			commit = commitish;
		} else if (commitish != null) {
			if (commitish.refType === 'stash') {
				const stash = await this.container.git.getStash(commitish.repoPath);
				commit = stash?.commits.get(commitish.ref);
			} else {
				commit = await this.container.git.getCommit(commitish.repoPath, commitish.ref);
			}
		}

		let wip = this._pendingContext?.wip ?? this._context.wip;

		if (this._repositorySubscription != null) {
			const { repo, subscription } = this._repositorySubscription;
			if (commit?.repoPath !== repo.path) {
				subscription.dispose();
				this._repositorySubscription = undefined;
				wip = undefined;
			}
		}

		if (this._repositorySubscription == null && commit != null) {
			const repo = await this.container.git.getOrOpenRepository(commit.repoPath);
			if (repo != null) {
				this._repositorySubscription = { repo: repo, subscription: this.subscribeToRepositoryWip(repo) };

				if (this.mode === 'wip') {
					void this.updateWipState(repo);
				} else {
					wip = undefined;
				}
			}
		}

		this.updatePendingContext(
			{
				commit: commit,
				richStateLoaded: Boolean(commit?.isUncommitted) || !getContext('gitlens:hasConnectedRemotes'),
				formattedMessage: undefined,
				autolinkedIssues: undefined,
				pullRequest: undefined,
				wip: wip,
			},
			options?.force,
		);

		if (options?.pinned != null) {
			this.updatePinned(options?.pinned);
		}

		if (this.isLineTrackerSuspended) {
			this.ensureTrackers();
		}

		if (commit != null) {
			if (!options?.skipStack) {
				this._commitStack.add(getReferenceFromRevision(commit));
			}

			this.updateNavigation();
		}
		this.updateState(options?.immediate ?? true);
		this.updateTitle();
	}

	private subscribeToRepositoryWip(repo: Repository) {
		return Disposable.from(
			repo.watchFileSystem(1000),
			repo.onDidChangeFileSystem(() => this.onWipChanged(repo)),
			repo.onDidChange(e => {
				if (e.changed(RepositoryChange.Index, RepositoryChangeComparisonMode.Any)) {
					this.onWipChanged(repo);
				}
			}),
		);
	}

	private onWipChanged(repository: Repository) {
		void this.updateWipState(repository);
	}

	private async getWipChange(repository: Repository): Promise<WipChange | undefined> {
		const status = await this.container.git.getStatusForRepo(repository.path);
		if (status == null) return undefined;

		const files: GitFileChangeShape[] = [];
		for (const file of status.files) {
			const change = {
				repoPath: file.repoPath,
				path: file.path,
				status: file.status,
				originalPath: file.originalPath,
				staged: file.staged,
			};

			files.push(change);
			if (file.staged && file.wip) {
				files.push({ ...change, staged: false });
			}
		}

		return {
			repository: {
				name: repository.name,
				path: repository.path,
				uri: repository.uri.toString(),
			},
			branchName: status.branch,
			files: files,
		};
	}

	private updatePinned(pinned: boolean, immediate?: boolean) {
		if (pinned === this._context.pinned) return;

		this._pinned = pinned;
		this.ensureTrackers();

		this.updatePendingContext({ pinned: pinned });
		this.updateState(immediate);
	}

	private updatePreferences(preferences: UpdateablePreferences) {
		if (
			this._context.preferences?.autolinksExpanded === preferences.autolinksExpanded &&
			this._context.preferences?.files?.compact === preferences.files?.compact &&
			this._context.preferences?.files?.icon === preferences.files?.icon &&
			this._context.preferences?.files?.layout === preferences.files?.layout &&
			this._context.preferences?.files?.threshold === preferences.files?.threshold
		) {
			return;
		}

		const changes: Preferences = {
			...this._context.preferences,
			...this._pendingContext?.preferences,
		};

		if (
			preferences.autolinksExpanded != null &&
			this._context.preferences?.autolinksExpanded !== preferences.autolinksExpanded
		) {
			void this.container.storage.storeWorkspace(
				'views:commitDetails:autolinksExpanded',
				preferences.autolinksExpanded,
			);

			changes.autolinksExpanded = preferences.autolinksExpanded;
		}

		if (preferences.files != null) {
			if (this._context.preferences?.files?.compact !== preferences.files?.compact) {
				void configuration.updateEffective('views.commitDetails.files.compact', preferences.files?.compact);
			}
			if (this._context.preferences?.files?.icon !== preferences.files?.icon) {
				void configuration.updateEffective('views.commitDetails.files.icon', preferences.files?.icon);
			}
			if (this._context.preferences?.files?.layout !== preferences.files?.layout) {
				void configuration.updateEffective('views.commitDetails.files.layout', preferences.files?.layout);
			}
			if (this._context.preferences?.files?.threshold !== preferences.files?.threshold) {
				void configuration.updateEffective('views.commitDetails.files.threshold', preferences.files?.threshold);
			}

			changes.files = preferences.files;
		}

		this.updatePendingContext({ preferences: changes });
		this.updateState();
	}

	private updatePendingContext(context: Partial<Context>, force: boolean = false): boolean {
		const [changed, pending] = updatePendingContext(this._context, this._pendingContext, context, force);
		if (changed) {
			this._pendingContext = pending;
		}

		return changed;
	}

	private _notifyDidChangeStateDebounced: Deferrable<() => void> | undefined = undefined;

	private updateState(immediate: boolean = false) {
		if (immediate) {
			void this.notifyDidChangeState();
			return;
		}

		if (this._notifyDidChangeStateDebounced == null) {
			this._notifyDidChangeStateDebounced = debounce(this.notifyDidChangeState.bind(this), 500);
		}

		this._notifyDidChangeStateDebounced();
	}

	private updateNavigation() {
		let sha = this._commitStack.get(this._commitStack.position - 1)?.ref;
		if (sha != null) {
			sha = shortenRevision(sha);
		}
		this.updatePendingContext({
			navigationStack: {
				count: this._commitStack.count,
				position: this._commitStack.position,
				hint: sha,
			},
		});
		this.updateState();
	}

	private notifyEndReview() {
		void this.host.notify(DidChangeDraftStateNotification, { inReview: false });
	}

	private async notifyDidChangeState(force: boolean = false) {
		const scope = getLogScope();

		this._notifyDidChangeStateDebounced?.cancel();
		if (!force && this._pendingContext == null) return false;

		let context: Context;
		if (this._pendingContext != null) {
			context = { ...this._context, ...this._pendingContext };
			this._context = context;
			this._pendingContext = undefined;
		} else {
			context = this._context;
		}

		return window.withProgress({ location: { viewId: this.host.id } }, async () => {
			try {
				await this.host.notify(DidChangeNotification, {
					state: await this.getState(context),
				});
			} catch (ex) {
				Logger.error(scope, ex);
				debugger;
			}
		});
	}

	private getBestCommitOrStash(): GitCommit | GitRevisionReference | undefined {
		if (this._pinned) return undefined;

		let commit;

		if (this.options.attachedTo !== 'graph' && window.activeTextEditor != null) {
			const { lineTracker } = this.container;
			const line = lineTracker.selections?.[0].active;
			if (line != null) {
				commit = lineTracker.getState(line)?.commit;
			}
		} else {
			commit = this._pendingContext?.commit;
			if (commit == null) {
				const args = this.container.events.getCachedEventArgs('commit:selected');
				commit = args?.commit;
			}
		}

		return commit;
	}

	private async getDetailsModel(commit: GitCommit, formattedMessage?: string): Promise<CommitDetails> {
		const [commitResult, avatarUriResult, remoteResult] = await Promise.allSettled([
			!commit.hasFullDetails() ? commit.ensureFullDetails().then(() => commit) : commit,
			commit.author.getAvatarUri(commit, { size: 32 }),
			this.container.git.getBestRemoteWithIntegration(commit.repoPath, { includeDisconnected: true }),
		]);

		commit = getSettledValue(commitResult, commit);
		const avatarUri = getSettledValue(avatarUriResult);
		const remote = getSettledValue(remoteResult);

		if (formattedMessage == null) {
			formattedMessage = this.getFormattedMessage(commit, remote);
		}

		const autolinks =
			commit.message != null ? await this.container.autolinks.getAutolinks(commit.message, remote) : undefined;

		return {
			repoPath: commit.repoPath,
			sha: commit.sha,
			shortSha: commit.shortSha,
			author: { ...commit.author, avatar: avatarUri?.toString(true) },
			// committer: { ...commit.committer, avatar: committerAvatar?.toString(true) },
			message: formattedMessage,
			parents: commit.parents,
			stashNumber: commit.refType === 'stash' ? commit.number : undefined,
			files: commit.files,
			stats: commit.stats,
			autolinks: autolinks != null ? [...map(autolinks.values(), serializeAutolink)] : undefined,
		};
	}

	private getFormattedMessage(
		commit: GitCommit,
		remote: GitRemote | undefined,
		enrichedAutolinks?: Map<string, MaybeEnrichedAutolink>,
	) {
		let message = CommitFormatter.fromTemplate(`\${message}`, commit);
		const index = message.indexOf('\n');
		if (index !== -1) {
			message = `${message.substring(0, index)}${messageHeadlineSplitterToken}${message.substring(index + 1)}`;
		}

		if (!configuration.get('views.commitDetails.autolinks.enabled')) return message;

		return this.container.autolinks.linkify(
			message,
			'html',
			remote != null ? [remote] : undefined,
			enrichedAutolinks,
		);
	}

	private async getFileCommitFromParams(
		params: ExecuteFileActionParams,
	): Promise<[commit: GitCommit, file: GitFileChange] | undefined> {
		let commit: GitCommit | undefined;
		if (this.mode === 'wip') {
			const uri = this._context.wip?.changes?.repository.uri;
			if (uri == null) return;

			commit = await this.container.git.getCommit(Uri.parse(uri), uncommitted);
		} else {
			commit = this._context.commit;
		}

		commit = await commit?.getCommitForFile(params.path, params.staged);
		return commit != null ? [commit, commit.file!] : undefined;
	}

	private showAutolinkSettings() {
		void executeCommand(Commands.ShowSettingsPageAndJumpToAutolinks);
	}

	private showCommitPicker() {
		void executeGitCommand({
			command: 'log',
			state: {
				reference: 'HEAD',
				repo: this._context.commit?.repoPath,
				openPickInView: true,
			},
		});
	}

	private showCommitSearch() {
		void executeGitCommand({ command: 'search', state: { openPickInView: true } });
	}

	private showCommitActions() {
		if (this._context.commit == null || this._context.commit.isUncommitted) return;

		void showDetailsQuickPick(this._context.commit);
	}

	private async showFileActions(params: ExecuteFileActionParams) {
		const result = await this.getFileCommitFromParams(params);
		if (result == null) return;

		const [commit, file] = result;

		this.suspendLineTracker();
		void showDetailsQuickPick(commit, file);
	}

	private switchMode(params: SwitchModeParams) {
		let repo;
		if (params.mode === 'wip') {
			let { repoPath } = params;
			if (repoPath == null) {
				repo = this.container.git.getBestRepositoryOrFirst();
				if (repo == null) return;

				repoPath = repo.path;
			} else {
				repo = this.container.git.getRepository(repoPath)!;
			}
		}

		this.setMode(params.mode, repo);
	}

	private async openFileComparisonWithWorking(params: ExecuteFileActionParams) {
		const result = await this.getFileCommitFromParams(params);
		if (result == null) return;

		const [commit, file] = result;

		this.suspendLineTracker();
		void openChangesWithWorking(file, commit, {
			preserveFocus: true,
			preview: true,
			...this.getShowOptions(params),
		});
	}

	private async openFileComparisonWithPrevious(params: ExecuteFileActionParams) {
		const result = await this.getFileCommitFromParams(params);
		if (result == null) return;

		const [commit, file] = result;

		this.suspendLineTracker();
		void openChanges(file, commit, {
			preserveFocus: true,
			preview: true,
			...this.getShowOptions(params),
		});
		this.container.events.fire('file:selected', { uri: file.uri }, { source: this.host.id });
	}

	private async openFile(params: ExecuteFileActionParams) {
		const result = await this.getFileCommitFromParams(params);
		if (result == null) return;

		const [commit, file] = result;

		this.suspendLineTracker();
		void openFile(file, commit, {
			preserveFocus: true,
			preview: true,
			...this.getShowOptions(params),
		});
	}

	private async openFileOnRemote(params: ExecuteFileActionParams) {
		const result = await this.getFileCommitFromParams(params);
		if (result == null) return;

		const [commit, file] = result;

		void openFileOnRemote(file, commit);
	}

	private async stageFile(params: ExecuteFileActionParams) {
		const result = await this.getFileCommitFromParams(params);
		if (result == null) return;

		const [commit, file] = result;

		await this.container.git.stageFile(commit.repoPath, file.path);
	}

	private async unstageFile(params: ExecuteFileActionParams) {
		const result = await this.getFileCommitFromParams(params);
		if (result == null) return;

		const [commit, file] = result;

		await this.container.git.unstageFile(commit.repoPath, file.path);
	}

	private getShowOptions(params: ExecuteFileActionParams): TextDocumentShowOptions | undefined {
		return params.showOptions;

		// return getContext('gitlens:webview:graph:active') || getContext('gitlens:webview:rebase:active')
		// 	? { ...params.showOptions, viewColumn: ViewColumn.Beside } : params.showOptions;
	}
}

// async function summaryModel(commit: GitCommit): Promise<CommitSummary> {
// 	return {
// 		sha: commit.sha,
// 		shortSha: commit.shortSha,
// 		summary: commit.summary,
// 		message: commit.message,
// 		author: commit.author,
// 		avatar: (await commit.getAvatarUri())?.toString(true),
// 	};
// }

function serializeBranch(branch?: GitBranch): GitBranchShape | undefined {
	if (branch == null) return undefined;

	return {
		name: branch.name,
		repoPath: branch.repoPath,
		upstream: branch.upstream,
		tracking: {
			ahead: branch.state.ahead,
			behind: branch.state.behind,
		},
	};
}

function serializeWipContext(wip?: WipContext): Wip | undefined {
	if (wip == null) return undefined;

	return {
		changes: wip.changes,
		repositoryCount: wip.repositoryCount,
		branch: serializeBranch(wip.branch),
		repo: {
			uri: wip.repo.uri.toString(),
			name: wip.repo.name,
			path: wip.repo.path,
			// type: wip.repo.provider.name,
		},
		pullRequest: wip.pullRequest != null ? serializePullRequest(wip.pullRequest) : undefined,
		codeSuggestions: wip.codeSuggestions?.map(draft => serializeDraft(draft)),
	};
}

function serializeDraft(draft: Draft): Serialized<Draft> {
	return serialize<Draft>(draft);
}
