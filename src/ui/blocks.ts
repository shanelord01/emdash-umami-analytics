/**
 * The handful of Block Kit constructors this plugin needs.
 *
 * Why not `blocks`/`elements` from `@emdash-cms/blocks/server`? Because
 * importing them puts the package in the *runtime* bundle, and the plugin
 * build inlines everything with `external: []`, so a self-contained
 * helper library would be carried into a bundle that has a 384 KiB gzip
 * ceiling. With pnpm's symlinked store the probe build also failed to
 * resolve it at all.
 *
 * The safety those builders provide is not the function calls, it is
 * getting `block_id` / `action_id` / `empty_text` right — the renderer
 * reads snake_case and silently ignores camelCase, which is the live bug
 * in upstream's own `audit-log` widget, where "Load more" and the empty
 * text never appear. That safety is preserved two ways here:
 *
 * 1. Every return type is upstream's own block interface, imported as a
 *    **type only** so it is erased before bundling. A wrong key is a
 *    compile error, not a silent no-op.
 * 2. The tests run upstream's real `validateBlocks()` — the same function
 *    the host uses to reject a bad response — over what `renderWidget`
 *    actually produces. That is a stronger check than calling a builder
 *    and trusting it, and it is where the dependency belongs: in
 *    devDependencies.
 */

import type { BannerBlock, ChartBlock, ChartSeries, CodeBlock, MeterBlock } from "@emdash-cms/blocks";
import type {
	ActionElement,
	ActionsBlock,
	ButtonElement,
	ColumnsBlock,
	ContextBlock,
	HeaderBlock,
	LinkElement,
	LinkTarget,
	SelectElement,
	StatItem,
	StatsBlock,
	TableBlock,
	TableColumn,
} from "@emdash-cms/blocks/server";

export function stats(items: StatItem[], opts?: { blockId?: string }): StatsBlock {
	return {
		type: "stats",
		items,
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function context(text: string, opts?: { blockId?: string }): ContextBlock {
	return {
		type: "context",
		text,
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function actions(elements: ActionElement[], opts?: { blockId?: string }): ActionsBlock {
	return {
		type: "actions",
		elements,
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function button(
	actionId: string,
	label: string,
	opts?: { style?: "primary" | "danger" | "secondary"; value?: unknown },
): ButtonElement {
	return {
		type: "button",
		action_id: actionId,
		label,
		...(opts?.style !== undefined && { style: opts.style }),
		...(opts?.value !== undefined && { value: opts.value }),
	};
}

export function link(
	label: string,
	target: LinkTarget,
	opts?: { appearance?: "inline" | "primary" | "secondary" },
): LinkElement {
	return {
		type: "link",
		label,
		target,
		...(opts?.appearance !== undefined && { appearance: opts.appearance }),
	};
}

export function select(
	actionId: string,
	label: string,
	options: Array<{ label: string; value: string }>,
	opts?: { initialValue?: string },
): SelectElement {
	return {
		type: "select",
		action_id: actionId,
		label,
		options,
		...(opts?.initialValue !== undefined && { initial_value: opts.initialValue }),
	};
}

export function banner(opts: {
	title?: string;
	description?: string;
	variant?: "default" | "alert" | "error";
	blockId?: string;
}): BannerBlock {
	return {
		type: "banner",
		...(opts.title !== undefined && { title: opts.title }),
		...(opts.description !== undefined && { description: opts.description }),
		...(opts.variant !== undefined && { variant: opts.variant }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function code(text: string, opts?: { language?: CodeBlock["language"]; blockId?: string }): CodeBlock {
	return {
		type: "code",
		code: text,
		...(opts?.language !== undefined && { language: opts.language }),
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function header(text: string, opts?: { blockId?: string }): HeaderBlock {
	return {
		type: "header",
		text,
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function columns(cols: AnalyticsBlock[][], opts?: { blockId?: string }): ColumnsBlock {
	return {
		type: "columns",
		columns: cols as ColumnsBlock["columns"],
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

/**
 * Series colours, in the order of the host's own categorical palette
 * (kumo's light theme), each with the catalogue key of its name.
 *
 * EmDash draws no legend: its chart block registers no ECharts legend
 * component, and a timeseries chart takes no options beyond its series. So
 * a chart with more than one series says in a line of text below it which
 * colour is which (`chartKey`), and each series is given its colour
 * explicitly, so that line stays true if the host's palette changes.
 */
export const SERIES_COLOURS = [
	{ hex: "#4290F0", name: "colourBlue" },
	{ hex: "#F5B647", name: "colourYellow" },
	{ hex: "#E8649D", name: "colourPink" },
	{ hex: "#8D58EE", name: "colourPurple" },
	{ hex: "#50C3B6", name: "colourTeal" },
	{ hex: "#D37536", name: "colourOrange" },
] as const;

/** The series with `SERIES_COLOURS` assigned in order. */
export function coloured(series: ChartSeries[]): ChartSeries[] {
	return series.map((s, i) => ({ ...s, color: SERIES_COLOURS[i % SERIES_COLOURS.length]!.hex }));
}

export function timeseries(
	series: ChartSeries[],
	opts?: { blockId?: string; height?: number; style?: "line" | "bar"; gradient?: boolean; yAxisName?: string },
): ChartBlock {
	return {
		type: "chart",
		config: {
			chart_type: "timeseries",
			series,
			...(opts?.style !== undefined && { style: opts.style }),
			...(opts?.yAxisName !== undefined && { y_axis_name: opts.yAxisName }),
			...(opts?.height !== undefined && { height: opts.height }),
			...(opts?.gradient !== undefined && { gradient: opts.gradient }),
		},
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function meter(opts: { label: string; value: number; max?: number; customValue?: string; blockId?: string }): MeterBlock {
	return {
		type: "meter",
		label: opts.label,
		value: opts.value,
		...(opts.max !== undefined && { max: opts.max }),
		...(opts.customValue !== undefined && { custom_value: opts.customValue }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function table(opts: {
	blockId?: string;
	columns: TableColumn[];
	rows: Array<Record<string, unknown>>;
	pageActionId: string;
	nextCursor?: string;
	emptyText?: string;
}): TableBlock {
	return {
		type: "table",
		columns: opts.columns,
		rows: opts.rows,
		page_action_id: opts.pageActionId,
		...(opts.nextCursor !== undefined && { next_cursor: opts.nextCursor }),
		...(opts.emptyText !== undefined && { empty_text: opts.emptyText }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

/**
 * `empty` is not in the server export's published type list on 0.38.0,
 * although the renderer and the validator both accept it. Typed locally
 * against the validator's expectations rather than left out, because "no
 * data yet, and here is why" is the most important thing this widget says
 * on a fresh install.
 */
export interface EmptyBlockShape {
	type: "empty";
	title?: string;
	description?: string;
	actions?: ActionElement[];
	block_id?: string;
}

export function empty(opts: {
	title?: string;
	description?: string;
	actions?: ActionElement[];
	blockId?: string;
}): EmptyBlockShape {
	return {
		type: "empty",
		...(opts.title !== undefined && { title: opts.title }),
		...(opts.description !== undefined && { description: opts.description }),
		...(opts.actions !== undefined && { actions: opts.actions }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

/** Every block shape this plugin can emit. */
export type AnalyticsBlock =
	| StatsBlock
	| ContextBlock
	| ActionsBlock
	| TableBlock
	| EmptyBlockShape
	| HeaderBlock
	| ColumnsBlock
	| ChartBlock
	| BannerBlock
	| CodeBlock
	| MeterBlock;
