import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from "n8n-workflow";
import * as k8s from "@kubernetes/client-node";

import {
	buildJobFromCronJob,
	classifyJob,
	describeApiError,
	isNotFound,
	jobPodSelector,
	makeKubeConfig,
	pickNewestPod,
} from "./k8s";

// Type-only imports from n8n-workflow: n8n loads this file from
// N8N_CUSTOM_EXTENSIONS, where n8n's own n8n-workflow does not resolve, and a
// second bundled copy would not be the one n8n checks errors against. Plain
// Errors thrown from execute() are wrapped by n8n into a NodeOperationError.

// Stryker disable next-line all
const showFor = (...operation: string[]) => ({ displayOptions: { show: { operation } } });

export class KubernetesBatch implements INodeType {
	// The description is UI data, not logic: mutation testing skips it
	// (the tests pin the parts that matter: operations, token, credential).
	// Stryker disable all
	description: INodeTypeDescription = {
		displayName: "Kubernetes Batch",
		name: "kubernetesBatch",
		icon: "file:k8s.svg",
		group: ["output"],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: "Start Kubernetes Jobs from suspended CronJob templates and check on them",
		defaults: { name: "Kubernetes Batch" },
		inputs: ["main"],
		outputs: ["main"],
		credentials: [{ name: "kubernetesTokenApi", required: true }],
		properties: [
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				options: [
					{
						name: "Create Job From CronJob",
						value: "createJobFromCronJob",
						description: "Create a Job from a CronJob's job template. The CronJob itself is never changed.",
						action: "Create a job from a cron job template",
					},
					{
						name: "Get Job Status",
						value: "getJobStatus",
						description: "Read a Job's state: running, suspended, complete, failed, or vanished (404). Returns at once.",
						action: "Get a job's status",
					},
					{
						name: "Get Job Log Tail",
						value: "getJobLogTail",
						description: "The last lines of the log of the Job's newest pod",
						action: "Get the tail of a job's log",
					},
				],
				default: "getJobStatus",
			},
			{
				displayName: "Token",
				name: "token",
				type: "string",
				typeOptions: { password: true },
				default: "",
				required: true,
				description: "Bearer token for this run, usually an expression on the incoming item. It is never included in the output.",
			},
			{
				displayName: "Namespace",
				name: "namespace",
				type: "string",
				default: "",
				required: true,
			},
			{
				displayName: "CronJob Name",
				name: "cronJobName",
				type: "string",
				default: "",
				required: true,
				...showFor("createJobFromCronJob"),
			},
			{
				displayName: "Job Name",
				name: "jobName",
				type: "string",
				default: "",
				required: true,
				description: "DNS-1123 label, at most 63 characters",
			},
			{
				displayName: "Args",
				name: "args",
				type: "json",
				default: "",
				description: "JSON array that replaces the container's args. Empty keeps the template's.",
				...showFor("createJobFromCronJob"),
			},
			{
				displayName: "Env",
				name: "env",
				type: "json",
				default: "",
				description: "JSON object of NAME: value, set on the container (replacing same-named entries)",
				...showFor("createJobFromCronJob"),
			},
			{
				displayName: "Labels",
				name: "labels",
				type: "json",
				default: "",
				description: "JSON object of extra labels for the Job and its pods",
				...showFor("createJobFromCronJob"),
			},
			{
				displayName: "Annotations",
				name: "annotations",
				type: "json",
				default: "",
				description: "JSON object of extra annotations for the Job",
				...showFor("createJobFromCronJob"),
			},
			{
				displayName: "Active Deadline Seconds",
				name: "activeDeadlineSeconds",
				type: "number",
				default: 0,
				description: "Override the template's activeDeadlineSeconds. 0 keeps the template's.",
				...showFor("createJobFromCronJob"),
			},
			{
				displayName: "Suspend",
				name: "suspend",
				type: "boolean",
				default: false,
				description: "Whether to create the Job suspended (it then starts no pods)",
				...showFor("createJobFromCronJob"),
			},
			{
				displayName: "Container",
				name: "container",
				type: "string",
				default: "",
				description: "Container to read. Empty reads the pod's only container.",
				...showFor("getJobLogTail"),
			},
			{
				displayName: "Tail Lines",
				name: "tailLines",
				type: "number",
				default: 100,
				...showFor("getJobLogTail"),
			},
			{
				displayName: "Limit Bytes",
				name: "limitBytes",
				type: "number",
				default: 65536,
				description: "Upper bound on the log text returned",
				...showFor("getJobLogTail"),
			},
		],
	};
	// Stryker restore all

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		const creds = await this.getCredentials("kubernetesTokenApi");
		for (let i = 0; i < items.length; i++) {
			try {
				const kc = makeKubeConfig({
					server: creds.server as string,
					caFile: creds.caFile as string,
					token: this.getNodeParameter("token", i) as string,
				});
				const operation = this.getNodeParameter("operation", i) as string;
				const namespace = required(this.getNodeParameter("namespace", i) as string, "Namespace");
				const jobName = required(this.getNodeParameter("jobName", i) as string, "Job Name");
				let json: IDataObject;
				if (operation === "createJobFromCronJob") {
					json = await createJobFromCronJob(kc, namespace, jobName, {
						cronJobName: required(this.getNodeParameter("cronJobName", i) as string, "CronJob Name"),
						args: jsonParam(this.getNodeParameter("args", i), "Args", "array") as string[] | undefined,
						env: jsonParam(this.getNodeParameter("env", i), "Env", "object") as Record<string, unknown> | undefined,
						labels: stringMap(jsonParam(this.getNodeParameter("labels", i), "Labels", "object"), "Labels"),
						annotations: stringMap(jsonParam(this.getNodeParameter("annotations", i), "Annotations", "object"), "Annotations"),
						activeDeadlineSeconds: (this.getNodeParameter("activeDeadlineSeconds", i) as number) || undefined,
						suspend: this.getNodeParameter("suspend", i) as boolean,
					});
				} else if (operation === "getJobStatus") {
					json = await getJobStatus(kc, namespace, jobName);
				} else if (operation === "getJobLogTail") {
					json = await getJobLogTail(kc, namespace, jobName, {
						container: (this.getNodeParameter("container", i) as string) || undefined,
						tailLines: this.getNodeParameter("tailLines", i) as number,
						limitBytes: this.getNodeParameter("limitBytes", i) as number,
					});
				} else {
					throw new Error(`Unknown operation "${operation}"`);
				}
				out.push({ json, pairedItem: { item: i } });
			} catch (e) {
				const text = describeApiError(e).text;
				if (this.continueOnFail()) {
					out.push({ json: { error: text }, pairedItem: { item: i } });
					continue;
				}
				throw new Error(text);
			}
		}
		return [out];
	}
}

