#!/usr/bin/env node
// End to end: the node-only image, loaded into a STOCK n8n through
// N8N_CUSTOM_EXTENSIONS, runs real workflows against a kind cluster with a
// minted service-account token over CA-verified TLS.
//
//   node test/e2e/e2e.mjs --image IMG --cluster NAME --kubeconfig FILE [--profile generic]
//   node test/e2e/e2e.mjs --image IMG --cluster NAME --kubeconfig FILE --profile external \
//        --namespace NS --sa SA_NS/SA_NAME --template CRONJOB
//
// generic   builds its own fixture (namespaces, a Role with exactly
//           get cronjobs; create, get jobs; list pods; get pods/log, and a
//           ValidatingAdmissionPolicy) and runs every check, including Jobs
//           that really complete and really fail.
// external  uses a Role/VAP/template that already exist in the cluster, and
//           only creates SUSPENDED Jobs from the template (nothing runs).
//
// The admin kubeconfig is used for setup, for minting the token, for checks
// the node cannot make (did the CronJob get stamped?), and for cleanup.
// Prints E2E-OK as its last line only when every check passed.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const IMAGE = opt("--image");
const N8N_IMAGE = opt("--n8n-image", "docker.n8n.io/n8nio/n8n:2.45.7");
const CLUSTER = opt("--cluster");
const KUBECONFIG = opt("--kubeconfig");
const PROFILE = opt("--profile", "generic");
if (!IMAGE || !CLUSTER || !KUBECONFIG) {
	console.error("need --image, --cluster and --kubeconfig");
	process.exit(2);
}
const RUN = randomBytes(3).toString("hex");
const generic = PROFILE === "generic";
const NS = generic ? "batch-e2e" : opt("--namespace");
const [SA_NS, SA] = (generic ? "client-e2e/trigger" : opt("--sa", "")).split("/");
const TEMPLATE = generic ? "ok" : opt("--template");
const OTHER_NS = generic ? "other-e2e" : "default";
const BAD_TEMPLATE = `e2e-refused-${RUN}`;
if (!NS || !SA_NS || !SA || !TEMPLATE) {
	console.error("external profile needs --namespace, --sa NS/NAME and --template");
	process.exit(2);
}
const CTR = `n8n-e2e-${RUN}`;
const VOL = `${CTR}-custom`;
const BUSYBOX = "docker.io/library/busybox:1.37.0-musl";

const sh = (cmd, args, input) => execFileSync(cmd, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
const kubectl = (args, input) => sh("kubectl", ["--kubeconfig", KUBECONFIG, ...args], input);
const docker = (args, input) => sh("docker", args, input);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
	if (!ok) failed++;
}

// ---- fixture -----------------------------------------------------------------
const restricted = {
	runAsNonRoot: true,
	runAsUser: 1000,
	allowPrivilegeEscalation: false,
	capabilities: { drop: ["ALL"] },
	seccompProfile: { type: "RuntimeDefault" },
};
function cronJob(name, image, script, deadline = 300) {
	return {
		apiVersion: "batch/v1",
		kind: "CronJob",
		metadata: { name, namespace: NS },
		spec: {
			schedule: "0 0 31 2 *",
			suspend: true,
			jobTemplate: {
				metadata: { labels: { "e2e/template": name } },
				spec: {
					backoffLimit: 0,
					ttlSecondsAfterFinished: 600,
					activeDeadlineSeconds: deadline,
					template: {
						spec: {
							restartPolicy: "Never",
							automountServiceAccountToken: false,
							containers: [
								{ name: "run", image, imagePullPolicy: "IfNotPresent", command: ["sh", "-c"], args: [script], securityContext: restricted },
							],
						},
					},
				},
			},
		},
	};
}
function genericFixture() {
	const docs = [
		...[NS, SA_NS, OTHER_NS].map((n) => ({
			apiVersion: "v1",
			kind: "Namespace",
			metadata: { name: n, labels: { "pod-security.kubernetes.io/enforce": "restricted" } },
		})),
		{ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: SA, namespace: SA_NS }, automountServiceAccountToken: false },
		{
			apiVersion: "rbac.authorization.k8s.io/v1",
			kind: "Role",
			metadata: { name: "trigger", namespace: NS },
			rules: [
				{ apiGroups: ["batch"], resources: ["cronjobs"], verbs: ["get"] },
				{ apiGroups: ["batch"], resources: ["jobs"], verbs: ["create", "get"] },
				{ apiGroups: [""], resources: ["pods"], verbs: ["list"] },
				{ apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
			],
		},
		{
			apiVersion: "rbac.authorization.k8s.io/v1",
			kind: "RoleBinding",
			metadata: { name: "trigger", namespace: NS },
			roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "trigger" },
			subjects: [{ kind: "ServiceAccount", name: SA, namespace: SA_NS }],
		},
		{
			apiVersion: "admissionregistration.k8s.io/v1",
			kind: "ValidatingAdmissionPolicy",
			metadata: { name: "e2e-job-guard" },
			spec: {
				failurePolicy: "Fail",
				matchConstraints: { resourceRules: [{ apiGroups: ["batch"], apiVersions: ["v1"], operations: ["CREATE"], resources: ["jobs"] }] },
				matchConditions: [{ name: "trigger-sa", expression: `request.userInfo.username == 'system:serviceaccount:${SA_NS}:${SA}'` }],
				validations: [
					{
						expression: `object.spec.template.spec.containers.all(c, c.image.startsWith('${BUSYBOX}'))`,
						message: "e2e guard: every image must be the allowed busybox",
					},
				],
			},
		},
		{
			apiVersion: "admissionregistration.k8s.io/v1",
			kind: "ValidatingAdmissionPolicyBinding",
			metadata: { name: "e2e-job-guard" },
			spec: { policyName: "e2e-job-guard", validationActions: ["Deny"] },
		},
		cronJob("ok", BUSYBOX, 'echo "e2e template default"'),
		cronJob("slow", BUSYBOX, "sleep 300"),
	];
	kubectl(["apply", "-f", "-"], docs.map((d) => JSON.stringify(d)).join("\n"));
}

