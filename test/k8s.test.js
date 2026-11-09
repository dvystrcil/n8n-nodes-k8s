// Unit tests for the pure parts of the node (dist/, i.e. the shipped code).
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Every temp dir a test makes is removed when the file ends: leaked ones once filled a laptop's /tmp inodes.
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
function mkTmp(prefix) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(d);
	return d;
}

const k = require("../dist/nodes/KubernetesBatch/k8s.js");

function cronJob(over = {}) {
	return {
		apiVersion: "batch/v1",
		kind: "CronJob",
		metadata: { name: "render", namespace: "batch", resourceVersion: "9", uid: "cj-uid" },
		spec: {
			schedule: "0 0 31 2 *",
			suspend: true,
			jobTemplate: {
				metadata: { labels: { app: "render", tier: "batch" }, annotations: { team: "cad" } },
				spec: {
					ttlSecondsAfterFinished: 3600,
					activeDeadlineSeconds: 600,
					backoffLimit: 0,
					template: {
						metadata: { labels: { app: "render", component: "runner" } },
						spec: {
							restartPolicy: "Never",
							containers: [
								{
									name: "run",
									image: "registry.example/run:1",
									args: ["--help"],
									env: [
										{ name: "KEEP", value: "1" },
										{ name: "REPLACE", value: "old" },
									],
								},
							],
						},
					},
				},
			},
		},
		status: { lastScheduleTime: "2026-01-01T00:00:00Z" },
		...over,
	};
}

// ---- buildJobFromCronJob -------------------------------------------------

test("build: a plain batch/v1 Job named as asked, in the template's namespace", () => {
	const job = k.buildJobFromCronJob(cronJob(), { jobName: "render-1" });
	assert.equal(job.apiVersion, "batch/v1");
	assert.equal(job.kind, "Job");
	assert.equal(job.metadata.name, "render-1");
	assert.equal(job.metadata.namespace, "batch");
	assert.deepEqual(Object.keys(job).sort(), ["apiVersion", "kind", "metadata", "spec"]);
});

test("build: the spec is the template's jobTemplate.spec, untouched when no overrides", () => {
	const cj = cronJob();
	const job = k.buildJobFromCronJob(cj, { jobName: "render-1" });
	assert.deepEqual(job.spec, cj.spec.jobTemplate.spec);
	assert.equal(job.spec.schedule, undefined);
	assert.equal(job.status, undefined);
});

test("build: nothing from the CronJob's own metadata leaks into the Job", () => {
	const job = k.buildJobFromCronJob(cronJob(), { jobName: "render-1" });
	assert.equal(job.metadata.resourceVersion, undefined);
	assert.equal(job.metadata.uid, undefined);
	assert.equal(job.metadata.ownerReferences, undefined);
});

test("build: a deep copy, so the fetched template is never mutated", () => {
	const cj = cronJob();
	const before = JSON.stringify(cj);
	const job = k.buildJobFromCronJob(cj, {
		jobName: "render-1",
		args: ["a"],
		env: { NEW: "x" },
		labels: { run: "1" },
		annotations: { note: "y" },
		activeDeadlineSeconds: 30,
		suspend: true,
	});
	job.spec.template.spec.containers[0].image = "changed";
	assert.equal(JSON.stringify(cj), before);
});

test("build: template labels and annotations carry over, extra ones are merged in", () => {
	const job = k.buildJobFromCronJob(cronJob(), {
		jobName: "render-1",
		labels: { run: "abc", app: "override" },
		annotations: { note: "y" },
	});
	assert.deepEqual(job.metadata.labels, { app: "override", tier: "batch", run: "abc" });
	assert.deepEqual(job.metadata.annotations, { team: "cad", note: "y" });
	assert.deepEqual(job.spec.template.metadata.labels, { app: "override", component: "runner", run: "abc" });
});

test("build: with no extra labels, the template's labels are kept as they are", () => {
	const job = k.buildJobFromCronJob(cronJob(), { jobName: "j" });
	assert.deepEqual(job.metadata.labels, { app: "render", tier: "batch" });
	assert.deepEqual(job.spec.template.metadata.labels, { app: "render", component: "runner" });
});

test("build: an empty labels object adds no pod template metadata", () => {
	const cj = cronJob();
	delete cj.spec.jobTemplate.spec.template.metadata;
	const job = k.buildJobFromCronJob(cj, { jobName: "j", labels: {} });
	assert.equal(job.spec.template.metadata, undefined);
});

