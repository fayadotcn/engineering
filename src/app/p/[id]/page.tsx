import { Workbench } from "@/ui/Workbench";
import { prisma } from "@database/client";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!await prisma.project.findUnique({ where: { id }, select: { id: true } })) notFound();
  return <Workbench projectId={id} />;
}
