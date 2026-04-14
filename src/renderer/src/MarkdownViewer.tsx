import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Components } from 'react-markdown'

interface MarkdownViewerProps {
  content: string
  filePath: string
  onWikilinkClick: (wikilink: string) => void
  onRelativeLinkClick?: (absolutePath: string) => void
}

// Regex to match [[wikilink]] patterns in text
// Global version for exec() loop, non-global for test()
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g
const WIKILINK_TEST = /\[\[([^\]]+)\]\]/

function processWikilinks(
  text: string,
  onWikilinkClick: (wikilink: string) => void
): React.JSX.Element {
  const parts: React.JSX.Element[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  // Reset regex state
  WIKILINK_RE.lastIndex = 0
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    // Text before the wikilink
    if (match.index > lastIndex) {
      parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex, match.index)}</span>)
    }

    const linkTarget = match[1]
    parts.push(
      <a
        key={`w-${match.index}`}
        className="deck-md-wikilink"
        href="#"
        onClick={(e) => {
          e.preventDefault()
          onWikilinkClick(linkTarget)
        }}
      >
        {linkTarget}
      </a>
    )
    lastIndex = match.index + match[0].length
  }

  // Remaining text after last match
  if (lastIndex < text.length) {
    parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex)}</span>)
  }

  if (parts.length === 0) {
    return <>{text}</>
  }

  return <>{parts}</>
}

function resolveRelativePath(href: string, currentFilePath: string): string | null {
  // Only handle relative .md links (not http://, #anchors, etc.)
  if (!href || href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:')) return null
  // Resolve relative to current file's directory
  const dir = currentFilePath.replace(/[/\\][^/\\]*$/, '')
  // Normalize: join dir + href, collapse ../ and ./
  const parts = `${dir}/${href}`.replace(/\\/g, '/').split('/')
  const resolved: string[] = []
  for (const p of parts) {
    if (p === '..') resolved.pop()
    else if (p !== '.') resolved.push(p)
  }
  return resolved.join('/')
}

function MarkdownViewer({ content, filePath, onWikilinkClick, onRelativeLinkClick }: MarkdownViewerProps): React.JSX.Element {
  // Build custom components that intercept text nodes for wikilinks
  const components: Components = {
    a: ({ href, children }) => {
      if (!href) return <a>{children}</a>
      const resolved = resolveRelativePath(href, filePath)
      if (resolved) {
        return (
          <a
            className="deck-md-wikilink"
            href="#"
            onClick={(e) => {
              e.preventDefault()
              if (onRelativeLinkClick) onRelativeLinkClick(resolved)
              else onWikilinkClick(href.replace(/\.md$/, '').split('/').pop() || href)
            }}
          >
            {children}
          </a>
        )
      }
      // External link — open normally
      return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    },
    p: ({ children }) => {
      const processed = processChildren(children, onWikilinkClick)
      return <p>{processed}</p>
    },
    li: ({ children }) => {
      const processed = processChildren(children, onWikilinkClick)
      return <li>{processed}</li>
    },
    td: ({ children }) => {
      const processed = processChildren(children, onWikilinkClick)
      return <td>{processed}</td>
    },
    h1: ({ children }) => <h1>{processChildren(children, onWikilinkClick)}</h1>,
    h2: ({ children }) => <h2>{processChildren(children, onWikilinkClick)}</h2>,
    h3: ({ children }) => <h3>{processChildren(children, onWikilinkClick)}</h3>,
    h4: ({ children }) => <h4>{processChildren(children, onWikilinkClick)}</h4>,
    blockquote: ({ children }) => <blockquote>{processChildren(children, onWikilinkClick)}</blockquote>
  }

  // Extract filename for display
  const fileName = filePath.split(/[/\\]/).pop() || filePath

  return (
    <div className="deck-md">
      <div className="deck-md-header">
        <span className="deck-md-filename">{fileName}</span>
      </div>
      <div className="deck-md-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}

// Process React children, replacing string children that contain [[wikilinks]]
function processChildren(
  children: React.ReactNode,
  onWikilinkClick: (wikilink: string) => void
): React.ReactNode {
  if (!children) return children

  if (typeof children === 'string') {
    if (WIKILINK_TEST.test(children)) {
      return processWikilinks(children, onWikilinkClick)
    }
    return children
  }

  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === 'string' && WIKILINK_TEST.test(child)) {
        return <span key={i}>{processWikilinks(child, onWikilinkClick)}</span>
      }
      return child
    })
  }

  return children
}

export default MarkdownViewer