test("build: extra labels reach the pod template even when it has no metadata", () => {
	const cj = cronJob();
	delete cj.spec.jobTemplate.spec.template.metadata;
	delete cj.spec.jobTemplate.metadata;
	const job = k.buildJobFromCronJob(cj, { jobName: "render-1", labels: { run: "abc" } });
	assert.deepEqual(job.metadata.labels, { run: "abc" });
	assert.deepEqual(job.spec.template.metadata.labels, { run: "abc" });
	assert.deepEqual(job.metadata.annotations, {});
});

test("build: args replace the container's args", () => {
	const job = k.buildJobFromCronJob(cronJob(), { jobName: "j", args: ["/work/x/spec.json"] });
	assert.deepEqual(job.spec.template.spec.containers[0].args, ["/work/x/spec.json"]);
});

test("build: env replaces by name, appends new, keeps the rest, stringifies values", () => {
	const job = k.buildJobFromCronJob(cronJob(), {
		jobName: "j",
		env: { REPLACE: "new", ADDED: 42 },
	});
	assert.deepEqual(job.spec.template.spec.containers[0].env, [
		{ name: "KEEP", value: "1" },
		{ name: "REPLACE", value: "new" },
		{ name: "ADDED", value: "42" },
	]);
});

test("build: env can replace the first entry", () => {
	const job = k.buildJobFromCronJob(cronJob(), { jobName: "j", env: { KEEP: "2" } });
	assert.deepEqual(job.spec.template.spec.containers[0].env, [
		{ name: "KEEP", value: "2" },
		{ name: "REPLACE", value: "old" },
	]);
});

test("build: args alone do not add an env list", () => {
	const cj = cronJob();
	delete cj.spec.jobTemplate.spec.template.spec.containers[0].env;
	const job = k.buildJobFromCronJob(cj, { jobName: "j", args: ["a"] });
	assert.equal("env" in job.spec.template.spec.containers[0], false);
});

test("build: args against a template with no containers is refused", () => {
	const cj = cronJob();
	delete cj.spec.jobTemplate.spec.template.spec.containers;
	assert.throws(() => k.buildJobFromCronJob(cj, { jobName: "j", args: ["a"] }), /it has 0/);
});

test("build: env on a container with no env list creates one", () => {
	const cj = cronJob();
	delete cj.spec.jobTemplate.spec.template.spec.containers[0].env;
	const job = k.buildJobFromCronJob(cj, { jobName: "j", env: { A: "b" } });
	assert.deepEqual(job.spec.template.spec.containers[0].env, [{ name: "A", value: "b" }]);
});

test("build: args or env against a multi-container template is refused", () => {
	const cj = cronJob();
	cj.spec.jobTemplate.spec.template.spec.containers.push({ name: "side", image: "x" });
	assert.throws(() => k.buildJobFromCronJob(cj, { jobName: "j", args: ["a"] }), /exactly one container.*has 2/);
	assert.throws(() => k.buildJobFromCronJob(cj, { jobName: "j", env: { A: "1" } }), /exactly one container/);
	// No overrides: a multi-container template is fine.
	assert.equal(k.buildJobFromCronJob(cj, { jobName: "j" }).spec.template.spec.containers.length, 2);
});

test("build: empty args or env objects are no override", () => {
	const job = k.buildJobFromCronJob(cronJob(), { jobName: "j", args: undefined, env: {} });
	assert.deepEqual(job.spec.template.spec.containers[0].args, ["--help"]);
	assert.equal(job.spec.template.spec.containers[0].env.length, 2);
});

test("build: activeDeadlineSeconds override, and bad values refused", () => {
	const job = k.buildJobFromCronJob(cronJob(), { jobName: "j", activeDeadlineSeconds: 5 });
	assert.equal(job.spec.activeDeadlineSeconds, 5);
	for (const bad of [0, -1, 1.5, Number.NaN]) {
		assert.throws(
			() => k.buildJobFromCronJob(cronJob(), { jobName: "j", activeDeadlineSeconds: bad }),
			/activeDeadlineSeconds must be a positive integer/,
			String(bad),
		);
	}
	assert.equal(k.buildJobFromCronJob(cronJob(), { jobName: "j" }).spec.activeDeadlineSeconds, 600);
});

test("build: suspend true creates a suspended Job; false leaves the template's value", () => {
	assert.equal(k.buildJobFromCronJob(cronJob(), { jobName: "j", suspend: true }).spec.suspend, true);
	assert.equal(k.buildJobFromCronJob(cronJob(), { jobName: "j", suspend: false }).spec.suspend, undefined);
});

