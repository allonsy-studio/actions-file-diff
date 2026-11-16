/**
 * A small in-memory GitHub REST server covering the git data endpoints the
 * action uses: blobs, trees, commits and refs, plus pages and issue comments.
 * It keeps real git semantics where they matter to the publisher: objects are
 * content-addressed, trees nest, `base_tree` merges, `sha: null` deletes,
 * and a non-forced ref update must fast-forward.
 * @module
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const sha1 = (...parts) => {
	const hash = createHash("sha1");
	parts.forEach((part) => hash.update(part));
	return hash.digest("hex");
};

/**
 * @param {object} [options]
 * @param {number} [options.truncateAt] Recursive tree listings longer than this come back truncated.
 * @param {string} [options.pagesUrl] `html_url` for GET /pages; 404 when omitted.
 * @returns {Promise<FakeGitHub>}
 */
export async function startFakeGitHub({ truncateAt = Infinity, pagesUrl } = {}) {
	/** @type {Map<string, { type: "blob", content: Buffer } | { type: "tree", entries: Map<string, { type: string, mode: string, sha: string }> } | { type: "commit", tree: string, parents: string[], message: string }>} */
	const objects = new Map();
	/** Ref name (`heads/main`) → commit sha. */
	const refs = new Map();
	/** Every request as `METHOD /path`. */
	const calls = [];
	/** Comments by issue number. */
	const comments = [];
	const stats = { active: 0, peakBlobUploads: 0, blobUploads: 0 };
	/** Called with (call count, method, path) before each ref read; tests use it to move a branch mid-publish. */
	const hooks = { beforeGetRef: undefined };
	let refReads = 0;

	const put = (object, ...key) => {
		const sha = sha1(object.type, ...key);
		objects.set(sha, object);
		return sha;
	};

	const putBlob = (content) => put({ type: "blob", content }, content);

	const putTree = (entries) => {
		const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b));
		return put({ type: "tree", entries: new Map(sorted) }, JSON.stringify(sorted));
	};

	/** Sets or deletes (leaf === null) one path under a tree, returning the new tree sha, or null when it ends up empty. */
	const setPath = (treeSha, parts, leaf) => {
		const entries = new Map(treeSha ? objects.get(treeSha).entries : []);
		const [name, ...rest] = parts;
		if (rest.length === 0) {
			if (leaf === null) entries.delete(name);
			else entries.set(name, leaf);
		} else {
			const child = entries.get(name);
			const next = setPath(child?.type === "tree" ? child.sha : undefined, rest, leaf);
			if (next === null) entries.delete(name);
			else entries.set(name, { type: "tree", mode: "040000", sha: next });
		}
		return entries.size === 0 ? null : putTree(entries);
	};

	const createTree = ({ base_tree: base, tree }) => {
		let root = base ?? null;
		tree.forEach((entry) => {
			const leaf = entry.sha === null ? null : { type: entry.type, mode: entry.mode, sha: entry.sha };
			root = setPath(root ?? undefined, entry.path.split("/"), leaf);
		});
		return root ?? putTree([]);
	};

	const listTree = (sha, recursive) => {
		const out = [];
		const walk = (treeSha, prefix) => {
			for (const [name, entry] of objects.get(treeSha).entries) {
				out.push({ path: `${prefix}${name}`, type: entry.type, mode: entry.mode, sha: entry.sha });
				if (recursive && entry.type === "tree") walk(entry.sha, `${prefix}${name}/`);
			}
		};
		walk(sha, "");
		return out;
	};

	const isAncestor = (ancestor, descendant) => {
		for (const stack = [descendant]; stack.length > 0; ) {
			const sha = stack.pop();
			if (sha === ancestor) return true;
			stack.push(...(objects.get(sha)?.parents ?? []));
		}
		return false;
	};

	/** Commits the given files (path → content) on a branch as another run would, bypassing the HTTP API. */
	const commitDirect = (branch, files, { parents } = {}) => {
		const head = refs.get(`heads/${branch}`);
		let root = head ? objects.get(head).tree : null;
		for (const [path, content] of Object.entries(files)) root = setPath(root ?? undefined, path.split("/"), content === null ? null : { type: "blob", mode: "100644", sha: putBlob(Buffer.from(content)) });
		const tree = root ?? putTree([]);
		const sha = put({ type: "commit", tree, parents: parents ?? (head ? [head] : []), message: "direct" }, tree, JSON.stringify(parents ?? head ?? ""), String(objects.size));
		refs.set(`heads/${branch}`, sha);
		return sha;
	};

	const handle = async (method, path, body) => {
		const match = (pattern) => path.match(pattern);
		let m;
		const ok = (data, status = 200) => [status, data];

		if (method === "POST" && match(/\/git\/blobs$/)) {
			stats.blobUploads++;
			// Hold the response briefly so overlapping uploads are visible in the peak count.
			await new Promise((resolve) => setTimeout(resolve, 5));
			return ok({ sha: putBlob(Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8")) }, 201);
		}
		if (method === "POST" && match(/\/git\/trees$/)) return ok({ sha: createTree(body) }, 201);
		if (method === "POST" && match(/\/git\/commits$/)) return ok({ sha: put({ type: "commit", tree: body.tree, parents: body.parents, message: body.message }, body.tree, JSON.stringify(body.parents), body.message, String(objects.size)) }, 201);
		if (method === "GET" && (m = match(/\/git\/commits\/([0-9a-f]+)$/))) {
			const commit = objects.get(m[1]);
			return commit ? ok({ sha: m[1], tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })) }) : ok({ message: "Not Found" }, 404);
		}
		if (method === "GET" && (m = match(/\/git\/trees\/([0-9a-f]+)$/))) {
			if (!objects.has(m[1])) return ok({ message: "Not Found" }, 404);
			const tree = listTree(m[1], Boolean(body.recursive));
			const truncated = tree.length > truncateAt;
			return ok({ sha: m[1], tree: truncated ? tree.slice(0, truncateAt) : tree, truncated });
		}
		if (method === "GET" && (m = match(/\/git\/ref\/(.+)$/))) {
			refReads++;
			await hooks.beforeGetRef?.(refReads);
			const sha = refs.get(m[1]);
			return sha ? ok({ ref: `refs/${m[1]}`, object: { sha, type: "commit" } }) : ok({ message: "Not Found" }, 404);
		}
		if (method === "POST" && match(/\/git\/refs$/)) {
			const name = body.ref.replace(/^refs\//, "");
			if (refs.has(name)) return ok({ message: "Reference already exists" }, 422);
			refs.set(name, body.sha);
			return ok({ ref: body.ref, object: { sha: body.sha } }, 201);
		}
		if (method === "PATCH" && (m = match(/\/git\/refs\/(.+)$/))) {
			const old = refs.get(m[1]);
			if (!old) return ok({ message: "Reference does not exist" }, 422);
			if (!body.force && !isAncestor(old, body.sha)) return ok({ message: "Update is not a fast forward" }, 422);
			refs.set(m[1], body.sha);
			return ok({ ref: `refs/${m[1]}`, object: { sha: body.sha } });
		}
		if (method === "GET" && match(/\/pages$/)) return pagesUrl ? ok({ html_url: pagesUrl }) : ok({ message: "Not Found" }, 404);
		if (method === "GET" && (m = match(/\/issues\/(\d+)\/comments$/))) return ok(comments.filter((c) => c.issue === Number(m[1])));
		if (method === "POST" && (m = match(/\/issues\/(\d+)\/comments$/))) {
			const comment = { id: comments.length + 1, issue: Number(m[1]), body: body.body, user: { type: "Bot" } };
			comments.push(comment);
			return ok(comment, 201);
		}
		if (method === "PATCH" && (m = match(/\/issues\/comments\/(\d+)$/))) {
			comments.find((c) => c.id === Number(m[1])).body = body.body;
			return ok({});
		}
		return ok({ message: `Unhandled ${method} ${path}` }, 500);
	};

	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", async () => {
			const url = new URL(req.url, "http://localhost");
			// Octokit encodes the slash in `heads/main`.
			const path = decodeURIComponent(url.pathname);
			calls.push(`${req.method} ${path}`);
			const body = { ...Object.fromEntries(url.searchParams), ...(raw ? JSON.parse(raw) : {}) };
			const isBlob = req.method === "POST" && path.endsWith("/git/blobs");
			if (isBlob) stats.peakBlobUploads = Math.max(stats.peakBlobUploads, ++stats.active);
			try {
				const [status, data] = await handle(req.method, path, body);
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(data));
			} finally {
				if (isBlob) stats.active--;
			}
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

	/** Files on a branch as `{ path: content }`, or undefined when it doesn't exist. */
	const files = (branch) => {
		const head = refs.get(`heads/${branch}`);
		if (!head) return undefined;
		return Object.fromEntries(
			listTree(objects.get(head).tree, true)
				.filter(({ type }) => type === "blob")
				.map(({ path, sha }) => [path, objects.get(sha).content.toString("utf8")]),
		);
	};

	return {
		url: `http://127.0.0.1:${server.address().port}`,
		calls,
		comments,
		stats,
		hooks,
		files,
		commit: (branch) => objects.get(refs.get(`heads/${branch}`)),
		head: (branch) => refs.get(`heads/${branch}`),
		commitDirect,
		/** Number of commits reachable from a branch head. */
		history: (branch) => {
			const seen = new Set();
			for (const stack = [refs.get(`heads/${branch}`)]; stack.length > 0; ) {
				const sha = stack.pop();
				if (sha && !seen.has(sha)) {
					seen.add(sha);
					stack.push(...objects.get(sha).parents);
				}
			}
			return seen.size;
		},
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}
