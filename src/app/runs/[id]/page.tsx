import { Bench } from "./Bench";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Bench runId={id} />;
}
