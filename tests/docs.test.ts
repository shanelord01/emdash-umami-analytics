import { describe, expect, it } from "vitest";

import manifestText from "../emdash-plugin.jsonc?raw";

/**
 * The registry page's tabs and the manifest description, against the caps
 * the registry enforces. Files come in as Vite `?raw` imports, since the
 * suite runs inside workerd. The glob picks up every file in the folder, so
 * a tab added there without a `sections` entry fails below.
 */

const FILES: Record<string, string> = Object.fromEntries(
	Object.entries(
		import.meta.glob<string>("../docs/registry/*.md", { query: "?raw", import: "default", eager: true }),
	).map(([path, text]) => [path.replace(/^\.\.\//, ""), text]),
);

/** JSON with comments and trailing commas, as `emdash-plugin.jsonc` is written. */
function parseJsonc(text: string): unknown {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (c === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2) + 1;
		} else out += c;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function manifest(): Record<string, unknown> {
	return parseJsonc(manifestText) as Record<string, unknown>;
}

function graphemes(text: string): number {
	let n = 0;
	for (const _ of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)) n++;
	return n;
}

describe("the manifest description", () => {
	// The registry refuses one over 140 graphemes; `emdash-plugin validate` does not check it.
	it("is at most 140 graphemes", () => {
		const text = manifest().description;
		expect(typeof text).toBe("string");
		expect(graphemes(text as string)).toBeLessThanOrEqual(140);
	});
});

describe("the registry page's sections", () => {
	const sections = manifest().sections as Record<string, { file: string }>;

	it("declares all five, each as a file inside the repository", () => {
		expect(Object.keys(sections).sort()).toEqual(["changelog", "description", "faq", "installation", "security"]);
		for (const [key, value] of Object.entries(sections)) {
			expect(value.file, key).toMatch(/^docs\/registry\/[a-z]+\.md$/);
		}
	});

	it("references every file in docs/registry", () => {
		const referenced = Object.values(sections).map((value) => value.file);
		expect(referenced.sort()).toEqual(Object.keys(FILES).sort());
	});

	for (const key of ["description", "installation", "faq", "changelog", "security"]) {
		it(`keeps ${key} inside the registry's caps of 20000 bytes and 2000 graphemes`, () => {
			const text = FILES[sections[key]!.file];
			expect(text, sections[key]!.file).toBeDefined();
			expect(text!.trim().length).toBeGreaterThan(200);
			expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(20_000);
			expect(graphemes(text!)).toBeLessThanOrEqual(2_000);
		});
	}
});
