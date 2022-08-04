import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import './codicon';

@customElement('webview-pane')
export class WebviewPane extends LitElement {
	static override styles = css`
		:host {
			display: flex;
			flex-direction: column;
			background-color: var(--color-view-background);
		}

		* {
			box-sizing: border-box;
		}

		.header {
			flex: none;
			display: flex;
			background-color: var(--color-view-background);
			color: var(--vscode-foreground);
			border-top: 1px solid var(--vscode-panel-border);
		}

		.header:focus-within {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}

		.label {
			appearance: none;
			display: flex;
			flex-direction: row;
			align-items: center;
			width: 100%;
			padding: 0;
			border: none;
			text-align: left;
			font-family: var(--font-family);
			font-size: 1.1rem;
			line-height: 2.2rem;
			height: 2.2rem;
			background: transparent;
			color: inherit;
			cursor: pointer;
			outline: none;
			text-overflow: ellipsis;
		}

		.title {
			font-weight: bold;
			text-transform: uppercase;
		}

		.subtitle {
			margin-left: 0.5rem;
			color: var(--vscode-descriptionForeground);
		}

		.icon {
			font-weight: normal;
			margin: 0 0.2rem;
		}

		.content {
			overflow: auto;
			/*
			scrollbar-gutter: stable;
			box-shadow: #000000 0 0.6rem 0.6rem -0.6rem inset;
			*/
			padding-top: 0.6rem;
		}

		:host([collapsable]:not([expanded])) .content {
			display: none;
		}
	`;

	@property({ type: Boolean, reflect: true })
	collapsable = false;

	@property({ type: Boolean, reflect: true })
	expanded = false;

	renderTitle() {
		if (!this.collapsable) {
			return html`<div class="label">
				<span class="title"><slot name="title">Section</slot></span>
				<span class="subtitle"><slot name="subtitle"></slot></span>
			</div>`;
		}
		return html`<button
			type="button"
			class="label"
			aria-controls="content"
			aria-expanded=${this.expanded}
			@click="${this.toggleExpanded}"
		>
			<code-icon class="icon" icon=${this.expanded ? 'chevron-down' : 'chevron-right'}></code-icon
			><span class="title"><slot name="title">Section</slot></span>
			<span class="subtitle"><slot name="subtitle"></slot></span>
		</button>`;
	}

	override render() {
		return html`
			<header class="header">${this.renderTitle()}</header>
			<div id="content" role="region" class="content">
				<slot></slot>
			</div>
		`;
	}

	private toggleExpanded() {
		this.expanded = !this.expanded;
	}
}
