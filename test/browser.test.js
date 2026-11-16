/**
 * Drives the published report page in a real browser, using the sample data
 * from scripts/preview-fixture.js. Run with `yarn test:browser`.
 *
 * Chrome is found through CHROME_PATH when set, else the "chrome" channel
 * (preinstalled on GitHub-hosted Ubuntu runners).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "preview");
const types = { ".html": "text/html; charset=utf-8", ".md": "text/plain; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

let server;
let browser;
let origin;
const contexts = [];

/** Opens a page of the rendered report and records script errors on it. */
async function open(path = "/base/", { width = 1280, height = 900, colorScheme = "light" } = {}) {
	const context = await browser.newContext({ viewport: { width, height }, colorScheme });
	contexts.push(context);
	const page = await context.newPage();
	page.errors = [];
	page.on("pageerror", (error) => page.errors.push(error.message));
	// Chrome words a failed request as an anonymous console error, so report the URL from the response instead.
	page.on("console", (message) => message.type() === "error" && !message.text().startsWith("Failed to load resource") && page.errors.push(message.text()));
	page.on("response", (response) => response.status() >= 400 && !response.url().endsWith("/favicon.ico") && page.errors.push(`${response.status()} ${response.url()}`));
	await page.goto(origin + path);
	return page;
}

/** Closes a page's context so the next test starts with empty storage. */
const close = (page) => page.context().close();

