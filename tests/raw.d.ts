/** Vite's `?raw` imports: a file's text, which the tests read without a file system. */
declare module "*?raw" {
	const text: string;
	export default text;
}

/** Vite's `import.meta.glob`, in the eager `?raw` form the docs test uses. */
interface ImportMeta {
	glob<T>(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, T>;
}
