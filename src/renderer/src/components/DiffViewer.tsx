import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { PipelineState } from '../../../core/harness/pipeline-state'
import PipelineMetadataPanel from './PipelineMetadataPanel'

interface DiffViewerProps {
  diff: string
  state: PipelineState
}

function DiffViewer({ diff, state }: DiffViewerProps): React.JSX.Element {
  const hasDiff = diff.trim().length > 0
  return (
    <div className="deck-plan-viewer">
      <PipelineMetadataPanel state={state} />
      <section className="deck-plan-section">
        <h3 className="deck-plan-heading">Diff</h3>
        {hasDiff ? (
          <div className="deck-md">
            <div className="deck-md-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {diff}
              </ReactMarkdown>
            </div>
          </div>
        ) : (
          <div className="deck-plan-empty">No diff produced.</div>
        )}
      </section>
    </div>
  )
}

export default DiffViewer
