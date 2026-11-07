// The node's Kubernetes logic, kept apart from the n8n glue so it can be
// tested on its own. Only the calls a batch chain needs:
//   get a CronJob, create a Job, get a Job, list pods, get a pod log.
// No watch, patch or delete: the chain waits with n8n's own Wait node, and
// finished Jobs are cleaned up by their ttlSecondsAfterFinished.
import { readFileSync } from "node:fs";
import * as k8s from "@kubernetes/client-node";

// ---- the credential -> KubeConfig -----------------------------------------

export interface TokenConfig {
	server: string;
	caFile: string;
	token: string | undefined;
}

// TLS is always verified against the CA read here. There is no option to skip
// verification, and no fallback to the process's default trust store or to
// NODE_EXTRA_CA_CERTS: client-node passes this CA as the only trusted root.
export function makeKubeConfig(cfg: TokenConfig): k8s.KubeConfig {
	if (typeof cfg.server !== "string" || !cfg.server.startsWith("https://")) {
		throw new Error(`Kubernetes server must be an https:// URL (got "${cfg.server}")`);
	}
	const token = (cfg.token ?? "").trim();
	if (token === "") {
		throw new Error("Kubernetes token is empty: pass the per-run token in the Token parameter");
	}
	if (!cfg.caFile) {
		throw new Error("Kubernetes CA file is required");
	}
	let ca: Buffer;
	try {
		ca = readFileSync(cfg.caFile);
	} catch (e) {
		throw new Error(`Kubernetes CA file ${cfg.caFile} could not be read: ${(e as Error).message}`);
	}
	if (!ca.includes("-----BEGIN CERTIFICATE-----")) {
		throw new Error(`Kubernetes CA file ${cfg.caFile} holds no PEM certificate`);
	}
	const kc = new k8s.KubeConfig();
	kc.loadFromOptions({
		clusters: [
			{
				name: "cluster",
				server: cfg.server,
				caData: ca.toString("base64"),
				skipTLSVerify: false,
			},
		],
		users: [{ name: "token", token }],
		contexts: [{ name: "token@cluster", cluster: "cluster", user: "token" }],
		currentContext: "token@cluster",
	});
	return kc;
}

// ---- Create Job from CronJob ----------------------------------------------

export interface JobOverrides {
	jobName: string;
	args?: string[];
	env?: Record<string, unknown>;
	labels?: Record<string, string>;
	annotations?: Record<string, string>;
	activeDeadlineSeconds?: number;
	suspend?: boolean;
}

const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

// A plain Job from the CronJob's .spec.jobTemplate, as `kubectl create job
// --from=cronjob/...` would build, but WITHOUT touching the CronJob: nothing
// is written back to it, so lastScheduleTime is never stamped, and the Job has
// no ownerReference to it.
export function buildJobFromCronJob(cronJob: any, o: JobOverrides): any {
	const tmpl = cronJob.spec?.jobTemplate;
	if (!tmpl?.spec?.template) {
		throw new Error(`CronJob ${cronJob.metadata.name} has no spec.jobTemplate.spec.template`);
	}
	if (o.jobName.length > 63 || !DNS1123_LABEL.test(o.jobName)) {
		throw new Error(
			`Job name "${o.jobName}" is not a valid DNS-1123 label (lowercase alphanumerics and '-', at most 63 characters)`,
		);
	}
	const spec = structuredClone(tmpl.spec);
	const labels = { ...(tmpl.metadata?.labels ?? {}), ...(o.labels ?? {}) };
	const annotations = { ...(tmpl.metadata?.annotations ?? {}), ...(o.annotations ?? {}) };

	const hasArgs = o.args !== undefined;
	const env = Object.entries(o.env ?? {});
	if (hasArgs || env.length > 0) {
		const containers = spec.template.spec.containers ?? [];
		if (containers.length !== 1) {
			throw new Error(`args/env overrides need exactly one container in the template; it has ${containers.length}`);
		}
		const c = containers[0];
		if (hasArgs) c.args = [...(o.args as string[])];
		if (env.length > 0) {
			const list: Array<{ name: string; value?: string }> = c.env ?? [];
			for (const [name, value] of env) {
				const entry = { name, value: String(value) };
				const at = list.findIndex((e) => e.name === name);
				if (at >= 0) list[at] = entry;
				else list.push(entry);
			}
			c.env = list;
		}
	}
	if (o.labels && Object.keys(o.labels).length > 0) {
		spec.template.metadata = spec.template.metadata ?? {};
		spec.template.metadata.labels = { ...(spec.template.metadata.labels ?? {}), ...o.labels };
	}
	if (o.activeDeadlineSeconds !== undefined) {
		const d = o.activeDeadlineSeconds;
		if (!Number.isInteger(d) || d <= 0) {
			throw new Error(`activeDeadlineSeconds must be a positive integer (got ${d})`);
		}
		spec.activeDeadlineSeconds = d;
	}
	if (o.suspend === true) spec.suspend = true;

	return {
		apiVersion: "batch/v1",
		kind: "Job",
		metadata: {
			name: o.jobName,
			namespace: cronJob.metadata.namespace,
			labels,
			annotations,
		},
		spec,
	};
}