test("build: the CronJob must carry a jobTemplate with a pod template", () => {
	assert.throws(() => k.buildJobFromCronJob({ metadata: { name: "x", namespace: "n" }, spec: {} }, { jobName: "j" }), /^Error: CronJob x has no spec\.jobTemplate/);
	assert.throws(() => k.buildJobFromCronJob({ metadata: { name: "x", namespace: "n" } }, { jobName: "j" }), /CronJob x has no spec\.jobTemplate/);
	assert.throws(() => k.buildJobFromCronJob({ metadata: { name: "x", namespace: "n" }, spec: { jobTemplate: {} } }, { jobName: "j" }), /no spec\.jobTemplate/);
	assert.throws(
		() => k.buildJobFromCronJob({ metadata: { name: "x", namespace: "n" }, spec: { jobTemplate: { spec: {} } } }, { jobName: "j" }),
		/no spec\.jobTemplate/,
	);
});

test("build: the Job name must be a DNS-1123 label of at most 63 characters", () => {
	for (const bad of ["", "Upper", "-lead", "trail-", "dot.ted", "a".repeat(64), "under_score"]) {
		assert.throws(() => k.buildJobFromCronJob(cronJob(), { jobName: bad }), /Job name/, JSON.stringify(bad));
	}
	assert.equal(k.buildJobFromCronJob(cronJob(), { jobName: "a".repeat(63) }).metadata.name.length, 63);
	assert.equal(k.buildJobFromCronJob(cronJob(), { jobName: "a" }).metadata.name, "a");
	assert.equal(k.buildJobFromCronJob(cronJob(), { jobName: "a-1-b" }).metadata.name, "a-1-b");
});

// ---- classifyJob ---------------------------------------------------------

const cond = (type, status, reason, message) => ({ type, status, reason, message });

test("status: a missing Job (404) is vanished, and terminal", () => {
	const s = k.classifyJob(null, "gone-1");
	assert.equal(s.state, "vanished");
	assert.equal(s.terminal, true);
	assert.equal(s.name, "gone-1");
	assert.equal(s.reason, "NotFound");
	assert.equal(s.message, "Job gone-1 no longer exists");
});

test("status: Complete=True is complete, terminal, with counts and times", () => {
	const s = k.classifyJob(
		{
			metadata: { name: "j", namespace: "n", uid: "u" },
			spec: {},
			status: {
				conditions: [cond("SuccessCriteriaMet", "True"), cond("Complete", "True", "CompletionsReached", "done")],
				succeeded: 1,
				startTime: "t0",
				completionTime: "t1",
			},
		},
		"j",
	);
	assert.deepEqual(s, {
		name: "j",
		namespace: "n",
		uid: "u",
		state: "complete",
		terminal: true,
		reason: "CompletionsReached",
		message: "done",
		active: 0,
		succeeded: 1,
		failed: 0,
		startTime: "t0",
		completionTime: "t1",
	});
});

test("status: Failed=True is failed, terminal, with the reason and message", () => {
	const s = k.classifyJob(
		{
			metadata: { name: "j" },
			spec: {},
			status: { conditions: [cond("FailureTarget", "True"), cond("Failed", "True", "DeadlineExceeded", "Job was active longer than specified deadline")], failed: 1 },
		},
		"j",
	);
	assert.equal(s.state, "failed");
	assert.equal(s.terminal, true);
	assert.equal(s.reason, "DeadlineExceeded");
	assert.equal(s.message, "Job was active longer than specified deadline");
	assert.equal(s.failed, 1);
});

test("status: a condition that is not True does not count", () => {
	const s = k.classifyJob({ metadata: { name: "j" }, spec: {}, status: { conditions: [cond("Failed", "False"), cond("Complete", "Unknown")], active: 1 } }, "j");
	assert.equal(s.state, "running");
	assert.equal(s.terminal, false);
	assert.equal(s.active, 1);
});

test("status: FailureTarget alone is still running (pods not yet terminated)", () => {
	const s = k.classifyJob({ metadata: { name: "j" }, spec: {}, status: { conditions: [cond("FailureTarget", "True")] } }, "j");
	assert.equal(s.state, "running");
});

test("status: Failed wins over Complete if both were ever reported", () => {
	const s = k.classifyJob({ metadata: { name: "j" }, spec: {}, status: { conditions: [cond("Complete", "True"), cond("Failed", "True", "X")] } }, "j");
	assert.equal(s.state, "failed");
	assert.equal(s.reason, "X");
});