// The VAP is enforced only once the API server's policy informer has it.
async function waitForGuard() {
	const probe = JSON.stringify(cronJob("probe", "docker.io/library/alpine:3", "true").spec.jobTemplate);
	const job = JSON.parse(probe);
	const body = JSON.stringify({ apiVersion: "batch/v1", kind: "Job", metadata: { name: `guard-probe-${RUN}`, namespace: NS }, spec: { ...job.spec, suspend: true } });
	for (let i = 0; i < 60; i++) {
		const r = spawnSync("kubectl", ["--kubeconfig", KUBECONFIG, "create", "--dry-run=server", `--as=system:serviceaccount:${SA_NS}:${SA}`, "-f", "-"], { input: body, encoding: "utf8" });
		if (r.status !== 0 && /ValidatingAdmissionPolicy/.test(r.stderr)) return;
		await sleep(1000);
	}
	throw new Error("the admission policy never started refusing");
}

// ---- n8n ---------------------------------------------------------------------
function startN8n() {
	docker(["volume", "create", VOL]);
	docker(["run", "--rm", "--user", "0", "-v", `${VOL}:/custom`, "--entrypoint", "chown", IMAGE, "1000:1000", "/custom"]);
	console.log(docker(["run", "--rm", "-v", `${VOL}:/custom`, IMAGE]).trim());
	docker([
		"run", "-d", "--name", CTR, "--network", "kind",
		"-v", `${VOL}:/custom:ro`,
		"-e", "N8N_CUSTOM_EXTENSIONS=/custom",
		"-e", "N8N_UNVERIFIED_PACKAGES_ENABLED=false",
		"-e", "N8N_DIAGNOSTICS_ENABLED=false",
		"-e", "N8N_LOG_LEVEL=info",
		N8N_IMAGE,
	]);
}
async function waitN8n() {
	for (let i = 0; i < 120; i++) {
		const r = spawnSync("docker", ["exec", CTR, "node", "-e", "fetch('http://127.0.0.1:5678/healthz/readiness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);
		if (r.status === 0) return;
		await sleep(2000);
	}
	throw new Error(`n8n never became ready:\n${docker(["logs", "--tail", "50", CTR])}`);
}

function workflow(id, params) {
	return {
		id,
		name: id,
		active: false,
		settings: {},
		connections: { Start: { main: [[{ node: "K8s", type: "main", index: 0 }]] } },
		nodes: [
			{ id: "s", name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} },
			{
				id: "k",
				name: "K8s",
				type: "CUSTOM.kubernetesBatch",
				typeVersion: 1,
				position: [200, 0],
				onError: "continueRegularOutput",
				parameters: params,
				credentials: { kubernetesTokenApi: { id: params.__cred ?? "e2eCredGoodCA01", name: "e2e" } },
			},
		].map((n) => {
			if (n.parameters) delete n.parameters.__cred;
			return n;
		}),
	};
}

function execute(id) {
	const out = docker(["exec", "-e", "N8N_RUNNERS_BROKER_PORT=5690", CTR, "n8n", "execute", `--id=${id}`, "--rawOutput"]);
	const start = out.search(/^\{/m);
	if (start < 0) throw new Error(`no JSON from n8n execute ${id}:\n${out.slice(-2000)}`);
	const run = JSON.parse(out.slice(start));
	const items = run.data.resultData.runData.K8s?.[0]?.data?.main?.[0];
	if (!items) throw new Error(`no K8s output in execution of ${id}: ${JSON.stringify(run.data.resultData.error ?? run).slice(0, 1000)}`);
	return items[0].json;
}

async function pollUntilTerminal(id, timeoutS) {
	const t0 = Date.now();
	let s;
	while (Date.now() - t0 < timeoutS * 1000) {
		s = execute(id);
		if (s.error || s.terminal) return s;
		await sleep(2000);
	}
	return s;
}

// ---- main --------------------------------------------------------------------
const created = [];
async function main() {
	if (generic) {
		console.log(`fixture: namespaces ${NS}, ${SA_NS}, ${OTHER_NS}; Role + VAP; templates ok, slow`);
		docker(["pull", "-q", BUSYBOX]);
		sh("kind", ["load", "docker-image", "--name", CLUSTER, BUSYBOX]);
		genericFixture();
	}
	// A template the guard must refuse. Created by the ADMIN (the VAP only
	// matches the trigger SA), so creating a Job from it as the SA is refused.
	kubectl(["apply", "-f", "-"], JSON.stringify(cronJob(BAD_TEMPLATE, "docker.io/library/alpine:3", "true")));
	await waitForGuard();

	startN8n();
	const caData = kubectl(["config", "view", "--raw", "--minify", "-o", "jsonpath={.clusters[0].cluster.certificate-authority-data}"]);
	const token = kubectl(["create", "token", SA, "-n", SA_NS, "--duration=30m"]).trim();
	await waitN8n();
	docker(["exec", "-i", CTR, "sh", "-c", "cat > /home/node/cluster-ca.crt"], Buffer.from(caData, "base64").toString());

	const server = `https://${CLUSTER}-control-plane:6443`;
	const creds = [
		{ id: "e2eCredGoodCA01", name: "e2e", type: "kubernetesTokenApi", data: { server, caFile: "/home/node/cluster-ca.crt" } },
		{ id: "e2eCredWrongCA1", name: "e2e-wrong-ca", type: "kubernetesTokenApi", data: { server, caFile: "/etc/ssl/certs/ca-certificates.crt" } },
	];
	const j = (s) => `e2e-${s}-${RUN}`;
	const base = { token, namespace: NS };
	const wfs = {
		createSuspended: { operation: "createJobFromCronJob", ...base, cronJobName: TEMPLATE, jobName: j("susp"), suspend: true, labels: '{"e2e/run":"' + RUN + '"}' },
		statusSuspended: { operation: "getJobStatus", ...base, jobName: j("susp") },
		logsSuspended: { operation: "getJobLogTail", ...base, jobName: j("susp"), tailLines: 10, limitBytes: 4096 },
		statusVanished: { operation: "getJobStatus", ...base, jobName: j("never-created") },
		createRefused: { operation: "createJobFromCronJob", ...base, cronJobName: BAD_TEMPLATE, jobName: j("refused"), suspend: true },
		createOtherNs: { operation: "createJobFromCronJob", ...base, namespace: OTHER_NS, cronJobName: TEMPLATE, jobName: j("other"), suspend: true },
		statusWrongCa: { operation: "getJobStatus", ...base, jobName: j("susp"), __cred: "e2eCredWrongCA1" },
	};
	if (generic) {
		Object.assign(wfs, {
			createOk: {
				operation: "createJobFromCronJob", ...base, cronJobName: "ok", jobName: j("ok"),
				args: JSON.stringify(['echo "e2e args override: $GREETING"']), env: JSON.stringify({ GREETING: "from n8n" }),
			},
			statusOk: { operation: "getJobStatus", ...base, jobName: j("ok") },
			logsOk: { operation: "getJobLogTail", ...base, jobName: j("ok"), tailLines: 10, limitBytes: 4096 },
			createSlow: { operation: "createJobFromCronJob", ...base, cronJobName: "slow", jobName: j("slow"), activeDeadlineSeconds: 5 },
			statusSlow: { operation: "getJobStatus", ...base, jobName: j("slow") },
		});
	}
	const ids = Object.fromEntries(Object.keys(wfs).map((k, i) => [k, `e2eWf${RUN}${String(i).padStart(4, "0")}`]));
	docker(["exec", "-i", CTR, "sh", "-c", "cat > /tmp/creds.json"], JSON.stringify(creds));
	docker(["exec", "-i", CTR, "sh", "-c", "cat > /tmp/wfs.json"], JSON.stringify(Object.entries(wfs).map(([k, p]) => workflow(ids[k], p))));
	docker(["exec", CTR, "n8n", "import:credentials", "--input=/tmp/creds.json"]);
	docker(["exec", CTR, "n8n", "import:workflow", "--input=/tmp/wfs.json"]);
	docker(["exec", CTR, "rm", "/tmp/wfs.json", "/tmp/creds.json"]);

	const version = docker(["exec", CTR, "n8n", "--version"]).trim();
	check(`stock n8n ${N8N_IMAGE.split(":").pop()} (got ${version})`, version === N8N_IMAGE.split(":").pop());

	// Suspended: nothing runs.
	let r = execute(ids.createSuspended);
	created.push(j("susp"));
	check("create a suspended Job from the template", r.name === j("susp") && r.suspended === true && !r.error, JSON.stringify(r));
	const cj = JSON.parse(kubectl(["get", "cronjob", "-n", NS, TEMPLATE, "-o", "json"]));
	check("the template CronJob was not stamped (no lastScheduleTime)", !cj.status?.lastScheduleTime, JSON.stringify(cj.status));
	const job = JSON.parse(kubectl(["get", "job", "-n", NS, j("susp"), "-o", "json"]));
	check("the Job has no ownerReference to the CronJob", !job.metadata.ownerReferences, JSON.stringify(job.metadata.ownerReferences));
	check("the Job carries the extra label", job.metadata.labels["e2e/run"] === RUN, JSON.stringify(job.metadata.labels));
	r = execute(ids.statusSuspended);
	check("status of the suspended Job is suspended, not terminal", r.state === "suspended" && r.terminal === false, JSON.stringify(r));
	r = execute(ids.logsSuspended);
	check("log tail of a Job with no pod is found=false", r.found === false && r.log === "", JSON.stringify(r));
	r = execute(ids.statusVanished);
	check("status of a Job that does not exist is vanished (404), terminal", r.state === "vanished" && r.terminal === true, JSON.stringify(r));
	r = execute(ids.createRefused);
	check(
		// 403 when the validation sets reason: Forbidden, 422 (Invalid) when it does not.
		"an off-list image is refused at create, with the policy's message",
		/^HTTP (403 Forbidden|422 Invalid): jobs\.batch ".*" is forbidden: ValidatingAdmissionPolicy '[^']+' with binding '[^']+' denied request/.test(r.error ?? ""),
		JSON.stringify(r),
	);
	r = execute(ids.createOtherNs);
	check("another namespace is refused by RBAC, with the API server's message", /^HTTP 403 Forbidden: cronjobs\.batch ".*" is forbidden: User "system:serviceaccount:/.test(r.error ?? ""), JSON.stringify(r));
	r = execute(ids.statusWrongCa);
	check("TLS is verified: a CA that did not sign the server is refused", /certificate|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(r.error ?? ""), JSON.stringify(r));

	if (generic) {
		r = execute(ids.createOk);
		created.push(j("ok"));
		check("create a running Job with args and env overrides", r.name === j("ok") && !r.error, JSON.stringify(r));
		r = await pollUntilTerminal(ids.statusOk, 180);
		check("it completes: state complete, terminal", r.state === "complete" && r.terminal === true && r.succeeded === 1, JSON.stringify(r));
		r = execute(ids.logsOk);
		check("its log tail shows the overridden args and env", r.found === true && /e2e args override: from n8n/.test(r.log), JSON.stringify(r));
		r = execute(ids.createSlow);
		created.push(j("slow"));
		check("create a Job with a 5 s deadline override", r.name === j("slow") && !r.error, JSON.stringify(r));
		r = await pollUntilTerminal(ids.statusSlow, 180);
		check("it fails: state failed, reason DeadlineExceeded", r.state === "failed" && r.terminal === true && r.reason === "DeadlineExceeded", JSON.stringify(r));
	}

	const logs = docker(["logs", CTR]) + spawnSync("docker", ["logs", CTR], { encoding: "utf8" }).stderr;
	check("n8n logged no custom-node load warning", !/skipping custom|failed to load|Cannot find module/i.test(logs), logs.split("\n").filter((l) => /custom|kubernetesBatch/i.test(l)).join("\n").slice(0, 2000));
}

function cleanup() {
	spawnSync("docker", ["rm", "-f", CTR]);
	spawnSync("docker", ["volume", "rm", VOL]);
	for (const name of created) spawnSync("kubectl", ["--kubeconfig", KUBECONFIG, "delete", "job", "-n", NS, name, "--ignore-not-found", "--wait=false"]);
	spawnSync("kubectl", ["--kubeconfig", KUBECONFIG, "delete", "cronjob", "-n", NS, BAD_TEMPLATE, "--ignore-not-found"]);
}

try {
	await main();
} catch (e) {
	console.log(`FAIL  e2e aborted: ${e.stack ?? e}${e.stderr ? `\n${e.stderr}` : ""}`);
	failed++;
} finally {
	cleanup();
}
console.log(`failed=${failed}`);
if (failed) process.exit(1);
console.log("E2E-OK");
