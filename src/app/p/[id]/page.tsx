import { Workbench } from "@/ui/Workbench";
import { listProjects } from "@project/service";
import { loadWorkbenchInit } from "@project/payload";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [initial, projects] = await Promise.all([loadWorkbenchInit(id), listProjects()]);
  if (!initial) notFound();
  return <Workbench projectId={id} projects={projects.map((p) => ({ id: p.id, name: p.name }))} initial={initial} />;
}