test("status: a suspended, unfinished Job is suspended, not terminal", () => {
	const s = k.classifyJob({ metadata: { name: "j" }, spec: { suspend: true }, status: { conditions: [cond("Suspended", "True", "JobSuspended", "Job suspended")] } }, "j");
	assert.equal(s.state, "suspended");
	assert.equal(s.terminal, false);
	assert.equal(s.reason, "JobSuspended");
});

test("status: a Job with no spec in the answer is still classified", () => {
	assert.equal(k.classifyJob({ metadata: { name: "j" } }, "j").state, "running");
});

test("status: a Job with no status yet is running with zero counts and null fields", () => {
	const s = k.classifyJob({ metadata: { name: "j" }, spec: {} }, "j");
	assert.equal(s.state, "running");
	assert.equal(s.active, 0);
	assert.equal(s.succeeded, 0);
	assert.equal(s.failed, 0);
	assert.equal(s.reason, null);
	assert.equal(s.message, null);
	assert.equal(s.startTime, null);
	assert.equal(s.completionTime, null);
	assert.equal(s.namespace, null);
	assert.equal(s.uid, null);
});

// ---- describeApiError / isNotFound ---------------------------------------

function apiErr(code, body) {
	const e = new Error(`HTTP-Code: ${code}\nMessage: Unknown API Status Code!`);
	e.code = code;
	e.body = body;
	return e;
}

test("errors: the API server's Status message is surfaced (VAP refusal)", () => {
	const msg = "jobs.batch \"x\" is forbidden: ValidatingAdmissionPolicy 'guard' with binding 'guard-binding' denied request: image not allowed";
	const d = k.describeApiError(apiErr(403, JSON.stringify({ kind: "Status", status: "Failure", reason: "Forbidden", message: msg, code: 403 })));
	assert.equal(d.status, 403);
	assert.equal(d.reason, "Forbidden");
	assert.equal(d.message, msg);
	assert.equal(d.text, `HTTP 403 Forbidden: ${msg}`);
});

test("errors: a body that is already an object is read too", () => {
	const d = k.describeApiError(apiErr(422, { reason: "Invalid", message: "spec bad" }));
	assert.equal(d.text, "HTTP 422 Invalid: spec bad");
});

test("errors: a Status with no reason gives the message alone", () => {
	const d = k.describeApiError(apiErr(500, JSON.stringify({ message: "etcd timeout" })));
	assert.equal(d.reason, null);
	assert.equal(d.text, "HTTP 500: etcd timeout");
});

test("errors: a non-JSON body is passed through, truncated", () => {
	const d = k.describeApiError(apiErr(502, "x".repeat(5000)));
	assert.equal(d.status, 502);
	assert.equal(d.reason, null);
	assert.equal(d.message.length, 2000);
	assert.equal(d.text, `HTTP 502: ${"x".repeat(2000)}`);
});

test("errors: a JSON body with no message falls back to the raw body", () => {
	const d = k.describeApiError(apiErr(500, JSON.stringify({ foo: 1 })));
	assert.equal(d.text, 'HTTP 500: {"foo":1}');
});

test("errors: an empty body gives just the status (client-node's message dumps headers)", () => {
	for (const body of ["", undefined]) {
		const d = k.describeApiError(apiErr(401, body));
		assert.equal(d.text, "HTTP 401");
		assert.equal(d.message, null);
	}
});

test("errors: a transport error (no HTTP code) keeps its own message", () => {
	const e = new Error("connect ECONNREFUSED 10.0.0.1:443");
	const d = k.describeApiError(e);
	assert.equal(d.status, null);
	assert.equal(d.text, "connect ECONNREFUSED 10.0.0.1:443");
});

test("errors: a TLS failure keeps its cause's code", () => {
	const e = new Error("fetch failed");
	e.cause = Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
	assert.equal(k.describeApiError(e).text, "fetch failed: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)");
});

test("errors: a cause without a code still shows its message", () => {
	const e = new Error("fetch failed");
	e.cause = new Error("socket hang up");
	assert.equal(k.describeApiError(e).text, "fetch failed: socket hang up");
});

test("errors: a code that is not an HTTP status is not treated as one", () => {
	const e = Object.assign(new Error("boom"), { code: "ECONNRESET" });
	assert.equal(k.describeApiError(e).status, null);
	assert.equal(k.describeApiError(e).text, "boom");
});

