import { App, Modal, ProgressBarComponent } from "obsidian";

/**
 * Shows export progress in main.ts's runExport(): an indeterminate
 * (animated, no known duration) bar while the SvelteKit project is being
 * scaffolded/npm-installed, then a determinate bar for the per-file export
 * loop, whose total is known upfront. Obsidian already renders a built-in
 * close (×) button on every Modal, so dismissing this early is harmless —
 * it only hides the UI, the export itself keeps running to completion.
 */
export class ExportProgressModal extends Modal {
	private total: number;
	private progressBar: ProgressBarComponent;
	private indeterminateEl: HTMLElement;
	private countEl: HTMLElement;
	private detailEl: HTMLElement;

	constructor(app: App, total: number) {
		super(app);
		this.total = total;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("Exporting to Svelte…");

		this.countEl = contentEl.createDiv({ cls: "svelte-exporter-progress-count" });

		const barWrapEl = contentEl.createDiv({ cls: "svelte-exporter-progress-bar" });
		this.progressBar = new ProgressBarComponent(barWrapEl);
		this.progressBar.setValue(0);
		this.indeterminateEl = barWrapEl.createDiv({
			cls: "svelte-exporter-progress-indeterminate",
		});

		this.detailEl = contentEl.createDiv({ cls: "svelte-exporter-progress-detail" });

		this.setPreparing("Preparing…");
	}

	/** Scaffolding phase: duration is unknown, so animate instead of filling. */
	setPreparing(label: string) {
		this.countEl.setText(label);
		this.detailEl.setText("This can take a minute on the first export.");
		this.progressBar.setValue(0);
		this.indeterminateEl.show();
	}

	/** Per-file export loop: total is known, so show real progress. */
	update(current: number, filePath: string) {
		this.indeterminateEl.hide();
		this.countEl.setText(`${current} / ${this.total}`);
		this.progressBar.setValue(this.total ? (current / this.total) * 100 : 100);
		this.detailEl.setText(filePath);
	}

	finish(summary: string) {
		this.indeterminateEl.hide();
		this.progressBar.setValue(100);
		this.countEl.setText(summary);
		this.detailEl.setText("");
	}

	onClose() {
		this.contentEl.empty();
	}
}