before(async () => {
	// Render the sample report exactly as `yarn preview` does.
	execFileSync(process.execPath, ["scripts/preview.js"], { cwd: root, stdio: "pipe" });

	server = createServer((req, res) => {
		const file = normalize(join(site, decodeURIComponent(new URL(req.url, "http://x").pathname)));
		const target = existsSync(file) && statSync(file).isDirectory() ? join(file, "index.html") : file;
		if (!file.startsWith(site) || !existsSync(target)) return res.writeHead(404).end();
		res.writeHead(200, { "content-type": types[extname(target)] ?? "application/octet-stream" });
		createReadStream(target).pipe(res);
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	origin = `http://127.0.0.1:${server.address().port}`;

	browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
});

after(async () => {
	await Promise.all(contexts.map((context) => context.close().catch(() => {})));
	await browser?.close();
	await new Promise((done) => server?.close(done));
});

describe("page", () => {
	it("loads without script errors and shows the summary", async () => {
		const page = await open();
		assert.equal(await page.locator(".card").count(), 4);
		const tabs = await page.locator('[role="tab"]').allTextContents();
		assert.equal(tabs.length, 3);
		tabs.forEach((label, i) => assert.match(label, new RegExp(`^${["Overview", "Code", "Visual"][i]}\\d+$`)));
		assert.equal(await page.getAttribute("#tab-overview", "aria-selected"), "true");
		assert.deepEqual(page.errors, []);
		await close(page);
	});

	it("moves between tabs with the arrow keys and opens the tab named in the URL", async () => {
		const page = await open();
		await page.focus("#tab-overview");
		await page.keyboard.press("ArrowRight");
		assert.equal(await page.getAttribute("#tab-code", "aria-selected"), "true");
		assert.equal(await page.evaluate(() => document.activeElement.id), "tab-code");
		await page.keyboard.press("End");
		assert.equal(await page.getAttribute("#tab-visual", "aria-selected"), "true");
		await page.keyboard.press("Home");
		assert.equal(await page.getAttribute("#tab-overview", "aria-selected"), "true");
		await close(page);

		const direct = await open("/base/#visual");
		assert.equal(await direct.getAttribute("#tab-visual", "aria-selected"), "true");
		assert.equal(await direct.locator("#panel-visual").isVisible(), true);
		await close(direct);
	});

	it("is usable on a phone and in the dark scheme", async () => {
		const phone = await open("/base/", { width: 390, height: 844 });
		for (const tab of ["overview", "code", "visual"]) {
			await phone.click(`#tab-${tab}`);
			assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tab} scrolls sideways`);
		}
		await close(phone);

		const light = await open();
		const dark = await open("/base/", { colorScheme: "dark" });
		const background = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
		assert.notEqual(await background(light), await background(dark));
		await close(light);
		await close(dark);
	});

	it("also renders when there is no base to compare against", async () => {
		const page = await open("/no-base/");
		assert.equal(await page.locator("th", { hasText: "Base" }).count(), 0);
		assert.deepEqual(page.errors, []);
		await close(page);
	});
});

describe("overview", () => {
	it("links each row to its own diff, not another file that ends the same way", async () => {
		const page = await open();
		// `index.js` exists under two packages' dist folders; the link must reach the one in core.
		const target = await page.evaluate(() => {
			const link = [...document.querySelectorAll(".sizes a")].find((a) => a.textContent === "index.js");
			const section = document.getElementById(link.hash.slice(1));
			return section.querySelector(".path").textContent;
		});
		assert.match(target, /packages\/core\/dist\/index\.js$/);

		await page.click('.sizes a:text-is("rules.css")');
		assert.equal(await page.getAttribute("#tab-code", "aria-selected"), "true");
		const rules = page.locator(".file", { hasText: "rules.css" });
		assert.equal(await rules.locator("details").evaluate((d) => d.open), true);
		assert.ok((await rules.locator(".rendered tr").count()) > 0);
		await close(page);
	});
});

describe("code", () => {
	it("builds rows only for files that are open", async () => {
		const page = await open("/base/#code");
		const medium = page.locator(".file", { hasText: "medium.js" });
		assert.equal(await medium.locator("details").evaluate((d) => d.open), false);
		assert.equal(await medium.locator(".rendered").count(), 0);

		await medium.locator("summary").click();
		await medium.locator(".rendered tr").first().waitFor();
		assert.ok((await medium.locator(".rendered tr").count()) > 900);
		await close(page);
	});

	it("pairs edited lines in the split view and marks only the changed words", async () => {
		const page = await open("/base/#code");
		await page.click('button[data-view="split"]');
		const rules = page.locator(".file", { hasText: "rules.css" });
		const rows = await rules.locator("tr").evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td.code")].map((td) => td.textContent.trim())));
		assert.deepEqual(rows.slice(1), [
			[".a{color:red}", ""],
			[".b{color:blue}", ".b{color:green}"],
			["", ".c{margin:0}"],
			[".shared{margin:0}", ".shared{margin:0}"],
		]);
		assert.deepEqual(await rules.locator("mark").allTextContents(), ["blue", "green"]);

		await page.click('button[data-view="unified"]');
		assert.equal(await rules.locator("table.unified").count(), 1);
		assert.equal(await rules.locator("table.split").count(), 0);
		await close(page);
	});

	it("remembers the layout across a reload", async () => {
		const page = await open("/base/#code");
		await page.click('button[data-view="split"]');
		await page.reload();
		assert.equal(await page.getAttribute('button[data-view="split"]', "aria-pressed"), "true");
		assert.ok((await page.locator("table.split").count()) > 0);
		await close(page);
	});

	it("says why a diff is missing and keeps counts for the ones left out", async () => {
		const page = await open("/base/#code");
		const notes = await page.locator(".file .note").allTextContents();
		assert.ok(notes.some((note) => note.includes("binary file")));
		assert.ok(notes.some((note) => note.includes("exceeds max-diff-size")));
		assert.ok(notes.some((note) => note.includes("diff budget (2,500 lines)")));
		const large = page.locator(".file", { hasText: "zz-large.js" });
		assert.match(await large.locator("summary .meta").textContent(), /\+1499\s+−1499/);
		await close(page);
	});

	it("expands and collapses every file", async () => {
		const page = await open("/base/#code");
		const toggle = page.locator('[data-action="collapse"]');
		assert.equal(await toggle.textContent(), "Expand all");
		await toggle.click();
		assert.equal(await page.locator(".file details:not([open])").count(), 0);
		assert.equal(await toggle.textContent(), "Collapse all");
		await toggle.click();
		assert.equal(await page.locator(".file details[open]").count(), 0);
		assert.deepEqual(page.errors, []);
		await close(page);
	});
});

describe("visual", () => {
	/** Opens the Visual tab and selects the second image (logo.png, which has both versions). */
	async function openLogo() {
		const page = await open("/base/#visual");
		await page.click(".filelist button >> nth=1");
		return page;
	}

	it("overlays head on base with an opacity slider", async () => {
		const page = await openLogo();
		await page.click('button[data-mode="overlay"]');
		await page.locator('input[data-control="opacity"]').fill("80");
		assert.equal(await page.locator(".viewer").evaluate((el) => el.style.getPropertyValue("--opacity")), "0.8");
		assert.equal(await page.locator("#img-1 .layer.head").evaluate((el) => getComputedStyle(el).opacity), "0.8");
		await close(page);
	});

	it("swipes by dragging on the image and stops following the pointer when released", async () => {
		const page = await openLogo();
		await page.click('button[data-mode="swipe"]');
		const box = await page.locator("#img-1 .layers").boundingBox();
		const position = () => page.locator('input[data-control="pos"]').inputValue();

		await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
		await page.mouse.up();
		const released = Number(await position());
		assert.ok(Math.abs(released - 25) <= 2, `swipe at ${released}%`);

		await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
		assert.equal(Number(await position()), released);

		await page.locator('input[data-control="pos"]').fill("70");
		assert.equal(await page.locator(".viewer").evaluate((el) => el.style.getPropertyValue("--pos")), "70%");
		await close(page);
	});

	it("blends the versions for a difference view", async () => {
		const page = await openLogo();
		await page.click('button[data-mode="diff"]');
		assert.equal(await page.locator("#img-1 .layer.head").evaluate((el) => getComputedStyle(el).mixBlendMode), "difference");
		await close(page);
	});

	it("switches images with J and K and the pager", async () => {
		const page = await open("/base/#visual");
		const count = page.locator(".pager-count");
		assert.equal(await count.textContent(), "1 of 4");
		await page.keyboard.press("j");
		assert.equal(await count.textContent(), "2 of 4");
		await page.keyboard.press("k");
		assert.equal(await count.textContent(), "1 of 4");
		await page.click('[data-step="-1"]');
		assert.equal(await count.textContent(), "4 of 4");
		await close(page);
	});

	it("disables compare modes for an image with only one version", async () => {
		const page = await open("/base/#visual");
		await page.click(".filelist button >> nth=2"); // hero.png, added
		assert.equal(await page.getAttribute('button[data-mode="overlay"]', "aria-disabled"), "true");
		await page.click('button[data-mode="overlay"]', { force: true });
		assert.equal(await page.locator(".viewer").getAttribute("data-mode"), "side");
		await close(page);
	});

	it("fits images to the stage and zooms by whole steps", async () => {
		const page = await openLogo();
		const width = () => page.locator("#img-1 .layer.head img").evaluate((img) => img.getBoundingClientRect().width);
		const stage = await page.locator("#img-1 .stage").evaluate((el) => el.clientWidth);
		assert.ok((await width()) <= stage);
		await page.click('button[data-zoom="2"]');
		assert.equal(await width(), 192);
		await page.click('button[data-zoom="1"]');
		assert.equal(await width(), 96);
		assert.deepEqual(page.errors, []);
		await close(page);
	});
});
