import { Viewer } from '../components/Viewer.js'

// The vault changes under us; never prerender it at build time.
export const dynamic = 'force-dynamic'

export default async function Home(props: PageProps<'/'>) {
  return <Viewer search={await props.searchParams} />
}
