"""During adoption, only the four containers and the consuming ECS rollout may change."""
import json
import sys

stage, path = sys.argv[1:]
with open(path) as source:
    resources = json.load(source)["resourcePlans"]

prefix = f"urn:pulumi:{stage}::bane::"
secret_op = "import" if stage == "dev" else "create"
containers = {
    prefix + "aws:secretsmanager/secret:Secret::nightmail-mail-gateway-" + key
    for key in ("db-url", "tls-cert", "tls-key", "api-token")
}
allowed = {urn: {secret_op} for urn in containers}
allowed.update({
    prefix + "aws:ecs/taskDefinition:TaskDefinition::bane-mail-gateway": {
        "replace", "create-replacement", "delete-replaced",
    },
    prefix + "aws:iam/rolePolicy:RolePolicy::bane-mail-gateway-execution": {"update"},
    prefix + "aws:ecs/service:Service::bane-mail-gateway": {"update"},
})
changes = {urn: set(plan.get("steps") or []) - {"same", "read"} for urn, plan in resources.items()}
if not containers <= changes.keys():
    sys.exit("gateway containers missing from preview")
if any(changes[urn] for urn in containers):
    for urn, ops in changes.items():
        if ops - allowed.get(urn, set()):
            sys.exit(f"unexpected gateway migration change: {urn}: {sorted(ops)}")
