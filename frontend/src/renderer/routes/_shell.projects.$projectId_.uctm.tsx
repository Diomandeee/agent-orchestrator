import { createFileRoute } from "@tanstack/react-router";
import { UctmView } from "../components/uctm/UctmView";

export const Route = createFileRoute("/_shell/projects/$projectId_/uctm")({
	component: ProjectUctmRoute,
});

function ProjectUctmRoute() {
	const { projectId } = Route.useParams();
	return <UctmView projectId={projectId} />;
}
