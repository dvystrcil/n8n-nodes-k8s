import type { ICredentialType, INodeProperties, Icon } from "n8n-workflow";

// "Token from input": the credential holds only WHERE the API server is and
// WHICH CA to verify it against. It holds no secret. The bearer token comes
// with each execution (the node's Token parameter, usually an expression on
// the incoming item), so n8n keeps no standing Kubernetes credential.
//
// There is deliberately no "load from n8n's own service account", no
// kubeconfig, and no option to skip TLS verification.
export class KubernetesTokenApi implements ICredentialType {
	name = "kubernetesTokenApi";
	displayName = "Kubernetes (Token From Input)";
	documentationUrl = "https://github.com/dvystrcil/n8n-nodes-k8s#credential";
	icon: Icon = "file:k8s.svg";
	properties: INodeProperties[] = [
		{
			displayName: "API Server URL",
			name: "server",
			type: "string",
			default: "https://kubernetes.default.svc",
			required: true,
			description: "Must be https://. Inside a pod this is the in-cluster API service.",
		},
		{
			displayName: "CA Certificate File",
			name: "caFile",
			type: "string",
			default: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
			required: true,
			description: "PEM file with the cluster CA. The API server's certificate is always verified against it.",
		},
	];
}
