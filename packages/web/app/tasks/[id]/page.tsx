import { Viewer } from '../../../components/Viewer.js'

export const dynamic = 'force-dynamic'

export async function generateMetadata(props: PageProps<'/tasks/[id]'>) {
  const { id } = await props.params
  return { title: `${id} · knot` }
}

export default async function TaskPage(props: PageProps<'/tasks/[id]'>) {
  const { id } = await props.params
  return <Viewer search={await props.searchParams} open={id} />
}