function required(v: string | undefined, what: string): string {
	const s = (v ?? "").trim();
	if (s === "") throw new Error(`${what} is required`);
	return s;
}

function jsonParam(v: unknown, what: string, kind: "array" | "object"): unknown {
	if (v === undefined || v === "") return undefined;
	let parsed = v;
	if (typeof v === "string") {
		try {
			parsed = JSON.parse(v);
		} catch {
			throw new Error(`${what} is not valid JSON`);
		}
	}
	const ok = kind === "array" ? Array.isArray(parsed) : typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
	if (!ok) throw new Error(`${what} must be a JSON ${kind}`);
	return parsed;
}

function stringMap(v: unknown, what: string): Record<string, string> | undefined {
	if (v === undefined) return undefined;
	for (const [key, value] of Object.entries(v as object)) {
		if (typeof value !== "string") throw new Error(`${what}: value of "${key}" must be a string`);
	}
	return v as Record<string, string>;
}

async function createJobFromCronJob(
	kc: k8s.KubeConfig,
	namespace: string,
	jobName: string,
	o: {
		cronJobName: string;
		args?: string[];
		env?: Record<string, unknown>;
		labels?: Record<string, string>;
		annotations?: Record<string, string>;
		activeDeadlineSeconds?: number;
		suspend: boolean;
	},
): Promise<IDataObject> {
	const batch = kc.makeApiClient(k8s.BatchV1Api);
	const cronJob = await batch.readNamespacedCronJob({ name: o.cronJobName, namespace });
	const body = buildJobFromCronJob(cronJob, { ...o, jobName });
	const job = await batch.createNamespacedJob({ namespace, body });
	return {
		name: job.metadata!.name!,
		namespace: job.metadata!.namespace!,
		uid: job.metadata!.uid!,
		cronJob: o.cronJobName,
		suspended: job.spec!.suspend === true,
	};
}

async function getJobStatus(kc: k8s.KubeConfig, namespace: string, jobName: string): Promise<IDataObject> {
	const batch = kc.makeApiClient(k8s.BatchV1Api);
	let job: k8s.V1Job | null;
	try {
		// The Job itself, not its /status subresource: the RBAC this node is
		// built for grants get on jobs only.
		job = await batch.readNamespacedJob({ name: jobName, namespace });
	} catch (e) {
		if (!isNotFound(e)) throw e;
		job = null;
	}
	return classifyJob(job, jobName) as unknown as IDataObject;
}

async function getJobLogTail(
	kc: k8s.KubeConfig,
	namespace: string,
	jobName: string,
	o: { container?: string; tailLines: number; limitBytes: number },
): Promise<IDataObject> {
	const core = kc.makeApiClient(k8s.CoreV1Api);
	const pods = await core.listNamespacedPod({ namespace, labelSelector: jobPodSelector(jobName) });
	const pod = pickNewestPod(pods.items);
	if (pod === null) {
		return { job: jobName, found: false, pod: null, phase: null, container: o.container ?? null, log: "" };
	}
	const log = await core.readNamespacedPodLog({
		name: pod.metadata.name,
		namespace,
		container: o.container,
		tailLines: o.tailLines,
		limitBytes: o.limitBytes,
	});
	return {
		job: jobName,
		found: true,
		pod: pod.metadata.name,
		phase: pod.status?.phase ?? null,
		container: o.container ?? pod.spec.containers[0].name,
		log,
	};
}
