/* Browser script for the visual diff page (inlined by page.js). */
(() => {
	const $ = (sel, root = document) => root.querySelector(sel);
	const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
	const store = {
		get(key) {
			try {
				return localStorage.getItem(`file-diff:${key}`);
			} catch {
				return null;
			}
		},
		set(key, value) {
			try {
				localStorage.setItem(`file-diff:${key}`, value);
			} catch {
				// Storage blocked; the choice still applies to this view.
			}
		},
	};

	const code = $(".code-main");

	/** Index an arrow, Home or End key moves to in a horizontal list, or undefined for other keys. */
	function targetIndex(key, i, length, rtl) {
		const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[key];
		if (step) return (i + step + length) % length;
		if (key === "Home") return 0;
		if (key === "End") return length - 1;
		return undefined;
	}

	/* ---- Tabs: selection follows focus, roving tabindex ------------------ */
	const tablist = $('[role="tablist"]');
	const tabs = $$('[role="tab"]', tablist);
	const panelFor = (tab) => document.getElementById(tab.id.replace(/^tab-/, "panel-"));

	function selectTab(tab, { focus = false, push = true } = {}) {
		tabs.forEach((t) => {
			const on = t === tab;
			t.setAttribute("aria-selected", String(on));
			t.tabIndex = on ? 0 : -1;
			const panel = panelFor(t);
			if (on) panel.removeAttribute("hidden");
			else panel.setAttribute("hidden", "until-found");
		});
		if (focus) tab.focus();
		tab.scrollIntoView({ block: "nearest", inline: "nearest" });
		if (push) history.replaceState(null, "", `#${tab.id.slice(4)}`);
	}

	tablist.addEventListener("click", (e) => {
		const tab = e.target.closest('[role="tab"]');
		if (tab) selectTab(tab);
	});
	tablist.addEventListener("keydown", (e) => {
		const i = tabs.indexOf(document.activeElement);
		const next = i < 0 ? undefined : targetIndex(e.key, i, tabs.length, getComputedStyle(tablist).direction === "rtl");
		if (next === undefined) return;
		e.preventDefault();
		selectTab(tabs[next], { focus: true });
	});
	// Find-in-page revealed a hidden panel: select its tab.
	$$('[role="tabpanel"]').forEach((panel) =>
		panel.addEventListener("beforematch", () => {
			const tab = document.getElementById(panel.getAttribute("aria-labelledby"));
			if (tab) selectTab(tab, { push: false });
		}),
	);

	/** Shows the tab holding an element, then scrolls to it. */
	function reveal(el) {
		const panel = el.closest('[role="tabpanel"]');
		const tab = panel && document.getElementById(panel.getAttribute("aria-labelledby"));
		if (tab && tab.getAttribute("aria-selected") !== "true") selectTab(tab, { push: false });
		const details = el.querySelector("details");
		if (details) {
			details.open = true;
			renderFile(el);
		}
		el.scrollIntoView({ block: "start" });
	}

	document.addEventListener("click", (e) => {
		const link = e.target.closest('a[href^="#f-"]');
		if (!link) return;
		const target = document.getElementById(link.hash.slice(1));
		if (!target) return;
		e.preventDefault();
		reveal(target);
		history.replaceState(null, "", link.hash);
	});

	/* ---- Toolbars: one tab stop, arrow keys move (focusgroup fallback) --- */
	$$('[role="toolbar"]').forEach((bar) => {
		if ("focusGroup" in HTMLElement.prototype) return bar.setAttribute("focusgroup", "toolbar wrap");
		const items = () => $$("button", bar);
		items().forEach((b, i) => (b.tabIndex = i ? -1 : 0));
		bar.addEventListener("focusin", ({ target }) => {
			if (items().includes(target)) items().forEach((b) => (b.tabIndex = b === target ? 0 : -1));
		});
		bar.addEventListener("keydown", (e) => {
			const list = items();
			const i = list.indexOf(document.activeElement);
			const next = i < 0 ? undefined : targetIndex(e.key, i, list.length, getComputedStyle(bar).direction === "rtl");
			if (next === undefined) return;
			e.preventDefault();
			list[next].focus();
		});
	});

	/** Presses one button in a segmented group. */
	function press(group, button) {
		$$("button", group).forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
	}

	/* ---- Code: rows are built from JSON when a file opens ----------------- */
	const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
	const esc = (text) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

	/** Escapes a line, wrapping the changed `[start, end, …]` ranges in <mark>. */
	function markup(text, ranges) {
		if (!ranges) return esc(text);
		let out = "";
		let at = 0;
		for (let k = 0; k < ranges.length; k += 2) {
			out += `${esc(text.slice(at, ranges[k]))}<mark>${esc(text.slice(ranges[k], ranges[k + 1]))}</mark>`;
			at = ranges[k + 1];
		}
		return out + esc(text.slice(at));
	}

	/** Old and new line numbers for every line of a hunk (null where a side has none). */
	function numbers({ o, n, l }) {
		let oldNo = o;
		let newNo = n;
		return l.map((line) => (line[0] === "-" ? [oldNo++, null] : line[0] === "+" ? [null, newNo++] : line[0] === "\\" ? [null, null] : [oldNo++, newNo++]));
	}

	const metaRow = (line, cols) => `<tr class="meta"><td colspan="${cols}">${esc(line)}</td></tr>`;

	function unifiedRows(hunk) {
		const nos = numbers(hunk);
		const rows = [`<tr class="hunk"><td colspan="3">${esc(hunk.h)}</td></tr>`];
		hunk.l.forEach((line, i) => {
			const sign = line[0];
			if (sign === "\\") return rows.push(metaRow(line, 3));
			const kind = sign === "-" ? "del" : sign === "+" ? "add" : "ctx";
			rows.push(`<tr class="${kind}"><td class="ln">${nos[i][0] ?? ""}</td><td class="ln">${nos[i][1] ?? ""}</td><td class="code"><span class="sign">${sign}</span>${markup(line.slice(1), hunk.m[i])}</td></tr>`);
		});
		return rows;
	}

	const EMPTY_CELLS = '<td class="ln empty"></td><td class="code empty"></td>';

	/** Side-by-side rows. Edited line pairs share a row; other changes fill the gaps between them. */
	function splitRows(hunk) {
		const nos = numbers(hunk);
		const pairOf = new Map(hunk.p);
		const cells = (i, kind, no) => (i < 0 ? EMPTY_CELLS : `<td class="ln ${kind}">${no}</td><td class="code ${kind}">${markup(hunk.l[i].slice(1), hunk.m[i])}</td>`);
		const rows = [`<tr class="hunk"><td colspan="4">${esc(hunk.h)}</td></tr>`];

		for (let i = 0; i < hunk.l.length; ) {
			const sign = hunk.l[i][0];
			if (sign === "\\") {
				rows.push(metaRow(hunk.l[i++], 4));
			} else if (sign !== "-" && sign !== "+") {
				const text = markup(hunk.l[i].slice(1));
				rows.push(`<tr class="ctx"><td class="ln">${nos[i][0]}</td><td class="code">${text}</td><td class="ln">${nos[i][1]}</td><td class="code">${text}</td></tr>`);
				i++;
			} else {
				const dels = [];
				const adds = [];
				const notes = [];
				while (hunk.l[i]?.[0] === "-") dels.push(i++);
				while (hunk.l[i]?.[0] === "\\") notes.push(i++);
				while (hunk.l[i]?.[0] === "+") adds.push(i++);

				const pairs = [];
				let di = 0;
				let ai = 0;
				const fill = (dEnd, aEnd) => {
					for (let k = 0, n = Math.max(dEnd - di, aEnd - ai); k < n; k++) pairs.push([di + k < dEnd ? dels[di + k] : -1, ai + k < aEnd ? adds[ai + k] : -1]);
					di = dEnd;
					ai = aEnd;
				};
				dels.forEach((d, dPos) => {
					const aPos = adds.indexOf(pairOf.get(d));
					if (aPos < ai) return;
					fill(dPos, aPos);
					pairs.push([d, adds[aPos]]);
					di = dPos + 1;
					ai = aPos + 1;
				});
				fill(dels.length, adds.length);

				pairs.forEach(([d, a]) => rows.push(`<tr>${cells(d, "del", nos[d]?.[0])}${cells(a, "add", nos[a]?.[1])}</tr>`));
				notes.forEach((n) => rows.push(metaRow(hunk.l[n], 4)));
			}
		}
		return rows;
	}

	const parsed = new WeakMap();

	/** Builds a file's diff table for the current layout, once per layout. */
	function renderFile(section) {
		const scroll = section && $(".diff-scroll", section);
		if (!scroll || !code) return;
		const view = code.dataset.view;
		if (scroll.dataset.view === view) return;
		if (!parsed.has(scroll)) parsed.set(scroll, JSON.parse($('script[type="application/json"]', scroll).textContent));
		const rows = parsed.get(scroll).flatMap((hunk) => (view === "split" ? splitRows(hunk) : unifiedRows(hunk)));
		const table = view === "split" ? `<table class="diff split"><colgroup><col class="ln-col"><col><col class="ln-col"><col></colgroup>${rows.join("")}</table>` : `<table class="diff unified">${rows.join("")}</table>`;
		$(".rendered", scroll)?.remove();
		scroll.insertAdjacentHTML("beforeend", `<div class="rendered">${table}</div>`);
		scroll.dataset.view = view;
	}

	if (code) {
		const sections = $$(".file", code);
		const renderOpen = () => sections.filter((section) => $("details", section).open).forEach(renderFile);
		const layout = $('[aria-label="Diff layout"]', code);
		const collapse = $('[data-action="collapse"]', code);
		const syncCollapse = () => (collapse.textContent = sections.every((section) => $("details", section).open) ? "Collapse all" : "Expand all");

		const setView = (view) => {
			code.dataset.view = view;
			press(layout, $(`button[data-view="${view}"]`, code));
			renderOpen();
		};

		layout.addEventListener("click", (e) => {
			const b = e.target.closest("button[data-view]");
			if (!b) return;
			setView(b.dataset.view);
			store.set("view", b.dataset.view);
		});
		collapse.addEventListener("click", () => {
			const open = collapse.textContent.startsWith("Expand");
			sections.forEach((section) => ($("details", section).open = open));
			syncCollapse();
		});
		// `toggle` doesn't bubble, so listen while it travels down.
		code.addEventListener(
			"toggle",
			(e) => {
				if (e.target.open) renderFile(e.target.closest(".file"));
				syncCollapse();
			},
			true,
		);

		setView(store.get("view") === "split" ? "split" : "unified");
		syncCollapse();
	}

	/* ---- Visual: modes, sliders, swipe drag, zoom, pager ----------------- */
	const viewer = $(".viewer");
	if (viewer) {
		const items = $$(".image-item", viewer);
		const listButtons = $$(".filelist button", viewer.parentElement);
		const modes = $(".modes", viewer);
		let index = 0;

		const current = () => items[index];

		const FIT_HEIGHT = 420;

		/** Sizes both versions by one scale so stacked modes stay aligned. Fit fills the stage. */
		function applyZoom() {
			const item = current();
			const imgs = $$("img", item);
			if (!imgs.every((img) => img.complete && img.naturalWidth)) {
				imgs.forEach((img) => img.addEventListener("load", applyZoom, { once: true }));
				return;
			}
			const zoom = viewer.dataset.zoom;
			let scale = Number(zoom);
			if (zoom === "fit") {
				const stage = $(".stage", item);
				const pad = parseFloat(getComputedStyle(stage).paddingLeft) * 2;
				const columns = viewer.dataset.mode === "side" && !item.hasAttribute("data-single") ? 2 : 1;
				const width = (stage.clientWidth - pad - (columns - 1) * 16) / columns;
				// The stage has no size while its tab is hidden; the ResizeObserver reruns this once it shows.
				if (width <= 0) return;
				const maxW = Math.max(...imgs.map((img) => img.naturalWidth));
				const maxH = Math.max(...imgs.map((img) => img.naturalHeight));
				scale = Math.min(width / maxW, FIT_HEIGHT / maxH);
			}
			imgs.forEach((img) => {
				img.style.inlineSize = `${Math.round(img.naturalWidth * scale)}px`;
				img.classList.toggle("upscaled", scale > 1);
			});
		}
		new ResizeObserver(() => viewer.dataset.zoom === "fit" && applyZoom()).observe(viewer);

		function syncModes() {
			const single = current().hasAttribute("data-single");
			$$("button", modes).forEach((b) => {
				if (b.dataset.mode === "side") return;
				if (single) b.setAttribute("aria-disabled", "true");
				else b.removeAttribute("aria-disabled");
			});
		}

		function show(i) {
			index = (i + items.length) % items.length;
			items.forEach((item, k) => (item.hidden = k !== index));
			listButtons.forEach((b, k) => (k === index ? b.setAttribute("aria-current", "true") : b.removeAttribute("aria-current")));
			$(".pager-count", viewer).textContent = `${index + 1} of ${items.length}`;
			syncModes();
			applyZoom();
		}

		// Natural dimensions under each image header.
		items.forEach((item) =>
			$$("img", item).forEach((img) => {
				const write = () => {
					const out = $(`[data-dims="${img.dataset.side}"]`, item);
					if (out) out.textContent = `${img.dataset.side} ${img.naturalWidth}×${img.naturalHeight}`;
				};
				if (img.complete && img.naturalWidth) write();
				else img.addEventListener("load", write, { once: true });
			}),
		);

		$(".toolbar", viewer).addEventListener("click", (e) => {
			const b = e.target.closest("button");
			if (!b || b.getAttribute("aria-disabled") === "true") return;
			for (const key of ["mode", "bg", "zoom"]) {
				if (b.dataset[key] === undefined) continue;
				viewer.dataset[key] = b.dataset[key];
				press(b.parentElement, b);
				if (key !== "bg") applyZoom();
				if (key !== "zoom") store.set(key, b.dataset[key]);
			}
		});
		for (const key of ["mode", "bg"]) {
			const saved = store.get(key);
			const b = saved && $(`button[data-${key}="${saved}"]`, viewer);
			if (b) {
				viewer.dataset[key] = saved;
				press(b.parentElement, b);
			}
		}

		// Range inputs drive --opacity / --pos; keep the filled track in sync.
		$$('input[type="range"]', viewer).forEach((input) => {
			const output = input.nextElementSibling;
			const sync = () => {
				const v = Number(input.value);
				input.style.setProperty("--control-value", v);
				input.style.setProperty("--attr-min", input.min || 0);
				input.style.setProperty("--attr-max", input.max || 100);
				viewer.style.setProperty(input.dataset.control === "opacity" ? "--opacity" : "--pos", input.dataset.control === "opacity" ? v / 100 : `${v}%`);
				output.textContent = `${v}%`;
			};
			input.addEventListener("input", sync);
			sync();
		});

		// Drag directly on the image in swipe mode.
		const swipeInput = $('input[data-control="pos"]', viewer);
		items.forEach((item) => {
			const layers = $(".layers", item);
			const move = (e) => {
				const box = layers.getBoundingClientRect();
				swipeInput.value = String(Math.round(Math.min(100, Math.max(0, ((e.clientX - box.left) / box.width) * 100))));
				swipeInput.dispatchEvent(new Event("input"));
			};
			layers.addEventListener("pointerdown", (e) => {
				if (viewer.dataset.mode !== "swipe" || item.hasAttribute("data-single")) return;
				layers.setPointerCapture(e.pointerId);
				move(e);
				layers.addEventListener("pointermove", move);
				// Fires after pointerup and pointercancel alike, so the listener never outlives the drag.
				layers.addEventListener("lostpointercapture", () => layers.removeEventListener("pointermove", move), { once: true });
			});
		});

		listButtons.forEach((b, k) => b.addEventListener("click", () => show(k)));
		$$("[data-step]", viewer).forEach((b) => b.addEventListener("click", () => show(index + Number(b.dataset.step))));
		document.addEventListener("keydown", (e) => {
			if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
			if ($("#panel-visual")?.hidden || e.target.closest("input, textarea, select, [contenteditable]")) return;
			if (e.key === "j" || e.key === "k") show(index + (e.key === "j" ? 1 : -1));
		});

		show(0);
	}

	/* ---- Open the tab or file named in the URL ---------------------------- */
	const initial = location.hash.slice(1);
	const initialTab = document.getElementById(`tab-${initial}`);
	if (initialTab) selectTab(initialTab, { push: false });
	else if (initial && document.getElementById(initial)) reveal(document.getElementById(initial));
})();