test("errors: isNotFound is true for exactly HTTP 404", () => {
	assert.equal(k.isNotFound(apiErr(404, "")), true);
	assert.equal(k.isNotFound(apiErr(403, "")), false);
	assert.equal(k.isNotFound(new Error("x")), false);
	assert.equal(k.isNotFound(null), false);
});

// ---- makeKubeConfig ------------------------------------------------------

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ==\n-----END CERTIFICATE-----\n";

function tmpFile(content) {
	const d = mkTmp("k8s-node-test-");
	const f = path.join(d, "ca.crt");
	fs.writeFileSync(f, content);
	return f;
}

test("kubeconfig: server, CA data from the file, token, TLS verified", () => {
	const caFile = tmpFile(PEM);
	const kc = k.makeKubeConfig({ server: "https://kubernetes.default.svc", caFile, token: "tok" });
	const c = kc.getCurrentCluster();
	assert.equal(c.server, "https://kubernetes.default.svc");
	assert.equal(c.skipTLSVerify, false);
	assert.equal(Buffer.from(c.caData, "base64").toString(), PEM);
	assert.equal(kc.getCurrentUser().token, "tok");
});

test("kubeconfig: a non-https server is refused", () => {
	const caFile = tmpFile(PEM);
	for (const server of ["http://kubernetes.default.svc", "kubernetes.default.svc", "", "HTTPS-ish://x", "xhttps://x", undefined]) {
		assert.throws(() => k.makeKubeConfig({ server, caFile, token: "t" }), /must be an https:\/\/ URL/, server);
	}
});

test("kubeconfig: an empty or whitespace token is refused", () => {
	const caFile = tmpFile(PEM);
	assert.throws(() => k.makeKubeConfig({ server: "https://x", caFile, token: "" }), /token is empty/);
	assert.throws(() => k.makeKubeConfig({ server: "https://x", caFile, token: "  \n" }), /token is empty/);
	assert.throws(() => k.makeKubeConfig({ server: "https://x", caFile, token: undefined }), /token is empty/);
});

test("kubeconfig: surrounding whitespace on the token is trimmed", () => {
	const kc = k.makeKubeConfig({ server: "https://x", caFile: tmpFile(PEM), token: " tok\n" });
	assert.equal(kc.getCurrentUser().token, "tok");
});

test("kubeconfig: a missing CA file fails closed, naming the path", () => {
	assert.throws(() => k.makeKubeConfig({ server: "https://x", caFile: "/nonexistent/ca.crt", token: "t" }), /CA file \/nonexistent\/ca\.crt/);
	assert.throws(() => k.makeKubeConfig({ server: "https://x", caFile: "", token: "t" }), /CA file is required/);
});

test("kubeconfig: a CA file with no PEM certificate fails closed", () => {
	assert.throws(() => k.makeKubeConfig({ server: "https://x", caFile: tmpFile("not a cert"), token: "t" }), /no PEM certificate/);
});

// ---- pickNewestPod -------------------------------------------------------

test("pods: the newest pod by creationTimestamp is picked", () => {
	const pods = [
		{ metadata: { name: "a", creationTimestamp: "2026-01-01T00:00:01Z" } },
		{ metadata: { name: "c", creationTimestamp: "2026-01-01T00:00:03Z" } },
		{ metadata: { name: "b", creationTimestamp: "2026-01-01T00:00:02Z" } },
	];
	assert.equal(k.pickNewestPod(pods).metadata.name, "c");
	assert.equal(k.pickNewestPod([...pods].reverse()).metadata.name, "c");
});

test("pods: Date objects (as client-node returns) compare too", () => {
	const pods = [
		{ metadata: { name: "old", creationTimestamp: new Date("2026-01-01T00:00:01Z") } },
		{ metadata: { name: "new", creationTimestamp: new Date("2026-01-01T00:00:09Z") } },
	];
	assert.equal(k.pickNewestPod(pods).metadata.name, "new");
});

test("pods: equal timestamps keep the first listed", () => {
	const t = "2026-01-01T00:00:01Z";
	const pods = [{ metadata: { name: "first", creationTimestamp: t } }, { metadata: { name: "second", creationTimestamp: t } }];
	assert.equal(k.pickNewestPod(pods).metadata.name, "first");
});

test("pods: no pods is null", () => {
	assert.equal(k.pickNewestPod([]), null);
	assert.equal(k.pickNewestPod(undefined), null);
});

// ---- jobPodSelector ------------------------------------------------------

test("pods: the selector is the Job controller's own label", () => {
	assert.equal(k.jobPodSelector("render-1"), "batch.kubernetes.io/job-name=render-1");
});