// ---- Get Job status --------------------------------------------------------

export type JobState = "running" | "suspended" | "complete" | "failed" | "vanished";

export interface JobStatus {
	name: string;
	namespace: string | null;
	uid: string | null;
	state: JobState;
	terminal: boolean;
	reason: string | null;
	message: string | null;
	active: number;
	succeeded: number;
	failed: number;
	startTime: string | null;
	completionTime: string | null;
}

function trueCondition(job: any, type: string): any {
	return job.status?.conditions?.find((c: any) => c.type === type && c.status === "True");
}

const iso = (t: unknown): string | null => (t instanceof Date ? t.toISOString() : t ? String(t) : null);

// Only Complete and Failed are terminal. FailureTarget / SuccessCriteriaMet
// come first, while pods are still terminating, so they read as running.
// `job === null` means the GET returned 404: the Job is gone (deleted, or
// cleaned up by its TTL before anyone looked). That is terminal too, so a
// chain never waits on a Job that no longer exists.
export function classifyJob(job: any, name: string): JobStatus {
	if (job === null) {
		return {
			name,
			namespace: null,
			uid: null,
			state: "vanished",
			terminal: true,
			reason: "NotFound",
			message: `Job ${name} no longer exists`,
			active: 0,
			succeeded: 0,
			failed: 0,
			startTime: null,
			completionTime: null,
		};
	}
	const failed = trueCondition(job, "Failed");
	const complete = trueCondition(job, "Complete");
	const suspended = job.spec?.suspend === true ? trueCondition(job, "Suspended") ?? {} : undefined;
	let state: JobState = "running";
	let c: any;
	if (failed) [state, c] = ["failed", failed];
	else if (complete) [state, c] = ["complete", complete];
	else if (suspended) [state, c] = ["suspended", suspended];
	return {
		name: job.metadata.name,
		namespace: job.metadata.namespace ?? null,
		uid: job.metadata.uid ?? null,
		state,
		terminal: state === "failed" || state === "complete",
		reason: c?.reason ?? null,
		message: c?.message ?? null,
		active: job.status?.active ?? 0,
		succeeded: job.status?.succeeded ?? 0,
		failed: job.status?.failed ?? 0,
		startTime: iso(job.status?.startTime),
		completionTime: iso(job.status?.completionTime),
	};
}

// ---- Get pod log tail ------------------------------------------------------

// Set by the Job controller on every pod it creates (Kubernetes >= 1.27).
export function jobPodSelector(jobName: string): string {
	return `batch.kubernetes.io/job-name=${jobName}`;
}

// Ties (creationTimestamp has 1 s resolution) keep the first one listed.
export function pickNewestPod(pods: any[] | undefined): any | null {
	let best: any = null;
	for (const p of pods ?? []) {
		if (best === null || new Date(p.metadata.creationTimestamp) > new Date(best.metadata.creationTimestamp)) best = p;
	}
	return best;
}

// ---- errors ----------------------------------------------------------------

const MAX_ERROR_BODY = 2000;

export interface ApiErrorInfo {
	status: number | null;
	reason: string | null;
	message: string | null;
	text: string;
}

function httpStatus(err: any): number | null {
	// client-node's ApiException carries the HTTP status as a number; Node's
	// own errors carry string codes (ECONNRESET, UNABLE_TO_VERIFY_...).
	const c = err?.code;
	return typeof c === "number" ? c : null;
}

export function isNotFound(err: unknown): boolean {
	return httpStatus(err) === 404;
}

// The API server's own words, e.g. a ValidatingAdmissionPolicy refusal:
//   HTTP 403 Forbidden: jobs.batch "x" is forbidden: ValidatingAdmissionPolicy ...
// The chain posts this text, so it must not be swallowed or replaced with
// client-node's generic "Unknown API Status Code!".
export function describeApiError(err: any): ApiErrorInfo {
	const status = httpStatus(err);
	if (status === null) {
		const cause = err.cause;
		const extra = cause ? `: ${cause.message}${cause.code ? ` (${cause.code})` : ""}` : "";
		return { status: null, reason: null, message: null, text: `${err.message}${extra}` };
	}
	let body: any = err.body;
	// (JSON.parse of a non-string throws too, so the typeof check is an
	// optimisation: its mutants are equivalent.)
	if (typeof body === "string") {
		try {
			body = JSON.parse(body);
		} catch {
			// not JSON: keep the raw text
		}
	}
	if (typeof body?.message === "string") {
		const reason = typeof body.reason === "string" ? body.reason : null;
		return { status, reason, message: body.message, text: `HTTP ${status}${reason ? ` ${reason}` : ""}: ${body.message}` };
	}
	if (body === undefined || body === "") {
		return { status, reason: null, message: null, text: `HTTP ${status}` };
	}
	const raw = (typeof body === "string" ? body : JSON.stringify(body)).slice(0, MAX_ERROR_BODY);
	return { status, reason: null, message: raw, text: `HTTP ${status}: ${raw}` };
}
