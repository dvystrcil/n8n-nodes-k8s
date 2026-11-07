// The compiled node (dist/) driven through execute(), against a local HTTPS
// stand-in for the API server with its own CA. This exercises the real
// client-node request path, including TLS verification against the CA file.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { KubernetesBatch } = require("../dist/nodes/KubernetesBatch/KubernetesBatch.node.js");

const TOKEN = "per-run-token-abc123";
let dir, caFile, otherCaFile, server, url;
let requests = [];
let routes = {};

function openssl(...args) {
	execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}

function makeCa(name) {
	openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.crt`, "-days", "1", "-subj", `/CN=${name}`);
}

before(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "k8s-node-tls-"));
	makeCa("ca");
	makeCa("other-ca");
	fs.writeFileSync(path.join(dir, "san.ext"), "subjectAltName=IP:127.0.0.1,DNS:localhost\n");
	openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost");
	openssl("x509", "-req", "-in", "srv.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.crt", "-days", "1", "-extfile", "san.ext");
	caFile = path.join(dir, "ca.crt");
	otherCaFile = path.join(dir, "other-ca.crt");
	server = https.createServer(
		{ key: fs.readFileSync(path.join(dir, "srv.key")), cert: fs.readFileSync(path.join(dir, "srv.crt")) },
		(req, res) => {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				const u = new URL(req.url, "https://x");
				const rec = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined };
				requests.push(rec);
				const h = routes[`${req.method} ${u.pathname}`];
				const [status, payload, type] = h ? h(rec) : [404, { kind: "Status", reason: "NotFound", message: `no route ${req.method} ${u.pathname}`, code: 404 }];
				res.writeHead(status, { "content-type": type ?? "application/json" });
				res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
			});
		},
	);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	url = `https://127.0.0.1:${server.address().port}`;
});

after(() => {
	server.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	requests = [];
	routes = {};
});

function run(params, { items = [{ json: {} }], continueOnFail = false, creds } = {}) {
	const per = Array.isArray(params) ? params : items.map(() => params);
	const ctx = {
		getInputData: () => items,
		getCredentials: async (name) => {
			assert.equal(name, "kubernetesTokenApi");
			return creds ?? { server: url, caFile };
		},
		getNodeParameter: (name, i, fallback) => (name in per[i] ? per[i][name] : fallback),
		continueOnFail: () => continueOnFail,
		getNode: () => ({ name: "Kubernetes Batch" }),
	};
	return new KubernetesBatch().execute.call(ctx);
}

const CRONJOB = {
	apiVersion: "batch/v1",
	kind: "CronJob",
	metadata: { name: "render", namespace: "batch", uid: "cj" },
	spec: {
		schedule: "0 0 31 2 *",
		suspend: true,
		jobTemplate: {
			spec: {
				ttlSecondsAfterFinished: 60,
				activeDeadlineSeconds: 600,
				template: { spec: { restartPolicy: "Never", containers: [{ name: "run", image: "img:1", args: ["x"] }] } },
			},
		},
	},
};

const VAP_MSG =
	"jobs.batch \"render-1\" is forbidden: ValidatingAdmissionPolicy 'job-guard' with binding 'job-guard-binding' denied request: every image must come from the allowed registry";

function createRoutes(postStatus = 201, postBody) {
	routes["GET /apis/batch/v1/namespaces/batch/cronjobs/render"] = () => [200, CRONJOB];
	routes["POST /apis/batch/v1/namespaces/batch/jobs"] = (r) => [postStatus, postBody ?? { ...r.body, metadata: { ...r.body.metadata, uid: "job-uid" } }];
}

const createParams = {
	operation: "createJobFromCronJob",
	token: TOKEN,
	namespace: "batch",
	cronJobName: "render",
	jobName: "render-1",
	args: '["/work/render-1/spec.json"]',
	env: { STEP: "export" },
	labels: '{"run": "render-1"}',
	annotations: "",
	activeDeadlineSeconds: 0,
	suspend: true,
};

test("create: reads the template, posts a plain Job, never writes the CronJob", async () => {
	createRoutes();
	const [[item]] = await run(createParams);
	assert.deepEqual(item.json, { name: "render-1", namespace: "batch", uid: "job-uid", cronJob: "render", suspended: true });
	assert.deepEqual(item.pairedItem, { item: 0 });
	assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [
		"GET /apis/batch/v1/namespaces/batch/cronjobs/render",
		"POST /apis/batch/v1/namespaces/batch/jobs",
	]);
	const posted = requests[1].body;
	assert.equal(posted.kind, "Job");
	assert.equal(posted.spec.suspend, true);
	assert.equal(posted.spec.activeDeadlineSeconds, 600);
	assert.deepEqual(posted.spec.template.spec.containers[0].args, ["/work/render-1/spec.json"]);
	assert.deepEqual(posted.spec.template.spec.containers[0].env, [{ name: "STEP", value: "export" }]);
	assert.deepEqual(posted.metadata.labels, { run: "render-1" });
	assert.equal(posted.spec.schedule, undefined);
});

