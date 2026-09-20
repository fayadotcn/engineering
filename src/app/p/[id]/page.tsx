import { Workbench } from "@/ui/Workbench";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <Workbench projectId={id} />;
}
