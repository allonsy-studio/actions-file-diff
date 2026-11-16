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
		const rtl = getComputedStyle(tablist).direction === "rtl";
		const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
		let next;
		if (step) next = tabs[(i + step + tabs.length) % tabs.length];
		else if (e.key === "Home") next = tabs[0];
		else if (e.key === "End") next = tabs.at(-1);
		if (!next || i < 0) return;
		e.preventDefault();
		selectTab(next, { focus: true });
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
		if (details) details.open = true;
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

	const initial = location.hash.slice(1);
	const initialTab = document.getElementById(`tab-${initial}`);
	if (initialTab) selectTab(initialTab, { push: false });
	else if (initial && document.getElementById(initial)) reveal(document.getElementById(initial));

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
			if (i < 0) return;
			const rtl = getComputedStyle(bar).direction === "rtl";
			const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
			let next;
			if (step) next = list[(i + step + list.length) % list.length];
			else if (e.key === "Home") next = list[0];
			else if (e.key === "End") next = list.at(-1);
			if (!next) return;
			e.preventDefault();
			next.focus();
		});
	});

	/** Presses one button in a segmented group. */
	function press(group, button) {
		$$("button", group).forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
	}

	/* ---- Code: unified/split and collapse -------------------------------- */
	const code = $(".code-main");
	if (code) {
		const setView = (view) => {
			code.dataset.view = view;
			press($('[aria-label="Diff layout"]', code), $(`button[data-view="${view}"]`, code));
		};
		setView(store.get("view") === "split" ? "split" : "unified");
		$('[aria-label="Diff layout"]', code).addEventListener("click", (e) => {
			const b = e.target.closest("button[data-view]");
			if (!b) return;
			setView(b.dataset.view);
			store.set("view", b.dataset.view);
		});
		const collapse = $('[data-action="collapse"]', code);
		collapse.addEventListener("click", () => {
			const open = collapse.textContent.startsWith("Expand");
			$$(".file details", code).forEach((d) => (d.open = open));
			collapse.textContent = open ? "Collapse all" : "Expand all";
		});
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
				layers.addEventListener("pointerup", () => layers.removeEventListener("pointermove", move), { once: true });
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
})();