test("every call carries the per-run token as a bearer token", async () => {
	createRoutes();
	await run(createParams);
	assert.ok(requests.length > 0);
	for (const r of requests) assert.equal(r.auth, `Bearer ${TOKEN}`);
});

test("the token never appears in the output", async () => {
	createRoutes();
	routes["GET /apis/batch/v1/namespaces/batch/jobs/render-1"] = () => [200, { metadata: { name: "render-1" }, spec: {}, status: {} }];
	const outs = [await run(createParams), await run({ operation: "getJobStatus", token: TOKEN, namespace: "batch", jobName: "render-1" })];
	for (const o of outs) assert.ok(!JSON.stringify(o).includes(TOKEN));
});

test("create: an admission refusal surfaces the API server's message", async () => {
	createRoutes(403, { kind: "Status", status: "Failure", reason: "Forbidden", message: VAP_MSG, code: 403 });
	await assert.rejects(run(createParams), (e) => {
		assert.equal(e.message, `HTTP 403 Forbidden: ${VAP_MSG}`);
		return true;
	});
});

test("create: with continueOnFail the refusal is an output item, not a throw", async () => {
	createRoutes(403, { kind: "Status", reason: "Forbidden", message: VAP_MSG, code: 403 });
	const [[item]] = await run(createParams, { continueOnFail: true });
	assert.deepEqual(item.json, { error: `HTTP 403 Forbidden: ${VAP_MSG}` });
	assert.deepEqual(item.pairedItem, { item: 0 });
});

test("create: a missing template is an error, and no Job is posted", async () => {
	await assert.rejects(run(createParams), /HTTP 404 NotFound/);
	assert.equal(requests.filter((r) => r.method === "POST").length, 0);
});

test("create: bad JSON parameters are refused before any call", async () => {
	for (const [k, v, re] of [
		["args", "[not json", /Args is not valid JSON/],
		["args", '{"a":1}', /Args must be a JSON array/],
		["env", "[1]", /Env must be a JSON object/],
		["env", "null", /Env must be a JSON object/],
		["labels", '{"a": 1}', /Labels: value of "a" must be a string/],
		["annotations", '{"a": true}', /Annotations: value of "a" must be a string/],
		["labels", "[1]", /Labels must be a JSON object/],
		["annotations", "{x", /Annotations is not valid JSON/],
		["env", "{x", /Env is not valid JSON/],
		["env", "5", /Env must be a JSON object/],
		["labels", "null", /Labels must be a JSON object/],
		["annotations", "[1]", /Annotations must be a JSON object/],
		["args", "null", /Args must be a JSON array/],
		["args", '"a"', /Args must be a JSON array/],
	]) {
		createRoutes();
		requests = [];
		await assert.rejects(run({ ...createParams, [k]: v }), re, `${k}=${v}`);
		assert.equal(requests.filter((r) => r.method === "POST").length, 0, `${k}=${v}`);
	}
});

test("create: only the required parameters is a Job straight from the template", async () => {
	createRoutes();
	const [[item]] = await run({ operation: "createJobFromCronJob", token: TOKEN, namespace: "batch", cronJobName: "render", jobName: "render-1" });
	assert.equal(item.json.suspended, false);
	const { metadata, ...rest } = requests[1].body;
	assert.deepEqual(rest, { apiVersion: "batch/v1", kind: "Job", spec: CRONJOB.spec.jobTemplate.spec });
	assert.deepEqual(metadata, { name: "render-1", namespace: "batch", labels: {}, annotations: {} });
});

test("create: a deadline override is applied", async () => {
	createRoutes();
	await run({ ...createParams, activeDeadlineSeconds: 7 });
	assert.equal(requests[1].body.spec.activeDeadlineSeconds, 7);
});

test("create: a negative deadline is refused", async () => {
	createRoutes();
	await assert.rejects(run({ ...createParams, activeDeadlineSeconds: -3 }), /positive integer/);
});

test("create: suspend off leaves the template's suspend unset", async () => {
	createRoutes();
	const [[item]] = await run({ ...createParams, suspend: false });
	assert.equal(requests[1].body.spec.suspend, undefined);
	assert.equal(item.json.suspended, false);
});

