import Render, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { TODO_MARKERS, type TodoState } from '@knot-tui/core'
import { Glyph, todoStyle } from './Glyph.js'

interface MdNode { type: string; value?: string; checked?: boolean | null; children?: MdNode[]; data?: object }

/**
 * GFM knows `[ ]` and `[x]`; the knot also writes `[/]` (in progress) and `[-]`
 * (cancelled). Take those markers off the text and tag the item with its state.
 */
function knotTaskItems() {
  const marker = /^\[([/-])\]\s+/
  const walk = (node: MdNode) => {
    if (node.type === 'listItem' && node.checked == null) {
      const text = node.children?.[0]?.children?.[0]
      const m = text?.type === 'text' && text.value ? marker.exec(text.value) : null
      if (text && m) {
        text.value = text.value!.slice(m[0].length)
        const state = TODO_MARKERS[m[1] as '/' | '-']
        node.data = { ...node.data, hProperties: { className: ['task-list-item', `todo-${state}`] } }
      }
    }
    node.children?.forEach(walk)
  }
  return (tree: MdNode) => walk(tree)
}

const STATE = /\btodo-(in-progress|cancelled)\b/

const components: Components = {
  li: ({ node: _, className, children, ...props }) => {
    const state = STATE.exec(className ?? '')?.[1] as TodoState | undefined
    if (!state) return <li className={className} {...props}>{children}</li>
    return <li className={className} {...props}><Glyph state={state} /> <span style={todoStyle(state)}>{children}</span></li>
  },
  a: ({ node: _, href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
}

const INLINE = ['code', 'strong', 'em', 'del', 'a']

/**
 * GitHub-flavoured markdown, read-only: raw HTML is dropped, task-list checkboxes
 * come out disabled. `inline` keeps only inline marks, for a todo's one-line text.
 */
export function Markdown({ children, inline = false }: { children: string; inline?: boolean }) {
  const md = (
    <Render
      remarkPlugins={[remarkGfm, knotTaskItems]}
      components={components}
      skipHtml
      {...(inline ? { allowedElements: INLINE, unwrapDisallowed: true } : {})}
    >
      {children}
    </Render>
  )
  return inline ? md : <div className="md">{md}</div>
}