test("create: empty optional JSON keeps the template's args", async () => {
	createRoutes();
	await run({ ...createParams, args: "", env: "", labels: "" });
	assert.deepEqual(requests[1].body.spec.template.spec.containers[0].args, ["x"]);
});

test("create: the CronJob name is required", async () => {
	await assert.rejects(run({ ...createParams, cronJobName: " " }), /CronJob Name is required/);
	assert.equal(requests.length, 0);
});

test("status: reads the Job itself (not /status), and reports its state", async () => {
	routes["GET /apis/batch/v1/namespaces/batch/jobs/render-1"] = () => [
		200,
		{ metadata: { name: "render-1", namespace: "batch", uid: "u" }, spec: {}, status: { failed: 1, conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "Job has reached the specified backoff limit" }] } },
	];
	const [[item]] = await run({ operation: "getJobStatus", token: TOKEN, namespace: "batch", jobName: "render-1" });
	assert.equal(item.json.state, "failed");
	assert.equal(item.json.terminal, true);
	assert.equal(item.json.reason, "BackoffLimitExceeded");
	assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), ["GET /apis/batch/v1/namespaces/batch/jobs/render-1"]);
});

test("status: a 404 is vanished, not an error", async () => {
	const [[item]] = await run({ operation: "getJobStatus", token: TOKEN, namespace: "batch", jobName: "gone" });
	assert.equal(item.json.state, "vanished");
	assert.equal(item.json.terminal, true);
});

test("status: a 403 is an error, not vanished", async () => {
	routes["GET /apis/batch/v1/namespaces/other/jobs/x"] = () => [403, { kind: "Status", reason: "Forbidden", message: 'jobs.batch "x" is forbidden: User cannot get', code: 403 }];
	await assert.rejects(run({ operation: "getJobStatus", token: TOKEN, namespace: "other", jobName: "x" }), /HTTP 403 Forbidden: jobs\.batch "x" is forbidden/);
});

test("status: every input item gets its own answer", async () => {
	routes["GET /apis/batch/v1/namespaces/batch/jobs/a"] = () => [200, { metadata: { name: "a" }, spec: {}, status: { conditions: [{ type: "Complete", status: "True" }] } }];
	const params = [
		{ operation: "getJobStatus", token: TOKEN, namespace: "batch", jobName: "a" },
		{ operation: "getJobStatus", token: TOKEN, namespace: "batch", jobName: "b" },
	];
	const [out] = await run(params, { items: [{ json: {} }, { json: {} }] });
	assert.deepEqual(out.map((o) => [o.json.name, o.json.state, o.pairedItem.item]), [["a", "complete", 0], ["b", "vanished", 1]]);
});

test("logs: the newest pod of the Job, with tail and byte limits", async () => {
	routes["GET /api/v1/namespaces/batch/pods"] = () => [
		200,
		{
			items: [
				{ metadata: { name: "render-1-old", creationTimestamp: "2026-01-01T00:00:01Z" }, spec: { containers: [{ name: "run" }] }, status: { phase: "Failed" } },
				{ metadata: { name: "render-1-new", creationTimestamp: "2026-01-01T00:00:05Z" }, spec: { containers: [{ name: "run" }] }, status: { phase: "Failed" } },
			],
		},
	];
	routes["GET /api/v1/namespaces/batch/pods/render-1-new/log"] = () => [200, "line 1\nline 2\n", "text/plain"];
	const [[item]] = await run({ operation: "getJobLogTail", token: TOKEN, namespace: "batch", jobName: "render-1", container: "", tailLines: 20, limitBytes: 4096 });
	assert.deepEqual(item.json, { job: "render-1", found: true, pod: "render-1-new", phase: "Failed", container: "run", log: "line 1\nline 2\n" });
	assert.equal(requests[0].query.labelSelector, "batch.kubernetes.io/job-name=render-1");
	assert.deepEqual(requests[1].query, { limitBytes: "4096", tailLines: "20" });
});

test("logs: a named container is passed through", async () => {
	routes["GET /api/v1/namespaces/batch/pods"] = () => [200, { items: [{ metadata: { name: "p", creationTimestamp: "2026-01-01T00:00:01Z" }, spec: { containers: [{ name: "a" }, { name: "b" }] } }] }];
	routes["GET /api/v1/namespaces/batch/pods/p/log"] = () => [200, "b says hi", "text/plain"];
	const [[item]] = await run({ operation: "getJobLogTail", token: TOKEN, namespace: "batch", jobName: "j", container: "b", tailLines: 5, limitBytes: 10 });
	assert.equal(requests[1].query.container, "b");
	assert.equal(item.json.container, "b");
	assert.equal(item.json.phase, null);
	assert.equal(item.json.log, "b says hi");
});

test("logs: no pod yet is found=false with an empty log, and no log call", async () => {
	routes["GET /api/v1/namespaces/batch/pods"] = () => [200, { items: [] }];
	const [[item]] = await run({ operation: "getJobLogTail", token: TOKEN, namespace: "batch", jobName: "j", tailLines: 5, limitBytes: 10 });
	assert.deepEqual(item.json, { job: "j", found: false, pod: null, phase: null, container: null, log: "" });
	assert.equal(requests.length, 1);
});

test("the node only ever GETs and POSTs, and never watches", async () => {
	createRoutes();
	routes["GET /apis/batch/v1/namespaces/batch/jobs/render-1"] = () => [200, { metadata: { name: "render-1" }, spec: {}, status: {} }];
	routes["GET /api/v1/namespaces/batch/pods"] = () => [200, { items: [] }];
	await run(createParams);
	await run({ operation: "getJobStatus", token: TOKEN, namespace: "batch", jobName: "render-1" });
	await run({ operation: "getJobLogTail", token: TOKEN, namespace: "batch", jobName: "render-1" });
	assert.ok(requests.length >= 4);
	for (const r of requests) {
		assert.ok(["GET", "POST"].includes(r.method), r.method);
		assert.equal(r.query.watch, undefined);
		assert.ok(!r.path.endsWith("/status"), r.path);
	}
});

test("TLS: a server whose certificate the CA did not sign is refused before any request", async () => {
	createRoutes();
	await assert.rejects(run(createParams, { creds: { server: url, caFile: otherCaFile } }), (e) => {
		assert.match(e.message, /certificate|self.signed|UNABLE_TO_VERIFY|issuer/i);
		return true;
	});
	assert.equal(requests.length, 0);
});

test("credential: http:// is refused", async () => {
	await assert.rejects(run(createParams, { creds: { server: url.replace("https", "http"), caFile } }), /must be an https:\/\/ URL/);
	assert.equal(requests.length, 0);
});

test("credential: missing fields fail closed", async () => {
	await assert.rejects(run(createParams, { creds: {} }), /must be an https:\/\/ URL/);
	await assert.rejects(run(createParams, { creds: { server: url } }), /CA file is required/);
});

test("an empty token is refused before any call", async () => {
	await assert.rejects(run({ ...createParams, token: "" }), /token is empty/);
	await assert.rejects(run({ operation: "getJobStatus", namespace: "batch", jobName: "x" }), /token is empty/);
	assert.equal(requests.length, 0);
});

test("namespace and job name are required", async () => {
	await assert.rejects(run({ ...createParams, namespace: "" }), /Namespace is required/);
	await assert.rejects(run({ operation: "getJobStatus", token: TOKEN, namespace: "batch" }), /Job Name is required/);
	assert.equal(requests.length, 0);
});

test("an unknown operation is an error", async () => {
	await assert.rejects(run({ operation: "deleteJob", token: TOKEN, namespace: "batch", jobName: "x" }), /Unknown operation "deleteJob"/);
	assert.equal(requests.length, 0);
});

// ---- the description: only the lane's operations, nothing that writes ------

test("description: exactly the three chain operations", () => {
	const d = new KubernetesBatch().description;
	const op = d.properties.find((p) => p.name === "operation");
	assert.deepEqual(op.options.map((o) => o.value).sort(), ["createJobFromCronJob", "getJobLogTail", "getJobStatus"]);
	assert.equal(op.noDataExpression, true);
	assert.deepEqual(d.credentials, [{ name: "kubernetesTokenApi", required: true }]);
	assert.equal(d.usableAsTool, undefined);
});

test("description: the token parameter is a password field", () => {
	const t = new KubernetesBatch().description.properties.find((p) => p.name === "token");
	assert.equal(t.typeOptions.password, true);
});

test("description: no wait, watch, timeout, cleanup or delete parameter exists", () => {
	const names = new KubernetesBatch().description.properties.map((p) => p.name.toLowerCase());
	for (const n of names) assert.doesNotMatch(n, /wait|watch|timeout|cleanup|delete/);
});

test("credential: token-from-input only, with in-cluster defaults and no skip-TLS field", () => {
	const { KubernetesTokenApi } = require("../dist/credentials/KubernetesTokenApi.credentials.js");
	const c = new KubernetesTokenApi();
	assert.equal(c.name, "kubernetesTokenApi");
	assert.deepEqual(c.properties.map((p) => [p.name, p.default]), [
		["server", "https://kubernetes.default.svc"],
		["caFile", "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"],
	]);
	assert.equal(c.authenticate, undefined);
});
